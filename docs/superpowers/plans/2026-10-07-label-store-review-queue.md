# Label Store and Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every filtering judgement as an append-only `LabelEvent`, route all feed-state writes through one serialised decision path, give the admin a daily review queue whose decisions are final, and export leak-free training labels and a scoreboard.

**Architecture:** Pure modules carry the logic and the unit tests:
- `labels.ts`: constants, cohort, authority, label resolution
- `review-queue.ts`: queue selection and the Helsinki day boundary
- `scoreboard.ts`: per-source scoring

`article-decisions.ts` is the only writer of article feed state and label events. Every function locks the article row (`SELECT … FOR UPDATE`) inside a transaction. Ingest, curation, the flag route and admin actions call it. The UI is a phone-first `/admin/review` page with server actions.

**Tech Stack:** Next.js 16 (App Router, `basePath: "/news"`), Prisma 7 + PostgreSQL, Vitest, tsx scripts, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-label-store-review-queue-design.md`

## Global Constraints

- Work in the worktree `/Users/tonibergholm/Developer/github/positivenews/.worktrees/label-store` (branch `label-store`). Never edit the main checkout.
- Use pnpm, and commit `pnpm-lock.yaml` with any dependency change. Do not touch `package-lock.json`.
- `LABEL_SOURCES = ["reader_flag", "admin", "ollama", "keyword"]`. `VERDICTS = ["keep", "reject", "retract"]`. `REVIEW_BUCKETS = ["flagged", "leak", "miss", "cohort", "manual"]`.
- `ADMIN_REJECTION_PASS = 3`. The admin rejection reason is `admin: <category label>`, or `admin`.
- `TIER_WEIGHTS = { gold: 1, flag: 0.5, ollama: 0.4, keyword: 0.3 }`.
- Test cohort: the first 4 bytes of `sha256(articleId)`, read as an unsigned 32-bit big-endian integer, `% 10 === 0`.
- Queue: `DAILY_TARGET = 20`. `QUOTAS = { flagged: 6, leak: 5, miss: 5, cohort: 4 }`. 14-day window. The cohort bucket goes every 5th card. The day boundary is Europe/Helsinki.
- Leak: in the feed and (`positiveP < 0.2` or `upliftingP < 0.2` or `topCategoryP > 0.8`). Miss: not in the feed and `positiveP > 0.8`, `upliftingP > 0.8` and `topCategoryP < 0.3`.
- Ollama outcomes: `judged_keep`, `judged_reject`, `unavailable`, `missing_result`. Only the `judged_*` outcomes are `eligible`. Eligibility is never derived from reason text.
- Reader actor: HMAC-SHA256 of the IP keyed by `AUTH_SECRET`, as hex, or `null` without a secret. Its `dedupeKey` is `flag:<articleId>:<hash>`. Backfill `dedupeKey`s are `backfill:<articleId>:<kind>`.
- Every writer sets `LabelEvent.createdAt = new Date()` explicitly, **after** acquiring the article lock, never the DB default. The backfill copies historical timestamps instead.
- Event and state writes share one transaction. Never write either without the other.
- Read `node_modules/next/dist/docs/` before writing page code. `<Link>` and `router` add `/news` automatically. Raw `<img src>` uses absolute external URLs as today.
- The UI follows DESIGN.md and the existing admin pages: warm tokens, `tabular-nums`, success `#3d8b5e`, `text-destructive` or `bg-destructive` for reject.
- Never print or commit `.env*` files, except the tracked `.env.example`.

## Review Focus

1. **Curation result racing an admin decision.** An admin keep made while Ollama is thinking must survive the later Ollama reject. Covered by the integration test in Task 2.
2. **Undo from a stale tab.** It must be refused, not override the newer decision. Covered by tests in Tasks 1 and 2.
3. **Repeat flag from the same reader, and two readers flagging.** The first is a no-op; the second gives two votes, but the article is hidden only once and keywords learn only once. Covered by the Task 3 route test and the manual curl check.
4. **A pass-1 or pass-2 Ollama result missing for an article.** It must be recorded as `missing_result` and ineligible, never as a judged keep. Covered by Task 3 tests.
5. **Cohort articles leaking into a training export.** Covered by the Task 7 export test.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/<ts>_label_events/` | `LabelEvent` model, `Article.createdAt` index |
| `src/lib/labels.ts` (+ test) | Constants, `isTestCohort`, `currentAdminAuthority`, `resolveLabel` (pure) |
| `src/lib/reader-identity.ts` (+ test) | `hashReaderIp` |
| `src/lib/article-decisions.ts` (+ integration test) | The serialised decision path: the only feed-state and event writer |
| `src/lib/llm-curator.ts` (+ test) | Adds an explicit `outcome` per result |
| `src/lib/curate.ts`, `src/lib/ingest.ts`, `app/api/articles/[id]/flag/route.ts`, `app/admin/{rejections,flagged}/actions.ts`, `scripts/backfill-classify.ts` | Route their writes through the decision path |
| `scripts/labels-backfill.ts` | History import |
| `src/lib/review-queue.ts` (+ test) | `bucketOf`, `selectNext`, Helsinki day helpers (pure) |
| `src/lib/review-queue-data.ts` | Candidate loader, today's counts, the next card |
| `app/admin/review/{page.tsx,ReviewCard.tsx,actions.ts}` | Review UI |
| `app/admin/layout.tsx`, `app/admin/flagged/page.tsx`, `app/admin/rejections/RejectionsClient.tsx` | Nav count, unresolved-flag inbox, pass-3 label |
| `src/lib/scoreboard.ts` (+ test), `src/lib/scoreboard-data.ts` | Scoring and its loader |
| `src/lib/jev-report.ts` (+ test), `src/lib/jev-report-data.ts`, `app/admin/jev/*` | Exclude admin-decided articles; scoreboard section |
| `scripts/labels-export.ts` (+ `src/lib/labels-export.ts` + test) | JSONL export |
| `.github/workflows/deploy.yml`, `README.md`, `package.json` | Migration step, docs, scripts |

---

### Task 1: Schema, migration, and pure label logic

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_label_events/migration.sql` (generated), `src/lib/labels.ts`, `src/lib/labels.test.ts`, `src/lib/reader-identity.ts`, `src/lib/reader-identity.test.ts`

**Interfaces (Produces):**
- `src/lib/labels.ts`:
  - `LABEL_SOURCES`, `VERDICTS`, `REVIEW_BUCKETS`, `TIER_WEIGHTS`, `ADMIN_REJECTION_PASS`
  - types `LabelSource`, `Verdict`, `ReviewBucket`, `LabelTier = "gold" | "flag" | "weak"`
  - `interface LabelEventLike { id: string; source: string; verdict: string; category: string | null; eligible: boolean; bucket: string | null; retractsId: string | null; createdAt: Date }`
  - `isTestCohort(articleId: string): boolean`
  - `currentAdminAuthority<E extends LabelEventLike>(events: E[]): E | null`
  - `interface ResolvedLabel { label: "keep" | "reject"; category: string | null; tier: LabelTier; weight: number; split: "train" | "test"; bucket: string | null }`
  - `resolveLabel(articleId: string, events: LabelEventLike[]): ResolvedLabel | null`
- `src/lib/reader-identity.ts`: `hashReaderIp(ip: string, secret?: string | undefined): string | null`. The default secret is `process.env.AUTH_SECRET`.
- Prisma model `LabelEvent` (fields exactly as below), `Article.labelEvents`.

- [ ] **Step 1: Install and set up the local database**

```bash
cd /Users/tonibergholm/Developer/github/positivenews/.worktrees/label-store
pnpm install
docker start pn-jev-pg 2>/dev/null || docker run -d --name pn-jev-pg -e POSTGRES_USER=pn -e POSTGRES_PASSWORD=pn -e POSTGRES_DB=positivenews -p 55432:5432 postgres:16-alpine
test -f .env || cp ../jev-shadow/.env .env
grep -c '^DATABASE_URL=' .env
```

Expected: `1`. The Jev worktree's `.env` has `DATABASE_URL` (`postgresql://pn:pn@localhost:55432/positivenews`) plus local auth vars. If `../jev-shadow/.env` is missing, write `DATABASE_URL=postgresql://pn:pn@localhost:55432/positivenews` to `.env`. Then run `pnpm prisma migrate deploy`, so the existing migrations (including `JevEvaluation`) are applied.

- [ ] **Step 2: Add the schema**

In `prisma/schema.prisma`, add to `model Article`, after `jevEvaluations`:

```prisma
  labelEvents     LabelEvent[]

  @@index([createdAt])
```

Then append:

```prisma
model LabelEvent {
  id         String   @id @default(cuid())
  article    Article  @relation(fields: [articleId], references: [id], onDelete: Cascade)
  articleId  String
  source     String
  verdict    String
  category   String?
  actor      String?
  reason     String?
  pass       Int?
  eligible   Boolean  @default(true)
  bucket     String?
  retractsId String?
  prevState  Json?
  dedupeKey  String?  @unique
  backfilled Boolean  @default(false)
  createdAt  DateTime @default(now())

  @@index([articleId, createdAt])
  @@index([source, createdAt])
}
```

Run `pnpm prisma migrate dev --name label_events`, then `pnpm prisma generate`. Confirm the generated SQL only creates the `LabelEvent` table and its indexes and FK (`ON DELETE CASCADE`), plus `Article_createdAt_idx`.

- [ ] **Step 3: Write the failing tests in `src/lib/labels.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  currentAdminAuthority,
  isTestCohort,
  resolveLabel,
  TIER_WEIGHTS,
  type LabelEventLike,
} from "./labels";

let seq = 0;
function ev(p: Partial<LabelEventLike>): LabelEventLike {
  seq++;
  return {
    id: `e${seq}`,
    source: "ollama",
    verdict: "keep",
    category: null,
    eligible: true,
    bucket: null,
    retractsId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    ...p,
  };
}

// Find ids on either side of the cohort split.
function idInCohort(want: boolean): string {
  for (let i = 0; i < 10_000; i++) if (isTestCohort(`a${i}`) === want) return `a${i}`;
  throw new Error("no id");
}
const TRAIN_ID = idInCohort(false);
const TEST_ID = idInCohort(true);

describe("isTestCohort", () => {
  it("is deterministic and selects roughly 10%", () => {
    expect(isTestCohort(TEST_ID)).toBe(true);
    expect(isTestCohort(TEST_ID)).toBe(true);
    let n = 0;
    for (let i = 0; i < 5000; i++) if (isTestCohort(`article-${i}`)) n++;
    expect(n / 5000).toBeGreaterThan(0.08);
    expect(n / 5000).toBeLessThan(0.12);
  });
});

describe("currentAdminAuthority", () => {
  it("returns the latest admin keep/reject", () => {
    const a1 = ev({ source: "admin", verdict: "keep" });
    const a2 = ev({ source: "admin", verdict: "reject", category: "cat_war" });
    expect(currentAdminAuthority([a2, a1])?.id).toBe(a2.id);
  });

  it("ignores retracted decisions and falls back to the previous one", () => {
    const a1 = ev({ source: "admin", verdict: "keep" });
    const a2 = ev({ source: "admin", verdict: "reject" });
    const r = ev({ source: "admin", verdict: "retract", retractsId: a2.id });
    expect(currentAdminAuthority([a1, a2, r])?.id).toBe(a1.id);
    const r1 = ev({ source: "admin", verdict: "retract", retractsId: a1.id });
    expect(currentAdminAuthority([a1, a2, r, r1])).toBeNull();
  });

  it("ignores non-admin events and breaks timestamp ties by id", () => {
    const t = new Date(Date.UTC(2026, 9, 2));
    const x = ev({ id: "x1", source: "admin", verdict: "keep", createdAt: t });
    const y = ev({ id: "x2", source: "admin", verdict: "reject", createdAt: t });
    const f = ev({ source: "reader_flag", verdict: "reject" });
    expect(currentAdminAuthority([y, f, x])?.id).toBe("x2");
    expect(currentAdminAuthority([f])).toBeNull();
  });
});

describe("resolveLabel", () => {
  it("gold: admin authority wins over everything", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "keyword", verdict: "reject" }),
      ev({ source: "reader_flag", verdict: "reject" }),
      ev({ source: "admin", verdict: "keep", bucket: "leak" }),
    ]);
    expect(r).toEqual({ label: "keep", category: null, tier: "gold", weight: TIER_WEIGHTS.gold, split: "train", bucket: "leak" });
  });

  it("gold carries the reject category", () => {
    const r = resolveLabel(TRAIN_ID, [ev({ source: "admin", verdict: "reject", category: "cat_sports", bucket: "flagged" })]);
    expect(r?.category).toBe("cat_sports");
  });

  it("flag tier beats Ollama and keyword", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "ollama", verdict: "keep" }),
      ev({ source: "reader_flag", verdict: "reject", eligible: true }),
    ]);
    expect(r).toMatchObject({ label: "reject", tier: "flag", weight: TIER_WEIGHTS.flag });
  });

  it("weak: latest eligible Ollama verdict, ignoring ineligible events", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "ollama", verdict: "reject" }),
      ev({ source: "ollama", verdict: "keep", eligible: false }),
    ]);
    expect(r).toMatchObject({ label: "reject", tier: "weak", weight: TIER_WEIGHTS.ollama });
  });

  it("weak: keyword reject when there is no eligible Ollama event", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "keyword", verdict: "reject" }),
      ev({ source: "ollama", verdict: "keep", eligible: false }),
    ]);
    expect(r).toMatchObject({ label: "reject", tier: "weak", weight: TIER_WEIGHTS.keyword });
  });

  it("a retracted admin decision no longer counts as gold", () => {
    const a = ev({ source: "admin", verdict: "reject" });
    const r = resolveLabel(TRAIN_ID, [ev({ source: "ollama", verdict: "keep" }), a, ev({ source: "admin", verdict: "retract", retractsId: a.id })]);
    expect(r).toMatchObject({ tier: "weak", label: "keep" });
  });

  it("marks cohort articles as test", () => {
    expect(resolveLabel(TEST_ID, [ev({ source: "ollama", verdict: "keep" })])?.split).toBe("test");
  });

  it("returns null without usable signal", () => {
    expect(resolveLabel(TRAIN_ID, [])).toBeNull();
    expect(resolveLabel(TRAIN_ID, [ev({ source: "ollama", verdict: "keep", eligible: false })])).toBeNull();
  });
});
```

`src/lib/reader-identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashReaderIp } from "./reader-identity";

describe("hashReaderIp", () => {
  it("is a stable 64-char hex HMAC that differs per IP and per secret", () => {
    const a = hashReaderIp("1.2.3.4", "s1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashReaderIp("1.2.3.4", "s1")).toBe(a);
    expect(hashReaderIp("1.2.3.5", "s1")).not.toBe(a);
    expect(hashReaderIp("1.2.3.4", "s2")).not.toBe(a);
  });

  it("returns null without a secret and never returns the raw IP", () => {
    expect(hashReaderIp("1.2.3.4", "")).toBeNull();
    expect(hashReaderIp("1.2.3.4", "s1")).not.toContain("1.2.3.4");
  });
});
```

- [ ] **Step 4: Run them to confirm they fail**

Run: `pnpm test src/lib/labels.test.ts src/lib/reader-identity.test.ts`
Expected: FAIL, because the modules don't exist yet.

- [ ] **Step 5: Implement `src/lib/labels.ts`**

```ts
/**
 * Label vocabulary and pure label logic for the self-learning filter.
 *
 * LabelEvent rows are an append-only record of judgements. These helpers
 * decide which admin decision is current, which articles form the
 * held-out test cohort, and what single training label an article gets.
 */

