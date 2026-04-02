# Pipeline Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a no-op filter, reduce LLM prompt maintenance burden, add 14-day article expiration, add a stats endpoint, and replace the in-memory keyword cache with Redis.

**Architecture:** Seven independent tasks ordered by dependency — types/filter first, then prompt refactor and expiration script (independent), then stats endpoint, then Redis in three sequential steps (install → classifier → flag route).

**Tech Stack:** Next.js 16, Prisma 7 (PostgreSQL), ioredis, tsx (scripts), Linux cron

**Spec:** `docs/superpowers/specs/2026-04-02-pipeline-improvements-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config/sources.ts` | Modify | Add `isActive?: boolean` to `FeedSource` |
| `src/lib/ingest.ts` | Modify | Fix no-op filter at line 139 |
| `src/lib/llm-curator.ts` | Modify | Extract `SHARED_REJECTION_RULES`, refactor prompt builders |
| `scripts/cleanup.ts` | Create | 14-day article expiration script |
| `app/api/stats/route.ts` | Create | Stats endpoint (no auth, GET) |
| `src/lib/redis.ts` | Create | ioredis singleton |
| `src/lib/classifier.ts` | Modify | Replace TTL cache with Redis cache-aside |
| `app/api/articles/[id]/flag/route.ts` | Modify | Invalidate Redis key after flag transaction |

---

## Task 1: FeedSource.isActive type + filter fix

**Files:**
- Modify: `src/config/sources.ts`
- Modify: `src/lib/ingest.ts`

- [ ] **Step 1: Add `isActive` to the FeedSource interface**

Open `src/config/sources.ts`. Change the `FeedSource` interface from:

```ts
export interface FeedSource {
  name: string;
  url: string;
  category: Exclude<Category, "All">;
  language: string;
  /** true = curated positive-news outlet; skip LLM classification */
  trusted?: boolean;
}
```

To:

```ts
export interface FeedSource {
  name: string;
  url: string;
  category: Exclude<Category, "All">;
  language: string;
  /** true = curated positive-news outlet; skip LLM classification */
  trusted?: boolean;
  /** false = skip this feed during ingest. Omit to keep active (default). */
  isActive?: boolean;
}
```

- [ ] **Step 2: Fix the no-op filter in ingest.ts**

Open `src/lib/ingest.ts`. At line 139, replace:

```ts
const activeSources = FEED_SOURCES.filter(() => true); // all active
```

With:

```ts
const activeSources = FEED_SOURCES.filter((f) => f.isActive !== false);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /path/to/positivenews && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/sources.ts src/lib/ingest.ts
git commit -m "fix: add isActive to FeedSource type and fix no-op filter"
```

---

## Task 2: Extract shared LLM rejection rules

**Files:**
- Modify: `src/lib/llm-curator.ts`

The two prompt builders (`buildPass1Prompt`, `buildPass2Prompt`) share ~21 rejection criteria verbatim. Extract them to a constant and interpolate into both. No behavioral change.

- [ ] **Step 1: Add the shared rules constant**

Open `src/lib/llm-curator.ts`. After the closing `}` of the `ArticleInput` interface (around line 16), add:

```ts
// ── Shared rejection rules (used in both Pass 1 and Pass 2) ──────────

const SHARED_REJECTION_RULES = [
  "Sports roster moves, transfers, coaching changes, retirements, lawsuits — only genuine triumphs count",
  "Sports scores, doping, league standings, match results",
  "Shopping sales and promotions (spring sale, Amazon deals, deal of the day, best price)",
  "Consumer product reviews, upgrades, or best-of roundups",
  "Crossword puzzles, quizzes, games, horoscopes — not news",
  "Entrepreneurship clickbait (dare to start, how companies fail, why you should start a business)",
  "CEO interview roundups and what-leaders-said puff pieces",
  "Rising costs, price increases, inflation, affordability complaints",
  "Political threats, sanctions, military activity (fighter jets, drones, air space violations, defense exercises)",
  "Administrative/bureaucratic disputes and legal complaints",
  "Health scares: anti-vaccination trends, disease outbreaks, declining health stats",
  "Cancelled events, illness of politicians or public figures",
  "Layoffs, firings, job cuts, restructuring",
  "Court verdicts, criminal convictions, sentencing, discrimination cases",
  "Police investigations, data breaches, leaked personal data",
  "Animal attacks on people",
  "Constitutional/privacy law debates, governance criticism",
  "Sports investigations and misconduct probes",
  "Conflict of interest stories, cronyism, insider appointments",
  "Environmental LOSS, alarm, or wildlife CRIME stories (illegal trade, poaching)",
  "Clickbait listicles with no real substance",
].map((r) => `- ${r}`).join("\n");
```

