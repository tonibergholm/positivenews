# Jev Shadow Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run TypeSafe Jev next to the Ollama curator, store its answers per article, and compare the two on `/admin/jev`, without changing any live feed decision.

**Architecture:** Pure modules (`jev.ts` question set and verdict, `jev-pool.ts` concurrency, `jev-report.ts` aggregation) carry the logic and the unit tests. Thin modules that talk to the database (`jev-shadow.ts`, `jev-report-data.ts`) wire them to Prisma. A new `JevEvaluation` table stores raw probabilities, and verdicts are derived when the page renders. The pipeline calls the shadow step after curation inside a catch-all, so it can never affect ingest or curation.

**Tech Stack:** Next.js 16 (App Router, `basePath: "/news"`), Prisma 7 + PostgreSQL, `@typesafe-ai/sdk` 0.6.0, Vitest, tsx scripts, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-jev-shadow-design.md`

## Global Constraints

- All work happens in the worktree `/Users/tonibergholm/Developer/github/positivenews/.worktrees/jev-shadow` on branch `jev-shadow`. Never edit the main checkout.
- Use pnpm (`pnpm add`, `pnpm test`). CI runs `pnpm install --frozen-lockfile`, so `pnpm-lock.yaml` must be committed with any dependency change. Do not touch `package-lock.json`.
- The default model is `jev-1.13.0`. `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_BASE_URL` override the model and endpoint. `TYPESAFE_API_KEY` is the only key name read.
- `QUESTION_SET = "v1"`. Bump it whenever a question, criterion, or the state format changes.
- State is `{ title, summary }`, with the summary trimmed and cut to 300 characters and omitted when empty.
- Default thresholds: `positiveMin: 0.5`, `upliftingMin: 0.5`, `categoryMax: 0.6`.
- Trusted sources (`FEED_SOURCES` entries with `trusted: true`) are never evaluated.
- The pipeline shadow step uses a 2-day window and a limit of 100. Backfill defaults are 30 days and 500 articles. Concurrency defaults to 5.
- Never print or commit `TYPESAFE_API_KEY`. `.env*` files are gitignored, except `.env.example`, which is tracked.
- Read `node_modules/next/dist/docs/` before writing page code (AGENTS.md: this Next.js has breaking changes). Browser URLs need the `/news` prefix; `<Link href>` adds it automatically.
- UI follows DESIGN.md and the existing admin pages: warm tokens (`bg-secondary`, `border-border`, `text-muted-foreground`), `tabular-nums` for numbers, no new colours.

## Review Focus

1. **Article with no summary, or a whitespace-only summary.** State must contain only `title`, never `summary: ""` or `undefined`. Covered by a test in Task 1.
2. **API response missing a question or with the wrong answer type.** It must be treated as a failure, so no row is stored with `NaN` or `0` probabilities. Covered by a test in Task 1.
3. **Invalid or revoked API key, or a 400/404/422 from a bad question set or model name.** The run must stop after the first failures instead of logging 100 errors every 15 minutes. A 429 must not stop the run. Covered by a test in Task 3.
4. **Backfill running while the scheduled pipeline evaluates the same article.** The second insert hits the unique constraint and must be ignored, not counted as a failure. Covered by a test in Task 3.
5. **Report with zero rows, or a group or language with zero articles.** Rates must be `null` and render as "—", never `NaN%`. Covered by a test in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `vitest.config.ts` (create) | Vitest config with the `@/` alias |
| `src/lib/jev.ts` (create) | Question set, state builder, answer parsing, verdict rule, SDK call |
| `src/lib/jev.test.ts` (create) | Unit tests for `jev.ts` pure functions |
| `src/lib/jev-pool.ts` (create) | Concurrency pool, fatal-error and unique-violation checks; no Prisma |
| `src/lib/jev-pool.test.ts` (create) | Unit tests for the pool and error checks |
| `src/lib/jev-shadow.ts` (create) | Selects unevaluated articles, evaluates, stores rows |
| `src/lib/jev-report.ts` (create) | Pure aggregation: groups, agreement, flagged and keyword metrics, disagreements |
| `src/lib/jev-report.test.ts` (create) | Unit tests for the report |
| `src/lib/jev-report-data.ts` (create) | Loads report rows from Prisma for the page and the backfill |
| `src/lib/pipeline.ts` (modify) | Calls `shadowEvaluate` after curation |
| `prisma/schema.prisma` (modify) | `JevEvaluation` model and `Article.jevEvaluations` relation |
| `prisma/migrations/<timestamp>_jev_evaluation/` (create) | Generated migration |
| `scripts/load-env.ts` (create) | Loads `.env.local`, then `.env` |
| `scripts/jev-smoke.ts` (create) | Live check of fixed FI and EN headlines; stores nothing |
| `scripts/jev-backfill.ts` (create) | Backfill CLI plus summary printout |
| `app/admin/jev/page.tsx` (create) | Server page: data loading and filter parsing |
| `app/admin/jev/JevReportView.tsx` (create) | Presentational server components: tiles, matrix, filters, table |
| `app/admin/layout.tsx` (modify) | "Jev" nav link |
| `package.json`, `pnpm-lock.yaml` (modify) | SDK, Vitest, scripts |
| `.github/workflows/*.yml` (modify) | Enable the `pnpm test` step |
| `.env.example`, `README.md` (modify) | Document `TYPESAFE_*` vars and the Jev scripts |

---

### Task 1: Tooling and the Jev core module

**Files:**
- Create: `vitest.config.ts`, `src/lib/jev.ts`, `src/lib/jev.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `@typesafe-ai/sdk` (`TypeSafeClient`, `noul`, `score`, `Questions`)
- Produces (exact exports of `src/lib/jev.ts`):
  - `JEV_DEFAULT_MODEL: "jev-1.13.0"`, `QUESTION_SET: "v1"`
  - `interface JevArticle { title: string; summary?: string | null }`
  - `buildState(article: JevArticle): Record<string, string>`
  - `CATEGORIES: Record<string, { label: string; instructions: string; yes: string; no: string }>` (17 entries, keys `cat_*`, in tie-break order)
  - `QUESTIONS: Questions`
  - `interface JevSummary { positiveP: number; upliftingP: number; upliftScore: number; topCategory: string; topCategoryP: number }`
  - `summarizeAnswers(answers: Record<string, unknown>): JevSummary` (throws on a missing or malformed answer)
  - `interface JevThresholds { positiveMin: number; upliftingMin: number; categoryMax: number }`, `DEFAULT_THRESHOLDS: JevThresholds`
  - `interface JevVerdict { keep: boolean; reason: string | null; topCategory: string | null }`
  - `deriveVerdict(s: Pick<JevSummary, "positiveP" | "upliftingP" | "topCategory" | "topCategoryP">, t?: JevThresholds): JevVerdict`
  - `interface JevEvaluationData extends JevSummary { model: string; answers: Record<string, unknown>; inputTokens: number; latencyMs: number }`
  - `isJevConfigured(): boolean`
  - `evaluateArticle(article: JevArticle): Promise<JevEvaluationData>`

- [ ] **Step 1: Install dependencies and add the test script**

```bash
cd /Users/tonibergholm/Developer/github/positivenews/.worktrees/jev-shadow
pnpm install
pnpm add @typesafe-ai/sdk@^0.6.0
pnpm add -D vitest
```

In `package.json`, add these to `"scripts"`:

```json
"test": "vitest run",
"jev:smoke": "tsx scripts/jev-smoke.ts",
"jev:backfill": "tsx scripts/jev-backfill.ts"
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: root }],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Write the failing tests in `src/lib/jev.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  buildState,
  CATEGORIES,
  DEFAULT_THRESHOLDS,
  deriveVerdict,
  QUESTIONS,
  summarizeAnswers,
} from "./jev";

const CATEGORY_KEYS = Object.keys(CATEGORIES);

function answers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    positive: { type: "noul", noul: 0.9 },
    uplifting: { type: "noul", noul: 0.8 },
    uplift: { type: "score", score: 2.5, confidence: 0.7, legend: {}, probabilities: {} },
  };
  for (const key of CATEGORY_KEYS) base[key] = { type: "noul", noul: 0.05 };
  return { ...base, ...overrides };
}

describe("buildState", () => {
  it("includes a trimmed summary cut to 300 characters", () => {
    const state = buildState({ title: "T", summary: `  ${"a".repeat(400)}  ` });
    expect(state).toEqual({ title: "T", summary: "a".repeat(300) });
  });

  it("omits a missing, null, empty or whitespace-only summary", () => {
    expect(buildState({ title: "T" })).toEqual({ title: "T" });
    expect(buildState({ title: "T", summary: null })).toEqual({ title: "T" });
    expect(buildState({ title: "T", summary: "" })).toEqual({ title: "T" });
    expect(buildState({ title: "T", summary: "   " })).toEqual({ title: "T" });
    expect("summary" in buildState({ title: "T", summary: " " })).toBe(false);
  });
});

describe("QUESTIONS", () => {
  it("asks the two mirror Nouls, the uplift Score and all 17 categories", () => {
    expect(CATEGORY_KEYS).toHaveLength(17);
    expect(QUESTIONS.positive.type).toBe("noul");
    expect(QUESTIONS.uplifting.type).toBe("noul");
    expect(QUESTIONS.uplift.type).toBe("score");
    for (const key of CATEGORY_KEYS) {
      expect(key.startsWith("cat_")).toBe(true);
      expect(QUESTIONS[key].type).toBe("noul");
    }
    expect(Object.keys(QUESTIONS)).toHaveLength(20);
  });
});

describe("summarizeAnswers", () => {
  it("extracts mirror probabilities, uplift score and the top category", () => {
    const s = summarizeAnswers(answers({ cat_sports: { type: "noul", noul: 0.7 } }));
    expect(s).toEqual({
      positiveP: 0.9,
      upliftingP: 0.8,
      upliftScore: 2.5,
      topCategory: "cat_sports",
      topCategoryP: 0.7,
    });
  });

  it("breaks ties in favour of the first category in CATEGORIES order", () => {
    const [first, second] = CATEGORY_KEYS;
    const s = summarizeAnswers(
      answers({
        [second]: { type: "noul", noul: 0.8 },
        [first]: { type: "noul", noul: 0.8 },
      }),
    );
    expect(s.topCategory).toBe(first);
  });

  it("throws when a question is missing", () => {
    const a = answers();
    delete a.cat_war;
    expect(() => summarizeAnswers(a)).toThrow(/cat_war/);
  });

  it("throws when an answer has the wrong type or a non-finite value", () => {
    expect(() => summarizeAnswers(answers({ positive: { type: "score", score: 1 } }))).toThrow(/positive/);
    expect(() => summarizeAnswers(answers({ uplifting: { type: "noul", noul: Number.NaN } }))).toThrow(/uplifting/);
    expect(() => summarizeAnswers(answers({ uplift: { type: "noul", noul: 1 } }))).toThrow(/uplift/);
  });
});

describe("deriveVerdict", () => {
  const ok = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.1 };

  it("keeps an article that passes every threshold", () => {
    expect(deriveVerdict(ok)).toEqual({ keep: true, reason: null, topCategory: null });
  });

  it("rejects on a category strictly above categoryMax, using its label", () => {
    const v = deriveVerdict({ ...ok, topCategoryP: 0.61 });
    expect(v).toEqual({ keep: false, reason: `jev: ${CATEGORIES.cat_war.label}`, topCategory: "cat_war" });
    expect(deriveVerdict({ ...ok, topCategoryP: 0.6 }).keep).toBe(true);
  });

  it("rejects when positive or uplifting is strictly below its minimum", () => {
    expect(deriveVerdict({ ...ok, positiveP: 0.49 }).reason).toBe("jev: not positive");
    expect(deriveVerdict({ ...ok, upliftingP: 0.49 }).reason).toBe("jev: not uplifting");
    expect(deriveVerdict({ ...ok, positiveP: 0.5, upliftingP: 0.5 }).keep).toBe(true);
  });

  it("reports the category first, then not positive, then not uplifting", () => {
    expect(deriveVerdict({ positiveP: 0.1, upliftingP: 0.1, topCategory: "cat_war", topCategoryP: 0.9 }).topCategory).toBe("cat_war");
    expect(deriveVerdict({ ...ok, positiveP: 0.1, upliftingP: 0.1 }).reason).toBe("jev: not positive");
  });

  it("accepts custom thresholds", () => {
    expect(deriveVerdict({ ...ok, positiveP: 0.6 }, { ...DEFAULT_THRESHOLDS, positiveMin: 0.7 }).keep).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to confirm they fail**

Run: `pnpm test`
Expected: FAIL, because `./jev` cannot be resolved.

- [ ] **Step 5: Implement `src/lib/jev.ts`**

```ts
/**
 * TypeSafe Jev evaluation for positive-news filtering (shadow mode).
 *
 * One request per article asks two Nouls that mirror the Ollama passes,
 * one Noul per rejection category, and an uplift Score. Verdicts are
 * derived in code from stored probabilities, so thresholds can change
 * without calling Jev again.
 */

