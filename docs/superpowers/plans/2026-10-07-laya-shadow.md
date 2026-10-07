# Laya Shadow Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Train Laya on our labels on minos, serve it on bergholm.net as a third shadow model, and score it on the held-out cohort, without affecting the live feed.

**Architecture:**
- **TypeScript, in the app:**
  - `src/lib/laya.ts`: the contract and the client
  - `src/lib/laya-export.ts`: pure supervision, splits and balance
  - `scripts/laya-export.ts`: DB to JSONL
  - `src/lib/laya-shadow.ts` plus a scheduler entry: the shadow step, outside `runPipeline`
  - `LayaEvaluation` table
  - a scoreboard Laya row, cohort-only
- **Python, under `laya/` in the repo:**
  - `serve.py`: Jev-compatible wrapper
  - `metrics.py` and `evaluate.py`
  - `train.sh`, `deploy.sh`, `bench.sh`
  - `pyproject.toml`
- **Operations:**
  - minos runs training and deploys.
  - The server runs a pm2 `laya` service from release directories.

**Tech Stack:** Next.js 16.2.1, Prisma 7 + PostgreSQL, Vitest, tsx; Python 3.12 via uv, `laya` (≥0.3.28), FastAPI/uvicorn (`laya[serve]`), pytest; pm2; rsync over SSH.

**Spec:** `docs/superpowers/specs/2026-10-07-laya-shadow-design.md`

## Global Constraints

- Work in the worktree `/Users/tonibergholm/Developer/github/positivenews/.worktrees/laya-shadow` (branch `laya-shadow`). Commits end with `Refs #5`.
- `LAYA_CONTRACT_VERSION = "1"`. Questions are `keep` (noul) and `reason` (choice over the 17 `CATEGORIES` keys, each described as `"<label>: <yes text>"`). State is `buildState({ title, summary })`.
- **Supervision precedence** (first match wins) with target p(keep):

  | # | Source | Target |
  |---|---|---|
  | 1 | Admin authority (gold) | 1 or 0 |
  | 2 | Eligible reader flag | 0.25 |
  | 3 | Jev teacher (`deriveVerdict` at `DEFAULT_THRESHOLDS`) | 0.80 or 0.20 |
  | 4 | Latest eligible Ollama | 0.70 or 0.30 |
  | 5 | Keyword reject | 0.35 |
  | 6 | Trusted-source article | 0.65 |
  | 7 | Historical Ollama keep (`eligible = false`, reason `historical approval (unverified)`) | 0.60 |

  Weights: `LAYA_WEIGHTS = { gold: 1, flag: 0.5, jev: 0.6, ollama: 0.4, keyword: 0.3, trusted: 0.3, historical: 0.2 }`. The target is `0.5 ± 0.5 × w`.
- `reason` gets a target only for gold admin rejects that have a category (hard one-hot).
- **Splits:**
  - test: cohort articles (`isTestCohort`) with gold only
  - validation: a seeded, stratified 10% of non-cohort rows, by label and source
  - train: the rest
  - other cohort rows are dropped
- **Balance:** by hard-label count. Sources 1–4 are always kept. Historical keeps are sampled up to the trusted count. Keyword rejects are sampled so rejects roughly equal keeps. If the keep share lands outside [0.4, 0.6], set `balance: "infeasible"` with the reason. Cap 20,000 rows per source group. Default seed 7.
- **Serving:**
  - `127.0.0.1:8100`, serial inference, `torch.set_num_threads(2)`, queue limit 4 (503 + `Retry-After`)
  - batch max 8
  - the response `model` field is the checkpoint id, plus `experimental` (bool)
  - `/health` returns `{ checkpoint, contract_hash, experimental, device, rss_mb, in_flight }`
- **Shadow scheduling:**
  - node-cron `7,22,37,52 * * * *`, outside `runPipeline`, with an overlap guard
  - only when `LAYA_URL` is set
  - 2-day window, limit 80, budget 120000 ms, batches of 8
  - request timeout `LAYA_TIMEOUT_MS`, default 30000
- **Release layout on the server:** `~/apps/laya/releases/<id>/`, the `~/apps/laya/current` symlink, the `~/apps/laya/last-good` file. Never print `.env` files.

## Review Focus