import { createHash } from "node:crypto";

export const LABEL_SOURCES = ["reader_flag", "admin", "ollama", "keyword"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const VERDICTS = ["keep", "reject", "retract"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REVIEW_BUCKETS = ["flagged", "leak", "miss", "cohort", "manual"] as const;
export type ReviewBucket = (typeof REVIEW_BUCKETS)[number];

/** Provisional; piece 3 recalibrates these from scoreboard precision. */
export const TIER_WEIGHTS = { gold: 1, flag: 0.5, ollama: 0.4, keyword: 0.3 } as const;
export type LabelTier = "gold" | "flag" | "weak";

/** Article.rejectionPass value for admin rejections (0 keyword, 1–2 Ollama). */
export const ADMIN_REJECTION_PASS = 3;

export interface LabelEventLike {
  id: string;
  source: string;
  verdict: string;
  category: string | null;
  eligible: boolean;
  bucket: string | null;
  retractsId: string | null;
  createdAt: Date;
}

/** ~10% of articles, chosen by hash, never used for training. */
export function isTestCohort(articleId: string): boolean {
  return createHash("sha256").update(articleId).digest().readUInt32BE(0) % 10 === 0;
}

function byTime(a: LabelEventLike, b: LabelEventLike): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function latest<E extends LabelEventLike>(events: E[]): E | null {
  return events.length === 0 ? null : [...events].sort(byTime)[events.length - 1];
}

/** The newest admin keep/reject that has not been retracted. */
export function currentAdminAuthority<E extends LabelEventLike>(events: E[]): E | null {
  const retracted = new Set(
    events
      .filter((e) => e.source === "admin" && e.verdict === "retract" && e.retractsId)
      .map((e) => e.retractsId as string),
  );
  return latest(
    events.filter(
      (e) => e.source === "admin" && (e.verdict === "keep" || e.verdict === "reject") && !retracted.has(e.id),
    ),
  );
}

export interface ResolvedLabel {
  label: "keep" | "reject";
  category: string | null;
  tier: LabelTier;
  weight: number;
  split: "train" | "test";
  bucket: string | null;
}

export function resolveLabel(articleId: string, events: LabelEventLike[]): ResolvedLabel | null {
  const split = isTestCohort(articleId) ? "test" : "train";

  const admin = currentAdminAuthority(events);
  if (admin) {
    return {
      label: admin.verdict as "keep" | "reject",
      category: admin.category,
      tier: "gold",
      weight: TIER_WEIGHTS.gold,
      split,
      bucket: admin.bucket,
    };
  }

  const usable = events.filter((e) => e.eligible);

  if (usable.some((e) => e.source === "reader_flag")) {
    return { label: "reject", category: null, tier: "flag", weight: TIER_WEIGHTS.flag, split, bucket: null };
  }

  const ollama = latest(usable.filter((e) => e.source === "ollama" && (e.verdict === "keep" || e.verdict === "reject")));
  if (ollama) {
    return { label: ollama.verdict as "keep" | "reject", category: null, tier: "weak", weight: TIER_WEIGHTS.ollama, split, bucket: null };
  }

  if (usable.some((e) => e.source === "keyword")) {
    return { label: "reject", category: null, tier: "weak", weight: TIER_WEIGHTS.keyword, split, bucket: null };
  }

  return null;
}
```

`src/lib/reader-identity.ts`:

```ts
import { createHmac } from "node:crypto";

/**
 * Pseudonymous reader identity for flag votes: HMAC of the IP keyed by the
 * server secret. Returns null without a secret so votes are still recorded.
 */
export function hashReaderIp(ip: string, secret: string | undefined = process.env.AUTH_SECRET): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(ip).digest("hex");
}
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`
Expected: all pass.

```bash
git add prisma src/lib/labels.ts src/lib/labels.test.ts src/lib/reader-identity.ts src/lib/reader-identity.test.ts
git commit -m "feat(labels): add LabelEvent table and pure label logic"
```

---

### Task 2: The serialised decision path

**Files:**
- Create: `src/lib/article-decisions.ts`, `src/lib/article-decisions.integration.test.ts`

**Interfaces:**
- Consumes: `currentAdminAuthority`, `ADMIN_REJECTION_PASS`, `REVIEW_BUCKETS`, `ReviewBucket` from `labels.ts`; `CATEGORIES` from `jev.ts`; `prisma`
- Produces (`src/lib/article-decisions.ts`):
  - `type Tx = Prisma.TransactionClient`
  - `type OllamaOutcome = "judged_keep" | "judged_reject" | "unavailable" | "missing_result"`
  - `recordKeywordReject(tx: Tx, articleId: string, reason: string): Promise<void>`
  - `recordOllamaResult(articleId: string, r: { outcome: OllamaOutcome; reason: string; pass: 1 | 2 }, model: string): Promise<"applied" | "recorded_only" | "not_found">`
  - `recordReaderFlag(articleId: string, actorHash: string | null, onHide: (tx: Tx) => Promise<void>): Promise<"not_found" | "duplicate" | "recorded" | "hidden">`
  - `recordAdminDecision(articleId: string, verdict: "keep" | "reject", opts: { category?: string | null; bucket: ReviewBucket; actor: string | null }): Promise<{ status: "ok"; eventId: string } | { status: "not_found" }>`
  - `retractAdminDecision(eventId: string, actor: string | null): Promise<"ok" | "stale" | "not_found">`

- [ ] **Step 1: Write the integration test** in `src/lib/article-decisions.integration.test.ts`. It runs only when `DATABASE_URL` is set. CI has no database, so it is skipped there.

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("article-decisions (integration)", () => {
  // Imported lazily so the suite never touches prisma without a database.
  let prisma: typeof import("./prisma").prisma;
  let d: typeof import("./article-decisions");
  let sourceId: string;
  const created: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import("./prisma"));
    d = await import("./article-decisions");
    const s = await prisma.source.upsert({
      where: { url: "https://test.invalid/feed" },
      update: {},
      create: { name: "Test", url: "https://test.invalid/feed", category: "Society", language: "en" },
    });
    sourceId = s.id;
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function article(): Promise<string> {
    const a = await prisma.article.create({
      data: { title: "T", url: `https://test.invalid/${Date.now()}-${Math.random()}`, publishedAt: new Date(), sourceId, category: "Society" },
    });
    created.push(a.id);
    return a.id;
  }

  it("an admin keep survives a concurrent Ollama reject, in either order", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await article();
      await Promise.all([
        d.recordAdminDecision(id, "keep", { bucket: "leak", actor: "admin@test" }),
        d.recordOllamaResult(id, { outcome: "judged_reject", reason: "war", pass: 1 }, "gemma3:4b"),
      ]);
      const a = await prisma.article.findUniqueOrThrow({ where: { id } });
      expect(a.isPositive).toBe(true);
      expect(a.rejectionPass).toBeNull();
      const events = await prisma.labelEvent.findMany({ where: { articleId: id } });
      expect(events.map((e) => e.source).sort()).toEqual(["admin", "ollama"]);
    }
  });

  it("undo restores the previous state; a stale undo is refused", async () => {
    const id = await article();
    const first = await d.recordAdminDecision(id, "reject", { category: "cat_war", bucket: "leak", actor: "a" });
    expect(first.status).toBe("ok");
    let a = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(a).toMatchObject({ isPositive: false, rejectionPass: 3, rejectionReason: "admin: war / military / geopolitics" });

    const second = await d.recordAdminDecision(id, "keep", { bucket: "manual", actor: "a" });
    if (first.status !== "ok" || second.status !== "ok") throw new Error("setup");
    expect(await d.retractAdminDecision(first.eventId, "a")).toBe("stale");

    expect(await d.retractAdminDecision(second.eventId, "a")).toBe("ok");
    a = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(a).toMatchObject({ isPositive: false, rejectionPass: 3 });
  });

  it("reader flags: one vote per actor, hide once, no hide after an admin keep", async () => {
    const id = await article();
    let hides = 0;
    const onHide = async () => { hides++; };
    expect(await d.recordReaderFlag(id, "h1", onHide)).toBe("hidden");
    expect(await d.recordReaderFlag(id, "h1", onHide)).toBe("duplicate");
    expect(await d.recordReaderFlag(id, "h2", onHide)).toBe("recorded");
    expect(hides).toBe(1);

    const kept = await article();
    await d.recordAdminDecision(kept, "keep", { bucket: "manual", actor: "a" });
    expect(await d.recordReaderFlag(kept, "h3", onHide)).toBe("recorded");
    expect((await prisma.article.findUniqueOrThrow({ where: { id: kept } })).isPositive).toBe(true);
  });

  it("ineligible Ollama outcomes are recorded as keeps with eligible=false", async () => {
    const id = await article();
    expect(await d.recordOllamaResult(id, { outcome: "missing_result", reason: "missing result", pass: 2 }, "m")).toBe("applied");
    const e = await prisma.labelEvent.findFirstOrThrow({ where: { articleId: id } });
    expect(e).toMatchObject({ source: "ollama", verdict: "keep", eligible: false });
    expect((await prisma.article.findUniqueOrThrow({ where: { id } })).curatedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** (the local database must be up): `pnpm test src/lib/article-decisions.integration.test.ts`. Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement `src/lib/article-decisions.ts`**

```ts
/**
 * The serialised decision path. This module is the only code allowed to
 * change an article's feed state or write a LabelEvent. Every function
 * locks the article row first, so admin decisions stay final regardless
 * of what curation or readers do concurrently.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { CATEGORIES } from "./jev";
import { ADMIN_REJECTION_PASS, currentAdminAuthority, REVIEW_BUCKETS, type ReviewBucket } from "./labels";

export type Tx = Prisma.TransactionClient;
export type OllamaOutcome = "judged_keep" | "judged_reject" | "unavailable" | "missing_result";

const AUTHORITY_SELECT = {
  id: true,
  source: true,
  verdict: true,
  category: true,
  eligible: true,
  bucket: true,
  retractsId: true,
  createdAt: true,
  prevState: true,
} as const;

async function lockArticle(tx: Tx, articleId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Article" WHERE id = ${articleId} FOR UPDATE`;
  return rows.length > 0;
}

async function loadAuthority(tx: Tx, articleId: string) {
  const events = await tx.labelEvent.findMany({ where: { articleId, source: "admin" }, select: AUTHORITY_SELECT });
  return currentAdminAuthority(events);
}

export async function recordKeywordReject(tx: Tx, articleId: string, reason: string): Promise<void> {
  // New row inside the ingest create transaction: nothing else can see it yet.
  await tx.labelEvent.create({
    data: { articleId, source: "keyword", verdict: "reject", reason, createdAt: new Date() },
  });
}

export async function recordOllamaResult(
  articleId: string,
  r: { outcome: OllamaOutcome; reason: string; pass: 1 | 2 },
  model: string,
): Promise<"applied" | "recorded_only" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockArticle(tx, articleId))) return "not_found";
    const authority = await loadAuthority(tx, articleId);
    const reject = r.outcome === "judged_reject";

    await tx.labelEvent.create({
      data: {
        articleId,
        source: "ollama",
        verdict: reject ? "reject" : "keep",
        reason: r.reason,
        pass: r.pass,
        actor: model,
        eligible: r.outcome === "judged_keep" || r.outcome === "judged_reject",
        createdAt: new Date(),
      },
    });

    if (authority) return "recorded_only";

    const now = new Date();
    await tx.article.update({
      where: { id: articleId },
      data: reject
        ? { isPositive: false, curatedAt: now, rejectionReason: r.reason, rejectionPass: r.pass }
        : { curatedAt: now },
    });
    return "applied";
  });
}

