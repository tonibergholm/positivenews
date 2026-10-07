/**
 * Pure mapping from article signals to Laya training rows.
 * One supervision result per article (fixed precedence), then question targets;
 * identical texts are de-duplicated across splits (a group touching the test cohort is test-only, gold only);
 * balance is enforced per language so language cannot predict the label;
 * validation is a deterministic seeded-hash 10% sample keyed on the text (no stratified quotas).
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
const HISTORICAL_CAP = 5000;
const SOURCE_ORDER: SupervisionSource[] = ["gold", "flag", "jev", "ollama", "keyword", "trusted", "historical"];
const LANGS = ["fi", "en", "other"] as const;
type LangBucket = (typeof LANGS)[number];
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
  /** sha256 of the normalized title + summary; identical texts share it. */
  textKey: string;
}

const normalize = (t: string) => t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** Keyed on what the model sees: title plus the summary trimmed to SUMMARY_CHARS (via buildState). */
export const textKey = (r: { title: string; summary: string | null }) => {
  const st = buildState(r);
  return createHash("sha256").update(normalize(`${st.title}\n${st.summary ?? ""}`)).digest("hex");
};

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function toRow(a: ArticleSignals, s: Supervision): LayaRow {
  const gold: LayaRow["gold"] = { keep: { probabilities: { true: round(s.p), false: round(1 - s.p) } } };
  if (s.source === "gold" && s.label === "reject" && s.category && Object.hasOwn(CATEGORIES, s.category)) {
    gold.reason = { probabilities: { [s.category]: 1 } };
  }
  return { id: a.id, state: buildState({ title: a.title, summary: a.summary }), language: a.language, questions: LAYA_QUESTIONS, gold, source: s.source, label: s.label, textKey: textKey(a) };
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

/**
 * Validation membership is a per-text hash threshold (not per id), so identical texts never straddle
 * train and val, and adding rows never moves an existing row between train and val.
 */
function inVal(seed: number, r: LayaRow): boolean {
  const h = createHash("sha256").update(`${seed}:val:${r.textKey}`).digest("hex");
  return Number.parseInt(h.slice(0, 8), 16) / 2 ** 32 < VAL_SHARE;
}

type SourceCounts = Record<SupervisionSource, { preCap: number; kept: number }>;
interface Status {
  status: "ok" | "infeasible";
  reason: string | null;
  keepRows: number;
  rejectRows: number;
}
export interface LanguageBalance extends Status {
  /** Rows after de-duplication, before balancing. */
  preRows: number;
  bySource: SourceCounts;
}

export interface SplitResult {
  train: LayaRow[];
  val: LayaRow[];
  test: LayaRow[];
  balance: Status & {
    meanTarget: number;
    /** Rows collapsed into another row of the same text group (in groups that yielded a row). */
    duplicatesDropped: number;
    /** Rows dropped because their text group touched the test cohort without contributing a test row. */
    cohortGroupDropped: number;
    bySource: SourceCounts;
    byLanguage: Record<LangBucket, LanguageBalance>;
  };
}

const bucketOf = (lang: string): LangBucket => (lang === "fi" || lang === "en" ? lang : "other");
const emptyGroups = () => Object.fromEntries(SOURCE_ORDER.map((s) => [s, [] as LayaRow[]])) as Record<SupervisionSource, LayaRow[]>;
const sourceCounts = (pre: Record<SupervisionSource, LayaRow[]>, rows: LayaRow[]) =>
  Object.fromEntries(SOURCE_ORDER.map((src) => [src, { preCap: pre[src].length, kept: rows.filter((r) => r.source === src).length }])) as SourceCounts;
const keepShare = (keepRows: number, rejectRows: number) => (keepRows + rejectRows ? keepRows / (keepRows + rejectRows) : 0);

/**
 * Balance one language: protected rows always kept; keeps topped up from historical (sampled) plus trusted
 * (at most as many as the non-trusted keeps); rejects topped up from keyword rows, to a common target.
 */
function balanceLanguage(g: Record<SupervisionSource, LayaRow[]>, seed: number, lang: string): { rows: LayaRow[]; info: LanguageBalance } {
  const byId = (r: LayaRow) => r.id;
  const prot = PROTECTED.flatMap((src) => g[src]);
  const pk = prot.filter((r) => r.label === "keep");
  const pr = prot.filter((r) => r.label === "reject");
  const historical = seededShuffle(g.historical, seed, `historical:${lang}`, byId).slice(0, Math.min(HISTORICAL_CAP, GROUP_CAP));
  const trusted = seededShuffle(g.trusted, seed, `trusted:${lang}`, byId).slice(0, pk.length + historical.length);
  const keepPool = seededShuffle([...historical, ...trusted], seed, `keep:${lang}`, byId);
  const rejectPool = seededShuffle(g.keyword, seed, `keyword:${lang}`, byId);
  const target = Math.max(pk.length, pr.length, Math.min(pk.length + keepPool.length, pr.length + rejectPool.length));

  // Walk the shuffled pool; a trusted row is taken only while trusted <= non-trusted keeps. Repeat until the quota is met.
  const quota = Math.max(0, target - pk.length);
  const taken = new Set<LayaRow>();
  let nonTrusted = pk.length;
  let trustedTaken = 0;
  for (let progress = true; progress && taken.size < quota; ) {
    progress = false;
    for (const r of keepPool) {
      if (taken.size >= quota) break;
      if (taken.has(r)) continue;
      if (r.source === "trusted") {
        if (trustedTaken >= nonTrusted) continue;
        trustedTaken++;
      } else nonTrusted++;
      taken.add(r);
      progress = true;
    }
  }
  const keeps = [...pk, ...keepPool.filter((r) => taken.has(r))];
  const rejects = [...pr, ...rejectPool.slice(0, Math.max(0, target - pr.length))];
  const rows = [...keeps, ...rejects];
  const share = keepShare(keeps.length, rejects.length);
  const preRows = SOURCE_ORDER.reduce((n, src) => n + g[src].length, 0);
  const ok = rows.length === 0 ? preRows === 0 : share >= 0.4 && share <= 0.6;
  const reason = ok ? null : rows.length === 0 ? `all ${preRows} rows lost in balancing` : `keep share ${(share * 100).toFixed(1)}% outside 40–60% (keep rows ${keeps.length}, reject rows ${rejects.length})`;
  return {
    rows,
    info: {
      status: ok ? "ok" : "infeasible",
      reason,
      preRows,
      keepRows: keeps.length,
      rejectRows: rejects.length,
      bySource: sourceCounts(g, rows),
    },
  };
}

export function buildSplits(articles: ArticleSignals[], seed: number): SplitResult {
  // 1. Supervise, then group by normalized text.
  const textGroups = new Map<string, { row: LayaRow; cohort: boolean }[]>();
  for (const a of articles) {
    const s = supervise(a);
    if (!s) continue;
    const row = toRow(a, s);
    const list = textGroups.get(row.textKey) ?? [];
    list.push({ row, cohort: isTestCohort(a.id) });
    textGroups.set(row.textKey, list);
  }

  // 2. Resolve duplicates: a group touching the cohort is test-only (one gold row); otherwise the strongest source wins.
  const test: LayaRow[] = [];
  const perLang: Record<LangBucket, Record<SupervisionSource, LayaRow[]>> = { fi: emptyGroups(), en: emptyGroups(), other: emptyGroups() };
  let duplicatesDropped = 0;
  let cohortGroupDropped = 0;
  const rank = (r: LayaRow) => SOURCE_ORDER.indexOf(r.source);
  for (const items of textGroups.values()) {
    if (items.some((i) => i.cohort)) {
      // Prefer gold rows from cohort articles; fall back to the lowest-id gold row of the group.
      const byRowId = (x: { row: LayaRow }, y: { row: LayaRow }) => (x.row.id < y.row.id ? -1 : x.row.id > y.row.id ? 1 : 0);
      const golds = items.filter((i) => i.row.source === "gold");
      const pick = [...golds.filter((i) => i.cohort).sort(byRowId), ...golds.sort(byRowId)][0];
      if (pick) {
        test.push(pick.row);
        duplicatesDropped += items.length - 1;
      } else cohortGroupDropped += items.length;
      continue;
    }
    duplicatesDropped += items.length - 1;
    const best = items.reduce((b, i) => (rank(i.row) < rank(b.row) || (rank(i.row) === rank(b.row) && i.row.id < b.row.id) ? i : b));
    perLang[bucketOf(best.row.language)][best.row.source].push(best.row);
  }

  // 3. Balance each language independently.
  const rows: LayaRow[] = [];
  const byLanguage = {} as Record<LangBucket, LanguageBalance>;
  for (const lang of LANGS) {
    const b = balanceLanguage(perLang[lang], seed, lang);
    rows.push(...b.rows);
    byLanguage[lang] = b.info;
  }
  const pre = emptyGroups();
  for (const lang of LANGS) for (const src of SOURCE_ORDER) pre[src].push(...perLang[lang][src]);

  const keepRows = rows.filter((r) => r.label === "keep").length;
  const rejectRows = rows.length - keepRows;
  const failing = LANGS.filter((l) => byLanguage[l].preRows >= 100 && byLanguage[l].status !== "ok");
  const meanTarget = rows.length ? rows.reduce((s, r) => s + r.gold.keep.probabilities.true, 0) / rows.length : 0;

  const val: LayaRow[] = [];
  const train: LayaRow[] = [];
  for (const r of rows) (inVal(seed, r) ? val : train).push(r);

  return {
    train,
    val,
    test,
    balance: {
      status: failing.length ? "infeasible" : "ok",
      reason: failing.length ? failing.map((l) => `${l}: ${byLanguage[l].reason}`).join("; ") : null,
      keepRows,
      rejectRows,
      meanTarget: round(meanTarget),
      duplicatesDropped,
      cohortGroupDropped,
      bySource: sourceCounts(pre, rows),
      byLanguage,
    },
  };
}
