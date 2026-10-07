/**
 * Pure mapping from article signals to Laya training rows.
 * One supervision result per article (fixed precedence), then question targets;
 * cohort articles go only to test (gold only); validation is a seeded stratified 10%.
 */

import { createHash } from "node:crypto";
import { buildState, CATEGORIES, DEFAULT_THRESHOLDS, deriveVerdict } from "./jev";
import { currentAdminAuthority, isTestCohort, type LabelEventLike } from "./labels";
import { LAYA_QUESTIONS } from "./laya";

export const LAYA_WEIGHTS = { gold: 1, flag: 0.5, jev: 0.6, ollama: 0.4, keyword: 0.3, trusted: 0.3, historical: 0.2 } as const;
export type SupervisionSource = keyof typeof LAYA_WEIGHTS;
const HISTORICAL_REASON = "historical approval (unverified)";
const PROTECTED: SupervisionSource[] = ["gold", "flag", "jev", "ollama"];
const GROUP_CAP = 20_000;
const VAL_SHARE = 0.1;

type Ev = LabelEventLike & { reason: string | null };

export interface ArticleSignals {
  id: string;
  title: string;
  summary: string | null;
  language: string;
  trusted: boolean;
  events: Ev[];
  jev: { positiveP: number; upliftingP: number; topCategory: string; topCategoryP: number } | null;
}

export interface Supervision {
  label: "keep" | "reject";
  p: number;
  source: SupervisionSource;
  category: string | null;
}

const target = (label: "keep" | "reject", w: number) => (label === "keep" ? 0.5 + 0.5 * w : 0.5 - 0.5 * w);
const byTime = (a: Ev, b: Ev) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);

export function supervise(a: ArticleSignals): Supervision | null {
  const admin = currentAdminAuthority(a.events);
  if (admin) {
    const label = admin.verdict as "keep" | "reject";
    return { label, p: label === "keep" ? 1 : 0, source: "gold", category: label === "reject" ? admin.category : null };
  }
  const eligible = a.events.filter((e) => e.eligible);
  if (eligible.some((e) => e.source === "reader_flag")) return { label: "reject", p: target("reject", LAYA_WEIGHTS.flag), source: "flag", category: null };
  if (a.jev) {
    const label = deriveVerdict(a.jev, DEFAULT_THRESHOLDS).keep ? "keep" : "reject";
    return { label, p: target(label, LAYA_WEIGHTS.jev), source: "jev", category: null };
  }
  const ollama = latestOllama(a.events);
  if (ollama) {
    const label = ollama.verdict as "keep" | "reject";
    return { label, p: target(label, LAYA_WEIGHTS.ollama), source: "ollama", category: null };
  }
  if (eligible.some((e) => e.source === "keyword")) return { label: "reject", p: target("reject", LAYA_WEIGHTS.keyword), source: "keyword", category: null };
  if (a.trusted) return { label: "keep", p: target("keep", LAYA_WEIGHTS.trusted), source: "trusted", category: null };
  if (a.events.some((e) => e.source === "ollama" && e.verdict === "keep" && !e.eligible && e.reason === HISTORICAL_REASON)) {
    return { label: "keep", p: target("keep", LAYA_WEIGHTS.historical), source: "historical", category: null };
  }
  return null;
}

