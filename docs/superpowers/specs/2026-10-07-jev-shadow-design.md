# Jev Shadow Evaluation: Design Spec
**Date:** 2026-10-07
**Scope:** Run TypeSafe Jev next to the Ollama curator, store its answers, and compare the two on an admin page. Jev makes no live decisions.

---

## Problem

LLM curation runs on a local Ollama `gemma3:4b` (`src/lib/llm-curator.ts`). We want to know whether TypeSafe's Jev (`jev-1.13.0`, https://docs.typesafe.ai) filters better before switching to it. Jev returns calibrated probabilities for typed questions, so it can replace the two long prompts with many narrow questions. Its docs say English accuracy is best and other languages are weaker, and many of our sources are Finnish.

The decision this work supports: replace the Ollama curator, replace the keyword pre-filter too, or keep Ollama.

## Goals

- Store Jev's answers for recent and new non-trusted articles without changing any live feed decision.
- Report agreement with Ollama overall and per language, plus how each model handles articles readers flagged.
- Show whether the keyword pre-filter rejects articles Jev would keep.
- Let thresholds be tuned without calling Jev again.

## Non-goals

- Switching curation to Jev. That is a follow-up decision based on this data.
- Translating Finnish articles before evaluation.
- Changing the keyword filter, learned keywords, or existing admin pages.

---

## Components

### `src/lib/jev.ts` (new)

- Wraps `@typesafe-ai/sdk` (`TypeSafeClient`, reads `TYPESAFE_API_KEY`).
- Model pinned to `jev-1.13.0` by default. `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_BASE_URL` (both read natively by the SDK) override the model and endpoint. Any backend that serves the same `/v1/systemone` API, such as a hosted OpenJev, can then be tried with a config change only. The model ID returned in each response is stored, so results stay attributable.
- `QUESTION_SET = "v1"`. Changing any question, criterion, or the state format requires bumping this value.
- `buildState(article)`: `{ title, summary }`, with the summary cut to 300 characters to match the keyword classifier. A missing summary is omitted.
- `QUESTIONS`: the question map (see below).
- `evaluateArticle(article)`: one `systemOne` call. Returns answers, model ID, input tokens, and latency.
- `deriveVerdict(row, thresholds)`: a pure function. Returns `{ keep: boolean, reason: string | null, topCategory: string | null }`.
- `DEFAULT_THRESHOLDS`: `{ positiveMin: 0.5, upliftingMin: 0.5, categoryMax: 0.6 }`.

### Question set v1

All questions go in one request per article.

| Key | Type | Purpose |
|---|---|---|
| `positive` | Noul | Mirrors Ollama pass 1: does the article report good news that would leave a reader hopeful, inspired, or calm? |
| `uplifting` | Noul | Mirrors Ollama pass 2: is it genuine achievement, progress, or kindness, as opposed to marketing, a corporate deal, or a puff piece? |
| `uplift` | Score, 4 levels | Distressing / neutral or routine / mildly positive / clearly uplifting. Stored for analysis; not used in the verdict. |
| `cat_*` | Noul, 17 | One per rejection rule. Each one asks whether the article is mainly about that topic. |

The category Nouls are adapted from `SHARED_REJECTION_RULES` and the pass-specific exclusions in `llm-curator.ts`:

- war, military, or geopolitics
- violent crime, police, or court cases
- politics and government disputes
- disasters and accidents
- sports results and roster moves
- shopping deals and product reviews
- puzzles, quizzes, and filler
- business clickbait and CEO puff pieces
- rising costs and inflation
- layoffs and labour disputes
- health scares
- data breaches and investigations
- environmental loss and wildlife crime, including hunting or culling of wild animals
- product marketing disguised as news
- celebrity gossip and scandal
- opinion pieces about societal problems
- error reports, failures, and cancellations

Each Noul states its condition literally, with `true`/`false` criteria that name the boundary cases the current prompts already call out. Example: sports *triumphs* are not `cat_sports`; only scores, standings, transfers, and doping are. The exact wording lives in `jev.ts`.

### Verdict rule

Jev rejects an article when any of these holds:

- `positive < positiveMin`
- `uplifting < upliftingMin`
- `max(cat_*) > categoryMax`

The reason is `jev: <highest category>` when a category triggered. Otherwise it is `jev: not positive` or `jev: not uplifting`. Ties go to the first category in the question order.

### `src/lib/jev-shadow.ts` (new)

`shadowEvaluate({ since, limit, concurrency = 5 })`:

1. Selects articles with `createdAt >= since` from non-trusted sources that have no `JevEvaluation` row for the current `QUESTION_SET`, newest first, capped at `limit`. Trusted sources are identified with `FEED_SOURCES` in the same way as `curate.ts`.
2. Evaluates them with at most `concurrency` requests in flight.
3. Inserts one row per success. A duplicate insert (P2002) is ignored.
4. Logs each failure with the article ID and continues. A failed article gets no row and is retried on the next run.
5. Returns `{ evaluated, failed }`.

If `TYPESAFE_API_KEY` is unset, it returns `{ evaluated: 0, failed: 0 }` without making a call.

### Pipeline

`runPipeline` calls `shadowEvaluate({ since: now - 2 days, limit: 100 })` after `curateUnchecked`, inside a `try/catch` that only logs. The result is not added to `PipelineResult`, so existing callers and the stats stream stay unchanged.

### `scripts/jev-backfill.ts` (new)

