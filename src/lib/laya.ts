/**
 * Laya contract (questions + state format) and HTTP client.
 *
 * The contract is shared by the training export and the shadow client so
 * training and inference ask identical questions. Its hash is bundled with
 * every checkpoint; the client refuses to evaluate against a different one.
 */

import { createHash } from "node:crypto";
import { buildState, CATEGORIES } from "./jev";

export const LAYA_CONTRACT_VERSION = "1";

export const LAYA_QUESTIONS = {
  keep: {
    type: "noul",
    instructions: "Does this article belong in a positive news feed: genuinely uplifting, hopeful or constructive news?",
    criteria: {
      true: "Genuinely uplifting, hopeful or constructive news a reader would be glad to see",
      false: "Negative, alarming, routine, promotional or otherwise not uplifting",
    },
  },
  reason: {
    type: "choice",
    instructions: "Which of these is the main reason this article does not belong in a positive news feed?",
    criteria: Object.fromEntries(Object.entries(CATEGORIES).map(([key, c]) => [key, `${c.label}: ${c.yes}`])),
  },
} as const;

export interface LayaContract {
  version: string;
  state: string;
  questions: typeof LAYA_QUESTIONS;
}

export function layaContract(): LayaContract {
  return { version: LAYA_CONTRACT_VERSION, state: "buildState({title, summary}) — summary trimmed, max 300 chars", questions: LAYA_QUESTIONS };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contractHash(): string {
  return createHash("sha256").update(stable(layaContract())).digest("hex");
}

export interface LayaAnswer {
  checkpoint: string;
  experimental: boolean;
  keepP: number;
  reason: string;
  reasonP: number;
  answers: Record<string, unknown>;
}

export function parseLayaAnswers(answers: unknown, checkpoint: string, experimental: boolean): LayaAnswer {
  const a = (answers ?? {}) as Record<string, { type?: unknown; noul?: unknown; choice?: unknown; probabilities?: Record<string, unknown> }>;
  const keep = a.keep;
  if (!keep || keep.type !== "noul" || typeof keep.noul !== "number" || !Number.isFinite(keep.noul) || keep.noul < 0 || keep.noul > 1) {
    throw new Error("Laya answer \"keep\" is missing or invalid");
  }
  const reason = a.reason;
  if (!reason || reason.type !== "choice" || typeof reason.choice !== "string" || !(reason.choice in CATEGORIES)) {
    throw new Error("Laya answer \"reason\" is missing or invalid");
  }
  const p = reason.probabilities?.[reason.choice];
  const reasonP = typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1 ? p : 0;
  return { checkpoint, experimental, keepP: keep.noul, reason: reason.choice, reasonP, answers: a as Record<string, unknown> };
}

export interface LayaClientOptions {
  url: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface LayaHealth {
  checkpoint: string;
  contract_hash: string;
  experimental: boolean;
}

async function call(path: string, opts: LayaClientOptions, init?: RequestInit): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.url.replace(/\/$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
  if (!res.ok) throw new Error(`Laya HTTP ${res.status} on ${path}`);
  return res.json();
}

export async function layaHealth(opts: LayaClientOptions): Promise<LayaHealth> {
  const h = (await call("/health", opts)) as Partial<LayaHealth>;
  if (typeof h.checkpoint !== "string" || typeof h.contract_hash !== "string") throw new Error("Laya /health response invalid");
  return { checkpoint: h.checkpoint, contract_hash: h.contract_hash, experimental: Boolean(h.experimental) };
}

export async function layaEvaluateBatch(
  articles: { id: string; title: string; summary: string | null }[],
  opts: LayaClientOptions,
): Promise<{ checkpoint: string; experimental: boolean; results: Array<{ id: string; answer: LayaAnswer } | { id: string; error: string }> }> {
  const body = {
    states: articles.map((a) => buildState({ title: a.title, summary: a.summary })),
    questions: LAYA_QUESTIONS,
  };
  const r = (await call("/v1/systemone/batch", opts, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as { model?: unknown; experimental?: unknown; results?: Array<{ answers?: unknown }> };
  if (typeof r.model !== "string" || !Array.isArray(r.results) || r.results.length !== articles.length) {
    throw new Error("Laya batch response invalid");
  }
  const checkpoint = r.model;
  const experimental = Boolean(r.experimental);
  return {
    checkpoint,
    experimental,
    results: articles.map((a, i) => {
      try {
        return { id: a.id, answer: parseLayaAnswers(r.results![i]?.answers, checkpoint, experimental) };
      } catch (err) {
        return { id: a.id, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  };
}
