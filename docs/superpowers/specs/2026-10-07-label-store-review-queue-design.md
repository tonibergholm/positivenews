# Label Store and Review Queue: Design Spec
**Date:** 2026-10-07 (revised after Sol review)
**Scope:** Piece 1 of the self-learning filtering work. Record every filtering judgement as an event, give the admin a daily review queue whose decisions are final, derive one training label per article, export a training file with a leak-free test cohort, and score each source against the admin's decisions.

Later pieces build on this one:
2. Laya fine-tuning and serving.
3. The self-learning loop, with scheduled retraining and an LLM judge.
4. Switching the live filter.

---

## Problem

The filter produces judgements in several places, but the data model can't use them for learning:

- **Reader flags carry no per-article identity.** A reader flag is one boolean on the article. The first flag hides the article for everyone, and later flags are dropped. IPs are recorded only per keyword.
- **Admin overrides overwrite history.** Un-reject and unflag overwrite article fields, so the record of being overruled is lost.
- **The admin can't reject.** There is no way to remove an article that slipped through.
- **Ollama approvals keep no trace of how they were reached.** Approvals store only `curatedAt`, so a real approval can't be told apart from an outage keep (`LLM unavailable`, `LLM pass 2 unavailable`) or from a missing result that the code records as `passed both checks` (`src/lib/llm-curator.ts:196,231,241`).
- **There is no human ground truth.** In production Jev and Ollama agree on 24% of articles, and without labels there is no way to say which one is right.

## Goals

- An append-only, auditable record of every discrete judgement, with source, eligibility for training, and the review bucket it came from.
- One serialised write path, so admin decisions are final and no other writer can overwrite them.
- A phone-friendly daily review queue of about 20 articles with fixed bucket quotas.
- A fixed, deterministic test cohort that never enters training exports, so evaluation can't leak.
- One resolved training label per article, exported as JSONL, with targeted admin decisions usable for training.
- A scoreboard that rates each source against admin decisions, with random-cohort results reported separately from targeted ones.

## Non-goals

- Laya training or serving (piece 2).
- An LLM judge, scheduled retraining, or question and keyword suggestions (piece 3).
- Changing which model decides the live feed (piece 4).
- Changing how reader flags affect the feed. One flag still hides an article unless an admin decision exists.
- Recovering past admin un-rejects and unflags.
- Detecting near-duplicate or syndicated stories across splits. This is a known limitation; URL uniqueness is the only dedupe.

---

## Data model

One additive migration.

```prisma
model LabelEvent {
  id         String   @id @default(cuid())
  article    Article  @relation(fields: [articleId], references: [id], onDelete: Cascade)
  articleId  String
  source     String   // "reader_flag" | "admin" | "ollama" | "keyword"  (later: "llm_judge")
  verdict    String   // "keep" | "reject" | "retract"  (retract: admin undo)
  category   String?  // Jev CATEGORIES key (cat_*), admin rejects only
  actor      String?  // reader: HMAC of IP; admin: email; ollama: model name; keyword: null
  reason     String?  // human-readable only; never used for logic
  pass       Int?     // Ollama pass (1 or 2)
  eligible   Boolean  @default(true)  // false: may not be used for training or scoring
  bucket     String?  // admin events: "flagged" | "leak" | "miss" | "cohort" | "manual"
  retractsId String?  // admin "retract" events: id of the admin event being undone
  prevState  Json?    // admin keep/reject: article state before the decision (for undo)
  dedupeKey  String?  @unique  // idempotency: reader votes and backfill imports
  backfilled Boolean  @default(false)
  createdAt  DateTime @default(now())

  @@index([articleId, createdAt])
  @@index([source, createdAt])
}
```

`Article` gets `labelEvents LabelEvent[]` and `@@index([createdAt])`, because the queue query filters on it.

Values are validated in code against exported constants: `LABEL_SOURCES`, `VERDICTS`, `REVIEW_BUCKETS`, and `CATEGORIES` from `src/lib/jev.ts`.

**`dedupeKey` values:**
- Reader vote: `flag:<articleId>:<actorHash>`. With no actor, it stays null and is never deduped.
- Backfill: `backfill:<articleId>:<kind>`, where `kind` is `keyword`, `ollama` or `flag`.
- Every other event: null.

PostgreSQL treats NULLs as distinct, so the unique constraint applies only where a key is set.

**`rejectionPass = 3`** is a new value meaning "rejected by admin". Its `rejectionReason` is `admin: <category label>`, or `admin`.

Model probabilities stay in `JevEvaluation` (and later a Laya table) and are joined at export.

---

## The serialised decision path

`src/lib/article-decisions.ts` is the only code allowed to change an article's feed state (`isPositive`, `curatedAt`, `rejectionPass`, `rejectionReason`, `flaggedAt`) or write a `LabelEvent`. Every function:

1. Opens a transaction.
2. Locks the article with `SELECT id FROM "Article" WHERE id = $1 FOR UPDATE`.
3. Re-reads the article and its current admin authority, meaning the latest admin keep/reject event that has not been retracted, inside the lock.
4. Writes the event and the state change, or only the event, according to the rules below.
5. Commits.

Event and state writes are atomic: if either fails, both roll back and the caller sees the error. Ordering of admin events is defined by the lock order: an event's `createdAt` is set inside the locked transaction, with `id` as the tiebreak.

| Function | Caller | Rule |
|---|---|---|
| `recordKeywordReject(tx, articleId, reason)` | ingest, in the create transaction | New article: event plus the existing pass-0 fields. No lock needed, since the row is new. |
| `recordOllamaResult(articleId, outcome)` | curate, per article | If admin authority exists: write the event (eligible as below) but **do not change state**. Otherwise apply the state change as today. |
| `recordReaderFlag(articleId, actorHash)` | flag route | Write the vote event; a duplicate `dedupeKey` is a no-op. Hide the article and advance learned-keyword counters only if `flaggedAt` is null **and** no admin authority exists. |
| `recordAdminDecision(articleId, verdict, { category, bucket, actor })` | review queue, un-reject, unflag | Store `prevState` (the article fields before the change), write the event, apply the state change. |
| `retractAdminDecision(eventId, actor)` | review Undo | Allowed only if `eventId` is the current admin authority for its article; otherwise "decision changed elsewhere". Write a `retract` event with `retractsId` and restore the article to that event's `prevState`. |

**Admin state changes:**
- Keep sets `isPositive = true`, `curatedAt ??= now`, `rejectionPass = null`, `rejectionReason = null`. `flaggedAt` is kept for history.
- Reject sets `isPositive = false`, `rejectionPass = 3`, `rejectionReason = admin: <label>`.

The existing `unrejectArticle` and `unflagArticle` actions become thin wrappers around `recordAdminDecision(..., "keep", { bucket: "manual" })`, so unflag now also clears stale rejection fields.

`scripts/backfill-classify.ts` changes articles directly. It will skip any article that has admin authority, and its header will mark it legacy.

### Ollama outcomes

`curateArticles` returns an explicit `outcome` per article. Training eligibility comes from this outcome, never from reason text:

| Outcome | When | Event | `eligible` |
|---|---|---|---|
| `judged_reject` | pass 1 or pass 2 returned a reject for this id | `ollama / reject`, pass | true |
| `judged_keep` | pass 1 **and** pass 2 both returned an affirmative result for this id | `ollama / keep`, pass 2 | true |
| `unavailable` | the pass-1 or pass-2 call failed | `ollama / keep`, reason `LLM unavailable` | false |
| `missing_result` | the call succeeded but this id was missing from pass 1 or pass 2 | `ollama / keep`, reason `missing result` | false |

The feed behaviour of each outcome is unchanged: missing or unavailable still keeps the article (fail-open).

### Reader identity

`actorHash` is HMAC-SHA256 of the first `x-forwarded-for` IP, keyed by `AUTH_SECRET`, as hex. If `AUTH_SECRET` is missing, the actor is null: the vote is recorded but can't be deduped, and a warning is logged. IP counts are weak evidence, because shared networks merge readers, changing addresses split them, and rotating the secret resets identities. The weights below treat flags accordingly.

---

## History import

`scripts/labels-backfill.ts [--before <ISO>]`. `--before` defaults to now. Only articles with `createdAt < before` are considered.

It converts each article in one transaction per article, paging by `id` with a keyset cursor in batches of 500:

- `rejectionPass = 0` → `keyword / reject`, eligible.
- `rejectionPass IN (1, 2)` → `ollama / reject`, pass, reason, eligible.
- `curatedAt` set, `rejectionPass` null, source not trusted → `ollama / keep` with reason `historical approval (unverified)`, **`eligible = false`**. These can't be told apart from outages or admin overrides.
- `flaggedAt` set → `reader_flag / reject`, actor null.

Each event uses `dedupeKey = backfill:<articleId>:<kind>`, so re-runs and partial failures are safe. An event is also skipped when the article already has a live, non-backfilled event from the same source. `createdAt` copies the relevant article timestamp. The script ends with a count reconciliation: articles scanned, events created per kind, and events skipped.

---

## Test cohort

An article is in the **test cohort** when `sha256(articleId)` read as a number is `≡ 0 (mod 10)`, about 10% of articles. `src/lib/cohort.ts` exports `isTestCohort(articleId)`.