- [ ] **Step 2: Replace buildPass1Prompt**

Replace the entire `buildPass1Prompt` function with:

```ts
function buildPass1Prompt(articles: ArticleInput[]): string {
  const items = articles
    .map((a, i) => {
      const lang = a.language === "fi" ? "FI" : "EN";
      const summary = a.summary ? ` — ${a.summary.slice(0, 150)}` : "";
      return `${i + 1}. id:${a.id} [${lang}] "${a.title}"${summary}`;
    })
    .join("\n");

  return `You are a STRICT Positive News curator. Your job is to ONLY let through news that makes a reader feel inspired, hopeful, or calm. When in doubt, REJECT.

INCLUDE (positive = true) — ONLY these:
- Solutions journalism: people or organizations actively solving real problems
- Scientific breakthroughs: medicine, space, green energy, technology that benefits humanity
- Acts of kindness: heroism, community support, altruism
- Environmental recovery: wildlife rebounding, reforestation, climate goals met
- Cultural/sports triumphs: uplifting ACHIEVEMENTS (winning, records, overcoming adversity) — NOT roster moves, transfers, or retirements
- Finnish specifics: "sisu" stories, community successes, innovations, nature conservation
- Practical wellness: health tips, well-being advice that helps people

EXCLUDE (positive = false) — be aggressive here:
- ANY mention of war, military threats, geopolitics, territorial disputes, sanctions, or drones/missiles
- ANY mention of Trump, Putin, or other politicians in conflict/threat context
- Violent crime, political bickering, government disputes, legal complaints
- Rage-bait, scandals, celebrity gossip
- Alarmist headlines (even if story is neutral)
- Tragic accidents, water damage, insurance disputes (even with a silver lining)
- Opinion pieces, columns, editorials about societal problems
- Error reports, corrections, failures
${SHARED_REJECTION_RULES}

Return ONLY this JSON: {"results": [{"id": "...", "positive": true/false, "reason": "brief reason"}]}

Articles:
${items}`;
}
```

- [ ] **Step 3: Replace buildPass2Prompt**

Replace the entire `buildPass2Prompt` function with:

```ts
function buildPass2Prompt(articles: ArticleInput[]): string {
  const items = articles
    .map((a, i) => {
      const summary = a.summary ? ` — ${a.summary.slice(0, 150)}` : "";
      return `${i + 1}. id:${a.id} "${a.title}"${summary}`;
    })
    .join("\n");

  return `You are the FINAL quality gate for a Positive News feed. These articles already passed an initial check. Apply the STRICTEST filter. When in doubt, REJECT.

Ask yourself: "Would this make someone smile, feel hopeful, or learn something good?" If not, reject it.

KEEP ONLY articles that are:
- Genuinely uplifting: real human achievement, community success, scientific progress
- Helpful to people: practical wellness, health breakthroughs, solutions to real problems
- Something to be proud of: innovation that helps humanity, environmental wins, acts of kindness
- Good business news ONLY IF it directly creates jobs, clean energy, or accessibility for people