export async function recordReaderFlag(
  articleId: string,
  actorHash: string | null,
  onHide: (tx: Tx) => Promise<void>,
): Promise<"not_found" | "duplicate" | "recorded" | "hidden"> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockArticle(tx, articleId))) return "not_found";

    const dedupeKey = actorHash ? `flag:${articleId}:${actorHash}` : null;
    if (dedupeKey && (await tx.labelEvent.findUnique({ where: { dedupeKey }, select: { id: true } }))) {
      return "duplicate";
    }

    await tx.labelEvent.create({
      data: { articleId, source: "reader_flag", verdict: "reject", actor: actorHash, dedupeKey, createdAt: new Date() },
    });

    const article = await tx.article.findUniqueOrThrow({ where: { id: articleId }, select: { flaggedAt: true } });
    if (article.flaggedAt || (await loadAuthority(tx, articleId))) return "recorded";

    await tx.article.update({ where: { id: articleId }, data: { isPositive: false, flaggedAt: new Date() } });
    await onHide(tx);
    return "hidden";
  });
}

function adminRejectReason(category: string | null): string {
  if (!category) return "admin";
  return `admin: ${CATEGORIES[category]?.label ?? category}`;
}

export async function recordAdminDecision(
  articleId: string,
  verdict: "keep" | "reject",
  opts: { category?: string | null; bucket: ReviewBucket; actor: string | null },
): Promise<{ status: "ok"; eventId: string } | { status: "not_found" }> {
  if (!(REVIEW_BUCKETS as readonly string[]).includes(opts.bucket)) throw new Error(`Invalid bucket: ${opts.bucket}`);
  const category = verdict === "reject" ? (opts.category ?? null) : null;
  if (category && !(category in CATEGORIES)) throw new Error(`Invalid category: ${category}`);

  return prisma.$transaction(async (tx) => {
    if (!(await lockArticle(tx, articleId))) return { status: "not_found" as const };

    const a = await tx.article.findUniqueOrThrow({
      where: { id: articleId },
      select: { isPositive: true, curatedAt: true, rejectionPass: true, rejectionReason: true },
    });
    const prevState = {
      isPositive: a.isPositive,
      curatedAt: a.curatedAt ? a.curatedAt.toISOString() : null,
      rejectionPass: a.rejectionPass,
      rejectionReason: a.rejectionReason,
    };

    const event = await tx.labelEvent.create({
      data: {
        articleId,
        source: "admin",
        verdict,
        category,
        bucket: opts.bucket,
        actor: opts.actor,
        prevState,
        createdAt: new Date(),
      },
    });

    await tx.article.update({
      where: { id: articleId },
      data:
        verdict === "keep"
          ? { isPositive: true, curatedAt: a.curatedAt ?? new Date(), rejectionPass: null, rejectionReason: null }
          : { isPositive: false, rejectionPass: ADMIN_REJECTION_PASS, rejectionReason: adminRejectReason(category) },
    });

    return { status: "ok" as const, eventId: event.id };
  });
}

interface PrevState {
  isPositive: boolean;
  curatedAt: string | null;
  rejectionPass: number | null;
  rejectionReason: string | null;
}

export async function retractAdminDecision(eventId: string, actor: string | null): Promise<"ok" | "stale" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.labelEvent.findUnique({ where: { id: eventId }, select: AUTHORITY_SELECT });
    if (!target || target.source !== "admin" || (target.verdict !== "keep" && target.verdict !== "reject")) {
      return "not_found";
    }
    const articleId = (await tx.labelEvent.findUniqueOrThrow({ where: { id: eventId }, select: { articleId: true } })).articleId;
    if (!(await lockArticle(tx, articleId))) return "not_found";

    const authority = await loadAuthority(tx, articleId);
    if (authority?.id !== eventId) return "stale";

    await tx.labelEvent.create({
      data: { articleId, source: "admin", verdict: "retract", retractsId: eventId, actor, reason: "undo", createdAt: new Date() },
    });

    const prev = target.prevState as unknown as PrevState | null;
    if (prev) {
      await tx.article.update({
        where: { id: articleId },
        data: {
          isPositive: prev.isPositive,
          curatedAt: prev.curatedAt ? new Date(prev.curatedAt) : null,
          rejectionPass: prev.rejectionPass,
          rejectionReason: prev.rejectionReason,
        },
      });
    }
    return "ok";
  });
}
```

- [ ] **Step 4: Run the integration test until it passes**, then run the full suite: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`. Then run `pnpm test` with `DATABASE_URL` unset (`env -u DATABASE_URL pnpm test`) to show the integration suite is skipped cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/lib/article-decisions.ts src/lib/article-decisions.integration.test.ts
git commit -m "feat(labels): add serialised article decision path"
```

---

### Task 3: Route existing writers through the decision path

**Files:**
- Modify: `src/lib/llm-curator.ts`, `src/lib/curate.ts`, `src/lib/ingest.ts`, `app/api/articles/[id]/flag/route.ts`, `app/admin/rejections/actions.ts`, `app/admin/flagged/actions.ts`, `scripts/backfill-classify.ts`
- Create: `src/lib/llm-curator.test.ts`

**Interfaces:**
- Consumes: everything from Task 2; `hashReaderIp`
- Produces: `CurationResult` gains `outcome: OllamaOutcome` (type imported from `article-decisions.ts`)

- [ ] **Step 1: Write the failing curator tests** in `src/lib/llm-curator.test.ts`. They stub `fetch` and return crafted Ollama responses.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { curateArticles } from "./llm-curator";

function ollamaReply(obj: unknown) {
  return { ok: true, json: async () => ({ response: JSON.stringify(obj) }) } as Response;
}

const A = { id: "a", title: "A", language: "en" };
const B = { id: "b", title: "B", language: "en" };
const C = { id: "c", title: "C", language: "en" };

afterEach(() => vi.unstubAllGlobals());

describe("curateArticles outcomes", () => {
  it("judged reject in pass 1, judged keep and judged reject in pass 2", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ollamaReply({ results: [
        { id: "a", positive: false, reason: "war" },
        { id: "b", positive: true, reason: "ok" },
        { id: "c", positive: true, reason: "ok" },
      ] }))
      .mockResolvedValueOnce(ollamaReply({ results: [
        { id: "b", keep: true, reason: "uplifting" },
        { id: "c", keep: false, reason: "marketing" },
      ] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await curateArticles([A, B, C]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ outcome: "judged_reject", isPositive: false, pass: 1 });
    expect(by.b).toMatchObject({ outcome: "judged_keep", isPositive: true, pass: 2 });
    expect(by.c).toMatchObject({ outcome: "judged_reject", isPositive: false, pass: 2 });
  });

  it("missing ids are missing_result (kept), never judged_keep", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "b", positive: true, reason: "ok" }] })) // a missing in pass 1
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", keep: true, reason: "fine" }] })); // b missing in pass 2
    vi.stubGlobal("fetch", fetchMock);
    const r = await curateArticles([A, B]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ outcome: "missing_result", isPositive: true });
    expect(by.b).toMatchObject({ outcome: "missing_result", isPositive: true, reason: "missing result" });
  });

  it("failed calls are unavailable (kept)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await curateArticles([A]);
    expect(r[0]).toMatchObject({ outcome: "unavailable", isPositive: true, reason: "LLM unavailable", pass: 1 });
  });

  it("pass 2 failure marks pass-1 positives unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", positive: true, reason: "ok" }] }))
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response));
    const r = await curateArticles([A]);
    expect(r[0]).toMatchObject({ outcome: "unavailable", isPositive: true, pass: 2 });
  });
});
```

