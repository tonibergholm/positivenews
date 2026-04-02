# Pipeline Improvements Design

**Date:** 2026-04-02
**Status:** Approved

## Overview

Five targeted improvements to the ingest/curation pipeline:

1. Fix the no-op `FeedSource` filter and add `isActive` to the type
2. Extract shared LLM rejection rules to eliminate prompt drift
3. 14-day article expiration via a daily cron script
4. A `/api/stats` endpoint for operational visibility
5. Replace the in-memory learned-keywords TTL cache with Redis for real-time invalidation

---

## 1. FeedSource.isActive + Filter Fix

**Files:** `src/config/sources.ts`, `src/lib/ingest.ts`

Add `isActive?: boolean` to the `FeedSource` interface. Omitting the field means active (backwards-compatible — no existing sources need updating).

Fix `ingest.ts:139`:
```ts
// Before
const activeSources = FEED_SOURCES.filter(() => true); // all active

// After
const activeSources = FEED_SOURCES.filter((f) => f.isActive !== false);
```

The `upsertSource` DB call already sets `isActive: true` on the DB record and is unchanged.

---

## 2. Shared LLM Rejection Rules

**File:** `src/lib/llm-curator.ts`

Extract the ~25 rejection criteria shared verbatim between Pass 1 and Pass 2 into a `const SHARED_REJECTION_RULES: string[]` near the top of the file. Categories in the shared list:

- Sports non-triumphs (roster moves, results, lawsuits)
- Shopping/sales/promotions
- Filler (crosswords, puzzles, quizzes, horoscopes)
- Rising costs/inflation/price complaints
- Military activity, political threats, sanctions
- Administrative/bureaucratic disputes
- Health scares (outbreaks, anti-vaccination trends)
- Cancelled events, politician illness
- Layoffs, job cuts, restructuring
- Court verdicts, convictions, criminal investigations, data breaches
- Animal attacks on people
- Infrastructure hazards, tech platform spam/outages
- Conflict of interest/cronyism
- CEO puff pieces and "what leaders said" roundups
- Entrepreneurship clickbait
- Environmental loss / wildlife crime
- Consumer product reviews and "best of" roundups

Each prompt builder interpolates `SHARED_REJECTION_RULES.join('\n- ')` into its EXCLUDE section. Pass 1 retains its unique positivity-focus framing; Pass 2 retains its unique quality-gate framing and its own unique rules (e.g. "marketing disguised as news", "good business news ONLY IF..."). The internal duplicate in Pass 2 (layoffs listed twice at lines 133–134) is removed.

**No behavioral change** — only structure.

---

## 3. Article Expiration Script

**New file:** `scripts/cleanup.ts`

Standalone script that connects to the DB via Prisma and deletes articles older than 14 days. Runs outside Next.js — no HTTP round-trip required.

```ts
// Pseudocode
const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
const { count } = await prisma.article.deleteMany({
  where: { publishedAt: { lt: cutoff } },
});
console.log(`[cleanup] Deleted ${count} articles older than 14 days`);
await prisma.$disconnect();
```

**Linux cron entry** (runs daily at 3am):
```
0 3 * * * cd /path/to/positivenews && npx tsx scripts/cleanup.ts >> /var/log/positivenews-cleanup.log 2>&1
```

No changes to the pipeline. No new API surface.

---

## 4. `/api/stats` Endpoint

**New file:** `app/api/stats/route.ts`

GET endpoint, no authentication (read-only, non-sensitive data on a personal server). All data fetched in parallel via `Promise.all` using Prisma `aggregate` and `groupBy` — no N+1 queries.

**Response shape:**
```json
{
  "pipeline": {
    "running": false
  },
  "articles": {
    "total": 1240,
    "positive": 890,
    "last24h": 43,
    "rejectionRate": 0.28,
    "oldest": "2026-03-19T08:00:00.000Z",
    "newest": "2026-04-02T14:32:00.000Z"
  },
  "byCategory": {
    "Science": 210,
    "Health": 190,
    "Environment": 185,
    "Society": 430,
    "Innovation": 225
  },
  "bySources": [
    { "name": "Good News Network", "count": 140, "lastArticle": "2026-04-02T..." },
    { "name": "Yle Uutiset", "count": 98, "lastArticle": "2026-04-02T..." }
  ]
}
```

`rejectionRate` is computed as `(total - positive) / total`, rounded to 2 decimal places. `bySources` is sorted descending by `count`.

---

## 5. Redis Cache for Learned Keywords

### Motivation

The current `classifier.ts` uses an in-memory object (`learnedCache`) with a 5-minute TTL. This means after a user flags an article, the classifier continues using stale keywords for up to 5 minutes. Redis replaces this with explicit cache invalidation on write: the cache is always fresh immediately after a flag.

### New file: `src/lib/redis.ts`

Exports a singleton `ioredis` client:

```ts
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
export default redis;
```

**Dependency:** `ioredis` (install via `pnpm add ioredis`).

**Environment variable:** `REDIS_URL` (optional, defaults to local Redis).

### Cache key structure

Two keys, one per language:
- `learned:keywords:fi` → JSON array of active Finnish keyword strings
- `learned:keywords:en` → JSON array of active English keyword strings

No expiry set. Keys stay valid indefinitely until explicitly invalidated.

### `classifier.ts` changes

Replace the `learnedCache` object, `CACHE_TTL` constant, and `refreshLearnedKeywords()` function with Redis-backed logic in `getLearnedKeywords()`:

```ts
// On read
async function getLearnedKeywords(language: string): Promise<string[]> {
  const key = `learned:keywords:${language}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as string[];

  // Cache miss — load from DB and populate Redis
  const keywords = await prisma.learnedKeyword.findMany({
    where: { active: true, language },
    select: { keyword: true },
  });
  const list = keywords.map((k) => k.keyword);
  await redis.set(key, JSON.stringify(list));
  return list;
}
```

Remove the exported `refreshLearnedKeywords()` function (no longer needed). Update the module docstring to reflect the new caching strategy.

### `app/api/articles/[id]/flag/route.ts` changes

After the Prisma transaction completes successfully, invalidate the Redis key for the article's language:

```ts
// After transaction
await redis.del(`learned:keywords:${language}`);
```

The `language` is already available from `article.source.language` (line 40 in current code). The next call to `getLearnedKeywords()` will repopulate from DB automatically.

### Redis setup on Linux server

```bash
# Install
sudo apt install redis-server

# Enable and start
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Verify
redis-cli ping  # → PONG
```

No Redis password needed for localhost-only access. If the app and Redis are on the same machine (which they are), the default config is sufficient.

---

## Files Changed / Created

| File | Change |
|------|--------|
| `src/config/sources.ts` | Add `isActive?: boolean` to `FeedSource` |
| `src/lib/ingest.ts` | Fix no-op filter at line 139 |
| `src/lib/llm-curator.ts` | Extract `SHARED_REJECTION_RULES`, refactor both prompt builders |
| `src/lib/classifier.ts` | Replace in-memory TTL cache with Redis |
| `src/lib/redis.ts` | **New** — ioredis singleton |
| `app/api/articles/[id]/flag/route.ts` | Invalidate Redis key after flag transaction |
| `app/api/stats/route.ts` | **New** — stats endpoint |
| `scripts/cleanup.ts` | **New** — 14-day expiration script |

## Dependencies

- `ioredis` — Redis client (`pnpm add ioredis`)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string |