import { noul, score, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";

export const JEV_DEFAULT_MODEL = "jev-1.13.0";
/** Bump whenever a question, criterion, or the state format changes. */
export const QUESTION_SET = "v1";

const SUMMARY_CHARS = 300;

export interface JevArticle {
  title: string;
  summary?: string | null;
}

export function buildState(article: JevArticle): Record<string, string> {
  const summary = article.summary?.trim().slice(0, SUMMARY_CHARS);
  return summary ? { title: article.title, summary } : { title: article.title };
}

// ── Questions ───────────────────────────────────────────────────────

interface CategoryDef {
  label: string;
  instructions: string;
  yes: string;
  no: string;
}

/** Rejection categories, adapted from the Ollama curator rules. Order breaks ties. */
export const CATEGORIES: Record<string, CategoryDef> = {
  cat_war: {
    label: "war / military / geopolitics",
    instructions: "Is the article mainly about war, armed conflict, military activity, or geopolitical threats between countries?",
    yes: "Wars, invasions, attacks, missiles, drones, fighter jets, air-space violations, defence exercises, sanctions, territorial disputes, or threats between states or leaders",
    no: "Peace agreements reached, humanitarian help, or a topic with no military or geopolitical conflict",
  },
  cat_crime: {
    label: "crime / police / courts",
    instructions: "Is the article mainly about a crime, a police matter, or a court case?",
    yes: "Violent or other crime, arrests, police investigations, charges, trials, verdicts, sentences, or discrimination cases",
    no: "Crime is absent or only mentioned in passing",
  },
  cat_politics: {
    label: "political conflict",
    instructions: "Is the article mainly about political conflict or a dispute involving government or officials?",
    yes: "Political bickering, government disputes, administrative or legal complaints, governance criticism, constitutional or privacy-law debates, conflicts of interest, cronyism",
    no: "An agreed policy that helps people, or no political conflict",
  },
  cat_disaster: {
    label: "disaster / accident / death",
    instructions: "Is the article mainly about a disaster, an accident, or someone dying or being hurt?",
    yes: "Fires, crashes, natural disasters, accidents, water damage, deaths, injuries, or victims, even if the story mentions a silver lining",
    no: "Nobody is harmed and no disaster or accident is described",
  },
  cat_sports: {
    label: "routine sports",
    instructions: "Is the article mainly a routine sports report rather than a sporting achievement?",
    yes: "Match results and scores, league standings, transfers, roster moves, contract extensions, coaching changes, retirements, doping, sports lawsuits or misconduct probes",
    no: "A genuine sporting triumph such as winning a title, breaking a record, or overcoming adversity, or not about sport",
  },
  cat_shopping: {
    label: "shopping / product reviews",
    instructions: "Is the article mainly about shopping, deals, or reviewing consumer products?",
    yes: "Sales, discounts, deal of the day, best-price roundups, product reviews, test drives, hands-on reviews, best-of lists",
    no: "Not about buying or rating products",
  },
  cat_filler: {
    label: "puzzles / quizzes / filler",
    instructions: "Is the article a puzzle, quiz, game, horoscope, or other filler that is not news?",
    yes: "Crosswords, quizzes, games, horoscopes, or clickbait listicles with no real substance",
    no: "A real news story",
  },
  cat_business_puff: {
    label: "business clickbait / CEO puff",
    instructions: "Is the article business clickbait, a puff piece about executives, or a routine corporate deal?",
    yes: "Entrepreneurship clickbait such as 'dare to start' or 'why companies fail', CEO interview roundups, what-leaders-said pieces, generic deals or contracts between companies",
    no: "Business news that directly creates jobs, clean energy, or accessibility for people, or not about business",
  },
  cat_costs: {
    label: "rising costs / economy worries",
    instructions: "Is the article mainly about rising prices, inflation, or money worries?",
    yes: "Price increases, inflation, cost of living, affordability complaints, insurance disputes, debt or payment defaults, economic downturns",
    no: "Prices and the economy are not a concern in the story",
  },
  cat_layoffs: {
    label: "layoffs / labour disputes",
    instructions: "Is the article mainly about job losses or a labour dispute?",
    yes: "Layoffs, firings, job cuts, restructuring, change negotiations (yt-neuvottelut), strikes, unresolved union conflicts",
    no: "Jobs are created or saved, a dispute was resolved, or work is not the topic",
  },
  cat_health_scare: {
    label: "health scare",
    instructions: "Is the article mainly a health scare?",
    yes: "Disease outbreaks, anti-vaccination trends, declining health statistics, infections, or illness of politicians or public figures",
    no: "Health breakthroughs, practical wellness advice, or not about health",
  },
  cat_breach: {
    label: "data breach / investigation",
    instructions: "Is the article mainly about a data breach, a leak, or an investigation into wrongdoing?",
    yes: "Data breaches, leaked personal data, hacking, misconduct probes, or investigations",
    no: "No breach, leak, or investigation",
  },
  cat_env_loss: {
    label: "harm to nature or animals",
    instructions: "Is the article mainly about harm to nature or animals?",
    yes: "Environmental loss or alarm, pollution, species decline, poaching, illegal wildlife trade, hunting or culling of wild animals such as wolf hunting, or animal attacks on people",
    no: "Nature recovering, conservation success, rewilding, or not about nature",
  },
  cat_marketing: {
    label: "marketing as news",
    instructions: "Is the article marketing dressed up as news?",
    yes: "Product launches, brand collaborations, celebrity collections, promotional copy, or 'your X is ugly and this company wants to fix it'",
    no: "Independent reporting that is not written to sell a product",
  },
  cat_gossip: {
    label: "gossip / scandal / rage-bait",
    instructions: "Is the article mainly celebrity gossip, a scandal, or rage-bait?",
    yes: "Celebrity gossip, scandals, or outrage-provoking or alarmist framing",
    no: "No gossip, scandal, or outrage",
  },
  cat_opinion: {
    label: "opinion on societal problems",
    instructions: "Is the article an opinion piece, column, or editorial about a problem in society?",
    yes: "Opinion columns, editorials, commentary, or reader letters arguing about societal problems",
    no: "News reporting, or an opinion piece celebrating something good",
  },
  cat_failure: {
    label: "failure / cancellation",
    instructions: "Is the article mainly about something failing, going wrong, or being cancelled?",
    yes: "Errors, corrections, outages, failures, cancelled events, dangerous roads, infrastructure failures, platform spam or abuse, things getting worse",
    no: "Things working or improving",
  },
};

export const QUESTIONS: Questions = {
  positive: noul(
    "Is this article positive news that would leave a reader feeling hopeful, inspired, or calm?",
    {
      true: "Solutions journalism, scientific or medical breakthroughs, kindness or heroism, environmental recovery, genuine cultural or sporting achievements, community successes, practical wellness advice",
      false: "Conflict, crime, disaster, politics, scandal, alarm, routine sports or business news, shopping, filler, or anything distressing even with a silver lining",
    },
  ),
  uplifting: noul(
    "Is this article genuinely uplifting rather than marketing, routine business news, or a puff piece?",
    {
      true: "Real human achievement, community success, scientific progress, help for people, environmental wins, acts of kindness, or business news that directly creates jobs, clean energy, or accessibility",
      false: "Product launches, brand collaborations, corporate deals, thought-leader puff pieces, or stories about problems, failures, or things getting worse",
    },
  ),
  uplift: score("How uplifting would a typical reader find this article?", [
    "Distressing or negative",
    "Neutral or routine",
    "Mildly positive",
    "Clearly uplifting and inspiring",
  ]),
  ...Object.fromEntries(
    Object.entries(CATEGORIES).map(([key, c]) => [key, noul(c.instructions, { true: c.yes, false: c.no })]),
  ),
};

// ── Answers → summary ───────────────────────────────────────────────

export interface JevSummary {
  positiveP: number;
  upliftingP: number;
  upliftScore: number;
  topCategory: string;
  topCategoryP: number;
}

type RawAnswer = { type?: unknown; noul?: unknown; score?: unknown };

function numberField(answers: Record<string, unknown>, key: string, type: "noul" | "score"): number {
  const answer = answers[key] as RawAnswer | undefined;
  const value = answer?.[type];
  if (!answer || answer.type !== type || typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Jev answer "${key}" is missing or not a valid ${type}`);
  }
  return value;
}

export function summarizeAnswers(answers: Record<string, unknown>): JevSummary {
  let topCategory = "";
  let topCategoryP = -1;
  for (const key of Object.keys(CATEGORIES)) {
    const p = numberField(answers, key, "noul");
    if (p > topCategoryP) {
      topCategory = key;
      topCategoryP = p;
    }
  }

  return {
    positiveP: numberField(answers, "positive", "noul"),
    upliftingP: numberField(answers, "uplifting", "noul"),
    upliftScore: numberField(answers, "uplift", "score"),
    topCategory,
    topCategoryP,
  };
}

// ── Verdict ─────────────────────────────────────────────────────────

export interface JevThresholds {
  positiveMin: number;
  upliftingMin: number;
  categoryMax: number;
}

export const DEFAULT_THRESHOLDS: JevThresholds = {
  positiveMin: 0.5,
  upliftingMin: 0.5,
  categoryMax: 0.6,
};

export interface JevVerdict {
  keep: boolean;
  reason: string | null;
  topCategory: string | null;
}

export function deriveVerdict(
  s: Pick<JevSummary, "positiveP" | "upliftingP" | "topCategory" | "topCategoryP">,
  t: JevThresholds = DEFAULT_THRESHOLDS,
): JevVerdict {
  if (s.topCategoryP > t.categoryMax) {
    const label = CATEGORIES[s.topCategory]?.label ?? s.topCategory;
    return { keep: false, reason: `jev: ${label}`, topCategory: s.topCategory };
  }
  if (s.positiveP < t.positiveMin) return { keep: false, reason: "jev: not positive", topCategory: null };
  if (s.upliftingP < t.upliftingMin) return { keep: false, reason: "jev: not uplifting", topCategory: null };
  return { keep: true, reason: null, topCategory: null };
}

// ── API ─────────────────────────────────────────────────────────────

export interface JevEvaluationData extends JevSummary {
  model: string;
  answers: Record<string, unknown>;
  inputTokens: number;
  latencyMs: number;
}

let client: TypeSafeClient | null = null;

export function isJevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

function getClient(): TypeSafeClient {
  // The SDK reads TYPESAFE_API_KEY and TYPESAFE_BASE_URL from the environment.
  client ??= new TypeSafeClient({
    defaultModel: process.env.TYPESAFE_DEFAULT_MODEL ?? JEV_DEFAULT_MODEL,
    timeout: 30_000,
  });
  return client;
}

export async function evaluateArticle(article: JevArticle): Promise<JevEvaluationData> {
  const started = Date.now();
  const res = await getClient().systemOne({ state: buildState(article), questions: QUESTIONS });
  const answers = res.answers as Record<string, unknown>;

  return {
    ...summarizeAnswers(answers),
    model: res.model,
    answers,
    inputTokens: res.usage.input_tokens,
    latencyMs: Date.now() - started,
  };
}
```

- [ ] **Step 6: Run the tests, type check, and lint**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`
Expected: all `jev.test.ts` tests pass, with no type or lint errors.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/jev.ts src/lib/jev.test.ts
git commit -m "feat(jev): add Jev question set, answer parsing and verdict rule"
```

---

### Task 2: Live smoke script

**Files:**
- Create: `scripts/load-env.ts`, `scripts/jev-smoke.ts`

**Interfaces:**
- Consumes: `evaluateArticle`, `deriveVerdict`, `isJevConfigured`, `JevArticle` from `src/lib/jev.ts`
- Produces: `scripts/load-env.ts` (a side-effect import that later scripts import first)

- [ ] **Step 1: Make the API key available in the worktree**

The key lives in the main checkout's `.env.local` as `TYPESAFE_API_KEY`. Copy the file without printing it, and confirm the variable name only:

```bash
cp ../../.env.local .env.local
git check-ignore -q .env.local && echo ignored
grep -c '^TYPESAFE_API_KEY=' .env.local
```

Expected: `ignored` and then `1`.

- [ ] **Step 2: Create `scripts/load-env.ts`**

```ts
/**
 * Loads .env.local, then .env. Import this first in scripts, because
 * modules such as prisma.ts read the environment at import time.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
```

- [ ] **Step 3: Create `scripts/jev-smoke.ts`**

```ts
/**
 * Sends fixed FI/EN headlines to Jev and prints each verdict. Stores nothing.
 * Use it to eyeball behaviour after changing the question set.
 *
 * Usage: pnpm jev:smoke
 */
import "./load-env";
import { deriveVerdict, evaluateArticle, isJevConfigured, type JevArticle } from "../src/lib/jev";

const FIXTURES: Array<JevArticle & { lang: "en" | "fi"; expectKeep: boolean }> = [
  { lang: "en", expectKeep: true, title: "Scientists restore sight to blind patients with gene therapy" },
  { lang: "en", expectKeep: true, title: "Volunteers plant one million trees to revive drought-hit forest" },
  { lang: "en", expectKeep: true, title: "Teenager breaks world record to win first Olympic gold for her country" },
  { lang: "en", expectKeep: false, title: "Three killed as fighter jets clash over disputed border" },
  { lang: "en", expectKeep: false, title: "Manchester United complete £60m transfer of striker" },
  { lang: "en", expectKeep: false, title: "Amazon spring sale: best deals on headphones today" },
  { lang: "en", expectKeep: false, title: "Opinion: Our cities are failing the people who live in them" },
  { lang: "fi", expectKeep: true, title: "Suomalaistutkijat kehittivät uuden menetelmän muovin kierrättämiseen" },
  { lang: "fi", expectKeep: true, title: "Kyläyhdistys kunnosti vanhan koulun nuorten kohtaamispaikaksi" },
  { lang: "fi", expectKeep: false, title: "Susijahti alkaa – Lappiin myönnettiin kaatolupia 20 sudelle" },
  { lang: "fi", expectKeep: false, title: "Kolari valtatiellä: kaksi kuoli" },
  { lang: "fi", expectKeep: false, title: "Kolumni: Hyvinvointivaltio murenee käsiin" },
];

async function main() {
  if (!isJevConfigured()) {
    console.error("TYPESAFE_API_KEY is not set (.env.local or .env)");
    process.exit(1);
  }

  let mismatches = 0;
  for (const f of FIXTURES) {
    const r = await evaluateArticle(f);
    const v = deriveVerdict(r);
    const ok = v.keep === f.expectKeep;
    if (!ok) mismatches++;
    console.log(
      `${ok ? "ok  " : "MISS"} [${f.lang}] ${v.keep ? "keep  " : "reject"} ` +
        `pos=${r.positiveP.toFixed(2)} upl=${r.upliftingP.toFixed(2)} ` +
        `top=${r.topCategory}:${r.topCategoryP.toFixed(2)} ${r.latencyMs}ms  ${f.title}`,
    );
  }
  console.log(`\n${FIXTURES.length - mismatches}/${FIXTURES.length} matched expectations (model ${process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0"})`);
}

main().catch((err) => {
  console.error("Smoke run failed:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Run it against the live API**

Run: `pnpm jev:smoke`
Expected: 12 result lines and a summary line, with no exception. Mismatches are allowed, since the run is diagnostic. Record the output for the final report, especially the Finnish rows. If every call fails with a 4xx, stop and report the error message. Never print the key.

- [ ] **Step 5: Commit**

```bash
git add scripts/load-env.ts scripts/jev-smoke.ts
git commit -m "feat(jev): add live smoke script for FI/EN headlines"
```

---

### Task 3: Schema, shadow evaluation, and pipeline hook

**Files:**
- Create: `src/lib/jev-pool.ts`, `src/lib/jev-pool.test.ts`, `src/lib/jev-shadow.ts`, `prisma/migrations/<timestamp>_jev_evaluation/migration.sql` (generated)
- Modify: `prisma/schema.prisma`, `src/lib/pipeline.ts`

**Interfaces:**
- Consumes: `evaluateArticle`, `isJevConfigured`, `QUESTION_SET` from `src/lib/jev.ts`; `prisma` from `src/lib/prisma.ts`; `FEED_SOURCES` from `@/src/config/sources`
- Produces:
  - `src/lib/jev-pool.ts`: `runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, isFatal: (err: unknown) => boolean): Promise<{ succeeded: number; failed: number; aborted: boolean }>`, `isFatalJevError(err: unknown): boolean`, `isUniqueViolation(err: unknown): boolean`
  - `src/lib/jev-shadow.ts`: `interface ShadowOptions { since: Date; limit: number; concurrency?: number }`, `shadowEvaluate(opts: ShadowOptions): Promise<{ evaluated: number; failed: number }>`
  - Prisma model `JevEvaluation` (fields below) and `prisma.jevEvaluation`

- [ ] **Step 1: Write the failing tests in `src/lib/jev-pool.test.ts`**

```ts
import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { isFatalJevError, isUniqueViolation, runPool } from "./jev-pool";

const apiError = (status: number) => APIError.fromResponse(status, {}, new Headers());

describe("runPool", () => {
  it("never exceeds the concurrency limit and processes every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const result = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      inFlight--;
    }, () => false);
    expect(peak).toBeLessThanOrEqual(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result).toEqual({ succeeded: 7, failed: 0, aborted: false });
  });

  it("counts non-fatal failures and keeps going", async () => {
    const result = await runPool([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 0) throw new Error("boom");
    }, () => false);
    expect(result).toEqual({ succeeded: 2, failed: 2, aborted: false });
  });

  it("stops starting new items after a fatal error", async () => {
    const started: number[] = [];
    const result = await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1, async (n) => {
      started.push(n);
      if (n === 2) throw apiError(401);
    }, isFatalJevError);
    expect(started).toEqual([1, 2]);
    expect(result).toEqual({ succeeded: 1, failed: 1, aborted: true });
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 5, async () => {}, () => false)).toEqual({ succeeded: 0, failed: 0, aborted: false });
  });
});

describe("isFatalJevError", () => {
  it("treats auth, permission, bad request, not found and unprocessable as fatal", () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isFatalJevError(apiError(status))).toBe(true);
  });

  it("does not treat rate limits, server errors or generic errors as fatal", () => {
    expect(isFatalJevError(apiError(429))).toBe(false);
    expect(isFatalJevError(apiError(500))).toBe(false);
    expect(isFatalJevError(new Error("network"))).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  it("detects Prisma P2002 only", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm test src/lib/jev-pool.test.ts`
Expected: FAIL, because `./jev-pool` cannot be resolved.

- [ ] **Step 3: Implement `src/lib/jev-pool.ts`**

```ts
/**
 * Concurrency and error helpers for Jev shadow runs. Kept free of Prisma
 * so they can be unit-tested without a database.
 */

import { APIError } from "@typesafe-ai/sdk";

/**
 * Runs fn over items with at most `concurrency` calls in flight. A failing
 * item is counted and the run continues; a fatal error stops new items
 * from starting (in-flight ones still finish).
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  isFatal: (err: unknown) => boolean,
): Promise<{ succeeded: number; failed: number; aborted: boolean }> {
  let next = 0;
  let succeeded = 0;
  let failed = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    while (!aborted && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
        succeeded++;
      } catch (err) {
        failed++;
        if (isFatal(err)) aborted = true;
      }
    }
  }

  const workers = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return { succeeded, failed, aborted };
}

/** A 4xx other than 429 means every later request would fail the same way. */
export function isFatalJevError(err: unknown): boolean {
  return err instanceof APIError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && "code" in (err as object) && (err as { code: unknown }).code === "P2002";
}
```

- [ ] **Step 4: Run the pool tests**

Run: `pnpm test src/lib/jev-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the Prisma model**

In `prisma/schema.prisma`, add `jevEvaluations JevEvaluation[]` as the last field of `model Article` (after `createdAt`), then append:

```prisma
model JevEvaluation {
  id           String   @id @default(cuid())
  article      Article  @relation(fields: [articleId], references: [id], onDelete: Cascade)
  articleId    String
  model        String
  questionSet  String
  answers      Json
  positiveP    Float
  upliftingP   Float
  upliftScore  Float
  topCategory  String
  topCategoryP Float
  inputTokens  Int
  latencyMs    Int
  createdAt    DateTime @default(now())

  @@unique([articleId, questionSet])
}
```

- [ ] **Step 6: Start a local Postgres and generate the migration**

```bash
docker run -d --name pn-jev-pg -e POSTGRES_USER=pn -e POSTGRES_PASSWORD=pn -e POSTGRES_DB=positivenews -p 55432:5432 postgres:16-alpine
printf 'DATABASE_URL=postgresql://pn:pn@localhost:55432/positivenews\n' > .env
git check-ignore -q .env && echo ignored
pnpm prisma migrate dev --name jev_evaluation
```

Expected: `ignored`, then Prisma applies the five existing migrations plus the new `<timestamp>_jev_evaluation`, and regenerates the client. Open the generated `migration.sql` and confirm it only creates the `JevEvaluation` table, its unique index, and the foreign key with `ON DELETE CASCADE`.

- [ ] **Step 7: Implement `src/lib/jev-shadow.ts`**

```ts
/**
 * Jev shadow evaluation.
 *
 * Evaluates recent non-trusted articles that have no JevEvaluation for the
 * current question set and stores the answers. Never changes Article rows,
 * so live feed decisions are unaffected.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { evaluateArticle, isJevConfigured, QUESTION_SET, type JevEvaluationData } from "./jev";
import { isFatalJevError, isUniqueViolation, runPool } from "./jev-pool";
import { FEED_SOURCES } from "@/src/config/sources";

const trustedSourceUrls = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url);

export interface ShadowOptions {
  since: Date;
  limit: number;
  concurrency?: number;
}

export async function shadowEvaluate({
  since,
  limit,
  concurrency = 5,
}: ShadowOptions): Promise<{ evaluated: number; failed: number }> {
  if (!isJevConfigured()) return { evaluated: 0, failed: 0 };

  const articles = await prisma.article.findMany({
    where: {
      createdAt: { gte: since },
      source: { url: { notIn: trustedSourceUrls } },
      jevEvaluations: { none: { questionSet: QUESTION_SET } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, title: true, summary: true },
  });

  if (articles.length === 0) return { evaluated: 0, failed: 0 };

  console.log(`[jev] Evaluating ${articles.length} articles…`);

  const result = await runPool(
    articles,
    concurrency,
    async (article) => {
      let data: JevEvaluationData;
      try {
        data = await evaluateArticle(article);
      } catch (err) {
        console.error(`[jev] Article ${article.id} failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }

      try {
        await prisma.jevEvaluation.create({
          data: {
            articleId: article.id,
            model: data.model,
            questionSet: QUESTION_SET,
            answers: data.answers as Prisma.InputJsonValue,
            positiveP: data.positiveP,
            upliftingP: data.upliftingP,
            upliftScore: data.upliftScore,
            topCategory: data.topCategory,
            topCategoryP: data.topCategoryP,
            inputTokens: data.inputTokens,
            latencyMs: data.latencyMs,
          },
        });
      } catch (err) {
        // Another run (backfill or scheduler) stored this article first.
        if (isUniqueViolation(err)) return;
        console.error(`[jev] Failed to store evaluation for ${article.id}:`, err);
        throw err;
      }
    },
    isFatalJevError,
  );

  if (result.aborted) console.error("[jev] Stopped early after a non-retryable API error");
  console.log(`[jev] Done — ${result.succeeded} evaluated, ${result.failed} failed`);

  return { evaluated: result.succeeded, failed: result.failed };
}
```

- [ ] **Step 8: Hook into the pipeline**

In `src/lib/pipeline.ts`, add the import and constants below the existing imports:

```ts
import { shadowEvaluate } from "./jev-shadow";

const JEV_SHADOW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const JEV_SHADOW_LIMIT = 100;
```

Then replace the body between `const curationResult = await curateUnchecked();` and `return {` with:

```ts
    const curationResult = await curateUnchecked();

    // Shadow mode: Jev results are stored for comparison only and must never
    // affect ingest or curation.
    try {
      await shadowEvaluate({
        since: new Date(Date.now() - JEV_SHADOW_WINDOW_MS),
        limit: JEV_SHADOW_LIMIT,
      });
    } catch (err) {
      console.error("[pipeline] Jev shadow evaluation failed:", err);
    }

    return {
```

- [ ] **Step 9: Verify**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`
Expected: all tests pass, with no type or lint errors.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/jev-pool.ts src/lib/jev-pool.test.ts src/lib/jev-shadow.ts src/lib/pipeline.ts
git commit -m "feat(jev): store shadow evaluations and run them after curation"
```

---

### Task 4: Report aggregation and backfill script

**Files:**
- Create: `src/lib/jev-report.ts`, `src/lib/jev-report.test.ts`, `src/lib/jev-report-data.ts`, `scripts/jev-backfill.ts`

**Interfaces:**
- Consumes: `deriveVerdict`, `DEFAULT_THRESHOLDS`, `JevThresholds`, `JevVerdict`, `QUESTION_SET` from `src/lib/jev.ts`; `shadowEvaluate` from `src/lib/jev-shadow.ts`; `prisma`
- Produces:
  - `src/lib/jev-report.ts`:
    - `type BaselineGroup = "keyword" | "ollama_reject" | "ollama_keep" | "pending"`
    - `interface ReportRow { articleId: string; title: string; sourceName: string; language: string; createdAt: Date; curatedAt: Date | null; flaggedAt: Date | null; rejectionPass: number | null; rejectionReason: string | null; model: string; positiveP: number; upliftingP: number; topCategory: string; topCategoryP: number }`
    - `baselineGroup(r: Pick<ReportRow, "rejectionPass" | "curatedAt">): BaselineGroup`
    - `interface Agreement { total: number; agree: number; rate: number | null; keepKeep: number; keepReject: number; rejectKeep: number; rejectReject: number }` (first word is Ollama, second is Jev)
    - `interface Disagreement { row: ReportRow; group: Exclude<BaselineGroup, "pending">; verdict: JevVerdict; direction: "jev_keeps" | "jev_rejects" }`
    - `interface JevReport { evaluated: number; models: string[]; groups: Record<BaselineGroup, number>; agreement: { all: Agreement; fi: Agreement; en: Agreement }; flagged: { total: number; jevRejects: number; rate: number | null }; keyword: { total: number; jevKeeps: number; rate: number | null }; disagreements: Disagreement[] }`
    - `buildReport(rows: ReportRow[], thresholds?: JevThresholds): JevReport`
  - `src/lib/jev-report-data.ts`: `loadReportRows(max?: number): Promise<ReportRow[]>`

- [ ] **Step 1: Write the failing tests in `src/lib/jev-report.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { baselineGroup, buildReport, type ReportRow } from "./jev-report";

const KEEP = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.1 };
const REJECT = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.9 };

let seq = 0;
function row(overrides: Partial<ReportRow>, jev: typeof KEEP = KEEP): ReportRow {
  seq++;
  return {
    articleId: `a${seq}`,
    title: `Article ${seq}`,
    sourceName: "Yle",
    language: "fi",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    curatedAt: null,
    flaggedAt: null,
    rejectionPass: null,
    rejectionReason: null,
    model: "jev-1.13.0",
    ...jev,
    ...overrides,
  };
}

const curated = new Date(Date.UTC(2026, 9, 1));

describe("baselineGroup", () => {
  it("classifies keyword, Ollama reject, Ollama keep and pending", () => {
    expect(baselineGroup({ rejectionPass: 0, curatedAt: null })).toBe("keyword");
    expect(baselineGroup({ rejectionPass: 1, curatedAt: curated })).toBe("ollama_reject");
    expect(baselineGroup({ rejectionPass: 2, curatedAt: curated })).toBe("ollama_reject");
    expect(baselineGroup({ rejectionPass: null, curatedAt: curated })).toBe("ollama_keep");
    expect(baselineGroup({ rejectionPass: null, curatedAt: null })).toBe("pending");
  });
});

describe("buildReport", () => {
  it("returns null rates and empty lists for no rows", () => {
    const r = buildReport([]);
    expect(r.evaluated).toBe(0);
    expect(r.agreement.all.rate).toBeNull();
    expect(r.agreement.fi.rate).toBeNull();
    expect(r.flagged.rate).toBeNull();
    expect(r.keyword.rate).toBeNull();
    expect(r.disagreements).toEqual([]);
    expect(r.models).toEqual([]);
  });

  it("computes agreement and the 2x2 matrix over Ollama groups only", () => {
    const rows = [
      row({ curatedAt: curated }, KEEP),                         // keep / keep
      row({ curatedAt: curated }, REJECT),                       // keep / reject
      row({ curatedAt: curated, rejectionPass: 1 }, KEEP),       // reject / keep
      row({ curatedAt: curated, rejectionPass: 2 }, REJECT),     // reject / reject
      row({ rejectionPass: 0 }, KEEP),                           // keyword: excluded
      row({}, REJECT),                                           // pending: excluded
    ];
    const a = buildReport(rows).agreement.all;
    expect(a).toEqual({ total: 4, agree: 2, rate: 0.5, keepKeep: 1, keepReject: 1, rejectKeep: 1, rejectReject: 1 });
  });

  it("splits agreement by language and leaves an empty language null", () => {
    const rows = [
      row({ curatedAt: curated, language: "fi" }, KEEP),
      row({ curatedAt: curated, language: "fi" }, REJECT),
      row({ curatedAt: curated, language: "sv" }, KEEP),
    ];
    const r = buildReport(rows);
    expect(r.agreement.fi).toMatchObject({ total: 2, agree: 1, rate: 0.5 });
    expect(r.agreement.en).toMatchObject({ total: 0, rate: null });
    expect(r.agreement.all.total).toBe(3);
  });

  it("measures flagged articles Jev rejects and keyword rejects Jev keeps", () => {
    const rows = [
      row({ curatedAt: curated, flaggedAt: curated }, REJECT),
      row({ curatedAt: curated, flaggedAt: curated }, KEEP),
      row({ rejectionPass: 0 }, KEEP),
      row({ rejectionPass: 0 }, KEEP),
      row({ rejectionPass: 0 }, REJECT),
      row({ flaggedAt: curated }, REJECT), // flagged before curation: pending, not counted
    ];
    const r = buildReport(rows);
    expect(r.flagged).toEqual({ total: 2, jevRejects: 1, rate: 0.5 });
    expect(r.keyword.total).toBe(3);
    expect(r.keyword.jevKeeps).toBe(2);
    expect(r.keyword.rate).toBeCloseTo(2 / 3);
    expect(r.groups).toEqual({ keyword: 3, ollama_reject: 0, ollama_keep: 2, pending: 1 });
  });

  it("lists disagreements newest first with direction, excluding pending", () => {
    const older = row({ curatedAt: curated, rejectionPass: 1 }, KEEP);
    const newer = row({ curatedAt: curated }, REJECT);
    const kw = row({ rejectionPass: 0 }, KEEP);
    const agreeing = row({ curatedAt: curated }, KEEP);
    const pending = row({}, REJECT);
    const d = buildReport([older, newer, kw, agreeing, pending]).disagreements;
    expect(d.map((x) => x.row.articleId)).toEqual([kw.articleId, newer.articleId, older.articleId]);
    expect(d.map((x) => x.direction)).toEqual(["jev_keeps", "jev_rejects", "jev_keeps"]);
    expect(d[1].verdict.topCategory).toBe("cat_war");
  });

  it("applies custom thresholds", () => {
    const rows = [row({ curatedAt: curated }, { ...KEEP, topCategoryP: 0.5 })];
    expect(buildReport(rows).agreement.all.agree).toBe(1);
    expect(buildReport(rows, { positiveMin: 0.5, upliftingMin: 0.5, categoryMax: 0.4 }).agreement.all.agree).toBe(0);
  });

  it("lists distinct models", () => {
    const rows = [row({ model: "jev-1.13.0" }), row({ model: "jev-1.13.0" }), row({ model: "jev-1.14.0" })];
    expect(buildReport(rows).models).toEqual(["jev-1.13.0", "jev-1.14.0"]);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm test src/lib/jev-report.test.ts`
Expected: FAIL, because `./jev-report` cannot be resolved.

- [ ] **Step 3: Implement `src/lib/jev-report.ts`**

```ts
/**
 * Pure aggregation for the Jev vs Ollama comparison. Used by the admin page
 * and the backfill script so both report identical numbers.
 */

import { DEFAULT_THRESHOLDS, deriveVerdict, type JevThresholds, type JevVerdict } from "./jev";

export type BaselineGroup = "keyword" | "ollama_reject" | "ollama_keep" | "pending";

export interface ReportRow {
  articleId: string;
  title: string;
  sourceName: string;
  language: string;
  createdAt: Date;
  curatedAt: Date | null;
  flaggedAt: Date | null;
  rejectionPass: number | null;
  rejectionReason: string | null;
  model: string;
  positiveP: number;
  upliftingP: number;
  topCategory: string;
  topCategoryP: number;
}

/** Ollama keep/reject first, Jev keep/reject second. */
export interface Agreement {
  total: number;
  agree: number;
  rate: number | null;
  keepKeep: number;
  keepReject: number;
  rejectKeep: number;
  rejectReject: number;
}

export interface Disagreement {
  row: ReportRow;
  group: Exclude<BaselineGroup, "pending">;
  verdict: JevVerdict;
  direction: "jev_keeps" | "jev_rejects";
}

export interface JevReport {
  evaluated: number;
  models: string[];
  groups: Record<BaselineGroup, number>;
  agreement: { all: Agreement; fi: Agreement; en: Agreement };
  flagged: { total: number; jevRejects: number; rate: number | null };
  keyword: { total: number; jevKeeps: number; rate: number | null };
  disagreements: Disagreement[];
}

export function baselineGroup(r: Pick<ReportRow, "rejectionPass" | "curatedAt">): BaselineGroup {
  if (r.rejectionPass === 0) return "keyword";
  if (r.rejectionPass === 1 || r.rejectionPass === 2) return "ollama_reject";
  if (r.curatedAt) return "ollama_keep";
  return "pending";
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function emptyAgreement(): Agreement {
  return { total: 0, agree: 0, rate: null, keepKeep: 0, keepReject: 0, rejectKeep: 0, rejectReject: 0 };
}

function addToAgreement(a: Agreement, ollamaKeep: boolean, jevKeep: boolean): void {
  a.total++;
  if (ollamaKeep === jevKeep) a.agree++;
  if (ollamaKeep && jevKeep) a.keepKeep++;
  else if (ollamaKeep) a.keepReject++;
  else if (jevKeep) a.rejectKeep++;
  else a.rejectReject++;
}

export function buildReport(rows: ReportRow[], thresholds: JevThresholds = DEFAULT_THRESHOLDS): JevReport {
  const groups: Record<BaselineGroup, number> = { keyword: 0, ollama_reject: 0, ollama_keep: 0, pending: 0 };
  const agreement = { all: emptyAgreement(), fi: emptyAgreement(), en: emptyAgreement() };
  const flagged = { total: 0, jevRejects: 0 };
  const keyword = { total: 0, jevKeeps: 0 };
  const disagreements: Disagreement[] = [];

  for (const row of rows) {
    const group = baselineGroup(row);
    groups[group]++;
    if (group === "pending") continue;

    const verdict = deriveVerdict(row, thresholds);
    const baselineKeep = group === "ollama_keep";

    if (group === "keyword") {
      keyword.total++;
      if (verdict.keep) keyword.jevKeeps++;
    } else {
      addToAgreement(agreement.all, baselineKeep, verdict.keep);
      if (row.language === "fi") addToAgreement(agreement.fi, baselineKeep, verdict.keep);
      if (row.language === "en") addToAgreement(agreement.en, baselineKeep, verdict.keep);
    }

    if (group === "ollama_keep" && row.flaggedAt) {
      flagged.total++;
      if (!verdict.keep) flagged.jevRejects++;
    }

    if (verdict.keep !== baselineKeep) {
      disagreements.push({ row, group, verdict, direction: verdict.keep ? "jev_keeps" : "jev_rejects" });
    }
  }

  for (const a of Object.values(agreement)) a.rate = ratio(a.agree, a.total);
  disagreements.sort((x, y) => y.row.createdAt.getTime() - x.row.createdAt.getTime());

  return {
    evaluated: rows.length,
    models: [...new Set(rows.map((r) => r.model))].sort(),
    groups,
    agreement,
    flagged: { ...flagged, rate: ratio(flagged.jevRejects, flagged.total) },
    keyword: { ...keyword, rate: ratio(keyword.jevKeeps, keyword.total) },
    disagreements,
  };
}
```

- [ ] **Step 4: Run the report tests**

Run: `pnpm test src/lib/jev-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/lib/jev-report-data.ts`**

```ts
import { prisma } from "./prisma";
import { QUESTION_SET } from "./jev";
import type { ReportRow } from "./jev-report";

/** Latest evaluations for the current question set, flattened for buildReport. */
export async function loadReportRows(max = 5000): Promise<ReportRow[]> {
  const evaluations = await prisma.jevEvaluation.findMany({
    where: { questionSet: QUESTION_SET },
    orderBy: { createdAt: "desc" },
    take: max,
    select: {
      model: true,
      positiveP: true,
      upliftingP: true,
      topCategory: true,
      topCategoryP: true,
      article: {
        select: {
          id: true,
          title: true,
          createdAt: true,
          curatedAt: true,
          flaggedAt: true,
          rejectionPass: true,
          rejectionReason: true,
          source: { select: { name: true, language: true } },
        },
      },
    },
  });

  return evaluations.map((e) => ({
    articleId: e.article.id,
    title: e.article.title,
    sourceName: e.article.source.name,
    language: e.article.source.language,
    createdAt: e.article.createdAt,
    curatedAt: e.article.curatedAt,
    flaggedAt: e.article.flaggedAt,
    rejectionPass: e.article.rejectionPass,
    rejectionReason: e.article.rejectionReason,
    model: e.model,
    positiveP: e.positiveP,
    upliftingP: e.upliftingP,
    topCategory: e.topCategory,
    topCategoryP: e.topCategoryP,
  }));
}
```

- [ ] **Step 6: Implement `scripts/jev-backfill.ts`**

```ts
/**
 * Evaluates already-ingested non-trusted articles with Jev and prints the
 * comparison against Ollama. Safe to re-run: evaluated articles are skipped.
 *
 * Usage: pnpm jev:backfill [--days 30] [--limit 500] [--concurrency 5]
 */
import "./load-env";
import { prisma } from "../src/lib/prisma";
import { DEFAULT_THRESHOLDS, isJevConfigured, QUESTION_SET } from "../src/lib/jev";
import { shadowEvaluate } from "../src/lib/jev-shadow";
import { buildReport, type Agreement } from "../src/lib/jev-report";
import { loadReportRows } from "../src/lib/jev-report-data";

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number.parseInt(process.argv[i + 1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const line = (label: string, a: Agreement) =>
  `  ${label.padEnd(4)} ${pct(a.rate).padStart(4)} of ${a.total}  ` +
  `(O keep/J keep ${a.keepKeep}, O keep/J reject ${a.keepReject}, O reject/J keep ${a.rejectKeep}, O reject/J reject ${a.rejectReject})`;

async function main() {
  if (!isJevConfigured()) {
    console.error("TYPESAFE_API_KEY is not set (.env.local or .env)");
    process.exit(1);
  }

  const days = intArg("days", 30);
  const limit = intArg("limit", 500);
  const concurrency = intArg("concurrency", 5);

  console.log(`[jev-backfill] question set ${QUESTION_SET}, last ${days} days, limit ${limit}, concurrency ${concurrency}`);
  const { evaluated, failed } = await shadowEvaluate({
    since: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    limit,
    concurrency,
  });
  console.log(`[jev-backfill] ${evaluated} evaluated, ${failed} failed\n`);

  const report = buildReport(await loadReportRows(), DEFAULT_THRESHOLDS);
  console.log(`Evaluations: ${report.evaluated} (models: ${report.models.join(", ") || "—"})`);
  console.log(`Groups: ${JSON.stringify(report.groups)}`);
  console.log("Agreement with Ollama:");
  console.log(line("all", report.agreement.all));
  console.log(line("fi", report.agreement.fi));
  console.log(line("en", report.agreement.en));
  console.log(`Reader-flagged that Jev rejects: ${pct(report.flagged.rate)} of ${report.flagged.total}`);
  console.log(`Keyword-rejected that Jev keeps: ${pct(report.keyword.rate)} of ${report.keyword.total}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[jev-backfill] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 7: Run the backfill against the local database**

The local database is empty, so seed it first. Without Ollama locally, curation fails open, which is enough to exercise the code path:

```bash
pnpm seed
pnpm jev:backfill --days 2 --limit 40
pnpm jev:backfill --days 2 --limit 40
```

Expected: the first backfill run reports `40 evaluated, 0 failed` (or fewer if fewer non-trusted articles exist) and prints the summary with no exception. The second run reports `0 evaluated`, because evaluated articles are skipped. Confirm the rows with `pnpm prisma studio` or:

```bash
docker exec pn-jev-pg psql -U pn -d positivenews -c 'select count(*), min("positiveP"), max("topCategoryP") from "JevEvaluation";'
```

If `pnpm seed` fails on Redis, start one with `docker run -d --name pn-jev-redis -p 6379:6379 redis:7-alpine` and retry. The classifier falls back to the database without Redis, but ingest may still log Redis errors.

- [ ] **Step 8: Verify**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`
Expected: all tests pass, with no type or lint errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/jev-report.ts src/lib/jev-report.test.ts src/lib/jev-report-data.ts scripts/jev-backfill.ts
git commit -m "feat(jev): add comparison report and backfill script"
```

---

### Task 5: Admin page `/admin/jev`

**Files:**
- Create: `app/admin/jev/page.tsx`, `app/admin/jev/JevReportView.tsx`
- Modify: `app/admin/layout.tsx`

**Interfaces:**
- Consumes: `loadReportRows` from `src/lib/jev-report-data.ts`; `buildReport`, `JevReport`, `Disagreement`, `Agreement` from `src/lib/jev-report.ts`; `DEFAULT_THRESHOLDS`, `QUESTION_SET`, `CATEGORIES` from `src/lib/jev.ts`
- Produces: the route `/admin/jev` (browser URL `/news/admin/jev`)

- [ ] **Step 1: Check the Next.js page conventions**

Read the App Router page and `searchParams` docs in `node_modules/next/dist/docs/` (for example `grep -rl "searchParams" node_modules/next/dist/docs | head`). Confirm that page `searchParams` is a `Promise` in this version. If the docs say otherwise, adapt the `JevPage` signature in Step 2 to match, and note the difference in the commit message.

- [ ] **Step 2: Create `app/admin/jev/page.tsx`**

```tsx
// app/admin/jev/page.tsx
import { DEFAULT_THRESHOLDS, QUESTION_SET } from "@/src/lib/jev";
import { buildReport } from "@/src/lib/jev-report";
import { loadReportRows } from "@/src/lib/jev-report-data";
import { JevReportView, type JevFilters } from "./JevReportView";

export const dynamic = "force-dynamic";

const DIRECTIONS = ["jev_keeps", "jev_rejects"] as const;
const LANGUAGES = ["fi", "en"] as const;
const GROUPS = ["keyword", "ollama_reject", "ollama_keep"] as const;

type SearchParams = Record<string, string | string[] | undefined>;

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function JevPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filters: JevFilters = {
    direction: pick(params.direction, DIRECTIONS),
    lang: pick(params.lang, LANGUAGES),
    group: pick(params.group, GROUPS),
  };

  const rows = await loadReportRows();
  const report = buildReport(rows, DEFAULT_THRESHOLDS);

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Jev shadow comparison</h1>
        <p className="text-sm text-muted-foreground">
          TypeSafe Jev evaluated next to the Ollama curator. Jev does not affect the live feed.
        </p>
      </div>

      {report.evaluated === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Jev evaluations yet. Set <code className="font-mono">TYPESAFE_API_KEY</code> and run{" "}
          <code className="font-mono">pnpm jev:backfill</code>, or wait for the next pipeline run.
        </p>
      ) : (
        <JevReportView
          report={report}
          filters={filters}
          questionSet={QUESTION_SET}
          thresholds={DEFAULT_THRESHOLDS}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `app/admin/jev/JevReportView.tsx`**

```tsx
// app/admin/jev/JevReportView.tsx
import Link from "next/link";
import { CATEGORIES, type JevThresholds } from "@/src/lib/jev";
import type { Agreement, Disagreement, JevReport } from "@/src/lib/jev-report";

export interface JevFilters {
  direction?: "jev_keeps" | "jev_rejects";
  lang?: "fi" | "en";
  group?: "keyword" | "ollama_reject" | "ollama_keep";
}

const TABLE_ROWS = 300;

const GROUP_LABELS: Record<Disagreement["group"], string> = {
  keyword: "Keyword reject",
  ollama_reject: "Ollama reject",
  ollama_keep: "Ollama keep",
};

const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const prob = (p: number) => p.toFixed(2);

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold text-foreground tabular-nums mt-1">{value}</div>
      <div className="text-xs text-muted-foreground tabular-nums mt-0.5">{detail}</div>
    </div>
  );
}

function Matrix({ a }: { a: Agreement }) {
  const cell = "px-4 py-2.5 text-right tabular-nums";
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Ollama ↓ / Jev →</th>
            <th className="text-right px-4 py-2.5 font-medium">Keep</th>
            <th className="text-right px-4 py-2.5 font-medium">Reject</th>
          </tr>
        </thead>
        <tbody className="text-xs">
          <tr className="border-b border-border/60">
            <td className="px-4 py-2.5 text-muted-foreground">Keep</td>
            <td className={cell}>{a.keepKeep}</td>
            <td className={cell}>{a.keepReject}</td>
          </tr>
          <tr>
            <td className="px-4 py-2.5 text-muted-foreground">Reject</td>
            <td className={cell}>{a.rejectKeep}</td>
            <td className={cell}>{a.rejectReject}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FilterLink({ filters, patch, label }: { filters: JevFilters; patch: Partial<JevFilters>; label: string }) {
  const next = { ...filters, ...patch };
  const active = (Object.keys(patch) as (keyof JevFilters)[]).every((k) => filters[k] === patch[k]);
  const query = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return (
    <Link
      href={{ pathname: "/admin/jev", query }}
      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function Filters({ filters }: { filters: JevFilters }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
      <div className="flex items-center gap-1">
        <FilterLink filters={filters} patch={{ direction: undefined }} label="All" />
        <FilterLink filters={filters} patch={{ direction: "jev_keeps" }} label="Jev keeps" />
        <FilterLink filters={filters} patch={{ direction: "jev_rejects" }} label="Jev rejects" />
      </div>
      <div className="flex items-center gap-1">
        <FilterLink filters={filters} patch={{ lang: undefined }} label="All languages" />
        <FilterLink filters={filters} patch={{ lang: "fi" }} label="FI" />
        <FilterLink filters={filters} patch={{ lang: "en" }} label="EN" />
      </div>
      <div className="flex items-center gap-1">
        <FilterLink filters={filters} patch={{ group: undefined }} label="All groups" />
        <FilterLink filters={filters} patch={{ group: "ollama_keep" }} label="Ollama keep" />
        <FilterLink filters={filters} patch={{ group: "ollama_reject" }} label="Ollama reject" />
        <FilterLink filters={filters} patch={{ group: "keyword" }} label="Keyword reject" />
      </div>
    </div>
  );
}

function DisagreementTable({ rows }: { rows: Disagreement[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No disagreements match these filters.</p>;
  }
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Baseline</th>
            <th className="text-left px-4 py-2.5 font-medium">Jev</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Pos / Upl</th>
            <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Top category</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, group, verdict, direction }, i) => (
            <tr
              key={row.articleId}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-2.5">
                <span className="line-clamp-2 text-xs text-foreground">{row.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {row.sourceName} · {row.language.toUpperCase()}
                  {row.flaggedAt ? " · reader-flagged" : ""}
                </span>
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                <div>{GROUP_LABELS[group]}</div>
                {row.rejectionReason && <div className="font-mono text-[11px]">{row.rejectionReason}</div>}
              </td>
              <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                <span className={direction === "jev_keeps" ? "text-[#3d8b5e]" : "text-[#c44b3f]"}>
                  {direction === "jev_keeps" ? "Keep" : "Reject"}
                </span>
                {verdict.reason && (
                  <div className="font-mono text-[11px] text-muted-foreground">{verdict.reason}</div>
                )}
              </td>
              <td className="px-4 py-2.5 text-xs text-right tabular-nums hidden sm:table-cell whitespace-nowrap">
                {prob(row.positiveP)} / {prob(row.upliftingP)}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                {CATEGORIES[row.topCategory]?.label ?? row.topCategory}{" "}
                <span className="tabular-nums">{prob(row.topCategoryP)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JevReportView({
  report,
  filters,
  questionSet,
  thresholds,
}: {
  report: JevReport;
  filters: JevFilters;
  questionSet: string;
  thresholds: JevThresholds;
}) {
  const { agreement, flagged, keyword } = report;
  const filtered = report.disagreements.filter(
    (d) =>
      (!filters.direction || d.direction === filters.direction) &&
      (!filters.lang || d.row.language === filters.lang) &&
      (!filters.group || d.group === filters.group),
  );

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground tabular-nums">
        {report.evaluated} evaluations · model {report.models.join(", ")} · question set {questionSet} ·
        thresholds positive ≥ {thresholds.positiveMin}, uplifting ≥ {thresholds.upliftingMin}, category ≤{" "}
        {thresholds.categoryMax} · {report.groups.pending} pending curation (excluded)
      </p>

      <section>
        <h2 className="text-lg font-medium text-foreground mb-3">Agreement with Ollama</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatTile label="All" value={pct(agreement.all.rate)} detail={`${agreement.all.agree} of ${agreement.all.total}`} />
          <StatTile label="Finnish" value={pct(agreement.fi.rate)} detail={`${agreement.fi.agree} of ${agreement.fi.total}`} />
          <StatTile label="English" value={pct(agreement.en.rate)} detail={`${agreement.en.agree} of ${agreement.en.total}`} />
        </div>
        <Matrix a={agreement.all} />
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatTile
          label="Reader-flagged articles Jev would reject"
          value={pct(flagged.rate)}
          detail={`${flagged.jevRejects} of ${flagged.total} (Ollama kept all of them)`}
        />
        <StatTile
          label="Keyword-rejected articles Jev would keep"
          value={pct(keyword.rate)}
          detail={`${keyword.jevKeeps} of ${keyword.total}`}
        />
      </section>

      <section>
        <h2 className="text-lg font-medium text-foreground mb-3">
          Disagreements{" "}
          <span className="text-sm text-muted-foreground tabular-nums">
            ({Math.min(filtered.length, TABLE_ROWS)} of {filtered.length})
          </span>
        </h2>
        <Filters filters={filters} />
        <DisagreementTable rows={filtered.slice(0, TABLE_ROWS)} />
      </section>
    </div>
  );
}
```

The keep and reject colours are DESIGN.md's semantic success `#3d8b5e` and error `#c44b3f`. If `globals.css` exposes these as theme tokens (check `app/globals.css` for `--success` or `--destructive`), use the token classes instead of the hex values.

- [ ] **Step 4: Add the nav link**

In `app/admin/layout.tsx`, insert this after the `Flagged` `<Link>`:

```tsx
            <Link
              href="/admin/jev"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Jev
            </Link>
```

- [ ] **Step 5: Verify in the browser**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
pnpm dev
```

`.env` needs `AUTH_SECRET`, `AUTH_URL=http://localhost:3000/news`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH` to log in. Add local-only values to the worktree `.env`; dollar signs in the bcrypt hash must be escaped as `\$`. Then sign in at `http://localhost:3000/news/admin/login` and open `http://localhost:3000/news/admin/jev`. Check:
- The tiles, matrix, and table render with the backfilled data. Rates show `—` where a denominator is zero.
- Each filter link updates the URL under `/news/admin/jev?...` and narrows the table. "All" clears only its own filter.
- The "Jev" nav link works, and existing admin pages still load.
- Empty state: `docker exec pn-jev-pg psql -U pn -d positivenews -c 'delete from "JevEvaluation";'` makes the page show the "No Jev evaluations yet" message. Run `pnpm jev:backfill --days 2 --limit 40` again afterwards.

Take a screenshot for the final report.

- [ ] **Step 6: Run a production build**

Run: `pnpm build`
Expected: the build succeeds, and `/admin/jev` is listed as a dynamic route.

- [ ] **Step 7: Commit**

```bash
git add app/admin/jev app/admin/layout.tsx
git commit -m "feat(admin): add Jev shadow comparison page"
```

---

### Task 6: CI, docs, and environment template

**Files:**
- Modify: `.github/workflows/<the deploy workflow>.yml`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: the `test`, `jev:smoke`, and `jev:backfill` scripts from Tasks 1, 2, and 4
- Produces: none

- [ ] **Step 1: Enable tests in CI**

In the workflow under `.github/workflows/`, replace:

```yaml
      # Uncomment when tests are added (sub-projects B/C/D):
      # - name: Test
      #   run: pnpm test
```

with:

```yaml
      - name: Test
        run: pnpm test
```

- [ ] **Step 2: Document the variables in `.env.example`**

Append:

```env

# TypeSafe Jev shadow evaluation (optional — shadow step is skipped when unset)
# TYPESAFE_API_KEY=
# Optional overrides (defaults: jev-1.13.0 on https://api.typesafe.ai)
# TYPESAFE_DEFAULT_MODEL=jev-1.13.0
# TYPESAFE_BASE_URL=
```

- [ ] **Step 3: Document it in `README.md`**

After the `### Run` section, add:

````markdown
### Jev shadow evaluation (optional)

With `TYPESAFE_API_KEY` set, every pipeline run also evaluates recent non-trusted articles with [TypeSafe Jev](https://docs.typesafe.ai) and stores the answers in `JevEvaluation`. Jev does not change what the feed shows. Compare it with the Ollama curator at `/news/admin/jev`.

```bash
pnpm jev:smoke                          # live check of fixed FI/EN headlines
pnpm jev:backfill --days 30 --limit 500 # evaluate existing articles and print the comparison
```

Bump `QUESTION_SET` in `src/lib/jev.ts` after changing any question so old and new results are not mixed.
````

- [ ] **Step 4: Verify and commit**

Run: `pnpm lint && pnpm test`
Expected: both pass.

```bash
git add .github/workflows .env.example README.md
git commit -m "chore: run tests in CI and document Jev shadow setup"
```

---

## Deployment notes (for the orchestrator, not an implementation task)

- The deploy workflow does **not** run migrations. Before or right after merge, run `npx prisma migrate deploy` on the server, or `/admin/jev` will fail. The pipeline shadow step would also fail, but its catch-all only logs.
- The shadow step stays off until `TYPESAFE_API_KEY` is added to the server `.env` and `pm2 restart positivenews` runs.
- After that, run `pnpm jev:backfill --days 30 --limit 500` on the server for the real comparison, since the local database has no meaningful Ollama labels.
- Clean up the local containers afterwards: `docker rm -f pn-jev-pg pn-jev-redis`.