Also silence the curator's `console.log` progress lines in these tests by adding `vi.spyOn(console, "log").mockImplementation(() => {})` in a `beforeEach`, so the output stays clean.

- [ ] **Step 2: Run them to confirm they fail.** `outcome` doesn't exist yet.

- [ ] **Step 3: Add outcomes to `src/lib/llm-curator.ts`**

- Import `type OllamaOutcome` from `./article-decisions`, and add `outcome: OllamaOutcome;` to `CurationResult`.
- In `curateArticles`, track `const pass1Missing = new Set<string>()`. In the pass-1 loop, `if (!r)` adds `a.id` to `pass1Missing` and pushes to `positiveArticles`.
- Replace each `results.push` as follows:

| Site | New push |
|---|---|
| Pass 1 failed (`!pass1?.results`) | `{ id, isPositive: true, reason: "LLM unavailable", pass: 1, outcome: "unavailable" }` |
| Pass 1 reject | `{ id, isPositive: false, reason: r.reason, pass: 1, outcome: "judged_reject" }` |
| Pass 2 failed | `{ id, isPositive: true, reason: "LLM pass 2 unavailable", pass: 2, outcome: "unavailable" }` |
| Pass 2 `r` missing | `{ id, isPositive: true, reason: "missing result", pass: 2, outcome: "missing_result" }` |
| Pass 2 `r.keep` | `{ id, isPositive: true, reason: r.reason, pass: 2, outcome: pass1Missing.has(a.id) ? "missing_result" : "judged_keep" }` |
| Pass 2 reject | `{ id, isPositive: false, reason: r.reason, pass: 2, outcome: "judged_reject" }` |

The old `r?.reason ?? "passed both checks"` fallback is removed.

- [ ] **Step 4: Rewrite the write section of `src/lib/curate.ts`**

Replace everything from `const approvedIds` to just before the final summary log with:

```ts
  let rejected = 0;
  let approved = 0;

  for (const r of results) {
    try {
      const status = await recordOllamaResult(r.id, { outcome: r.outcome, reason: r.reason, pass: r.pass }, OLLAMA_MODEL);
      if (status !== "applied") continue;
      if (r.isPositive) {
        approved++;
      } else {
        rejected++;
        console.log(`[curate] Rejected: "${needsCuration.find((a) => a.id === r.id)?.title}" — ${r.reason} (pass ${r.pass})`);
      }
    } catch (err) {
      console.error(`[curate] Failed to record result for ${r.id}:`, err);
    }
  }

  const curated = trusted.length + approved;
```

Keep the existing summary log and return statement, using these `curated` and `rejected` values. Add `import { recordOllamaResult } from "./article-decisions";` and `const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma3:4b";`. The trusted auto-approve `updateMany` stays as is: it writes no event, by design.

- [ ] **Step 5: Ingest** (`src/lib/ingest.ts`). Wrap the create in a transaction:

```ts
      await prisma.$transaction(async (tx) => {
        const created = await tx.article.create({
          data: { /* unchanged fields */ },
        });
        if (!classResult.positive) {
          await recordKeywordReject(tx, created.id, classResult.reason ?? "keyword filter");
        }
      });
```

Keep the `data` object exactly as it is today, and keep the existing P2002 catch. Import `recordKeywordReject` from `./article-decisions`.

- [ ] **Step 6: Flag route** (`app/api/articles/[id]/flag/route.ts`). Keep the CSRF check, the rate limit and the `findUnique` (it 404s early and gives `language`). Remove the `if (article.flaggedAt) return duplicate` early return. Replace the `$transaction` block with:

```ts
  const status = await recordReaderFlag(id, hashReaderIp(ip), async (tx) => {
    if (keywords.length === 0) return;
    // …existing keyword upsert / LearnedKeywordFlag / uniqueIps / auto-activate code, unchanged, using `tx`…
  });

  if (status === "not_found") return NextResponse.json({ error: "Article not found" }, { status: 404 });
  if (status !== "hidden") return NextResponse.json({ success: true, duplicate: true });
```

Keep the Redis invalidation and the final `{ success: true }`; they now run only when the article was hidden. The `result.count === 0` guard goes away, because `recordReaderFlag` already decides whether a hide happened. If `hashReaderIp` returns null, log `console.warn("[flag] AUTH_SECRET missing; reader vote recorded without identity")`.

- [ ] **Step 7: Admin actions.** In `app/admin/rejections/actions.ts` and `app/admin/flagged/actions.ts`, replace the `prisma.article.update` with:

```ts
  const session = await auth();
  if (!session) redirect("/admin/login");
  await recordAdminDecision(id, "keep", { bucket: "manual", actor: session.user?.email ?? null });
```

Keep the existing `revalidatePath` calls, adding `revalidatePath("/admin/review")`. Replace `requireAdmin` with the inline check above, since the session is needed for the email.

- [ ] **Step 8: Legacy script.** In `scripts/backfill-classify.ts`, add a header line: `LEGACY: bypasses the decision path; skips articles with an admin decision.` Before each update, skip articles that have any admin `LabelEvent`. Batch this: fetch the ids that have admin events with `prisma.labelEvent.findMany({ where: { source: "admin", articleId: { in: batchIds } }, select: { articleId: true } })`.

- [ ] **Step 9: Verify and commit.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint`; the curator tests should pass and the integration suite still runs locally. Then flag-check by hand:

```bash
pnpm build >/dev/null && (pnpm start > /tmp/ls-start.log 2>&1 &) && sleep 6
ID=$(docker exec pn-jev-pg psql -U pn -d positivenews -Atc 'select id from "Article" where "isPositive" order by "createdAt" desc limit 1')
for ip in 10.0.0.1 10.0.0.1 10.0.0.2; do curl -s -X POST -H "X-Forwarded-For: $ip" http://localhost:3000/news/api/articles/$ID/flag; echo; done
docker exec pn-jev-pg psql -U pn -d positivenews -Atc "select source, count(*) from \"LabelEvent\" where \"articleId\"='$ID' group by 1"
pkill -f "next start"
```

Expected responses: `{"success":true}`, then `{"success":true,"duplicate":true}` twice. Expected count: `reader_flag|2`.

```bash
git add -A src app scripts
git commit -m "feat(labels): route ingest, curation, flags and admin actions through decision path"
```

---

### Task 4: History import

**Files:**
- Create: `scripts/labels-backfill.ts`
- Modify: `package.json` (add the script `"labels:backfill": "tsx scripts/labels-backfill.ts"`)

**Interfaces:**
- Consumes: `prisma`, `FEED_SOURCES`, `scripts/load-env.ts`
- Produces: the CLI `pnpm labels:backfill [--before <ISO>]`

- [ ] **Step 1: Implement `scripts/labels-backfill.ts`**

```ts
/**
 * One-off import of historical judgements into LabelEvent (backfilled = true).
 * Idempotent: every event has dedupeKey backfill:<articleId>:<kind>.
 *
 * Usage: pnpm labels:backfill [--before 2026-10-08T00:00:00Z]
 */
import "./load-env";
import { prisma } from "../src/lib/prisma";
import { FEED_SOURCES } from "../src/config/sources";

const BATCH = 500;
const trusted = new Set(FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url));

function beforeArg(): Date {
  const i = process.argv.indexOf("--before");
  if (i === -1) return new Date();
  const d = new Date(process.argv[i + 1] ?? "");
  if (Number.isNaN(d.getTime())) {
    console.error("--before must be an ISO date");
    process.exit(1);
  }
  return d;
}

type Kind = "keyword" | "ollama" | "flag";