REJECT everything else, including:
- Marketing disguised as news (product launches, brand collaborations, celebrity collections)
- Generic business deals, contracts, or corporate transactions
- Business thought-leader puff pieces ("insights from CEO X", "future of business")
- "Your X is ugly / broken, this company wants to fix it" — product marketing
- Labor disputes, strikes, union conflicts without resolution
- Dangerous roads, safety hazards, infrastructure failures
- Tech platform problems (spam, abuse, outages)
- Stories about errors, failures, corrections, or things getting worse
${SHARED_REJECTION_RULES}

Return ONLY this JSON: {"results": [{"id": "...", "keep": true/false, "reason": "brief reason"}]}

Articles:
${items}`;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Verify prompt content is unchanged (sanity check)**

Scan the new prompts and confirm the EXCLUDE/REJECT sections together still cover everything the original two prompts covered. Spot-check: "drones", "layoffs", "court verdicts", "animal attacks" all appear (via `SHARED_REJECTION_RULES`). Pass 1 still has "Rage-bait", Pass 2 still has "Marketing disguised as news".

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm-curator.ts
git commit -m "refactor: extract shared LLM rejection rules to reduce prompt drift"
```

---

## Task 3: Article expiration script

**Files:**
- Create: `scripts/cleanup.ts`

- [ ] **Step 1: Create the script**

Create `scripts/cleanup.ts` with:

```ts
/**
 * Cleanup script — deletes articles older than 14 days.
 * Usage: npx tsx scripts/cleanup.ts
 * Cron:  0 3 * * * cd /path/to/positivenews && npx tsx scripts/cleanup.ts >> /var/log/positivenews-cleanup.log 2>&1
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  console.log(`[cleanup] Deleting articles published before ${cutoff.toISOString()}…`);

  const { count } = await prisma.article.deleteMany({
    where: { publishedAt: { lt: cutoff } },
  });

  console.log(`[cleanup] Done — deleted ${count} articles`);
}

main()
  .catch((err) => {
    console.error("[cleanup] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run it manually to verify**

```bash
npx tsx scripts/cleanup.ts
```

Expected output (varies by DB state):
```
[cleanup] Deleting articles published before 2026-03-19T...
[cleanup] Done — deleted 0 articles
```

(Zero is expected if your DB has no articles older than 14 days yet — that's fine.)

- [ ] **Step 3: Add the cron entry on the Linux server**

```bash
crontab -e
```

Add this line (adjust the path):
```
0 3 * * * cd /path/to/positivenews && npx tsx scripts/cleanup.ts >> /var/log/positivenews-cleanup.log 2>&1
```

Verify it was saved:
```bash
crontab -l
```

- [ ] **Step 4: Commit**

```bash
git add scripts/cleanup.ts
git commit -m "feat: add 14-day article expiration script"
```

---

## Task 4: /api/stats endpoint

**Files:**
- Create: `app/api/stats/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/stats/route.ts` with:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { isPipelineRunning } from "@/src/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    total,
    positive,
    last24h,
    range,
    byCategory,
    bySourceId,
    sources,
  ] = await Promise.all([
    prisma.article.count(),
    prisma.article.count({ where: { isPositive: true } }),
    prisma.article.count({ where: { publishedAt: { gte: yesterday } } }),
    prisma.article.aggregate({
      _min: { publishedAt: true },
      _max: { publishedAt: true },
    }),
    prisma.article.groupBy({
      by: ["category"],
      _count: { id: true },
    }),
    prisma.article.groupBy({
      by: ["sourceId"],
      _count: { id: true },
      _max: { publishedAt: true },
      orderBy: { _count: { id: "desc" } },
    }),
    prisma.source.findMany({ select: { id: true, name: true } }),
  ]);

  const sourceMap = new Map(sources.map((s) => [s.id, s.name]));

  const rejectionRate =
    total > 0 ? Math.round(((total - positive) / total) * 100) / 100 : 0;

  return NextResponse.json({
    pipeline: {
      running: isPipelineRunning(),
    },
    articles: {
      total,
      positive,
      last24h,
      rejectionRate,
      oldest: range._min.publishedAt ?? null,
      newest: range._max.publishedAt ?? null,
    },
    byCategory: Object.fromEntries(
      byCategory.map((row) => [row.category, row._count.id])
    ),
    bySources: bySourceId.map((row) => ({
      name: sourceMap.get(row.sourceId) ?? row.sourceId,
      count: row._count.id,
      lastArticle: row._max.publishedAt ?? null,
    })),
  });
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Start the dev server:
```bash
pnpm dev
```

In another terminal:
```bash
curl -s http://localhost:3000/api/stats | jq .
```

Expected: JSON with `pipeline`, `articles`, `byCategory`, `bySources` keys. `articles.total` should be a positive integer matching your DB state.

- [ ] **Step 4: Commit**

```bash
git add app/api/stats/route.ts
git commit -m "feat: add /api/stats endpoint"
```

---

## Task 5: Install ioredis and create Redis singleton

**Files:**
- Create: `src/lib/redis.ts`

This task is a prerequisite for Tasks 6 and 7. Complete it before either of those.

- [ ] **Step 1: Install ioredis**

```bash
pnpm add ioredis
```

Expected: `ioredis` appears in `package.json` dependencies.

- [ ] **Step 2: Ensure Redis is running on the server**

```bash
redis-cli ping
```

Expected: `PONG`

If not installed:
```bash
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping
```

- [ ] **Step 3: Create the Redis singleton**

Create `src/lib/redis.ts` with:

```ts
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redis.on("error", (err) => {
  // Log but don't crash — classifier falls back to DB on Redis failure
  console.error("[redis] Connection error:", err.message);
});