1. **The served checkpoint changes mid-run.** Each row's checkpoint comes from the batch response's `model`, never from `/health`. Test in Task 4.
2. **Contract mismatch between app and server.** The shadow run must skip, not store answers to different questions. Test in Task 1/4.
3. **Jev teacher boundary.** Category 0.55 with positive and uplifting at 0.9 must be a keep (Jev's rule). Test in Task 2.
4. **Cohort leakage.** A cohort article with a weak label must appear in no file; one with gold appears only in test. Test in Task 2.
5. **Malformed Laya answers** (probability out of range, unknown reason) are not stored. Test in Task 1.

---

### Task 1: Laya contract and client

**Files:** Create `src/lib/laya.ts`, `src/lib/laya.test.ts`.

**Produces:**
- `LAYA_CONTRACT_VERSION`
- `LAYA_QUESTIONS`
- `layaContract(): LayaContract`
- `contractHash(): string`
- `interface LayaAnswer { checkpoint: string; experimental: boolean; keepP: number; reason: string; reasonP: number; answers: Record<string, unknown> }`
- `parseLayaAnswers(answers: unknown, checkpoint: string, experimental: boolean): LayaAnswer`, which throws on invalid input
- `interface LayaHealth { checkpoint: string; contract_hash: string; experimental: boolean }`
- `layaHealth(opts: LayaClientOptions): Promise<LayaHealth>`
- `layaEvaluateBatch(articles: { id: string; title: string; summary: string | null }[], opts: LayaClientOptions): Promise<{ checkpoint: string; experimental: boolean; results: Array<{ id: string; answer: LayaAnswer } | { id: string; error: string }> }>`
- `interface LayaClientOptions { url: string; timeoutMs: number; fetchImpl?: typeof fetch }`

- [ ] **Step 1: Write the failing tests (`src/lib/laya.test.ts`)**

```ts
import { describe, expect, it, vi } from "vitest";
import { CATEGORIES } from "./jev";
import { contractHash, LAYA_QUESTIONS, layaContract, layaEvaluateBatch, layaHealth, parseLayaAnswers } from "./laya";

const okAnswers = {
  keep: { type: "noul", noul: 0.8 },
  reason: { type: "choice", choice: "cat_war", confidence: 0.4, probabilities: { cat_war: 0.6 } },
};

describe("contract", () => {
  it("has keep (noul) and reason (choice over every category)", () => {
    expect(LAYA_QUESTIONS.keep.type).toBe("noul");
    expect(LAYA_QUESTIONS.reason.type).toBe("choice");
    expect(Object.keys((LAYA_QUESTIONS.reason as { criteria: Record<string, string> }).criteria)).toEqual(Object.keys(CATEGORIES));
  });
  it("hash is stable 64-hex and covers the questions", () => {
    expect(contractHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(contractHash()).toBe(contractHash());
    expect(layaContract().version).toBe("1");
  });
});

describe("parseLayaAnswers", () => {
  it("extracts keepP, reason and reasonP", () => {
    expect(parseLayaAnswers(okAnswers, "ck1", false)).toMatchObject({ checkpoint: "ck1", keepP: 0.8, reason: "cat_war", reasonP: 0.6, experimental: false });
  });
  it("rejects out-of-range keep, unknown reason, wrong types", () => {
    expect(() => parseLayaAnswers({ ...okAnswers, keep: { type: "noul", noul: 1.2 } }, "c", false)).toThrow(/keep/);
    expect(() => parseLayaAnswers({ ...okAnswers, reason: { type: "choice", choice: "cat_nope", probabilities: {} } }, "c", false)).toThrow(/reason/);
    expect(() => parseLayaAnswers({ keep: okAnswers.keep }, "c", false)).toThrow(/reason/);
  });
});

function fakeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response);
}

describe("client", () => {
  it("health returns contract hash", async () => {
    const f = fakeFetch({ checkpoint: "ck", contract_hash: "h", experimental: true });
    expect(await layaHealth({ url: "http://x", timeoutMs: 1000, fetchImpl: f })).toEqual({ checkpoint: "ck", contract_hash: "h", experimental: true });
  });
  it("batch takes the checkpoint from the response and isolates bad answers", async () => {
    const f = fakeFetch({ model: "ck-resp", experimental: false, results: [{ answers: okAnswers }, { answers: { keep: { type: "noul", noul: 5 } } }] });
    const r = await layaEvaluateBatch(
      [{ id: "a", title: "A", summary: null }, { id: "b", title: "B", summary: "S" }],
      { url: "http://x", timeoutMs: 1000, fetchImpl: f },
    );
    expect(r.checkpoint).toBe("ck-resp");
    expect(r.results[0]).toMatchObject({ id: "a", answer: { keepP: 0.8, checkpoint: "ck-resp" } });
    expect(r.results[1]).toMatchObject({ id: "b" });
    expect("error" in r.results[1]).toBe(true);
    const sent = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.states).toEqual([{ title: "A" }, { title: "B", summary: "S" }]);
    expect(Object.keys(sent.questions)).toEqual(["keep", "reason"]);
  });
  it("throws on HTTP errors (e.g. 503)", async () => {
    await expect(layaEvaluateBatch([{ id: "a", title: "A", summary: null }], { url: "http://x", timeoutMs: 1000, fetchImpl: fakeFetch({}, 503) })).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test src/lib/laya.test.ts`.

- [ ] **Step 3: Implement `src/lib/laya.ts`**

```ts
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
```

- [ ] **Step 4: Verify and commit.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint`, then commit with the message `feat(laya): contract and client` followed by `Refs #5`.

---

### Task 2: Supervision, splits and balance (pure)

**Files:** Create `src/lib/laya-export.ts`, `src/lib/laya-export.test.ts`.

**Consumes:**
- `currentAdminAuthority`, `isTestCohort`, `LabelEventLike` from `labels.ts`
- `buildState`, `deriveVerdict`, `DEFAULT_THRESHOLDS`, `CATEGORIES` from `jev.ts`
- `LAYA_QUESTIONS`, `contractHash` from `laya.ts`

**Produces:**
- `LAYA_WEIGHTS`
- `type SupervisionSource = "gold" | "flag" | "jev" | "ollama" | "keyword" | "trusted" | "historical"`
- `interface ArticleSignals { id: string; title: string; summary: string | null; language: string; trusted: boolean; events: Array<LabelEventLike & { reason: string | null }>; jev: { positiveP: number; upliftingP: number; topCategory: string; topCategoryP: number } | null }`
- `interface Supervision { label: "keep" | "reject"; p: number; source: SupervisionSource; category: string | null }`
- `supervise(a: ArticleSignals): Supervision | null`
- `interface LayaRow { id: string; state: Record<string, string>; language: string; questions: typeof LAYA_QUESTIONS; gold: Record<string, { probabilities: Record<string, number> }>; source: SupervisionSource; label: "keep" | "reject" }`
- `toRow(a: ArticleSignals, s: Supervision): LayaRow`
- `interface SplitResult { train: LayaRow[]; val: LayaRow[]; test: LayaRow[]; balance: { status: "ok" | "infeasible"; reason: string | null; keepRows: number; rejectRows: number; meanTarget: number } }`
- `buildSplits(articles: ArticleSignals[], seed: number): SplitResult`
- `seededShuffle<T>(xs: T[], seed: number, salt: string): T[]`

- [ ] **Step 1: Write the failing tests (`src/lib/laya-export.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { isTestCohort, type LabelEventLike } from "./labels";
import { buildSplits, LAYA_WEIGHTS, seededShuffle, supervise, toRow, type ArticleSignals } from "./laya-export";

let seq = 0;
type Ev = LabelEventLike & { reason: string | null };
const ev = (p: Partial<Ev>): Ev => ({ id: `e${++seq}`, source: "ollama", verdict: "keep", category: null, eligible: true, bucket: null, retractsId: null, createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)), reason: null, ...p });
function idInCohort(want: boolean, from = 0): string {
  for (let i = from; i < 100000; i++) if (isTestCohort(`x${i}`) === want) return `x${i}`;
  throw new Error("no id");
}
const art = (p: Partial<ArticleSignals>): ArticleSignals => ({ id: idInCohort(false, seq++ * 13), title: "T", summary: "S", language: "fi", trusted: false, events: [], jev: null, ...p });
const JEV_KEEP = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.55 };
const JEV_REJECT = { positiveP: 0.1, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.2 };

describe("supervise precedence", () => {
  it("gold beats everything, with category", () => {
    const s = supervise(art({ events: [ev({ source: "reader_flag", verdict: "reject" }), ev({ source: "admin", verdict: "reject", category: "cat_sports" })], jev: JEV_KEEP }));
    expect(s).toEqual({ label: "reject", p: 0, source: "gold", category: "cat_sports" });
  });
  it("flags beat the Jev teacher", () => {
    expect(supervise(art({ events: [ev({ source: "reader_flag", verdict: "reject" })], jev: JEV_KEEP }))).toMatchObject({ source: "flag", label: "reject", p: 0.25 });
  });
  it("Jev teacher uses Jev's own rule (category 0.55 with 0.9/0.9 is keep)", () => {
    expect(supervise(art({ jev: JEV_KEEP }))).toMatchObject({ source: "jev", label: "keep", p: 0.8 });
    expect(supervise(art({ jev: JEV_REJECT }))).toMatchObject({ source: "jev", label: "reject", p: expect.closeTo(0.2) });
  });
  it("eligible Ollama (live or backfilled) next, then keyword, trusted, historical", () => {
    expect(supervise(art({ events: [ev({ source: "ollama", verdict: "reject" }), ev({ source: "keyword", verdict: "reject" })] }))).toMatchObject({ source: "ollama", p: expect.closeTo(0.3) });
    expect(supervise(art({ events: [ev({ source: "keyword", verdict: "reject" })], trusted: true }))).toMatchObject({ source: "keyword", p: expect.closeTo(0.35) });
    expect(supervise(art({ trusted: true }))).toMatchObject({ source: "trusted", label: "keep", p: expect.closeTo(0.65) });
    expect(supervise(art({ events: [ev({ source: "ollama", verdict: "keep", eligible: false, reason: "historical approval (unverified)" })] }))).toMatchObject({ source: "historical", p: expect.closeTo(0.6) });
  });
  it("ignores ineligible non-historical events and returns null without signal", () => {
    expect(supervise(art({ events: [ev({ source: "ollama", verdict: "keep", eligible: false, reason: "LLM unavailable" })] }))).toBeNull();
    expect(supervise(art({}))).toBeNull();
  });
  it("weights map to targets", () => {
    expect(LAYA_WEIGHTS).toEqual({ gold: 1, flag: 0.5, jev: 0.6, ollama: 0.4, keyword: 0.3, trusted: 0.3, historical: 0.2 });
  });
});

describe("toRow", () => {
  it("keep probabilities and reason only for categorised gold rejects", () => {
    const a = art({});
    expect(toRow(a, { label: "reject", p: 0, source: "gold", category: "cat_war" }).gold).toEqual({
      keep: { probabilities: { true: 0, false: 1 } },
      reason: { probabilities: { cat_war: 1 } },
    });
    expect(toRow(a, { label: "reject", p: 0.3, source: "ollama", category: null }).gold).toEqual({ keep: { probabilities: { true: 0.3, false: 0.7 } } });
    expect(toRow(a, { label: "reject", p: 0, source: "gold", category: null }).gold.reason).toBeUndefined();
  });
});

describe("buildSplits", () => {
  it("never leaks cohort articles; test holds only gold cohort rows", () => {
    const cohortWeak = art({ id: idInCohort(true), events: [ev({ source: "keyword", verdict: "reject" })] });
    const cohortGold = art({ id: idInCohort(true, 5000), events: [ev({ source: "admin", verdict: "keep" })] });
    const r = buildSplits([cohortWeak, cohortGold, art({ trusted: true }), art({ events: [ev({ source: "keyword", verdict: "reject" })] })], 7);
    const all = [...r.train, ...r.val].map((x) => x.id);
    expect(all).not.toContain(cohortWeak.id);
    expect(all).not.toContain(cohortGold.id);
    expect(r.test.map((x) => x.id)).toEqual([cohortGold.id]);
  });
  it("balances by hard count, keeps protected sources, samples historical to trusted count", () => {
    const trusted = Array.from({ length: 30 }, () => art({ trusted: true }));
    const hist = Array.from({ length: 100 }, () => art({ events: [ev({ source: "ollama", verdict: "keep", eligible: false, reason: "historical approval (unverified)" })] }));
    const kw = Array.from({ length: 500 }, () => art({ events: [ev({ source: "keyword", verdict: "reject" })] }));
    const ol = Array.from({ length: 10 }, () => art({ events: [ev({ source: "ollama", verdict: "reject" })] }));
    const r = buildSplits([...trusted, ...hist, ...kw, ...ol], 7);
    const rows = [...r.train, ...r.val];
    const count = (src: string) => rows.filter((x) => x.source === src).length;
    expect(count("trusted")).toBe(30);
    expect(count("historical")).toBe(30);
    expect(count("ollama")).toBe(10);
    expect(r.balance.keepRows).toBe(60);
    expect(r.balance.rejectRows).toBe(60);
    expect(r.balance.status).toBe("ok");
  });
  it("reports infeasible balance", () => {
    const r = buildSplits(Array.from({ length: 20 }, () => art({ events: [ev({ source: "ollama", verdict: "reject" })] })), 7);
    expect(r.balance.status).toBe("infeasible");
    expect(r.balance.reason).toMatch(/keep/);
  });
  it("validation is ~10%, seeded and stable", () => {
    const xs = Array.from({ length: 200 }, (_, i) => art({ trusted: i % 2 === 0, events: i % 2 ? [ev({ source: "ollama", verdict: "reject" })] : [] }));
    const a = buildSplits(xs, 7), b = buildSplits(xs, 7);
    expect(a.val.map((x) => x.id)).toEqual(b.val.map((x) => x.id));
    expect(a.val.length).toBeGreaterThanOrEqual(18);
    expect(a.val.length).toBeLessThanOrEqual(22);
  });
  it("seededShuffle is deterministic and seed-sensitive", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(seededShuffle(xs, 1, "a")).toEqual(seededShuffle(xs, 1, "a"));
    expect(seededShuffle(xs, 1, "a")).not.toEqual(seededShuffle(xs, 2, "a"));
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement `src/lib/laya-export.ts`**

```ts
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
  const ollama = eligible.filter((e) => e.source === "ollama" && (e.verdict === "keep" || e.verdict === "reject")).sort(byTime).at(-1);
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

export function seededShuffle<T>(xs: T[], seed: number, salt: string): T[] {
  const key = (i: number) => createHash("sha256").update(`${seed}:${salt}:${i}`).digest("hex");
  return xs.map((x, i) => ({ x, k: key(i) })).sort((a, b) => (a.k < b.k ? -1 : 1)).map((e) => e.x);
}

export interface SplitResult {
  train: LayaRow[];
  val: LayaRow[];
  test: LayaRow[];
  balance: { status: "ok" | "infeasible"; reason: string | null; keepRows: number; rejectRows: number; meanTarget: number };
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

  const cap = (rows: LayaRow[], n: number, salt: string) => seededShuffle(rows, seed, salt).slice(0, Math.min(n, GROUP_CAP));
  const kept: LayaRow[] = PROTECTED.flatMap((src) => cap(groups[src], Infinity, src));
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

  // Stratified validation split by (label, source).
  const strata = new Map<string, LayaRow[]>();
  for (const r of rows) strata.set(`${r.label}:${r.source}`, [...(strata.get(`${r.label}:${r.source}`) ?? []), r]);
  const val: LayaRow[] = [];
  const train: LayaRow[] = [];
  for (const [key, list] of [...strata.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const shuffled = seededShuffle(list, seed, `val:${key}`);
    const nVal = Math.round(list.length * VAL_SHARE);
    val.push(...shuffled.slice(0, nVal));
    train.push(...shuffled.slice(nVal));
  }

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
    },
  };
}
```

- [ ] **Step 4: Verify and commit.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint`, then commit with the message `feat(laya): supervision, splits and balance` followed by `Refs #5`.

---

### Task 3: Export script

**Files:**
- Create `scripts/laya-export.ts`.
- Modify `package.json` to add `"laya:export": "tsx scripts/laya-export.ts"`.

**Consumes:**
- `buildSplits`, `LAYA_WEIGHTS` from Task 2
- `layaContract`, `contractHash` from Task 1
- `QUESTION_SET` from `jev.ts`
- `FEED_SOURCES`
- `scripts/load-env.ts`

- [ ] **Step 1: Implement `scripts/laya-export.ts`**

```ts
/**
 * Writes Laya training data: train/val/test JSONL, test-compare.jsonl,
 * contract.json, manifest.json and train-ids.txt into --out <dir>.
 * Snapshot: only events created before the start time.
 *
 * Usage: pnpm laya:export --out <dir> [--seed 7] [--distill]
 */
import "./load-env";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { DEFAULT_THRESHOLDS, deriveVerdict, QUESTION_SET } from "../src/lib/jev";
import { contractHash, layaContract } from "../src/lib/laya";
import { buildSplits, LAYA_WEIGHTS, type ArticleSignals, type LayaRow } from "../src/lib/laya-export";
import { FEED_SOURCES } from "../src/config/sources";

const BATCH = 1000;
const trusted = new Set(FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const out = arg("out");
  if (!out) {
    console.error("Usage: pnpm laya:export --out <dir> [--seed 7] [--distill]");
    process.exit(1);
  }
  if (process.argv.includes("--distill")) {
    console.error("[laya-export] --distill is phase 2 and not implemented yet");
    process.exit(1);
  }
  const seed = Number.parseInt(arg("seed") ?? "7", 10);
  const cutoff = new Date();
  const articles: ArticleSignals[] = [];
  const compareInfo = new Map<string, { ollama: string | null; jev: { keep: boolean; model: string; questionSet: string } | null }>();
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.article.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      take: BATCH,
      select: {
        id: true,
        title: true,
        summary: true,
        source: { select: { url: true, language: true } },
        labelEvents: {
          where: { createdAt: { lt: cutoff } },
          select: { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true, reason: true },
        },
        jevEvaluations: { where: { questionSet: QUESTION_SET, createdAt: { lt: cutoff } }, select: { positiveP: true, upliftingP: true, topCategory: true, topCategoryP: true, model: true }, take: 1 },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    for (const a of batch) {
      const jev = a.jevEvaluations[0] ?? null;
      articles.push({ id: a.id, title: a.title, summary: a.summary, language: a.source.language, trusted: trusted.has(a.source.url), events: a.labelEvents, jev });
      const ollama = a.labelEvents.filter((e) => e.source === "ollama" && e.eligible).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
      compareInfo.set(a.id, {
        ollama: ollama ? ollama.verdict : null,
        jev: jev ? { keep: deriveVerdict(jev, DEFAULT_THRESHOLDS).keep, model: jev.model, questionSet: QUESTION_SET } : null,
      });
    }
  }

  const r = buildSplits(articles, seed);
  mkdirSync(out, { recursive: true });
  const jsonl = (rows: object[]) => rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : "");
  const strip = (row: LayaRow) => ({ id: row.id, state: row.state, language: row.language, questions: row.questions, gold: row.gold });
  const files: Record<string, string> = {
    "train.jsonl": jsonl(r.train.map(strip)),
    "val.jsonl": jsonl(r.val.map(strip)),
    "test.jsonl": jsonl(r.test.map(strip)),
    "test-compare.jsonl": jsonl(r.test.map((row) => ({ id: row.id, language: row.language, label: row.label, ...compareInfo.get(row.id) }))),
    "contract.json": JSON.stringify({ ...layaContract(), hash: contractHash() }, null, 2),
    "train-ids.txt": r.train.map((x) => x.id).join("\n") + "\n",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);

  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const count = (rows: LayaRow[], key: "source" | "label" | "language") => rows.reduce<Record<string, number>>((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {});
  const stamp = cutoff.toISOString().replace(/[-:]/g, "").slice(0, 13);
  const exportId = `${stamp}-${sha(files["train-ids.txt"]).slice(0, 6)}`;
  const manifest = {
    exportId,
    cutoff: cutoff.toISOString(),
    seed,
    questionSet: QUESTION_SET,
    contractHash: contractHash(),
    weights: LAYA_WEIGHTS,
    balance: r.balance,
    counts: Object.fromEntries((["train", "val", "test"] as const).map((k) => [k, { total: r[k].length, bySource: count(r[k], "source"), byLabel: count(r[k], "label"), byLanguage: count(r[k], "language") }])),
    files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha(c)])),
  };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[laya-export] ${exportId} → ${out}`);
  console.log(JSON.stringify({ balance: r.balance, counts: manifest.counts }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[laya-export] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 2: Verify locally.** Run `pnpm laya:export --out /tmp/laya-exp`. Expect a summary with counts, files that exist, and no cohort ids in `train-ids.txt`. Check the last point with a node one-liner that calls `isTestCohort` on each id, run through `pnpm exec tsx -e`. Then run `pnpm exec tsc --noEmit && pnpm lint`.

- [ ] **Step 3: Commit** with the message `feat(laya): training export` followed by `Refs #5`.

---

### Task 4: LayaEvaluation, shadow step, scheduler, backfill, cleanup

**Files:**
- Modify `prisma/schema.prisma`, `src/lib/scheduler.ts`, `scripts/cleanup.ts`, `package.json`.
- Create the migration, `src/lib/laya-shadow.ts`, `src/lib/laya-shadow.test.ts` and `scripts/laya-backfill.ts`.

**Consumes:**
- `layaHealth`, `layaEvaluateBatch`, `contractHash` from Task 1
- `isTestCohort`
- `isUniqueViolation` from `jev-pool.ts`
- `FEED_SOURCES`

**Produces:**
- `interface LayaShadowDeps { health: typeof layaHealth; evaluate: typeof layaEvaluateBatch; loadCandidates: (since: Date, limit: number) => Promise<{ id: string; title: string; summary: string | null }[]>; store: (row: LayaStoreRow) => Promise<"stored" | "duplicate">; now: () => number }`
- `runLayaShadow(opts: { url: string; timeoutMs: number; since: Date; limit: number; budgetMs: number; batchSize?: number }, deps: LayaShadowDeps): Promise<{ status: "skipped" | "done"; reason?: string; evaluated: number; failed: number }>`
- `layaShadowEvaluate(opts)`: the DB-wired wrapper
- `isLayaConfigured()`

- [ ] **Step 1: Add the schema.** Add `layaEvaluations LayaEvaluation[]` to `Article` and append:

```prisma
model LayaEvaluation {
  id           String   @id @default(cuid())
  article      Article  @relation(fields: [articleId], references: [id], onDelete: Cascade)
  articleId    String
  checkpoint   String
  experimental Boolean  @default(false)
  keepP        Float
  reason       String
  reasonP      Float
  answers      Json
  latencyMs    Int
  createdAt    DateTime @default(now())

  @@unique([articleId, checkpoint])
  @@index([checkpoint, createdAt])
}
```

Then run `pnpm prisma migrate dev --name laya_evaluation` against the local `pn-jev-pg` database, using `DATABASE_URL` from the worktree `.env`. Confirm the migration is additive.

- [ ] **Step 2: Write the failing tests (`src/lib/laya-shadow.test.ts`).** They use injected deps, with no DB and no network.

```ts
import { describe, expect, it, vi } from "vitest";
import { contractHash } from "./laya";
import { runLayaShadow, type LayaShadowDeps } from "./laya-shadow";

const art = (i: number) => ({ id: `a${i}`, title: `T${i}`, summary: null });
const answer = (checkpoint: string) => ({ checkpoint, experimental: false, keepP: 0.7, reason: "cat_war", reasonP: 0.5, answers: {} });

function deps(over: Partial<LayaShadowDeps> = {}): LayaShadowDeps & { stored: unknown[] } {
  const stored: unknown[] = [];
  return {
    stored,
    health: vi.fn().mockResolvedValue({ checkpoint: "ck1", contract_hash: contractHash(), experimental: false }),
    evaluate: vi.fn().mockImplementation(async (arts: { id: string }[]) => ({ checkpoint: "ck-resp", experimental: false, results: arts.map((a) => ({ id: a.id, answer: answer("ck-resp") })) })),
    loadCandidates: vi.fn().mockResolvedValue(Array.from({ length: 20 }, (_, i) => art(i))),
    store: vi.fn().mockImplementation(async (r) => { stored.push(r); return "stored"; }),
    now: () => 0,
    ...over,
  };
}
const OPTS = { url: "http://laya", timeoutMs: 1000, since: new Date(0), limit: 80, budgetMs: 120000, batchSize: 8 };

describe("runLayaShadow", () => {
  it("skips on contract mismatch without evaluating", async () => {
    const d = deps({ health: vi.fn().mockResolvedValue({ checkpoint: "ck", contract_hash: "different", experimental: false }) });
    const r = await runLayaShadow(OPTS, d);
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/contract/) });
    expect(d.evaluate).not.toHaveBeenCalled();
  });
  it("evaluates in batches of 8 and stores the checkpoint from the response", async () => {
    const d = deps();
    const r = await runLayaShadow(OPTS, d);
    expect(d.evaluate).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ status: "done", evaluated: 20, failed: 0 });
    expect((d.stored[0] as { checkpoint: string }).checkpoint).toBe("ck-resp");
  });
  it("counts per-article errors and stops at the budget", async () => {
    let t = 0;
    const d = deps({
      now: () => t,
      evaluate: vi.fn().mockImplementation(async (arts: { id: string }[]) => { t += 70_000; return { checkpoint: "ck", experimental: false, results: arts.map((a, i) => (i === 0 ? { id: a.id, error: "bad" } : { id: a.id, answer: answer("ck") })) }; }),
    });
    const r = await runLayaShadow(OPTS, d);
    expect(d.evaluate).toHaveBeenCalledTimes(2);
    expect(r.failed).toBe(2);
    expect(r.evaluated).toBe(14);
  });
  it("skips when health fails or the batch throws, without throwing", async () => {
    expect((await runLayaShadow(OPTS, deps({ health: vi.fn().mockRejectedValue(new Error("down")) }))).status).toBe("skipped");
    const r = await runLayaShadow(OPTS, deps({ evaluate: vi.fn().mockRejectedValue(new Error("Laya HTTP 503")) }));
    expect(r).toMatchObject({ status: "done", evaluated: 0 });
  });
  it("treats duplicates as not failed", async () => {
    const r = await runLayaShadow(OPTS, deps({ store: vi.fn().mockResolvedValue("duplicate") }));
    expect(r.failed).toBe(0);
  });
});
```

- [ ] **Step 3: Implement `src/lib/laya-shadow.ts`**

```ts
/**
 * Laya shadow evaluation. Runs on its own schedule (not inside runPipeline),
 * stores answers per article and checkpoint, never changes feed state.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { contractHash, layaEvaluateBatch, layaHealth } from "./laya";
import { isTestCohort } from "./labels";
import { isUniqueViolation } from "./jev-pool";
import { FEED_SOURCES } from "@/src/config/sources";

export interface LayaStoreRow {
  articleId: string;
  checkpoint: string;
  experimental: boolean;
  keepP: number;
  reason: string;
  reasonP: number;
  answers: Record<string, unknown>;
  latencyMs: number;
}

export interface LayaShadowDeps {
  health: typeof layaHealth;
  evaluate: typeof layaEvaluateBatch;
  loadCandidates: (since: Date, limit: number) => Promise<{ id: string; title: string; summary: string | null }[]>;
  store: (row: LayaStoreRow) => Promise<"stored" | "duplicate">;
  now: () => number;
}

export function isLayaConfigured(): boolean {
  return Boolean(process.env.LAYA_URL);
}

export async function runLayaShadow(
  opts: { url: string; timeoutMs: number; since: Date; limit: number; budgetMs: number; batchSize?: number },
  deps: LayaShadowDeps,
): Promise<{ status: "skipped" | "done"; reason?: string; evaluated: number; failed: number }> {
  const client = { url: opts.url, timeoutMs: opts.timeoutMs };
  try {
    const h = await deps.health(client);
    if (h.contract_hash !== contractHash()) {
      return { status: "skipped", reason: `contract mismatch (server ${h.contract_hash.slice(0, 8)}, app ${contractHash().slice(0, 8)})`, evaluated: 0, failed: 0 };
    }
  } catch (err) {
    return { status: "skipped", reason: `health failed: ${err instanceof Error ? err.message : err}`, evaluated: 0, failed: 0 };
  }

  const candidates = await deps.loadCandidates(opts.since, opts.limit);
  const size = opts.batchSize ?? 8;
  const deadline = deps.now() + opts.budgetMs;
  let evaluated = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i += size) {
    if (deps.now() >= deadline) break;
    const batch = candidates.slice(i, i + size);
    const started = deps.now();
    let res;
    try {
      res = await deps.evaluate(batch, client);
    } catch (err) {
      console.error(`[laya] batch failed: ${err instanceof Error ? err.message : err}`);
      break; // server unhealthy (503/timeout): stop this run, retry next schedule
    }
    const latencyMs = Math.round((deps.now() - started) / Math.max(batch.length, 1));
    for (const r of res.results) {
      if ("error" in r) {
        failed++;
        console.error(`[laya] ${r.id}: ${r.error}`);
        continue;
      }
      const { answer } = r;
      const s = await deps.store({ articleId: r.id, checkpoint: answer.checkpoint, experimental: answer.experimental, keepP: answer.keepP, reason: answer.reason, reasonP: answer.reasonP, answers: answer.answers, latencyMs });
      if (s === "stored") evaluated++;
    }
  }
  return { status: "done", evaluated, failed };
}

const trustedUrls = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url);

export async function layaShadowEvaluate(opts: { since: Date; limit: number; budgetMs: number }) {
  const url = process.env.LAYA_URL;
  if (!url) return { status: "skipped" as const, reason: "LAYA_URL unset", evaluated: 0, failed: 0 };
  const timeoutMs = Number.parseInt(process.env.LAYA_TIMEOUT_MS ?? "30000", 10) || 30000;
  let currentCheckpoint: string | null = null;

  const result = await runLayaShadow({ url, timeoutMs, ...opts }, {
    health: async (c) => {
      const h = await layaHealth(c);
      currentCheckpoint = h.checkpoint;
      return h;
    },
    evaluate: layaEvaluateBatch,
    now: () => Date.now(),
    loadCandidates: async (since, limit) => {
      const notDone = currentCheckpoint ? { layaEvaluations: { none: { checkpoint: currentCheckpoint } } } : {};
      const recent = await prisma.article.findMany({
        where: { createdAt: { gte: since }, source: { url: { notIn: trustedUrls } }, ...notDone },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, title: true, summary: true },
      });
      const cohortPool = await prisma.article.findMany({
        where: { labelEvents: { some: { source: "admin" } }, ...notDone },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, title: true, summary: true },
      });
      const cohort = cohortPool.filter((a) => isTestCohort(a.id));
      const seen = new Set<string>();
      return [...cohort, ...recent].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))).slice(0, limit);
    },
    store: async (row) => {
      try {
        await prisma.layaEvaluation.create({ data: { ...row, answers: row.answers as Prisma.InputJsonValue } });
        return "stored";
      } catch (err) {
        if (isUniqueViolation(err)) return "duplicate";
        throw err;
      }
    },
  });
  if (result.status === "skipped") console.warn(`[laya] shadow skipped: ${result.reason}`);
  else console.log(`[laya] shadow done — ${result.evaluated} evaluated, ${result.failed} failed`);
  return result;
}
```

- [ ] **Step 4: Scheduler.** In `src/lib/scheduler.ts`, add after the pipeline schedule:

```ts
  // Laya shadow evaluation: own schedule so it never extends the pipeline lock.
  let layaRunning = false;
  cron.schedule("7,22,37,52 * * * *", async () => {
    if (!isLayaConfigured() || layaRunning) return;
    layaRunning = true;
    try {
      await layaShadowEvaluate({ since: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), limit: 80, budgetMs: 120_000 });
    } catch (error) {
      console.error("[scheduler] Laya shadow failed:", error);
    } finally {
      layaRunning = false;
    }
  });
```

Add the import: `import { isLayaConfigured, layaShadowEvaluate } from "./laya-shadow";`.

- [ ] **Step 5: Backfill script, cleanup and package scripts.**
  - **`scripts/laya-backfill.ts`:** `pnpm laya:backfill [--days 30] [--limit 2000]`. It imports `./load-env`, calls `layaShadowEvaluate({ since, limit, budgetMs: 60 * 60 * 1000 })`, prints the result and disconnects. Validate the arguments as `jev-backfill.ts` does.
  - **`scripts/cleanup.ts`:** add `AND NOT EXISTS (SELECT 1 FROM "LayaEvaluation" y WHERE y."articleId" = a.id)` to the locking `SELECT`. Add `layaEvaluations: { none: {} }` to the dry-run `count` and the `deleteMany` re-check, and mention Laya evaluations in the header comment.
  - **`package.json`:** add `"laya:backfill": "tsx scripts/laya-backfill.ts"`.

- [ ] **Step 6: Verify and commit.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build`, then `npx tsx scripts/cleanup.ts --dry-run` against the local database. Commit with the message `feat(laya): shadow evaluation on its own schedule` followed by `Refs #5`.

---

### Task 5: Scoreboard Laya row (cohort only)

**Files:**
- Modify `src/lib/scoreboard.ts`, `src/lib/scoreboard.test.ts`, `src/lib/scoreboard-data.ts`, `app/admin/jev/page.tsx` and `app/admin/jev/JevReportView.tsx`.

**Produces:**
- `ScoreRow.laya: "keep" | "reject" | null`
- `ScoreTable.laya: Record<Slice, BinaryScore>`
- `loadScoreRows()` now returns `{ rows: ScoreRow[]; laya: { checkpoint: string; experimental: boolean } | null }`. Update every caller.

- [ ] **Step 1: Tests.**
  - In `scoreboard.test.ts`, every `row()` defaults to `laya: null`.
  - Add a test: Laya is scored like Jev, as a binary source (n, agree, rejectPrecision, wronglyHidden), in both tables.
- [ ] **Step 2: Implement.**
  - **`scoreboard.ts`:** add `laya` to `ScoreRow` and `ScoreTable`, and include `"laya"` in the binary-source loops alongside `"ollama"` and `"jev"`.
  - **`scoreboard-data.ts`:**
    - Find the current checkpoint: `prisma.layaEvaluation.findFirst({ orderBy: { createdAt: "desc" }, select: { checkpoint: true, experimental: true } })`.
    - Include `layaEvaluations: { where: { checkpoint }, take: 1, select: { keepP: true } }` when a checkpoint exists.
    - Set `laya` to `keepP >= 0.5 ? "keep" : "reject"`, or `null`.
- [ ] **Step 3: View.**
  - **`JevReportView.tsx`:** add a "Laya" row to the **Random cohort** table only, using the cohort `laya` scores. Under that table, add a muted caption: `Laya checkpoint <id>[ (experimental)] — evaluated <n> of <labels> cohort labels`, where n is `cohort.laya.all.n`.
  - When `laya` is null, show "Laya: not running yet" instead.
  - Don't add Laya to the targeted table.
- [ ] **Step 4: Verify and commit.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build`, then commit with the message `feat(laya): scoreboard row on the held-out cohort` followed by `Refs #5`.

---

### Task 6: Python training, evaluation, serving and deploy (`laya/`)

**Files:**
- Create `laya/pyproject.toml`, `laya/metrics.py`, `laya/test_metrics.py`, `laya/evaluate.py`, `laya/serve.py`, `laya/train.sh`, `laya/deploy.sh`, `laya/bench.sh` and `laya/README.md`.
- Modify `.gitignore` to add `laya/.venv/` and `laya/data/`.

Run Python tests and the end-to-end check on minos (`ssh toni@minos.taila2b943.ts.net`).

Before writing `serve.py` and `evaluate.py`, read the installed laya source on minos and match its actual API:
- `laya/router.py`: the `Router(models=...)`, `predict` and `predict_batch` signatures, and the result shape
- `laya/train_cli.py`: the flags

If any call below differs, adapt it and note the difference in the report.

- [ ] **Step 1: `laya/pyproject.toml`**

```toml
[project]
name = "positivenews-laya"
version = "0.1.0"
requires-python = ">=3.12,<3.13"
dependencies = ["laya[serve]>=0.3.28,<0.4", "pytest>=8"]

[tool.uv]
package = false
```

- [ ] **Step 2: `laya/metrics.py` and `laya/test_metrics.py`.** These are pure functions with no torch.

```python
"""Evaluation metrics for the keep question (pure, no model)."""
from __future__ import annotations
from typing import Iterable

def _hard(p: float) -> str:
    return "keep" if p >= 0.5 else "reject"

def keep_metrics(preds: list[float], labels: list[str]) -> dict:
    n = len(preds)
    if n == 0:
        return {"n": 0, "accuracy": None, "balanced_accuracy": None, "reject_precision": None,
                "reject_recall": None, "ece": None, "majority_baseline": None}
    hard = [_hard(p) for p in preds]
    acc = sum(h == l for h, l in zip(hard, labels)) / n
    def recall(cls: str):
        idx = [i for i, l in enumerate(labels) if l == cls]
        return None if not idx else sum(hard[i] == cls for i in idx) / len(idx)
    rk, rr = recall("keep"), recall("reject")
    bal = None if rk is None or rr is None else (rk + rr) / 2
    pred_rej = [i for i, h in enumerate(hard) if h == "reject"]
    rej_prec = None if not pred_rej else sum(labels[i] == "reject" for i in pred_rej) / len(pred_rej)
    majority = max(labels.count("keep"), labels.count("reject")) / n
    return {"n": n, "accuracy": acc, "balanced_accuracy": bal, "reject_precision": rej_prec,
            "reject_recall": rr, "ece": ece(preds, [l == "keep" for l in labels]), "majority_baseline": majority}

def ece(probs: list[float], outcomes: list[bool], bins: int = 10) -> float | None:
    if not probs:
        return None
    total, err = len(probs), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, p in enumerate(probs) if (lo <= p < hi) or (b == bins - 1 and p == 1.0)]
        if idx:
            conf = sum(probs[i] for i in idx) / len(idx)
            freq = sum(outcomes[i] for i in idx) / len(idx)
            err += len(idx) / total * abs(conf - freq)
    return err

def gate(val_new: dict, val_base: dict, n_val: int, n_test: int, margin: float = 0.02) -> str:
    if n_val < 200 or n_test < 50:
        return "experimental"
    b_new, b_base = val_new.get("balanced_accuracy"), val_base.get("balanced_accuracy")
    if b_new is None or b_base is None:
        return "fail"
    majority = val_new.get("majority_baseline") or 0.0
    return "pass" if b_new >= b_base + margin and b_new >= majority + margin else "fail"

def by_language(rows: Iterable[dict], preds: dict[str, float]) -> dict:
    out = {}
    rows = list(rows)
    for lang in ("all", "fi", "en"):
        sel = [r for r in rows if lang == "all" or r["language"] == lang]
        out[lang] = keep_metrics([preds[r["id"]] for r in sel], [r["label"] for r in sel])
    return out
```

`test_metrics.py`:

```python
from metrics import ece, gate, keep_metrics

def test_perfect_and_constant():
    m = keep_metrics([0.9, 0.1, 0.8, 0.2], ["keep", "reject", "keep", "reject"])
    assert m["accuracy"] == 1 and m["balanced_accuracy"] == 1 and m["reject_precision"] == 1
    c = keep_metrics([0.4] * 4, ["keep", "reject", "reject", "reject"])
    assert c["balanced_accuracy"] == 0.5 and c["majority_baseline"] == 0.75

def test_empty():
    assert keep_metrics([], [])["accuracy"] is None and ece([], []) is None

def test_ece_calibrated_is_small():
    assert ece([0.25] * 4, [True, False, False, False]) < 1e-9

def test_gate():
    good = {"balanced_accuracy": 0.8, "majority_baseline": 0.5}
    base = {"balanced_accuracy": 0.6}
    assert gate(good, base, 500, 100) == "pass"
    assert gate({"balanced_accuracy": 0.61, "majority_baseline": 0.5}, base, 500, 100) == "fail"
    assert gate(good, base, 100, 100) == "experimental"
    assert gate(good, base, 500, 10) == "experimental"
```

- [ ] **Step 3: `laya/evaluate.py`**

```python
"""Score a checkpoint (and the untuned base) on val.jsonl and test.jsonl.
Writes report.json and report.md into the checkpoint directory.
Usage: uv run python evaluate.py --data <export-dir> --checkpoint <dir>
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
from laya import Router
from metrics import by_language, gate

BASE = "convaiinnovations/laya-multilingual"

def load(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]

def label_of(row: dict) -> str:
    return "keep" if row["gold"]["keep"]["probabilities"]["true"] >= 0.5 else "reject"

def predict(router: Router, model: str, rows: list[dict]) -> dict[str, float]:
    out = {}
    for r in rows:
        res = router.predict(r["state"], {"keep": r["questions"]["keep"]}, model=model)
        out[r["id"]] = float(res["answers"]["keep"]["noul"])
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--checkpoint", required=True)
    a = ap.parse_args()
    data, ck = Path(a.data), Path(a.checkpoint)
    val = [dict(r, label=label_of(r)) for r in load(data / "val.jsonl")]
    test = [dict(r, label=label_of(r)) for r in load(data / "test.jsonl")]
    router = Router(models={"positivenews": str(ck), "base": BASE})
    report = {"checkpoint": ck.name, "manifest": json.loads((data / "manifest.json").read_text())}
    for name, rows in (("val", val), ("test", test)):
        report[name] = {m: by_language(rows, predict(router, m, rows)) for m in ("positivenews", "base")}
    compare = {c["id"]: c for c in load(data / "test-compare.jsonl")} if (data / "test-compare.jsonl").exists() else {}
    report["test_compare"] = {
        src: {"coverage": sum(1 for r in test if compare.get(r["id"], {}).get(src) is not None),
              "agree": sum(1 for r in test if (v := compare.get(r["id"], {}).get(src)) is not None
                           and (v if isinstance(v, str) else ("keep" if v["keep"] else "reject")) == r["label"])}
        for src in ("ollama", "jev")}
    report["gate"] = gate(report["val"]["positivenews"]["all"], report["val"]["base"]["all"], len(val), len(test))
    report["indicative_only"] = len(test) < 50
    (ck / "report.json").write_text(json.dumps(report, indent=2))
    v, t = report["val"]["positivenews"]["all"], report["test"]["positivenews"]["all"]
    (ck / "report.md").write_text(
        f"# {ck.name}\n\ngate: **{report['gate']}**{' (test set < 50: indicative only)' if report['indicative_only'] else ''}\n\n"
        f"val: n={v['n']} bal_acc={v['balanced_accuracy']} ece={v['ece']} majority={v['majority_baseline']}\n\n"
        f"test: n={t['n']} bal_acc={t['balanced_accuracy']} ece={t['ece']}\n")
    print(ck / "report.md")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: `laya/serve.py`**

```python
"""Jev-compatible Laya server for the positivenews checkpoint.
Serial inference (one at a time), small queue, localhost only.
Run from a release dir: .venv/bin/python serve.py
"""
from __future__ import annotations
import json, os, resource, threading
from pathlib import Path
import torch
import uvicorn
from fastapi import Body, FastAPI, HTTPException
from laya import Router

HERE = Path(__file__).resolve().parent
CONTRACT = json.loads((HERE / "contract.json").read_text())
RELEASE = json.loads((HERE / "release.json").read_text())  # {"checkpoint": id, "experimental": bool}
torch.set_num_threads(int(os.environ.get("LAYA_THREADS", "2")))
router = Router(models={"positivenews": str(HERE / "checkpoint")})
router.predict({"title": "warmup"}, {"keep": CONTRACT["questions"]["keep"]}, model="positivenews")

lock = threading.Lock()
in_flight = 0
in_flight_lock = threading.Lock()
MAX_QUEUE = 4
MAX_BATCH = 8
app = FastAPI()

def _admit():
    global in_flight
    with in_flight_lock:
        if in_flight >= MAX_QUEUE:
            raise HTTPException(status_code=503, detail="busy", headers={"Retry-After": "30"})
        in_flight += 1

def _release():
    global in_flight
    with in_flight_lock:
        in_flight -= 1

def _predict(state, questions):
    with lock:
        return router.predict(state, questions, model="positivenews")["answers"]

@app.get("/health")
def health():
    return {"checkpoint": RELEASE["checkpoint"], "experimental": RELEASE.get("experimental", False),
            "contract_hash": CONTRACT["hash"], "device": "cpu", "in_flight": in_flight,
            "rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)}

# Sync handlers: FastAPI runs them in a threadpool, so /health stays responsive while
# inference holds `lock`. (An async handler calling blocking inference would stall the event loop.)
@app.post("/v1/systemone")
def one(body: dict = Body(...)):
    _admit()
    try:
        answers = _predict(body["state"], body["questions"])
    finally:
        _release()
    return {"model": RELEASE["checkpoint"], "experimental": RELEASE.get("experimental", False), "answers": answers}

@app.post("/v1/systemone/batch")
def batch(body: dict = Body(...)):
    states = body.get("states") or []
    if not isinstance(states, list) or not 1 <= len(states) <= MAX_BATCH:
        raise HTTPException(status_code=422, detail=f"states must be a list of 1..{MAX_BATCH}")
    _admit()
    try:
        results = [{"answers": _predict(s, body["questions"])} for s in states]
    finally:
        _release()
    return {"model": RELEASE["checkpoint"], "experimental": RELEASE.get("experimental", False), "results": results}

if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("LAYA_HOST", "127.0.0.1"), port=int(os.environ.get("LAYA_PORT", "8100")), workers=1)
```

On Linux, `ru_maxrss` is in KB, so dividing by 1024 gives MB (peak RSS).

- [ ] **Step 5: `laya/train.sh`**

```bash
#!/usr/bin/env bash
# Train a Laya checkpoint on minos from a fresh server export.
# Usage: laya/train.sh [--timing] [--epochs N] [--micro-batch M] [--grad-accum G]
set -euo pipefail
cd "$(dirname "$0")"
HOME_DIR="${LAYA_HOME:-$HOME/laya-positivenews}"
SERVER="${LAYA_SERVER:-toni@bergholm.net}"
SSH_PORT="${LAYA_SERVER_PORT:-2222}"
EPOCHS=2; MB=8; GA=4; TIMING=0
[ -f "$HOME_DIR/train.env" ] && source "$HOME_DIR/train.env"
while [ $# -gt 0 ]; do case "$1" in
  --timing) TIMING=1;; --epochs) EPOCHS="$2"; shift;; --micro-batch) MB="$2"; shift;; --grad-accum) GA="$2"; shift;;
  *) echo "unknown arg $1"; exit 1;; esac; shift; done