async function main() {
  const before = beforeArg();
  const counts = { scanned: 0, keyword: 0, ollama_reject: 0, ollama_keep_unverified: 0, flag: 0, skipped: 0 };
  let cursor: string | undefined;

  console.log(`[labels-backfill] articles created before ${before.toISOString()}`);

  for (;;) {
    const batch = await prisma.article.findMany({
      where: { createdAt: { lt: before } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        createdAt: true,
        curatedAt: true,
        flaggedAt: true,
        rejectionPass: true,
        rejectionReason: true,
        source: { select: { url: true } },
        labelEvents: { where: { backfilled: false }, select: { source: true } },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const a of batch) {
      counts.scanned++;
      const live = new Set(a.labelEvents.map((e) => e.source));
      const rows: Array<{ kind: Kind; data: Record<string, unknown> }> = [];

      if (a.rejectionPass === 0 && !live.has("keyword")) {
        rows.push({ kind: "keyword", data: { source: "keyword", verdict: "reject", reason: a.rejectionReason, createdAt: a.createdAt } });
      } else if ((a.rejectionPass === 1 || a.rejectionPass === 2) && !live.has("ollama")) {
        rows.push({ kind: "ollama", data: { source: "ollama", verdict: "reject", reason: a.rejectionReason, pass: a.rejectionPass, createdAt: a.curatedAt ?? a.createdAt } });
      } else if (a.curatedAt && a.rejectionPass === null && !trusted.has(a.source.url) && !live.has("ollama")) {
        rows.push({ kind: "ollama", data: { source: "ollama", verdict: "keep", reason: "historical approval (unverified)", pass: 2, eligible: false, createdAt: a.curatedAt } });
      }
      if (a.flaggedAt && !live.has("reader_flag")) {
        rows.push({ kind: "flag", data: { source: "reader_flag", verdict: "reject", createdAt: a.flaggedAt } });
      }

      if (rows.length === 0) continue;

      const result = await prisma.labelEvent.createMany({
        data: rows.map((r) => ({ articleId: a.id, backfilled: true, dedupeKey: `backfill:${a.id}:${r.kind}`, ...r.data })) as never,
        skipDuplicates: true,
      });
      counts.skipped += rows.length - result.count;
      if (result.count === 0) continue;
      for (const r of rows) {
        if (r.kind === "keyword") counts.keyword++;
        else if (r.kind === "flag") counts.flag++;
        else if (r.data.verdict === "reject") counts.ollama_reject++;
        else counts.ollama_keep_unverified++;
      }
    }
    console.log(`[labels-backfill] ${counts.scanned} scanned…`);
  }

  console.log("[labels-backfill] done", counts);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[labels-backfill] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
```

`createMany` with `skipDuplicates` makes each article's import a single atomic statement that is safe to re-run. The `as never` cast is needed because the rows are built generically. If tsc can't accept it, replace the cast by typing `rows` as `Prisma.LabelEventCreateManyInput[]` without `articleId`, then adding it.

- [ ] **Step 2: Verify locally**

```bash
pnpm labels:backfill
pnpm labels:backfill
docker exec pn-jev-pg psql -U pn -d positivenews -Atc 'select source, verdict, eligible, count(*) from "LabelEvent" where backfilled group by 1,2,3 order by 1,2,3'
```

Expected: the first run creates events. The second run reports 0 new for every kind, with all of them counted as skipped or excluded by the `live` check. The counts match the article fields.

- [ ] **Step 3: Commit**

```bash
git add scripts/labels-backfill.ts package.json
git commit -m "feat(labels): add idempotent history import"
```

---

### Task 5: Review queue logic and loader

**Files:**
- Create: `src/lib/review-queue.ts`, `src/lib/review-queue.test.ts`, `src/lib/review-queue-data.ts`

**Interfaces:**
- Consumes: `isTestCohort`, `currentAdminAuthority` from `labels.ts`; `QUESTION_SET` from `jev.ts`; `prisma`
- Produces:
  - `src/lib/review-queue.ts` (pure):
    - `DAILY_TARGET`, `QUOTAS`, `type QueueBucket = "flagged" | "leak" | "miss" | "cohort"`
    - `interface QueueCandidate { articleId: string; createdAt: Date; flagged: boolean; inFeed: boolean; cohort: boolean; jev: { positiveP: number; upliftingP: number; topCategoryP: number } | null }`
    - `bucketOf(c: QueueCandidate): QueueBucket | null`
    - `selectNext(candidates: QueueCandidate[], decidedToday: Record<QueueBucket, number>, opts: { date: string; exclude?: ReadonlySet<string> }): { candidate: QueueCandidate; bucket: QueueBucket } | null`
    - `helsinkiDate(d: Date): string` (YYYY-MM-DD), `startOfHelsinkiDay(d: Date): Date`
  - `src/lib/review-queue-data.ts`:
    - `loadCandidates(now?: Date): Promise<QueueCandidate[]>`
    - `loadDecidedToday(now?: Date): Promise<Record<QueueBucket, number>>`
    - `todayCount(now?: Date): Promise<number>`
    - `interface ReviewCard { articleId; title; summary: string | null; url; imageUrl: string | null; sourceName; language; bucket: QueueBucket }`
    - `loadNextCard(opts: { exclude: ReadonlySet<string>; focus?: string | null; now?: Date }): Promise<{ card: ReviewCard | null; doneToday: number }>`

- [ ] **Step 1: Write the failing tests in `src/lib/review-queue.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { bucketOf, DAILY_TARGET, helsinkiDate, QUOTAS, selectNext, startOfHelsinkiDay, type QueueBucket, type QueueCandidate } from "./review-queue";

let seq = 0;
function cand(p: Partial<QueueCandidate>): QueueCandidate {
  seq++;
  return { articleId: `a${seq}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)), flagged: false, inFeed: true, cohort: false, jev: null, ...p };
}
const zero = (): Record<QueueBucket, number> => ({ flagged: 0, leak: 0, miss: 0, cohort: 0 });
const DATE = "2026-10-07";

describe("bucketOf", () => {
  it("applies the bucket rules in order, reserving cohort articles", () => {
    expect(bucketOf(cand({ cohort: true, flagged: true }))).toBe("cohort");
    expect(bucketOf(cand({ flagged: true }))).toBe("flagged");
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0.1 } }))).toBe("leak");
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.9, upliftingP: 0.1, topCategoryP: 0.1 } }))).toBe("leak");
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.9, upliftingP: 0.9, topCategoryP: 0.81 } }))).toBe("leak");
    expect(bucketOf(cand({ inFeed: false, jev: { positiveP: 0.81, upliftingP: 0.81, topCategoryP: 0.29 } }))).toBe("miss");
    expect(bucketOf(cand({ inFeed: false, jev: { positiveP: 0.8, upliftingP: 0.9, topCategoryP: 0.1 } }))).toBeNull();
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.5, upliftingP: 0.5, topCategoryP: 0.5 } }))).toBeNull();
    expect(bucketOf(cand({ inFeed: true, jev: null }))).toBeNull();
  });
});

describe("selectNext", () => {
  it("serves the cohort every fifth card while it has quota", () => {
    const pool = [
      ...Array.from({ length: 10 }, () => cand({ flagged: true })),
      ...Array.from({ length: 10 }, () => cand({ cohort: true })),
    ];
    const d = zero();
    d.flagged = 4; // 4 decided → the next is the 5th card
    expect(selectNext(pool, d, { date: DATE })?.bucket).toBe("cohort");
    d.flagged = 3;
    expect(selectNext(pool, d, { date: DATE })?.bucket).toBe("flagged");
  });

  it("picks the targeted bucket with most remaining quota, oldest first", () => {
    const oldLeak = cand({ inFeed: true, jev: { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0 }, createdAt: new Date(Date.UTC(2026, 8, 25)) });
    const newLeak = cand({ inFeed: true, jev: { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0 } });
    const flag = cand({ flagged: true });
    const d = zero();
    d.flagged = 5; // flagged has 1 left, leak has 5
    expect(selectNext([newLeak, flag, oldLeak], d, { date: DATE })?.candidate.articleId).toBe(oldLeak.articleId);
  });

  it("passes quota on when a bucket is empty and respects exclude", () => {
    const miss = cand({ inFeed: false, jev: { positiveP: 0.9, upliftingP: 0.9, topCategoryP: 0 } });
    const d = zero();
    d.miss = QUOTAS.miss; // miss quota used up, but it's the only candidate
    expect(selectNext([miss], d, { date: DATE })?.bucket).toBe("miss");
    expect(selectNext([miss], d, { date: DATE, exclude: new Set([miss.articleId]) })).toBeNull();
  });

  it("orders the cohort by a stable per-day hash", () => {
    const pool = Array.from({ length: 20 }, () => cand({ cohort: true }));
    const d = zero();
    d.flagged = 4;
    const a = selectNext(pool, d, { date: DATE })?.candidate.articleId;
    expect(selectNext([...pool].reverse(), d, { date: DATE })?.candidate.articleId).toBe(a);
    const other = selectNext(pool, d, { date: "2026-10-08" })?.candidate.articleId;
    expect(typeof other).toBe("string");
  });

  it("keeps serving after the daily target, in bucket order", () => {
    const pool = [cand({ cohort: true }), cand({ flagged: true })];
    const d: Record<QueueBucket, number> = { flagged: 6, leak: 5, miss: 5, cohort: 4 };
    expect(d.flagged + d.leak + d.miss + d.cohort).toBe(DAILY_TARGET);
    expect(selectNext(pool, d, { date: DATE })?.bucket).toBe("flagged");
  });

  it("ignores candidates that belong to no bucket", () => {
    expect(selectNext([cand({ inFeed: true, jev: null })], zero(), { date: DATE })).toBeNull();
  });
});

describe("Helsinki day", () => {
  it("handles summer (UTC+3) and winter (UTC+2)", () => {
    expect(helsinkiDate(new Date("2026-10-07T21:30:00Z"))).toBe("2026-10-08");
    expect(startOfHelsinkiDay(new Date("2026-10-07T21:30:00Z")).toISOString()).toBe("2026-10-07T21:00:00.000Z");
    expect(startOfHelsinkiDay(new Date("2026-12-01T10:00:00Z")).toISOString()).toBe("2026-11-30T22:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run them to confirm they fail.**

- [ ] **Step 3: Implement `src/lib/review-queue.ts`**

```ts
/**
 * Pure selection logic for the admin review queue. Each decision records
 * its bucket, so remaining quotas are derived from today's decisions and
 * the selection stays consistent across reloads and devices.
 */

import { createHash } from "node:crypto";

export const DAILY_TARGET = 20;
export const QUOTAS = { flagged: 6, leak: 5, miss: 5, cohort: 4 } as const;
export type QueueBucket = keyof typeof QUOTAS;
const TARGETED: QueueBucket[] = ["flagged", "leak", "miss"];
const FALLBACK_ORDER: QueueBucket[] = ["flagged", "leak", "miss", "cohort"];
const COHORT_EVERY = 5;

export interface QueueCandidate {
  articleId: string;
  createdAt: Date;
  flagged: boolean;
  inFeed: boolean;
  cohort: boolean;
  jev: { positiveP: number; upliftingP: number; topCategoryP: number } | null;
}

export function bucketOf(c: QueueCandidate): QueueBucket | null {
  if (c.cohort) return "cohort";
  if (c.flagged) return "flagged";
  if (c.jev && c.inFeed && (c.jev.positiveP < 0.2 || c.jev.upliftingP < 0.2 || c.jev.topCategoryP > 0.8)) return "leak";
  if (c.jev && !c.inFeed && c.jev.positiveP > 0.8 && c.jev.upliftingP > 0.8 && c.jev.topCategoryP < 0.3) return "miss";
  return null;
}

function dayHash(articleId: string, date: string): string {
  return createHash("sha256").update(`${articleId}:${date}`).digest("hex");
}

export function selectNext(
  candidates: QueueCandidate[],
  decidedToday: Record<QueueBucket, number>,
  opts: { date: string; exclude?: ReadonlySet<string> },
): { candidate: QueueCandidate; bucket: QueueBucket } | null {
  const groups: Record<QueueBucket, QueueCandidate[]> = { flagged: [], leak: [], miss: [], cohort: [] };
  for (const c of candidates) {
    if (opts.exclude?.has(c.articleId)) continue;
    const b = bucketOf(c);
    if (b) groups[b].push(c);
  }
  for (const b of TARGETED) groups[b].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  groups.cohort.sort((x, y) => (dayHash(x.articleId, opts.date) < dayHash(y.articleId, opts.date) ? -1 : 1));

  const pick = (b: QueueBucket) => (groups[b].length > 0 ? { candidate: groups[b][0], bucket: b } : null);
  const total = (Object.keys(QUOTAS) as QueueBucket[]).reduce((s, b) => s + decidedToday[b], 0);
  const remaining = (b: QueueBucket) => Math.max(0, QUOTAS[b] - decidedToday[b]);

  if (total < DAILY_TARGET) {
    if ((total + 1) % COHORT_EVERY === 0 && remaining("cohort") > 0) {
      const c = pick("cohort");
      if (c) return c;
    }
    const targeted = TARGETED.filter((b) => remaining(b) > 0 && groups[b].length > 0).sort(
      (x, y) => remaining(y) - remaining(x) || TARGETED.indexOf(x) - TARGETED.indexOf(y),
    );
    if (targeted.length > 0) return pick(targeted[0]);
    if (remaining("cohort") > 0) {
      const c = pick("cohort");
      if (c) return c;
    }
  }

  for (const b of FALLBACK_ORDER) {
    const c = pick(b);
    if (c) return c;
  }
  return null;
}

const DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit" });
const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Helsinki",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function helsinkiDate(d: Date): string {
  return DATE_FMT.format(d);
}

/** Midnight Europe/Helsinki of d's Helsinki date (uses d's UTC offset). */
export function startOfHelsinkiDay(d: Date): Date {
  const parts = Object.fromEntries(PARTS_FMT.formatToParts(d).map((p) => [p.type, p.value]));
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offsetMs = wallAsUtc - Math.floor(d.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
}
```

- [ ] **Step 4: Implement `src/lib/review-queue-data.ts`**

```ts
import { prisma } from "./prisma";
import { QUESTION_SET } from "./jev";
import { currentAdminAuthority, isTestCohort } from "./labels";
import { helsinkiDate, QUOTAS, selectNext, startOfHelsinkiDay, type QueueBucket, type QueueCandidate } from "./review-queue";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ADMIN_EVENT_SELECT = { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true } as const;

export interface ReviewCard {
  articleId: string;
  title: string;
  summary: string | null;
  url: string;
  imageUrl: string | null;
  sourceName: string;
  language: string;
  bucket: QueueBucket;
}

export async function loadCandidates(now = new Date()): Promise<QueueCandidate[]> {
  const rows = await prisma.article.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - WINDOW_MS) } },
    select: {
      id: true,
      createdAt: true,
      isPositive: true,
      flaggedAt: true,
      labelEvents: { where: { source: { in: ["admin", "reader_flag"] } }, select: ADMIN_EVENT_SELECT },
      jevEvaluations: { where: { questionSet: QUESTION_SET }, select: { positiveP: true, upliftingP: true, topCategoryP: true }, take: 1 },
    },
  });

  return rows
    .filter((r) => currentAdminAuthority(r.labelEvents) === null)
    .map((r) => ({
      articleId: r.id,
      createdAt: r.createdAt,
      flagged: Boolean(r.flaggedAt) || r.labelEvents.some((e) => e.source === "reader_flag"),
      inFeed: r.isPositive,
      cohort: isTestCohort(r.id),
      jev: r.jevEvaluations[0] ?? null,
    }));
}