- Cohort articles are **never** written to a training export, whatever their label tier. That rules out leakage from weak labels exported earlier.
- The review queue's random bucket draws only from the cohort. Admin decisions on cohort articles, with `bucket = "cohort"`, form the test set.
- Admin decisions from the other buckets are gold-tier training labels.
- Thresholds and judge prompts (piece 3) must be tuned on targeted gold labels, never on the cohort.

---

## Review queue: `/admin/review`

### Selection

`src/lib/review-queue.ts` holds a pure function, `selectNext(candidates, decidedToday, { date })`, plus a Prisma loader.

Candidates are articles with `createdAt` in the last 14 days and no current admin authority. Each candidate carries:
- its Jev summary for the current `QUESTION_SET`, if any
- `flagged`: any `reader_flag` event, or `flaggedAt` set
- `inFeed`: `isPositive`
- `cohort`: `isTestCohort`

The loader limits the query to these fields and does not load event history wholesale.

Buckets and daily quotas (`QUOTAS`, summing to `DAILY_TARGET = 20`):

| Bucket | Rule | Quota |
|---|---|---|
| `flagged` | flagged | 6 |
| `leak` | in feed, and Jev `positiveP < 0.2` or `upliftingP < 0.2` or `topCategoryP > 0.8` | 5 |
| `miss` | not in feed, and Jev `positiveP > 0.8`, `upliftingP > 0.8`, `topCategoryP < 0.3` | 5 |
| `cohort` | cohort article, any state | 4 |

Each card's bucket is the first matching rule in table order, except that cohort candidates are reserved for the cohort bucket. That keeps the random test sample unbiased.

`selectNext` returns the single next card:
- Remaining quota per bucket is the quota minus today's admin events in that bucket, counted from the `bucket` column.
- Buckets take turns by remaining quota. The cohort bucket goes every fifth card while it has quota left.
- Within the flagged, leak and miss buckets the oldest candidate comes first, so items don't age out.
- Within the cohort bucket, order is a stable hash of `articleId + date`, where `date` is the Europe/Helsinki date.
- When a bucket is empty its quota passes to the others.
- After the daily target ("Keep going"), any bucket is served in the same order.

Because every decision records its bucket, the selection stays consistent across reloads and devices.

### Daily target

"Today" means admin events with `bucket` set, created since 00:00 Europe/Helsinki. The nav shows `Review 7/20`. At 20 or more, the page shows "Done for today" with a "Keep going" link.

### Card

Phone first, one article at a time:

- title, summary, source name, language, image if present, and a link to the original (new tab)
- **Keep**, **Reject** and **Skip** buttons, with large touch targets
- after Reject, chips for the 17 category labels plus **No category**. One tap submits.
- **Undo** retracts this session's last decision through `retractAdminDecision`. If another tab has decided the article since, the card says so and nothing changes.
- **Skip** hides the card for the session only.
- keyboard shortcuts on desktop: `k` keep, `r` reject (then `1`–`9`, `0` or `n` for the category), `s` skip, `u` undo
- **Model opinions stay hidden until the decision is made.** Afterwards, a strip shows for about 1.5s with what Ollama, Jev and the keyword filter said.
- The page notes that readers who already have the feed open see the change on their next load.

Decisions are admin-only server actions that call the decision path. They revalidate `/`, `/admin/review`, `/admin/rejections` and `/admin/flagged`.

### Flagged inbox

`/admin/flagged` lists **unresolved** flags only: articles with a flag and no admin authority newer than that flag. A "show resolved" toggle shows the rest.

---

## Resolved labels

`src/lib/labels.ts` holds a pure function, `resolveLabel(events, opts)`. It returns `{ label, category, tier, weight, split, bucket }`, or `null` when there is no usable signal. It ignores events where `eligible = false`, and ignores admin events that a later `retract` undid.

| Tier | Rule | Label | Weight |
|---|---|---|---|
| gold | Current admin authority | its verdict and category | 1.0 |
| flag | ≥1 reader vote, no admin authority | reject | 0.5 |
| weak | Latest eligible `ollama` event | its verdict | 0.4 |
| weak | `keyword` event and no eligible `ollama` event | reject | 0.3 |

Weights are named constants (`TIER_WEIGHTS`). They are provisional: the scoreboard measures reject precision for flags, Ollama and keywords, so piece 3 can recalibrate them. Flags don't scale with the number of distinct IPs, because IP counts are weak evidence.

`split` is `test` for cohort articles and `train` otherwise.

---

## Export: `pnpm labels:export`

`scripts/labels-export.ts --out <file>` writes JSONL. Each run takes a consistent snapshot: it reads with keyset pagination under a fixed cutoff, the timestamp when the script started, and includes only events created before it.

```json
{"articleId":"…","state":{"title":"…","summary":"…"},"language":"fi","createdAt":"…",
 "label":"reject","category":"cat_sports","tier":"gold","weight":1,"bucket":"leak",
 "split":"train","jev":{"model":"jev-1.13.0","questionSet":"v1","answers":{…}}}
```