export default redis;
```

`lazyConnect: true` — doesn't connect until first command (safe for Next.js server startup).
`enableOfflineQueue: false` — commands fail fast if Redis is down rather than queuing indefinitely.
`maxRetriesPerRequest: 1` — one retry then fail, so a dead Redis doesn't slow every request.

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Add REDIS_URL to your .env (if not localhost)**

If your Redis is on localhost, no change needed. If it's elsewhere, add to `.env`:
```
REDIS_URL=redis://127.0.0.1:6379
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/redis.ts package.json pnpm-lock.yaml
git commit -m "feat: add ioredis singleton (prerequisite for classifier cache)"
```

---

## Task 6: Replace classifier TTL cache with Redis

**Files:**
- Modify: `src/lib/classifier.ts`

**Before:** In-memory `learnedCache` object polled on a 5-minute TTL — stale for up to 5 minutes after a user flags an article.
**After:** Cache-aside pattern with Redis. On read: check Redis, fall back to DB on miss, store in Redis. No TTL — stays valid until the flag route explicitly deletes the key (Task 7).

- [ ] **Step 1: Update the module docstring and imports**

At the top of `src/lib/classifier.ts`, replace the comment block and import:

```ts
/**
 * Positive-news classifier.
 *
 * Uses keyword matching with Finnish stem awareness plus learned
 * keywords from user feedback. Learned keywords are cached in Redis
 * and invalidated on write (when an article is flagged).
 */

import { prisma } from "./prisma";
import redis from "./redis";
```

- [ ] **Step 2: Remove the in-memory cache**

Delete these lines (around line 151–182 in the current file):

```ts
// ── Learned keywords cache ──────────────────────────────────────────

interface LearnedCache {
  fi: string[];
  en: string[];
  loadedAt: number;
}