async function todaysDecisions(now: Date) {
  const since = startOfHelsinkiDay(now);
  const events = await prisma.labelEvent.findMany({
    where: { source: "admin", createdAt: { gte: since } },
    select: ADMIN_EVENT_SELECT,
  });
  const retracted = new Set(events.filter((e) => e.verdict === "retract").map((e) => e.retractsId));
  return events.filter((e) => e.verdict !== "retract" && e.bucket && !retracted.has(e.id));
}

export async function loadDecidedToday(now = new Date()): Promise<Record<QueueBucket, number>> {
  const counts: Record<QueueBucket, number> = { flagged: 0, leak: 0, miss: 0, cohort: 0 };
  for (const e of await todaysDecisions(now)) {
    if (e.bucket && e.bucket in QUOTAS) counts[e.bucket as QueueBucket]++;
  }
  return counts;
}

export async function todayCount(now = new Date()): Promise<number> {
  return (await todaysDecisions(now)).length;
}

export async function loadNextCard(opts: { exclude: ReadonlySet<string>; focus?: string | null; now?: Date }) {
  const now = opts.now ?? new Date();
  const [candidates, decided, doneToday] = await Promise.all([loadCandidates(now), loadDecidedToday(now), todayCount(now)]);

  let chosen: { candidate: QueueCandidate; bucket: QueueBucket } | null = null;
  if (opts.focus) {
    const c = candidates.find((x) => x.articleId === opts.focus);
    if (c) chosen = { candidate: c, bucket: c.cohort ? "cohort" : c.flagged ? "flagged" : "leak" };
  }
  chosen ??= selectNext(candidates, decided, { date: helsinkiDate(now), exclude: opts.exclude });
  if (!chosen) return { card: null, doneToday };

  const a = await prisma.article.findUniqueOrThrow({
    where: { id: chosen.candidate.articleId },
    select: { id: true, title: true, summary: true, url: true, imageUrl: true, source: { select: { name: true, language: true } } },
  });
  const card: ReviewCard = {
    articleId: a.id,
    title: a.title,
    summary: a.summary,
    url: a.url,
    imageUrl: a.imageUrl,
    sourceName: a.source.name,
    language: a.source.language,
    bucket: chosen.bucket,
  };
  return { card, doneToday };
}
```

The `focus` bucket fallback (`"leak"`) only applies to a card re-shown after an undo whose original bucket can't be recomputed. Compute it properly instead: use `bucketOf(c) ?? "leak"`, importing `bucketOf`.

- [ ] **Step 5: Verify and commit.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint`.

```bash
git add src/lib/review-queue.ts src/lib/review-queue.test.ts src/lib/review-queue-data.ts
git commit -m "feat(review): add review queue selection and loader"
```

---

### Task 6: Review UI, nav, flagged inbox, pass-3 label

**Files:**
- Create: `app/admin/review/page.tsx`, `app/admin/review/ReviewCard.tsx`, `app/admin/review/actions.ts`
- Modify: `app/admin/layout.tsx`, `app/admin/flagged/page.tsx`, `app/admin/rejections/RejectionsClient.tsx`

**Interfaces:**
- Consumes: `loadNextCard`, `todayCount`, `ReviewCard`, `DAILY_TARGET`; `recordAdminDecision`, `retractAdminDecision`; `CATEGORIES`, `deriveVerdict` from `jev.ts`; `currentAdminAuthority`
- Produces: the route `/admin/review` (browser URL `/news/admin/review`). Server actions:
  - `decideAction(articleId: string, verdict: "keep" | "reject", category: string | null, bucket: string)`, returning `{ ok: true; eventId: string; reveal: Reveal } | { ok: false; error: string }`
  - `undoAction(eventId: string)`, returning `{ ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Read the Next.js docs** on server actions and on `searchParams` (it is a Promise) in `node_modules/next/dist/docs/`.

- [ ] **Step 2: `app/admin/review/actions.ts`**

```ts
"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/src/lib/prisma";
import { recordAdminDecision, retractAdminDecision } from "@/src/lib/article-decisions";
import { CATEGORIES, deriveVerdict, QUESTION_SET } from "@/src/lib/jev";
import { REVIEW_BUCKETS, type ReviewBucket } from "@/src/lib/labels";

export interface Reveal {
  ollama: string | null;  // "keep" | "reject" | null
  keyword: boolean;
  jev: { keep: boolean; positiveP: number; upliftingP: number; topCategory: string } | null;
}

async function actor(): Promise<string | null> {
  const session = await auth();
  if (!session) redirect("/admin/login");
  return session.user?.email ?? null;
}

function revalidate() {
  for (const p of ["/", "/admin/review", "/admin/rejections", "/admin/flagged"]) revalidatePath(p);
}

async function loadReveal(articleId: string): Promise<Reveal> {
  const [events, jev] = await Promise.all([
    prisma.labelEvent.findMany({
      where: { articleId, source: { in: ["ollama", "keyword"] }, eligible: true },
      orderBy: { createdAt: "desc" },
      select: { source: true, verdict: true },
    }),
    prisma.jevEvaluation.findFirst({ where: { articleId, questionSet: QUESTION_SET } }),
  ]);
  return {
    ollama: events.find((e) => e.source === "ollama")?.verdict ?? null,
    keyword: events.some((e) => e.source === "keyword"),
    jev: jev
      ? { keep: deriveVerdict(jev).keep, positiveP: jev.positiveP, upliftingP: jev.upliftingP, topCategory: CATEGORIES[jev.topCategory]?.label ?? jev.topCategory }
      : null,
  };
}

export async function decideAction(articleId: string, verdict: "keep" | "reject", category: string | null, bucket: string) {
  const who = await actor();
  if (verdict !== "keep" && verdict !== "reject") return { ok: false as const, error: "Invalid verdict" };
  if (!(REVIEW_BUCKETS as readonly string[]).includes(bucket)) return { ok: false as const, error: "Invalid bucket" };
  if (category && !(category in CATEGORIES)) return { ok: false as const, error: "Invalid category" };
  try {
    const r = await recordAdminDecision(articleId, verdict, { category, bucket: bucket as ReviewBucket, actor: who });
    if (r.status === "not_found") return { ok: false as const, error: "Article not found" };
    revalidate();
    return { ok: true as const, eventId: r.eventId, reveal: await loadReveal(articleId) };
  } catch (err) {
    console.error("[review] decide failed:", err);
    return { ok: false as const, error: "Could not save decision" };
  }
}

export async function undoAction(eventId: string) {
  const who = await actor();
  try {
    const r = await retractAdminDecision(eventId, who);
    if (r === "stale") return { ok: false as const, error: "Decision changed elsewhere" };
    if (r === "not_found") return { ok: false as const, error: "Decision not found" };
    revalidate();
    return { ok: true as const };
  } catch (err) {
    console.error("[review] undo failed:", err);
    return { ok: false as const, error: "Could not undo" };
  }
}
```

- [ ] **Step 3: `app/admin/review/page.tsx`**

```tsx
// app/admin/review/page.tsx
import Link from "next/link";
import { loadNextCard } from "@/src/lib/review-queue-data";
import { DAILY_TARGET } from "@/src/lib/review-queue";
import { CATEGORIES } from "@/src/lib/jev";
import { ReviewCardView } from "./ReviewCard";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function ReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const skip = new Set((one(params.skip) ?? "").split(",").filter(Boolean).slice(0, 200));
  const more = one(params.more) === "1";
  const { card, doneToday } = await loadNextCard({ exclude: skip, focus: one(params.focus) ?? null });
  const done = doneToday >= DAILY_TARGET && !more;
  const categories = Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label }));

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold text-foreground">Review</h1>
        <span className="text-sm text-muted-foreground tabular-nums">{doneToday} / {DAILY_TARGET} today</span>
      </div>

      {done ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-foreground font-medium">Done for today.</p>
          <p className="text-sm text-muted-foreground mt-1">Thanks — these decisions train and test the filter.</p>
          <Link href={{ pathname: "/admin/review", query: { more: "1" } }} className="inline-block mt-4 text-sm text-primary hover:underline">
            Keep going
          </Link>
        </div>
      ) : card ? (
        <ReviewCardView key={card.articleId} card={card} categories={categories} skip={[...skip]} more={more} />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to review right now.</p>
      )}

      <p className="text-xs text-muted-foreground mt-6">
        Decisions are final and update the feed immediately; readers with the feed already open see the change on their next load.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: `app/admin/review/ReviewCard.tsx`** (client component)

```tsx
"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReviewCard } from "@/src/lib/review-queue-data";
import { decideAction, undoAction, type Reveal } from "./actions";

interface Props {
  card: ReviewCard;
  categories: { key: string; label: string }[];
  skip: string[];
  more: boolean;
}

const LAST_KEY = "review:last"; // sessionStorage: { eventId, articleId }
const REVEAL_MS = 1500;

export function ReviewCardView({ card, categories, skip, more }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picking, setPicking] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const busy = useRef(false);

  useEffect(() => setCanUndo(Boolean(sessionStorage.getItem(LAST_KEY))), []);

  const go = useCallback(
    (extra: { skip?: string[]; focus?: string }) => {
      const query = new URLSearchParams();
      const s = extra.skip ?? skip;
      if (s.length) query.set("skip", s.join(","));
      if (more) query.set("more", "1");
      if (extra.focus) query.set("focus", extra.focus);
      const qs = query.toString();
      router.replace(qs ? `/admin/review?${qs}` : "/admin/review");
      router.refresh();
    },
    [router, skip, more],
  );

  const decide = useCallback(
    (verdict: "keep" | "reject", category: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      startTransition(async () => {
        const r = await decideAction(card.articleId, verdict, category, card.bucket);
        if (!r.ok) {
          setError(r.error);
          busy.current = false;
          return;
        }
        sessionStorage.setItem(LAST_KEY, JSON.stringify({ eventId: r.eventId, articleId: card.articleId }));
        setReveal(r.reveal);
        setTimeout(() => go({}), REVEAL_MS);
      });
    },
    [card, go],
  );

  const undo = useCallback(() => {
    const raw = sessionStorage.getItem(LAST_KEY);
    if (!raw || busy.current) return;
    const last = JSON.parse(raw) as { eventId: string; articleId: string };
    busy.current = true;
    startTransition(async () => {
      const r = await undoAction(last.eventId);
      sessionStorage.removeItem(LAST_KEY);
      if (!r.ok) {
        setError(r.error);
        setCanUndo(false);
        busy.current = false;
        return;
      }
      go({ focus: last.articleId });
    });
  }, [go]);

  const skipCard = useCallback(() => go({ skip: [...skip, card.articleId] }), [go, skip, card.articleId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || reveal) return;
      if (picking) {
        if (e.key === "n" || e.key === "0") decide("reject", null);
        const n = Number(e.key);
        if (n >= 1 && n <= 9 && categories[n - 1]) decide("reject", categories[n - 1].key);
        if (e.key === "Escape") setPicking(false);
        return;
      }
      if (e.key === "k") decide("keep", null);
      else if (e.key === "r") setPicking(true);
      else if (e.key === "s") skipCard();
      else if (e.key === "u") undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, reveal, categories, decide, skipCard, undo]);

  return (
    <article className="rounded-lg border border-border bg-card overflow-hidden">
      {card.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={card.imageUrl} alt="" className="w-full h-48 object-cover" />
      )}
      <div className="p-4">
        <div className="text-xs text-muted-foreground mb-1">
          {card.sourceName} · {card.language.toUpperCase()}
        </div>
        <h2 className="font-serif text-lg leading-snug text-foreground">{card.title}</h2>
        {card.summary && <p className="text-sm text-muted-foreground mt-2 line-clamp-6">{card.summary}</p>}
        <a href={card.url} target="_blank" rel="noreferrer" className="inline-block mt-2 text-xs text-primary hover:underline">
          Open original ↗
        </a>
      </div>

      {reveal ? (
        <div className="border-t border-border bg-secondary/60 px-4 py-3 text-xs text-muted-foreground tabular-nums" role="status">
          Ollama: {reveal.ollama ?? "—"} · Keyword: {reveal.keyword ? "reject" : "—"} · Jev:{" "}
          {reveal.jev ? `${reveal.jev.keep ? "keep" : "reject"} (pos ${reveal.jev.positiveP.toFixed(2)}, upl ${reveal.jev.upliftingP.toFixed(2)}, ${reveal.jev.topCategory})` : "—"}
        </div>
      ) : picking ? (
        <div className="border-t border-border p-3">
          <div className="text-xs text-muted-foreground mb-2">Why reject? (optional)</div>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c, i) => (
              <button
                key={c.key}
                onClick={() => decide("reject", c.key)}
                disabled={pending}
                className="rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
              >
                {i < 9 ? <span className="text-muted-foreground mr-1">{i + 1}</span> : null}
                {c.label}
              </button>
            ))}
            <button
              onClick={() => decide("reject", null)}
              disabled={pending}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
            >
              No category
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-border grid grid-cols-3 gap-2 p-3">
          <button
            onClick={() => decide("keep", null)}
            disabled={pending}
            className="rounded-md bg-[#3d8b5e] py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Keep
          </button>
          <button
            onClick={() => setPicking(true)}
            disabled={pending}
            className="rounded-md bg-destructive py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Reject
          </button>
          <button
            onClick={skipCard}
            disabled={pending}
            className="rounded-md border border-border py-3 text-sm text-muted-foreground disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      )}

      <div className="flex items-center justify-between px-4 pb-3 text-xs text-muted-foreground">
        <span className="hidden sm:inline">Keys: k keep · r reject (1–9, n) · s skip · u undo</span>
        <button onClick={undo} disabled={!canUndo || pending} className="hover:text-foreground disabled:opacity-40">
          Undo last
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-xs text-destructive" role="alert">{error}</p>}
    </article>
  );
}
```