free_gb=$(df -g "$HOME" | awk 'NR==2{print $4}')
[ "$free_gb" -ge 15 ] || { echo "Refusing: only ${free_gb} GB free (need 15)"; exit 1; }
pmset -g batt | grep -q "AC Power" || { echo "Refusing: not on AC power"; exit 1; }
mkdir -p "$HOME_DIR/data" "$HOME_DIR/checkpoints"
ls -1dt "$HOME_DIR"/checkpoints/*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf

tmp=$(ssh -p "$SSH_PORT" "$SERVER" 'd=$(mktemp -d) && cd ~/apps/positivenews && pnpm -s laya:export --out "$d" >/dev/null && echo "$d"')
id=$(ssh -p "$SSH_PORT" "$SERVER" "python3 -c 'import json;print(json.load(open(\"$tmp/manifest.json\"))[\"exportId\"])'")
rsync -az -e "ssh -p $SSH_PORT" "$SERVER:$tmp/" "$HOME_DIR/data/$id/"
ssh -p "$SSH_PORT" "$SERVER" "rm -rf '$tmp'"
data="$HOME_DIR/data/$id"
train="$data/train.jsonl"
if [ "$TIMING" = 1 ]; then head -n 200 "$train" > "$data/train-timing.jsonl"; train="$data/train-timing.jsonl"; EPOCHS=1; fi
out="$HOME_DIR/checkpoints/$(date +%Y%m%d)-$id"
start=$(date +%s)
caffeinate -i uv run laya-train --data "$train" --eval "$data/val.jsonl" --base convaiinnovations/laya-multilingual \
  --loss soft-ce --epochs "$EPOCHS" --micro-batch "$MB" --grad-accum "$GA" --out "$out"
echo "train seconds: $(( $(date +%s) - start )) rows: $(wc -l < "$train") epochs: $EPOCHS" | tee "$out/timing.txt"
cp "$data/contract.json" "$data/manifest.json" "$out/"
caffeinate -i uv run python evaluate.py --data "$data" --checkpoint "$out"
echo "checkpoint: $out"
```

- [ ] **Step 6: `laya/deploy.sh`**

```bash
#!/usr/bin/env bash
# Deploy a checkpoint as an immutable release on bergholm.net (run on minos).
# Usage: laya/deploy.sh <checkpoint-dir> [--experimental|--force]   |   laya/deploy.sh --rollback [release-id]
set -euo pipefail
cd "$(dirname "$0")"
SERVER="${LAYA_SERVER:-toni@bergholm.net}"; P="${LAYA_SERVER_PORT:-2222}"; R='~/apps/laya'
ssh_() { ssh -p "$P" "$SERVER" "$@"; }
switch_and_restart() {  # $1 = release id
  ssh_ "cd $R && ln -sfn releases/$1 current.tmp && mv -T current.tmp current && \
        (pm2 describe laya >/dev/null 2>&1 && pm2 restart laya --update-env || \
         LAYA_THREADS=2 LAYA_HOST=127.0.0.1 LAYA_PORT=8100 pm2 start .venv/bin/python --name laya --cwd $R/current -- serve.py) && pm2 save >/dev/null"
}
smoke() {
  ssh_ "for i in \$(seq 1 60); do curl -sf http://127.0.0.1:8100/health >/dev/null && break; sleep 2; done; \
        curl -sf http://127.0.0.1:8100/health && \
        curl -sf -X POST http://127.0.0.1:8100/v1/systemone -H 'content-type: application/json' \
          -d \"{\\\"state\\\":{\\\"title\\\":\\\"Volunteers restore a wetland\\\"},\\\"questions\\\":\$(python3 -c 'import json;print(json.dumps(json.load(open(\"$R/current/contract.json\"))[\"questions\"]))')}\" >/dev/null"
}
if [ "${1:-}" = "--rollback" ]; then
  target="${2:-$(ssh_ "cat $R/last-good")}"; switch_and_restart "$target"; smoke && echo "rolled back to $target"; exit
fi
ck="$1"; mode="${2:-}"
g=$(python3 -c "import json;print(json.load(open('$ck/report.json'))['gate'])")
case "$g:$mode" in pass:*|experimental:--experimental|*:--force) ;; *) echo "Refusing: gate=$g (use --experimental or --force)"; exit 1;; esac
id="$(basename "$ck")"; exp=$([ "$g" = experimental ] && echo true || echo false)
stage=$(mktemp -d); mkdir -p "$stage/checkpoint"
rsync -a "$ck/" "$stage/checkpoint/"; cp serve.py pyproject.toml uv.lock "$stage/"; cp "$ck/contract.json" "$stage/"
echo "{\"checkpoint\":\"$id\",\"experimental\":$exp}" > "$stage/release.json"
ssh_ "mkdir -p $R/releases/$id"
rsync -az -e "ssh -p $P" "$stage/" "$SERVER:$R/releases/$id/"
ssh_ "cd $R/releases/$id && ~/.local/bin/uv sync --frozen"
switch_and_restart "$id"
if smoke; then
  ssh_ "echo $id > $R/last-good && cd $R/releases && ls -1t | grep -vx \"\$(cat $R/last-good)\" | tail -n +3 | xargs -r rm -rf"
  echo "deployed $id (gate=$g)"
else
  echo "smoke failed — rolling back"; prev=$(ssh_ "cat $R/last-good 2>/dev/null || true")
  [ -n "$prev" ] && switch_and_restart "$prev" || ssh_ "pm2 stop laya"
  exit 1
fi
```

- [ ] **Step 7: `laya/bench.sh`**

```bash
#!/usr/bin/env bash
# Benchmark the deployed Laya service on the server (run on minos). Prints p50/p95 and peak RSS.
set -euo pipefail
SERVER="${LAYA_SERVER:-toni@bergholm.net}"; P="${LAYA_SERVER_PORT:-2222}"
ssh -p "$P" "$SERVER" 'cd ~/apps/laya/current && python3 - <<EOF
import json, time, urllib.request, statistics
q = json.load(open("contract.json"))["questions"]
def post(path, body):
    t = time.time()
    req = urllib.request.Request("http://127.0.0.1:8100" + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=120).read()
    return time.time() - t
single = [post("/v1/systemone", {"state": {"title": f"Community garden opens {i}", "summary": "Volunteers planted trees."}, "questions": q}) for i in range(50)]
batch = [post("/v1/systemone/batch", {"states": [{"title": f"Story {i}-{j}", "summary": "A short summary."} for j in range(8)], "questions": q}) for i in range(10)]
h = json.load(urllib.request.urlopen("http://127.0.0.1:8100/health"))
p = lambda xs, q: sorted(xs)[min(len(xs) - 1, int(q * len(xs)))]
print(json.dumps({"single_p50": statistics.median(single), "single_p95": p(single, .95), "batch8_p50": statistics.median(batch), "batch8_p95": p(batch, .95), "rss_mb": h["rss_mb"]}))
EOF
free -m | awk "/Mem:/{print \"available_mb=\" \$7}"'
```

- [ ] **Step 8: `laya/README.md`.** Cover setup on minos and on the server (`uv` install, `uv sync`), `train.sh` (timing first), `deploy.sh`, `bench.sh` and its thresholds (batch-8 p95 under 20 s, RSS under 2500 MB, available memory over 1000 MB), rollback, and enabling `LAYA_URL` and `LAYA_TIMEOUT_MS` in the server `.env`.

- [ ] **Step 9: Set up minos and run the end-to-end check.**
  - Install `uv` in the home folder: `curl -LsSf https://astral.sh/uv/install.sh | sh`.
  - Copy `laya/` to `~/laya-positivenews/src`, then run `uv sync` (this generates `uv.lock`; commit it back into the repo).
  - Run `uv run pytest -q`.
  - Run a tiny training on a 300-row local export with 1 epoch. Use the local DB export scp'd from the session machine, or a server export if the app is deployed.
  - Run `evaluate.py`, then start `serve.py` on minos at port 8100.
  - From the session machine, run the shadow step against it over Tailscale (`LAYA_URL=http://minos.taila2b943.ts.net:8100`, with serve bound to `0.0.0.0` for this test only) against the local database, using `pnpm laya:backfill --days 30 --limit 40`.
  - Check that `LayaEvaluation` rows were written. Stop the server afterwards.

- [ ] **Step 10: Commit.** Commit `laya/` including `uv.lock`, plus `.gitignore`, with the message `feat(laya): training, evaluation, serving and deploy scripts` followed by `Refs #5`.

---

### Task 7: Operations (controller, after merge)

1. Merge the PR. The deploy migrates (`LayaEvaluation`). `LAYA_URL` is unset, so nothing runs yet.
2. **On minos:** run `train.sh --timing`, size the epochs (target an overnight run of at most ~8 hours), write `~/laya-positivenews/train.env`, then run `train.sh`.
3. **On the server:**
   - Install `uv` and create `~/apps/laya/`.
   - Run `deploy.sh <checkpoint> --experimental`, then `bench.sh`.
4. **If bench passes the thresholds:**
   - Add `LAYA_URL=http://127.0.0.1:8100` and `LAYA_TIMEOUT_MS=<2× batch p95, at least 15000>` to the server `.env`, then run `pm2 restart positivenews --update-env`.
   - Run `pnpm laya:backfill --days 30 --limit 2000`.
   - Verify the rows, then the scoreboard caption.
5. Comment on #5 with the results. Close #5 after phase 1 is verified in production. Open a follow-up issue for phase 2 (distillation) if it hasn't been done.