`npx tsx scripts/jev-backfill.ts [--days 30] [--limit 500]` calls `shadowEvaluate` and prints totals plus the agreement summary. It is safe to re-run, because evaluated articles are skipped.

### `scripts/jev-smoke.ts` (new)

Sends a fixed set of about 10 FI and EN headlines (clear positives, clear negatives, and known tricky cases such as sports triumph vs. transfer, a wolf-hunting story, and an opinion column) to the live API. It prints each verdict and probability, and stores nothing. Used for manual checks when the question set changes.

---

## Data model

New Prisma model, added in one migration. `Article` gets only the back-relation.

```prisma
model JevEvaluation {
  id            String   @id @default(cuid())
  article       Article  @relation(fields: [articleId], references: [id], onDelete: Cascade)
  articleId     String
  model         String   // versioned ID returned by the API, e.g. "jev-1.13.0"
  questionSet   String   // QUESTION_SET at evaluation time
  answers       Json     // full answers map from the API
  positiveP     Float
  upliftingP    Float
  upliftScore   Float
  topCategory   String
  topCategoryP  Float
  inputTokens   Int
  latencyMs     Int
  createdAt     DateTime @default(now())

  @@unique([articleId, questionSet])
}
```

No keep/reject flag is stored. Verdicts are derived when the page renders, so changing thresholds never leaves stale data.

---

## Comparison baseline

Each evaluated article falls into exactly one group, based on its current `Article` fields:

| Group | Condition | Meaning |
|---|---|---|
| Keyword-rejected | `rejectionPass = 0` | Rejected before Ollama saw it |
| Ollama-rejected | `rejectionPass IN (1, 2)` | Ollama said reject |
| Ollama-kept | `curatedAt` set, `rejectionPass` null | Ollama said keep. Includes articles readers later flagged and admin un-rejects. |
| Pending | `curatedAt` null, `isPositive = true` | Not curated yet; excluded from agreement |

Reader-flagged articles (`flaggedAt` set) are a subset of Ollama-kept and get their own metric. An article an admin un-rejected counts as Ollama-kept. That is a small known inaccuracy, because the admin overrode Ollama. When Ollama is unavailable the curator keeps articles (fail-open) without a distinguishing marker, so those count as Ollama-kept too. During Ollama outages agreement and Jev-rejects disagreements are inflated.

---

## Admin page: `/admin/jev`

A server component that follows the `app/admin/rejections` pattern, inside the existing admin layout and auth. Styling follows DESIGN.md. It is also added to the admin navigation.

- **Header:** number of evaluated articles, model ID, question set, and the thresholds in use (`DEFAULT_THRESHOLDS`, read-only in v1).
- **Agreement:** agreement percentage over the Ollama-kept and Ollama-rejected groups, shown overall, for FI, and for EN. A 2×2 table of Ollama keep/reject against Jev keep/reject.
- **Reader-flag check:** share of flagged articles Jev rejects. Ollama kept all of these by definition.
- **Keyword check:** share of keyword-rejected articles Jev would keep, with a link to the matching rows.
- **Disagreement table:** filters for direction (Jev keeps / Ollama rejects, and the reverse), language, and group. Each row shows the title, source, language, Ollama's verdict and reason, Jev's `positive`/`uplifting` probabilities, top category with probability, and Jev's reason. The newest 300 rows are shown.

Aggregation is in `src/lib/jev-report.ts`, kept pure so it can be tested: `(rows, thresholds) => report`. The page and the backfill script both use it.

---

## Failure handling

| Failure | Behaviour |
|---|---|
| `TYPESAFE_API_KEY` missing | Shadow step does nothing; the page shows "no evaluations" |
| 429 or transient error | SDK retries with backoff. If it still fails, the error is logged and the article is retried next run. |
| 401, 403 or 404 (bad key, no permission, unknown model) | Logged once per run; the remaining articles in the run are skipped |
| 400 or 422 for one article | Logged; that article gets no row and is retried next run |
| Slow or unavailable API | Shadow step stops starting new articles after a 90-second budget; calls use a 10-second timeout and one retry |
| Malformed or missing answer | Treated as a failure: no row is written |
| Any shadow error | Caught in `runPipeline`; ingest and curation results are unaffected |

---

## Cost and limits

The cost is about 1.5k input tokens per article (state plus 20 questions) at $0.042 per million tokens. That makes 500 backfilled articles plus about 100 per run negligible. Concurrency 5 is far below the published 80 requests per second.

## Security and privacy

- Only public RSS titles and summaries are sent to TypeSafe.
- `TYPESAFE_API_KEY` goes in `.env.local` or `.env` locally and in `.env` on the server, and is never committed. New scripts load `.env.local` before `.env`. CI does not need it.

## Testing

- Add Vitest as a dev dependency with a `test` script.
- Unit tests for `deriveVerdict`: each threshold boundary, the reason priority, and tie-breaking.
- Unit tests for `jev-report`: group assignment, agreement maths, the per-language split, exclusion of pending articles, and the flagged and keyword metrics.
- Manual: run `jev-smoke.ts`, run the backfill against the dev database, and check `/admin/jev` in the browser under `/news`.

## Rollout

1. Merge with the key absent on the server, so nothing runs.
2. Add `TYPESAFE_API_KEY` to the server `.env` and run the backfill there.
3. Review `/admin/jev` and tune thresholds or bump the question set as needed.
4. Decide on the switch in a separate spec.

## Open questions

None blocking. Threshold values are expected to change after the first backfill.