`ReviewCard` is imported as a type from `review-queue-data.ts`, so only the type crosses into the client bundle, not Prisma. Check this in the build output: if bundling fails, move `ReviewCard` and `QueueBucket` into a types-only file, `src/lib/review-types.ts`, and import from there.

- [ ] **Step 5: Nav.** In `app/admin/layout.tsx`, fetch `todayCount()` next to `getPendingKeywordCount()`, using `.catch(() => 0)`. Add this link first in the nav, before Dashboard:

```tsx
            <Link
              href="/admin/review"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium tabular-nums"
            >
              Review {reviewCount}/{DAILY_TARGET}
            </Link>
```

- [ ] **Step 6: Flagged inbox.** In `app/admin/flagged/page.tsx`, accept `searchParams` (a Promise), and when `resolved` isn't `"1"`, keep only unresolved rows. Include `labelEvents: { where: { source: "admin" }, select: { id, source, verdict, category, eligible, bucket, retractsId, createdAt } }` in the select. Then filter in code:

```ts
const unresolved = rows.filter((r) => {
  const authority = currentAdminAuthority(r.labelEvents);
  return !authority || (r.flaggedAt !== null && authority.createdAt < r.flaggedAt);
});
```

Pass rows to `FlaggedTable` without `labelEvents`. Add a link under the heading: "Show resolved" pointing to `?resolved=1`, or "Show unresolved only".

- [ ] **Step 7: Pass-3 label.** In `RejectionsClient.tsx`, add `3: "Admin"` to `PASS_LABELS` and `3: "bg-secondary text-foreground"` to `PASS_COLORS`.

- [ ] **Step 8: Verify.** Run `pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build`, all clean. The controller verifies the review flow live.

- [ ] **Step 9: Commit**

```bash
git add app/admin
git commit -m "feat(review): add phone-first review queue page"
```

---

### Task 7: Scoreboard, export, and Jev report exclusion

**Files:**
- Create: `src/lib/scoreboard.ts`, `src/lib/scoreboard.test.ts`, `src/lib/scoreboard-data.ts`, `src/lib/labels-export.ts`, `src/lib/labels-export.test.ts`, `scripts/labels-export.ts`
- Modify: `src/lib/jev-report.ts`, `src/lib/jev-report.test.ts`, `src/lib/jev-report-data.ts`, `app/admin/jev/page.tsx`, `app/admin/jev/JevReportView.tsx`, `package.json` (`"labels:export": "tsx scripts/labels-export.ts"`)

**Interfaces:**
- Produces:
  - `src/lib/scoreboard.ts`:
    - `type Slice = "all" | "fi" | "en"`
    - `interface ScoreRow { language: string; bucket: string | null; admin: "keep" | "reject"; keyword: boolean; ollama: "keep" | "reject" | null; jev: "keep" | "reject" | null; flagged: boolean }`
    - `interface BinaryScore { n: number; agree: number; agreement: number | null; rejects: number; rejectsCorrect: number; rejectPrecision: number | null; wronglyHidden: number }`
    - `interface RejectOnlyScore { n: number; correct: number; rejectPrecision: number | null }`
    - `interface ScoreTable { labels: Record<Slice, number>; ollama: Record<Slice, BinaryScore>; jev: Record<Slice, BinaryScore>; keyword: Record<Slice, RejectOnlyScore>; flags: Record<Slice, RejectOnlyScore> }`
    - `scoreSources(rows: ScoreRow[]): { cohort: ScoreTable; targeted: ScoreTable }`
  - `src/lib/scoreboard-data.ts`: `loadScoreRows(): Promise<ScoreRow[]>`
  - `src/lib/labels-export.ts`:
    - `interface ExportArticle { id: string; title: string; summary: string | null; language: string; createdAt: Date; events: LabelEventLike[]; jev: { model: string; questionSet: string; answers: unknown } | null }`
    - `interface ExportRow { articleId; state: Record<string, string>; language; createdAt: string; label; category; tier; weight; bucket; split; jev }`
    - `toExportRow(a: ExportArticle): ExportRow | null`
  - `src/lib/jev-report.ts`: `ReportRow` gains `adminDecided: boolean`. `BaselineGroup` gains `"admin"`, which is excluded like `pending`.

- [ ] **Step 1: Write the failing tests** in `src/lib/scoreboard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scoreSources, type ScoreRow } from "./scoreboard";

const row = (p: Partial<ScoreRow>): ScoreRow => ({ language: "fi", bucket: "leak", admin: "reject", keyword: false, ollama: null, jev: null, flagged: false, ...p });

describe("scoreSources", () => {
  it("splits cohort from targeted reviews", () => {
    const s = scoreSources([row({ bucket: "cohort" }), row({ bucket: "leak" }), row({ bucket: "manual" })]);
    expect(s.cohort.labels.all).toBe(1);
    expect(s.targeted.labels.all).toBe(2);
  });

  it("scores binary sources: agreement, reject precision, wrongly hidden", () => {
    const s = scoreSources([
      row({ admin: "reject", ollama: "reject", jev: "keep" }),
      row({ admin: "keep", ollama: "reject", jev: "keep" }),
      row({ admin: "keep", ollama: "keep", jev: null }),
    ]).targeted;
    expect(s.ollama.all).toEqual({ n: 3, agree: 2, agreement: 2 / 3, rejects: 2, rejectsCorrect: 1, rejectPrecision: 0.5, wronglyHidden: 1 });
    expect(s.jev.all).toMatchObject({ n: 2, agree: 1, rejects: 0, rejectPrecision: null, wronglyHidden: 0 });
  });

  it("scores reject-only sources by coverage and precision", () => {
    const s = scoreSources([
      row({ admin: "reject", keyword: true, flagged: true }),
      row({ admin: "keep", keyword: true }),
      row({ admin: "keep" }),
    ]).targeted;
    expect(s.keyword.all).toEqual({ n: 2, correct: 1, rejectPrecision: 0.5 });
    expect(s.flags.all).toEqual({ n: 1, correct: 1, rejectPrecision: 1 });
  });

  it("splits by language and returns null rates for empty slices", () => {
    const s = scoreSources([row({ language: "fi", ollama: "reject" })]).targeted;
    expect(s.ollama.fi.n).toBe(1);
    expect(s.ollama.en).toEqual({ n: 0, agree: 0, agreement: null, rejects: 0, rejectsCorrect: 0, rejectPrecision: null, wronglyHidden: 0 });
    expect(scoreSources([]).cohort.keyword.all.rejectPrecision).toBeNull();
  });
});
```

and `src/lib/labels-export.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isTestCohort, type LabelEventLike } from "./labels";
import { toExportRow, type ExportArticle } from "./labels-export";

function idInCohort(want: boolean): string {
  for (let i = 0; i < 10_000; i++) if (isTestCohort(`x${i}`) === want) return `x${i}`;
  throw new Error("no id");
}
const ev = (p: Partial<LabelEventLike>): LabelEventLike => ({ id: "e1", source: "ollama", verdict: "keep", category: null, eligible: true, bucket: null, retractsId: null, createdAt: new Date(0), ...p });
const art = (id: string, events: LabelEventLike[]): ExportArticle => ({ id, title: "T", summary: "  S  ", language: "fi", createdAt: new Date("2026-10-01T00:00:00Z"), events, jev: null });

describe("toExportRow", () => {
  it("builds a train row with state, tier, weight and split", () => {
    const id = idInCohort(false);
    expect(toExportRow(art(id, [ev({ source: "admin", verdict: "reject", category: "cat_war", bucket: "leak" })]))).toEqual({
      articleId: id, state: { title: "T", summary: "S" }, language: "fi", createdAt: "2026-10-01T00:00:00.000Z",
      label: "reject", category: "cat_war", tier: "gold", weight: 1, bucket: "leak", split: "train", jev: null,
    });
  });

  it("marks cohort articles as test and skips articles without a label", () => {
    expect(toExportRow(art(idInCohort(true), [ev({})]))?.split).toBe("test");
    expect(toExportRow(art(idInCohort(false), []))).toBeNull();
  });
});
```

Update `src/lib/jev-report.test.ts`: the `row()` helper defaults `adminDecided: false`. Add a test that an admin-decided row lands in group `admin`, is excluded from agreement and disagreements, and that `groups.admin` counts it. Update the existing `groups` expectations to include `admin: 0`.

- [ ] **Step 2: Run them to confirm they fail.**

- [ ] **Step 3: Implement `src/lib/scoreboard.ts`**