export interface LayaRow {
  id: string;
  state: Record<string, string>;
  language: string;
  questions: typeof LAYA_QUESTIONS;
  gold: Record<string, { probabilities: Record<string, number> }>;
  source: SupervisionSource;
  label: "keep" | "reject";
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function toRow(a: ArticleSignals, s: Supervision): LayaRow {
  const gold: LayaRow["gold"] = { keep: { probabilities: { true: round(s.p), false: round(1 - s.p) } } };
  if (s.source === "gold" && s.label === "reject" && s.category && Object.hasOwn(CATEGORIES, s.category)) {
    gold.reason = { probabilities: { [s.category]: 1 } };
  }
  return { id: a.id, state: buildState({ title: a.title, summary: a.summary }), language: a.language, questions: LAYA_QUESTIONS, gold, source: s.source, label: s.label };
}

/** Content-addressed: order depends on each item's stable key, not its position. */
export function seededShuffle<T>(xs: T[], seed: number, salt: string, keyOf: (x: T) => string): T[] {
  const key = (x: T) => createHash("sha256").update(`${seed}:${salt}:${keyOf(x)}`).digest("hex");
  return xs.map((x) => ({ x, k: key(x) })).sort((a, b) => (a.k < b.k ? -1 : 1)).map((e) => e.x);
}

/** Latest eligible Ollama keep/reject event (time, then id tie-break), as used by supervise. */
export function latestOllama<E extends Ev>(events: E[]): E | undefined {
  return events.filter((e) => e.eligible && e.source === "ollama" && (e.verdict === "keep" || e.verdict === "reject")).sort(byTime).at(-1);
}

function inVal(seed: number, r: LayaRow): boolean {
  const h = createHash("sha256").update(`${seed}:val:${r.label}:${r.source}:${r.id}`).digest("hex");
  return Number.parseInt(h.slice(0, 8), 16) / 2 ** 32 < VAL_SHARE;
}

export interface SplitResult {
  train: LayaRow[];
  val: LayaRow[];
  test: LayaRow[];
  balance: {
    status: "ok" | "infeasible";
    reason: string | null;
    keepRows: number;
    rejectRows: number;
    meanTarget: number;
    bySource: Record<SupervisionSource, { preCap: number; kept: number }>;
  };
}

export function buildSplits(articles: ArticleSignals[], seed: number): SplitResult {
  const test: LayaRow[] = [];
  const groups: Record<SupervisionSource, LayaRow[]> = { gold: [], flag: [], jev: [], ollama: [], keyword: [], trusted: [], historical: [] };
  for (const a of articles) {
    const s = supervise(a);
    if (!s) continue;
    if (isTestCohort(a.id)) {
      if (s.source === "gold") test.push(toRow(a, s));
      continue;
    }
    groups[s.source].push(toRow(a, s));
  }

  const byId = (r: LayaRow) => r.id;
  // Protected sources are never capped; only keyword, trusted and historical obey GROUP_CAP.
  const cap = (rows: LayaRow[], n: number, salt: string) => seededShuffle(rows, seed, salt, byId).slice(0, Math.min(n, GROUP_CAP));
  const kept: LayaRow[] = PROTECTED.flatMap((src) => groups[src]);
  const trusted = cap(groups.trusted, Infinity, "trusted");
  const historical = cap(groups.historical, trusted.length, "historical");
  const keepsSoFar = [...kept, ...trusted, ...historical].filter((r) => r.label === "keep").length;
  const rejectsSoFar = kept.filter((r) => r.label === "reject").length;
  const keyword = cap(groups.keyword, Math.max(0, keepsSoFar - rejectsSoFar), "keyword");
  const rows = [...kept, ...trusted, ...historical, ...keyword];

  const keepRows = rows.filter((r) => r.label === "keep").length;
  const rejectRows = rows.length - keepRows;
  const share = rows.length ? keepRows / rows.length : 0;
  const feasible = share >= 0.4 && share <= 0.6;
  const meanTarget = rows.length ? rows.reduce((s, r) => s + r.gold.keep.probabilities.true, 0) / rows.length : 0;

  // Validation membership is a per-row hash threshold, so adding rows never moves existing ones.
  // A row whose label or source changes may move, since both are part of the hash key.
  const val: LayaRow[] = [];
  const train: LayaRow[] = [];
  for (const r of rows) (inVal(seed, r) ? val : train).push(r);

  const bySource = Object.fromEntries(
    (Object.keys(groups) as SupervisionSource[]).map((src) => [src, { preCap: groups[src].length, kept: rows.filter((r) => r.source === src).length }]),
  ) as SplitResult["balance"]["bySource"];

  return {
    train,
    val,
    test,
    balance: {
      status: feasible ? "ok" : "infeasible",
      reason: feasible ? null : `keep share ${(share * 100).toFixed(1)}% outside 40–60% (keep rows ${keepRows}, reject rows ${rejectRows})`,
      keepRows,
      rejectRows,
      meanTarget: round(meanTarget),
      bySource,
    },
  };
}