let learnedCache: LearnedCache = { fi: [], en: [], loadedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function refreshLearnedKeywords(): Promise<void> {
  try {
    const keywords = await prisma.learnedKeyword.findMany({
      where: { active: true },
      select: { keyword: true, language: true },
    });
    learnedCache = {
      fi: keywords.filter((k) => k.language === "fi").map((k) => k.keyword),
      en: keywords.filter((k) => k.language === "en").map((k) => k.keyword),
      loadedAt: Date.now(),
    };
  } catch {
    // DB unavailable — keep stale cache
  }
}

async function getLearnedKeywords(language: string): Promise<string[]> {
  if (Date.now() - learnedCache.loadedAt > CACHE_TTL) {
    await refreshLearnedKeywords();
  }
  return language === "fi" ? learnedCache.fi : learnedCache.en;
}
```

- [ ] **Step 3: Add the Redis-backed getLearnedKeywords**

In place of the deleted block, add:

```ts
// ── Learned keywords cache (Redis) ─────────────────────────────────

async function getLearnedKeywords(language: string): Promise<string[]> {
  const key = `learned:keywords:${language}`;

  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as string[];
  } catch {
    // Redis unavailable — fall through to DB
  }

  try {
    const rows = await prisma.learnedKeyword.findMany({
      where: { active: true, language },
      select: { keyword: true },
    });
    const list = rows.map((r) => r.keyword);
    try {
      await redis.set(key, JSON.stringify(list));
    } catch {
      // Redis write failed — return DB results without caching
    }
    return list;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors. Note: if anything imported `refreshLearnedKeywords` from classifier, it will now error — search for usages first:

```bash
grep -r "refreshLearnedKeywords" --include="*.ts" .
```

Expected: no results (it was only used internally).

- [ ] **Step 5: Smoke test the classifier via the dev server**

```bash
pnpm dev
```

Then trigger an ingest:
```bash
curl -s -X POST http://localhost:3000/api/ingest \
  -H "x-ingest-secret: $INGEST_SECRET" | jq .
```

Check Redis was populated:
```bash
redis-cli keys "learned:keywords:*"
redis-cli get "learned:keywords:en"
```

Expected: keys exist with a JSON array of strings (may be `[]` if no keywords have reached the activation threshold yet — that's fine).

- [ ] **Step 6: Commit**

```bash
git add src/lib/classifier.ts
git commit -m "feat: replace in-memory keyword TTL cache with Redis cache-aside"
```

---

## Task 7: Redis invalidation in flag route

**Files:**
- Modify: `app/api/articles/[id]/flag/route.ts`

After a user flags an article, the keyword cache for that article's language becomes stale. Deleting the Redis key forces the next classifier read to repopulate from DB.

- [ ] **Step 1: Add the Redis import**

At the top of `app/api/articles/[id]/flag/route.ts`, add after the existing imports:

```ts
import redis from "@/src/lib/redis";
```

- [ ] **Step 2: Invalidate the cache after the transaction**

The transaction block ends at line 85 (`});`). The `language` variable is available as `article.source.language` (fetched at line 40). After the `await prisma.$transaction(...)` call, add:

```ts
  await redis.del(`learned:keywords:${language}`);
```

The full POST handler's try-free section after the transaction should look like:

```ts
  await prisma.$transaction(async (tx) => {
    // ... (unchanged)
  });

  await redis.del(`learned:keywords:${language}`);

  return NextResponse.json({ success: true });
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: End-to-end test of the full flag → cache invalidation flow**

1. Check the current Redis cache:
```bash
redis-cli get "learned:keywords:en"
```

2. Flag an article (use a real article ID from your DB):
```bash
curl -s -X POST http://localhost:3000/api/articles/<ARTICLE_ID>/flag \
  -H "origin: http://localhost:3000" \
  -H "host: localhost:3000" | jq .
```

Expected response: `{"success": true}`

3. Immediately check Redis:
```bash
redis-cli get "learned:keywords:en"
```

Expected: `(nil)` — the key was deleted.

4. Trigger another request that uses the classifier (e.g., call `/api/ingest`), then check Redis again:
```bash
redis-cli get "learned:keywords:en"
```

Expected: key is back, populated with the updated keywords.

- [ ] **Step 5: Commit**

```bash
git add app/api/articles/[id]/flag/route.ts
git commit -m "feat: invalidate Redis keyword cache on article flag"
```

---

## Done

All 7 tasks complete. Verify the full build is clean:

```bash
npx tsc --noEmit && pnpm lint
```

Expected: no errors, no warnings.