```ts
/**
 * Scores each filtering source against admin decisions (gold labels).
 * Random-cohort reviews are reported apart from targeted reviews, because
 * targeted buckets over-sample disagreements.
 */

export type Slice = "all" | "fi" | "en";
const SLICES: Slice[] = ["all", "fi", "en"];

export interface ScoreRow {
  language: string;
  bucket: string | null;
  admin: "keep" | "reject";
  keyword: boolean;
  ollama: "keep" | "reject" | null;
  jev: "keep" | "reject" | null;
  flagged: boolean;
}

export interface BinaryScore { n: number; agree: number; agreement: number | null; rejects: number; rejectsCorrect: number; rejectPrecision: number | null; wronglyHidden: number }
export interface RejectOnlyScore { n: number; correct: number; rejectPrecision: number | null }
export interface ScoreTable {
  labels: Record<Slice, number>;
  ollama: Record<Slice, BinaryScore>;
  jev: Record<Slice, BinaryScore>;
  keyword: Record<Slice, RejectOnlyScore>;
  flags: Record<Slice, RejectOnlyScore>;
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
const perSlice = <T>(make: () => T): Record<Slice, T> => ({ all: make(), fi: make(), en: make() });
const emptyBinary = (): BinaryScore => ({ n: 0, agree: 0, agreement: null, rejects: 0, rejectsCorrect: 0, rejectPrecision: null, wronglyHidden: 0 });
const emptyRejectOnly = (): RejectOnlyScore => ({ n: 0, correct: 0, rejectPrecision: null });

function slicesFor(language: string): Slice[] {
  return language === "fi" || language === "en" ? ["all", language] : ["all"];
}

function scoreTable(rows: ScoreRow[]): ScoreTable {
  const t: ScoreTable = {
    labels: { all: 0, fi: 0, en: 0 },
    ollama: perSlice(emptyBinary),
    jev: perSlice(emptyBinary),
    keyword: perSlice(emptyRejectOnly),
    flags: perSlice(emptyRejectOnly),
  };

  for (const r of rows) {
    for (const s of slicesFor(r.language)) {
      t.labels[s]++;
      for (const key of ["ollama", "jev"] as const) {
        const v = r[key];
        if (!v) continue;
        const b = t[key][s];
        b.n++;
        if (v === r.admin) b.agree++;
        if (v === "reject") {
          b.rejects++;
          if (r.admin === "reject") b.rejectsCorrect++;
          else b.wronglyHidden++;
        }
      }
      if (r.keyword) {
        t.keyword[s].n++;
        if (r.admin === "reject") t.keyword[s].correct++;
      }
      if (r.flagged) {
        t.flags[s].n++;
        if (r.admin === "reject") t.flags[s].correct++;
      }
    }
  }

  for (const s of SLICES) {
    for (const key of ["ollama", "jev"] as const) {
      const b = t[key][s];
      b.agreement = ratio(b.agree, b.n);
      b.rejectPrecision = ratio(b.rejectsCorrect, b.rejects);
    }
    for (const key of ["keyword", "flags"] as const) t[key][s].rejectPrecision = ratio(t[key][s].correct, t[key][s].n);
  }
  return t;
}

export function scoreSources(rows: ScoreRow[]): { cohort: ScoreTable; targeted: ScoreTable } {
  return {
    cohort: scoreTable(rows.filter((r) => r.bucket === "cohort")),
    targeted: scoreTable(rows.filter((r) => r.bucket !== "cohort")),
  };
}
```

- [ ] **Step 4: Implement `src/lib/scoreboard-data.ts`**

```ts
import { prisma } from "./prisma";
import { DEFAULT_THRESHOLDS, deriveVerdict, QUESTION_SET } from "./jev";
import { currentAdminAuthority } from "./labels";
import type { ScoreRow } from "./scoreboard";

const EVENT_SELECT = { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true } as const;

export async function loadScoreRows(): Promise<ScoreRow[]> {
  const articles = await prisma.article.findMany({
    where: { labelEvents: { some: { source: "admin" } } },
    select: {
      flaggedAt: true,
      source: { select: { language: true } },
      labelEvents: { select: EVENT_SELECT, orderBy: { createdAt: "asc" } },
      jevEvaluations: { where: { questionSet: QUESTION_SET }, take: 1 },
    },
  });

  const rows: ScoreRow[] = [];
  for (const a of articles) {
    const authority = currentAdminAuthority(a.labelEvents);
    if (!authority) continue;
    const ollama = a.labelEvents.filter((e) => e.source === "ollama" && e.eligible).at(-1);
    const jev = a.jevEvaluations[0];
    rows.push({
      language: a.source.language,
      bucket: authority.bucket,
      admin: authority.verdict as "keep" | "reject",
      keyword: a.labelEvents.some((e) => e.source === "keyword" && e.eligible),
      ollama: ollama ? (ollama.verdict as "keep" | "reject") : null,
      jev: jev ? (deriveVerdict(jev, DEFAULT_THRESHOLDS).keep ? "keep" : "reject") : null,
      flagged: Boolean(a.flaggedAt) || a.labelEvents.some((e) => e.source === "reader_flag"),
    });
  }
  return rows;
}
```

- [ ] **Step 5: Implement `src/lib/labels-export.ts` and `scripts/labels-export.ts`**

```ts
// src/lib/labels-export.ts
import { buildState } from "./jev";
import { resolveLabel, type LabelEventLike } from "./labels";

export interface ExportArticle {
  id: string;
  title: string;
  summary: string | null;
  language: string;
  createdAt: Date;
  events: LabelEventLike[];
  jev: { model: string; questionSet: string; answers: unknown } | null;
}

export interface ExportRow {
  articleId: string;
  state: Record<string, string>;
  language: string;
  createdAt: string;
  label: "keep" | "reject";
  category: string | null;
  tier: string;
  weight: number;
  bucket: string | null;
  split: "train" | "test";
  jev: ExportArticle["jev"];
}

export function toExportRow(a: ExportArticle): ExportRow | null {
  const label = resolveLabel(a.id, a.events);
  if (!label) return null;
  return {
    articleId: a.id,
    state: buildState({ title: a.title, summary: a.summary }),
    language: a.language,
    createdAt: a.createdAt.toISOString(),
    label: label.label,
    category: label.category,
    tier: label.tier,
    weight: label.weight,
    bucket: label.bucket,
    split: label.split,
    jev: a.jev,
  };
}
```

```ts
// scripts/labels-export.ts
/**
 * Writes resolved labels as JSONL: train rows to <out>, test (cohort) rows
 * to <out>.test.jsonl. Snapshot: only events created before the start time.
 *
 * Usage: pnpm labels:export --out labels.jsonl [--split train|test]
 */
import "./load-env";
import { createWriteStream, type WriteStream } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { QUESTION_SET } from "../src/lib/jev";
import { toExportRow } from "../src/lib/labels-export";

const BATCH = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const out = arg("out");
  const only = arg("split");
  if (!out || (only && only !== "train" && only !== "test")) {
    console.error("Usage: pnpm labels:export --out <file> [--split train|test]");
    process.exit(1);
  }
  const cutoff = new Date();
  const streams: Partial<Record<"train" | "test", WriteStream>> = {};
  if (only !== "test") streams.train = createWriteStream(out);
  if (only !== "train") streams.test = createWriteStream(only === "test" ? out : `${out}.test.jsonl`);

  const summary: Record<string, number> = {};
  const bump = (k: string) => (summary[k] = (summary[k] ?? 0) + 1);
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.article.findMany({
      where: { labelEvents: { some: { createdAt: { lt: cutoff } } } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        title: true,
        summary: true,
        createdAt: true,
        source: { select: { language: true } },
        labelEvents: {
          where: { createdAt: { lt: cutoff } },
          select: { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true },
        },
        jevEvaluations: { where: { questionSet: QUESTION_SET }, select: { model: true, questionSet: true, answers: true }, take: 1 },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const a of batch) {
      const row = toExportRow({
        id: a.id,
        title: a.title,
        summary: a.summary,
        language: a.source.language,
        createdAt: a.createdAt,
        events: a.labelEvents,
        jev: a.jevEvaluations[0] ?? null,
      });
      if (!row) continue;
      const stream = streams[row.split];
      if (!stream) continue;
      stream.write(`${JSON.stringify(row)}\n`);
      bump(`split:${row.split}`);
      bump(`tier:${row.tier}`);
      bump(`lang:${row.language}`);
      if (row.bucket) bump(`bucket:${row.bucket}`);
    }
  }

  await Promise.all(Object.values(streams).map((s) => new Promise((r) => s!.end(r))));
  console.log(`[labels-export] snapshot ${cutoff.toISOString()}`, summary);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[labels-export] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 6: Jev report exclusion.**
  - `jev-report.ts`:
    - Add `adminDecided: boolean` to `ReportRow` and `"admin"` to `BaselineGroup`.
    - `baselineGroup` gains a first line, `if (r.adminDecided) return "admin";`. Change its parameter type to `Pick<ReportRow, "rejectionPass" | "curatedAt" | "adminDecided">`.
    - In `buildReport`, initialise `groups` with `admin: 0` and change `if (group === "pending") continue;` to `if (group === "pending" || group === "admin") continue;`.
    - `Disagreement.group` becomes `Exclude<BaselineGroup, "pending" | "admin">`.
  - `jev-report-data.ts`: select `labelEvents: { where: { source: "admin" }, select: { id, source, verdict, category, eligible, bucket, retractsId, createdAt } }` on the article, and set `adminDecided: currentAdminAuthority(e.article.labelEvents) !== null`.

- [ ] **Step 7: Scoreboard section.**
  - In `app/admin/jev/page.tsx`, load `scoreSources(await loadScoreRows())` next to the report and pass it to the view.
  - In `JevReportView.tsx`, add a section "Against your decisions" above "Agreement with Ollama". It has two tables, "Random cohort (unbiased)" and "Targeted reviews". Rows: Jev, Ollama, Keyword filter, Reader flags. Columns: n, Agreement, Reject precision, Wrongly hidden, each shown as all / FI / EN.
    - The keyword and flag rows show "—" for Agreement and Wrongly hidden.
    - Use the existing `pct` helper and table styling.
    - Above the tables, a muted note: `{cohort labels} cohort labels · {targeted labels} targeted — rates firm up as labels accumulate (about 4 cohort reviews a day).`
    - If no gold labels exist, show "No reviewed articles yet — start at Review." with a link to `/admin/review`.
  - Add `{report.groups.admin} admin-decided (excluded)` to the header line.

- [ ] **Step 8: Verify.** Run `pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build`. Then locally run `pnpm labels:export --out /tmp/labels.jsonl` and check:

```bash
head -2 /tmp/labels.jsonl
node -e 'const fs=require("fs");const {createHash}=require("crypto");const bad=fs.readFileSync("/tmp/labels.jsonl","utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(r=>createHash("sha256").update(r.articleId).digest().readUInt32BE(0)%10===0);console.log("cohort rows in train:",bad.length)'
```

Expected: `cohort rows in train: 0`.

- [ ] **Step 9: Commit**

```bash
git add src app scripts package.json
git commit -m "feat(labels): add scoreboard, JSONL export and admin exclusion in Jev report"
```

---

### Task 8: Deploy migration step and docs

**Files:**
- Modify: `.github/workflows/deploy.yml`, `README.md`

- [ ] **Step 1: Deploy step.** In `deploy.yml`'s SSH script, insert `npx prisma migrate deploy` on its own line between `pnpm install --frozen-lockfile` and the `NEXT_PUBLIC_BUILD_SHA=… pnpm build` line. Change nothing else.

- [ ] **Step 2: README.**
  - In the "Jev shadow evaluation (optional)" section, replace the migration note with: "Migrations run automatically during deploy (`prisma migrate deploy`)."
  - After that section, add:

````markdown
### Labels and review queue

Every filtering judgement is stored as a `LabelEvent`: keyword rejects, Ollama verdicts, reader flags and admin decisions. Review about 20 articles a day at `/news/admin/review`. Your decisions are final and update the feed. They also train and test the filter: a fixed ~10% test cohort never appears in training exports.

```bash
pnpm labels:backfill                 # one-off: import historical judgements (idempotent)
pnpm labels:export --out labels.jsonl  # train rows → labels.jsonl, test rows → labels.jsonl.test.jsonl
```

The scoreboard at `/news/admin/jev` ("Against your decisions") rates each source against your reviews.
````

- [ ] **Step 3: Verify and commit.** Run `pnpm lint && pnpm test`.

```bash
git add .github/workflows/deploy.yml README.md
git commit -m "chore: run migrations on deploy; document labels and review queue"
```