- By default `train` rows go to `<file>` and `test` rows to `<file>.test.jsonl`. `--split train|test` writes one only.
- `state` uses `buildState` from `src/lib/jev.ts`.
- `jev` uses the current `QUESTION_SET` only. It is analysis and teacher metadata, not part of the model's text input.
- A summary prints counts by tier, split, bucket and language.

This file is the contract for piece 2.

---

## Scoreboard: "Against your decisions" on `/admin/jev`

`src/lib/scoreboard.ts` holds a pure function, `scoreSources(rows, thresholds)`. Its inputs are articles with current admin authority, each carrying its bucket and every source's verdict:
- keyword: a keyword event means reject
- Ollama: the latest eligible Ollama event
- Jev: `deriveVerdict` at the current thresholds
- reader flags: any vote means reject

It shows two tables: **Random cohort (unbiased)** and **Targeted reviews**. For each source in each table, overall and for FI and EN:
- **Jev and Ollama**, which give both keep and reject: `n`, agreement, reject precision, and wrongly hidden (articles the source rejected that the admin kept).
- **Keyword and reader flags**, which only reject: `n` (coverage) and reject precision.

Zero denominators render as "—". A note shows how many cohort labels exist; at four a day, rates firm up after several weeks.

The existing Jev report excludes every article with admin authority from its Ollama baseline, because admin keeps and rejects overwrite the Ollama fields. The scoreboard covers those articles.

---

## Existing UI touch-ups

- `RejectionsClient` adds pass 3, labelled "Admin".
- The admin nav gets the Review link with today's count.

## Rollout and migrations

This migration adds a table that live writers (ingest, curation, the flag route) depend on, so code must never run before the table exists.

**The deploy workflow therefore gets a migration step.** In `.github/workflows/deploy.yml`, `npx prisma migrate deploy` runs after `pnpm install --frozen-lockfile` and before `pnpm build`. The migrations are additive, and `migrate deploy` only applies pending migrations. This needs the user's approval, because it changes the deploy policy decided in the Jev work. If it is declined, the fallback is to run `prisma migrate deploy` on the server from the merge commit before the workflow restarts the app.

Steps:
1. Merge. The deploy migrates, builds and restarts.
2. Run `pnpm labels:backfill --before <deploy time>` on the server.
3. Review about 20 articles a day.
4. Piece 2 consumes `pnpm labels:export`.

## Failure handling

| Failure | Behaviour |
|---|---|
| Event or state write fails in any writer | The transaction rolls back. Ingest and curation log it and retry the article next run. The flag route returns 500. Admin actions show an error. |
| Curation result arrives after an admin decision | The event is recorded; state is not changed (decision path rule) |
| Undo after another tab decided | Refused with "decision changed elsewhere" |
| Duplicate reader vote or backfill event | `dedupeKey` unique violation, treated as a no-op |
| `AUTH_SECRET` missing | The vote is recorded with a null actor; a warning is logged |
| Review action on a deleted article | "Not found"; the card is skipped |

## Privacy

- HMAC with the server secret; no raw IPs in `LabelEvent`.
- `LearnedKeywordFlag` keeps its raw IPs, unchanged.
- The admin email is stored as the actor.

## Testing

Vitest covers:
- **`resolveLabel`:**
  - tier precedence
  - retraction restores the previous authority, or none
  - ineligible events are ignored
  - flags score lower than gold
  - cohort articles get `split = test`
  - null when there is no signal
- **`selectNext`:**
  - quotas and quota passing
  - cohort every fifth card, cohort reserved for its bucket
  - oldest first in targeted buckets
  - stable cohort order per Helsinki date
  - articles with admin authority and articles older than 14 days are excluded
  - "Keep going" after the target
- **`isTestCohort`:** deterministic, about 10% on a sample of ids.
- **Ollama outcome mapping** from curator results, including a missing id in pass 1 and in pass 2.
- **Decision path rules**, with pure helpers for "is admin authority" and "should change state" unit-tested. The locking itself is verified by an integration test against the local Postgres: two concurrent writers (admin keep plus curation reject) leave the admin state in place.
- **`scoreSources`:** both tables, the reject-only sources, the language split, null rates.
- **The Jev report change:** admin-decided articles are excluded.

Manual checks:
- Run the backfill twice; the second run creates 0 events.
- Two curl flags from different `X-Forwarded-For` addresses create two votes. Repeating one is a no-op.
- Exercise the review flow in a browser against a local database: keep, reject with a category, undo (including a stale undo from a second tab), skip, the shortcuts, quotas and "done for today".
- Run the export: train and test files, no cohort articles in train.
