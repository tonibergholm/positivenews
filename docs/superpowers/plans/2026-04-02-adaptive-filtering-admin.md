# Adaptive Filtering & Admin Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden keyword learning (IP-based threshold, staleness), persist LLM rejection reasons, and add a protected admin panel for oversight and correction.

**Architecture:** Backend changes run first (schema migration, smarter flag route, rejection reasons in pipeline). Auth layer (NextAuth v5 credentials) protects `/admin/*` via Next.js middleware. Four React Server Component admin pages nest inside the existing public layout via `app/admin/layout.tsx`.

**Tech Stack:** Next.js 16 App Router, NextAuth v5 (`next-auth@beta`), bcryptjs, Prisma 7 (PostgreSQL), Redis, React Server Components, Server Actions, Tailwind CSS.

---

## Context for implementers

- `basePath: "/news"` in `next.config.ts` — all browser-visible URLs include `/news/`. Middleware matchers use paths **without** the basePath (e.g. `/admin/:path*`). Redirect URLs must use `req.nextUrl.clone()` to preserve basePath.
- Auth.js v5 must be told about the basePath via `basePath: "/news/api/auth"` in the NextAuth config, so its callback URLs are correct.
- No test framework exists. Each task has manual verification steps.
- Prisma 7 uses `prisma.$transaction([...])` for arrays and `prisma.$transaction(async (tx) => {...})` for callbacks.
- Read `node_modules/next/dist/docs/01-app/02-guides/authentication.md` before touching auth code.

---

## File Map

**New files:**
- `auth.ts` — NextAuth v5 config, exports `{ handlers, auth, signIn, signOut }`
- `middleware.ts` — edge auth guard for `/admin/*`
- `app/api/auth/[...nextauth]/route.ts` — NextAuth route handler
- `app/admin/layout.tsx` — admin sub-nav (sits inside existing public layout)
- `app/admin/page.tsx` — dashboard (RSC)
- `app/admin/login/page.tsx` — login form with server action
- `app/admin/keywords/page.tsx` — keywords management (RSC)
- `app/admin/keywords/actions.ts` — server actions: activate / deactivate / delete
- `app/admin/keywords/KeywordsClient.tsx` — `"use client"` component with mutation buttons
- `app/admin/rejections/page.tsx` — rejection log (RSC)
- `app/admin/flagged/page.tsx` — flagged articles log (RSC)
- `src/lib/keywords-maintenance.ts` — staleness + auto-activation logic

**Modified files:**
- `prisma/schema.prisma` — new fields + `LearnedKeywordFlag` model
- `src/lib/classifier.ts` — `classifyPositive()` returns `{ positive, reason? }`, adds reason helpers
- `src/lib/ingest.ts` — write `rejectionReason` / `rejectionPass: 0` for keyword rejections
- `src/lib/curate.ts` — write `rejectionReason` / `rejectionPass` for LLM rejections
- `src/lib/pipeline.ts` — call staleness maintenance at start of each run
- `app/api/articles/[id]/flag/route.ts` — IP tracking, new threshold, `lastHitAt`

---

## Task 1: Schema migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Update schema**

Replace the `LearnedKeyword` model and `Article` model with the additions below. Leave all other models untouched.

```prisma
// In Article model, add after `curatedAt`:
rejectionReason  String?
rejectionPass    Int?

// LearnedKeyword model — full replacement:
model LearnedKeyword {
  id        String    @id @default(cuid())
  keyword   String
  language  String    @default("en")
  hits      Int       @default(1)
  active    Boolean   @default(false)
  uniqueIps Int       @default(0)
  lastHitAt DateTime?
  createdAt DateTime  @default(now())

  @@unique([keyword, language])
}

// New model — add after LearnedKeyword:
model LearnedKeywordFlag {
  id        String   @id @default(cuid())
  keyword   String
  language  String
  ip        String
  createdAt DateTime @default(now())

  @@unique([keyword, language, ip])
}
```

- [ ] **Step 2: Create and run the migration**

```bash
cd /path/to/positivenews
pnpm prisma migrate dev --name adaptive_filtering
```

Expected output ends with: `✔  Applied 1 migration(s)`

- [ ] **Step 3: Verify migration**

```bash
pnpm prisma studio
```

Open the browser preview. Confirm `Article` has `rejectionReason` and `rejectionPass` columns. Confirm `LearnedKeyword` has `uniqueIps`, `lastHitAt`, `createdAt` columns. Confirm `LearnedKeywordFlag` table exists.

Close Prisma Studio (`Ctrl+C`).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: schema — rejection reasons, keyword IP tracking, staleness fields"
```

---

## Task 2: Classifier returns rejection reason

**Files:**
- Modify: `src/lib/classifier.ts`

- [ ] **Step 1: Add reason-extraction helpers after the existing matchers (around line 230)**

Add these four functions between `phraseMatch` and `negativeHitsEnglish`:

```ts
// ── Reason extraction (called only when positive = false) ───────────

function firstExactMatch(tokens: string[], words: string[]): string | null {
  const tokenSet = new Set(tokens);
  for (const word of words) {
    if (tokenSet.has(word)) return word;
  }
  return null;
}

function firstStemMatchReason(tokens: string[], stems: string[], useIncludes: boolean): string | null {
  for (const token of tokens) {
    for (const stem of stems) {
      if (useIncludes ? token.includes(stem) : token.startsWith(stem)) {
        return stem;
      }
    }
  }
  return null;
}

function firstPhraseMatch(text: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
}

function findRejectionReason(
  tokens: string[],
  text: string,
  isFinnish: boolean,
  learned: string[]
): string {
  if (isFinnish) {
    const match = firstStemMatchReason(tokens, [...NEGATIVE_STEMS_FI, ...learned], true);
    return `keyword: ${match ?? "unknown"}`;
  }
  const match =
    firstExactMatch(tokens, [...NEGATIVE_WORDS_EN, ...learned]) ??
    firstStemMatchReason(tokens, NEGATIVE_PREFIXES_EN, false) ??
    firstPhraseMatch(text, NEGATIVE_PHRASES_EN);
  return `keyword: ${match ?? "unknown"}`;
}
```

- [ ] **Step 2: Update `classifyPositive` return type and return values**

Replace the entire `classifyPositive` function (starting at `export async function classifyPositive`) with:

```ts
export async function classifyPositive(
  title: string,
  summary?: string | null,
  language = "en"
): Promise<{ positive: boolean; reason?: string }> {
  const text = summary
    ? `${title} ${summary.slice(0, 300)}`
    : title;

  const tokens = tokenize(text);
  const normalizedText = normalizeText(text);
  const isFinnish = language === "fi";

  const posStemsList = isFinnish ? POSITIVE_OVERRIDES_FI : POSITIVE_OVERRIDES_EN;
  const learned = await getLearnedKeywords(language);

  const negHits = isFinnish
    ? stemMatch(tokens, [...NEGATIVE_STEMS_FI, ...learned], true)
    : negativeHitsEnglish(tokens, normalizedText, learned);
  const posHits = stemMatch(tokens, posStemsList, isFinnish);

  if (posHits > 0 && negHits <= posHits) return { positive: true };

  if (negHits >= THRESHOLD) {
    return {
      positive: false,
      reason: findRejectionReason(tokens, normalizedText, isFinnish, learned),
    };
  }

  return { positive: true };
}
```

- [ ] **Step 3: Check TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: errors about `ingest.ts` using the old boolean return. Those are fixed in Task 3. If any other files use `classifyPositive`, fix them now.

```bash
grep -rn "classifyPositive" src/ app/
```

Only `src/lib/ingest.ts` should appear. If anything else appears, update it to use `result.positive`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/classifier.ts
git commit -m "feat: classifier — return rejection reason with classifyPositive result"
```

---

## Task 3: Ingest writes keyword rejection reason

**Files:**
- Modify: `src/lib/ingest.ts`

- [ ] **Step 1: Update the `ingestFeed` article creation block**

In `ingestFeed`, replace lines 107–122 (the `isPositive` + `prisma.article.create` block) with:

```ts
      const classResult = feed.trusted
        ? { positive: true as const }
        : await classifyPositive(safeTitle, summary, feed.language);

      await prisma.article.create({
        data: {
          title: safeTitle,
          url,
          summary,
          imageUrl,
          publishedAt,
          sourceId,
          category: feed.category,
          isPositive: classResult.positive,
          rejectionReason: classResult.positive
            ? null
            : (classResult.reason ?? "keyword filter"),
          rejectionPass: classResult.positive ? null : 0,
        },
      });
      saved++;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ingest.ts
git commit -m "feat: ingest — persist keyword rejection reason and pass=0 to article"
```

---

## Task 4: Curate writes LLM rejection reason

**Files:**
- Modify: `src/lib/curate.ts`

- [ ] **Step 1: Collect per-article rejection data instead of just IDs**

In `curateUnchecked`, replace the `approvedIds`/`rejectedIds` section (lines 74–102) with:

```ts
  const approvedIds: string[] = [];
  const rejectedResults: Array<{ id: string; reason: string; pass: 1 | 2 }> = [];
  let rejected = 0;

  for (const r of results) {
    if (r.isPositive) {
      approvedIds.push(r.id);
    } else {
      rejectedResults.push({ id: r.id, reason: r.reason, pass: r.pass });
      rejected++;
      console.log(`[curate] Rejected: "${needsCuration.find((a) => a.id === r.id)?.title}" — ${r.reason} (pass ${r.pass})`);
    }
  }

  const curatedAt = new Date();

  if (approvedIds.length > 0) {
    await prisma.article.updateMany({
      where: { id: { in: approvedIds } },
      data: { curatedAt },
    });
  }

  if (rejectedResults.length > 0) {
    await prisma.$transaction(
      rejectedResults.map((r) =>
        prisma.article.update({
          where: { id: r.id },
          data: {
            isPositive: false,
            curatedAt,
            rejectionReason: r.reason,
            rejectionPass: r.pass,
          },
        })
      )
    );
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Smoke-test the pipeline locally**

```bash
curl -X POST http://localhost:3001/news/api/ingest \
  -H "x-ingest-secret: $(grep INGEST_SECRET .env | cut -d= -f2)"
```

Let it run. Then check a rejected article has `rejectionReason` set:

```bash
pnpm prisma studio
```

Open `Article` table, filter `isPositive = false`, verify recent articles have `rejectionReason` and `rejectionPass` populated.

- [ ] **Step 4: Commit**

```bash
git add src/lib/curate.ts
git commit -m "feat: curate — persist LLM rejection reason and pass (1 or 2) to article"
```

---

## Task 5: Smarter flag route with IP tracking

**Files:**
- Modify: `app/api/articles/[id]/flag/route.ts`

- [ ] **Step 1: Replace the entire route file**

```ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { extractKeywords } from "@/src/lib/keywords";
import redis from "@/src/lib/redis";

export const dynamic = "force-dynamic";

const KEYWORD_MIN_HITS = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
const KEYWORD_MIN_IPS = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);

const flagRateMap = new Map<string, { count: number; resetAt: number }>();
const FLAG_WINDOW_MS = 60_000;
const FLAG_LIMIT = 10;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // CSRF: reject cross-origin POSTs
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Rate limit: 10 flags per IP per minute
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const entry = flagRateMap.get(ip);
  if (!entry || entry.resetAt < now) {
    flagRateMap.set(ip, { count: 1, resetAt: now + FLAG_WINDOW_MS });
  } else if (entry.count >= FLAG_LIMIT) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  } else {
    entry.count++;
  }

  const { id } = await params;

  const article = await prisma.article.findUnique({
    where: { id },
    include: { source: { select: { language: true } } },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }

  if (article.flaggedAt) {
    return NextResponse.json({ success: true, duplicate: true });
  }

  const language = article.source.language;
  const keywords = extractKeywords(article.title, language);

  await prisma.$transaction(async (tx) => {
    const result = await tx.article.updateMany({
      where: { id, flaggedAt: null },
      data: { isPositive: false, flaggedAt: new Date() },
    });

    if (result.count === 0 || keywords.length === 0) return;

    // Upsert keywords: increment hits and lastHitAt
    for (const keyword of keywords) {
      await tx.learnedKeyword.upsert({
        where: { keyword_language: { keyword, language } },
        update: {
          hits: { increment: 1 },
          lastHitAt: new Date(),
        },
        create: { keyword, language, hits: 1, active: false, lastHitAt: new Date() },
      });
    }

    // Record this IP's contribution (skip if already recorded)
    await tx.learnedKeywordFlag.createMany({
      data: keywords.map((keyword) => ({ keyword, language, ip })),
      skipDuplicates: true,
    });

    // Recount uniqueIps from LearnedKeywordFlag for each keyword
    for (const keyword of keywords) {
      const count = await tx.learnedKeywordFlag.count({
        where: { keyword, language },
      });
      await tx.learnedKeyword.update({
        where: { keyword_language: { keyword, language } },
        data: { uniqueIps: count },
      });
    }

    // Auto-activate keywords that meet threshold
    await tx.learnedKeyword.updateMany({
      where: {
        keyword: { in: keywords },
        language,
        hits: { gte: KEYWORD_MIN_HITS },
        uniqueIps: { gte: KEYWORD_MIN_IPS },
        active: false,
      },
      data: { active: true },
    });
  });

  try {
    await redis.del(`learned:keywords:${language}`);
  } catch (err) {
    console.error("[flag] Redis cache invalidation failed:", err);
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Add env vars to .env**

Add these two lines to `.env` (they have defaults but making them explicit is good):

```
KEYWORD_MIN_HITS=5
KEYWORD_MIN_IPS=2
```

- [ ] **Step 4: Manual test**

Start the dev server and flag an article from the UI. Then:

```bash
pnpm prisma studio
```

Check `LearnedKeywordFlag` table has an entry for the flagged article's keywords with the correct IP. Check `LearnedKeyword.lastHitAt` updated. Check `uniqueIps = 1`.

- [ ] **Step 5: Commit**

```bash
git add app/api/articles/[id]/flag/route.ts .env
git commit -m "feat: flag route — IP-based keyword threshold, lastHitAt tracking"
```

---

## Task 6: Pipeline keyword staleness maintenance

**Files:**
- Create: `src/lib/keywords-maintenance.ts`
- Modify: `src/lib/pipeline.ts`

- [ ] **Step 1: Create keywords-maintenance.ts**

```ts
// src/lib/keywords-maintenance.ts
import { prisma } from "./prisma";
import redis from "./redis";

const STALE_DAYS = parseInt(process.env.KEYWORD_STALE_DAYS ?? "30", 10);
const AUTO_ACTIVATE_DAYS = parseInt(process.env.KEYWORD_AUTO_ACTIVATE_DAYS ?? "7", 10);
const KEYWORD_MIN_HITS = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
const KEYWORD_MIN_IPS = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);

async function invalidateKeywordCaches(): Promise<void> {
  await Promise.allSettled([
    redis.del("learned:keywords:en"),
    redis.del("learned:keywords:fi"),
  ]);
}

export async function deactivateStaleKeywords(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.learnedKeyword.updateMany({
    where: {
      active: true,
      lastHitAt: { lt: cutoff },
    },
    data: { active: false },
  });
  if (result.count > 0) {
    await invalidateKeywordCaches();
    console.log(`[keywords] Deactivated ${result.count} stale keywords (no hits in ${STALE_DAYS} days)`);
  }
  return result.count;
}

export async function activatePendingKeywords(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_ACTIVATE_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.learnedKeyword.updateMany({
    where: {
      active: false,
      hits: { gte: KEYWORD_MIN_HITS },
      uniqueIps: { gte: KEYWORD_MIN_IPS },
      createdAt: { lt: cutoff },
    },
    data: { active: true },
  });
  if (result.count > 0) {
    await invalidateKeywordCaches();
    console.log(`[keywords] Auto-activated ${result.count} keywords (pending > ${AUTO_ACTIVATE_DAYS} days)`);
  }
  return result.count;
}
```

- [ ] **Step 2: Call maintenance from pipeline.ts**

Replace the entire `pipeline.ts` with:

```ts
import { curateUnchecked } from "./curate";
import { ingestAll } from "./ingest";
import { deactivateStaleKeywords, activatePendingKeywords } from "./keywords-maintenance";

interface PipelineResult {
  total: number;
  errors: string[];
  curation: {
    curated: number;
    rejected: number;
    skipped: number;
  };
}

let pipelineRun: Promise<PipelineResult> | null = null;

export async function runPipeline(): Promise<PipelineResult> {
  if (pipelineRun) return pipelineRun;

  pipelineRun = (async () => {
    // Keyword maintenance runs before ingest so fresh keywords are available
    await deactivateStaleKeywords();
    await activatePendingKeywords();

    const ingestResult = await ingestAll();
    const curationResult = await curateUnchecked();

    return {
      ...ingestResult,
      curation: curationResult,
    };
  })();

  try {
    return await pipelineRun;
  } finally {
    pipelineRun = null;
  }
}

export function isPipelineRunning(): boolean {
  return pipelineRun !== null;
}
```

- [ ] **Step 3: Add env vars to .env**

```
KEYWORD_STALE_DAYS=30
KEYWORD_AUTO_ACTIVATE_DAYS=7
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/keywords-maintenance.ts src/lib/pipeline.ts .env
git commit -m "feat: pipeline — auto-deactivate stale keywords, auto-activate long-pending"
```

---

## Task 7: NextAuth setup

**Files:**
- Create: `auth.ts`
- Create: `app/api/auth/[...nextauth]/route.ts`

- [ ] **Step 1: Read Next.js auth guide**

```bash
cat node_modules/next/dist/docs/01-app/02-guides/authentication.md | head -100
```

Note the recommended pattern for Auth libraries with App Router.

- [ ] **Step 2: Install packages**

```bash
pnpm add next-auth@beta bcryptjs
pnpm add -D @types/bcryptjs
```

- [ ] **Step 3: Generate AUTH_SECRET**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output. Add to `.env`:

```
AUTH_SECRET=<paste output here>
AUTH_URL=http://localhost:3001/news
ADMIN_EMAIL=your@email.com
ADMIN_PASSWORD_HASH=<generate below>
```

Generate the password hash (replace `yourpassword`):

```bash
node -e "require('bcryptjs').hash('yourpassword', 10).then(console.log)"
```

Paste the hash as `ADMIN_PASSWORD_HASH`.

- [ ] **Step 4: Create auth.ts at project root**

```ts
// auth.ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // With Next.js basePath "/news", Auth.js routes live at /news/api/auth
  basePath: "/news/api/auth",
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
        if (!adminEmail || !adminPasswordHash) return null;
        if (credentials.email !== adminEmail) return null;
        const valid = await bcrypt.compare(
          credentials.password as string,
          adminPasswordHash
        );
        if (!valid) return null;
        return { id: "admin", email: adminEmail, name: "Admin" };
      },
    }),
  ],
  pages: {
    signIn: "/admin/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
});
```

- [ ] **Step 5: Create NextAuth route handler**

```ts
// app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: no errors (or only errors about missing admin pages — fine, those come in later tasks).

- [ ] **Step 7: Commit**

```bash
git add auth.ts app/api/auth/ .env
git commit -m "feat: auth — NextAuth v5 credentials setup with bcrypt password"
```

---

## Task 8: Middleware route protection

**Files:**
- Create: `middleware.ts`

- [ ] **Step 1: Create middleware.ts at project root**

```ts
// middleware.ts
import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isLoginPage = req.nextUrl.pathname === "/admin/login";
  if (!req.auth && !isLoginPage) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/admin/login";
    return NextResponse.redirect(loginUrl);
  }
});

export const config = {
  // Middleware matchers use paths without the basePath prefix
  matcher: ["/admin/:path*"],
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 3: Start dev server and test redirect**

```bash
pnpm dev
```

Open `http://localhost:3001/news/admin` in the browser.

Expected: redirected to `http://localhost:3001/news/admin/login` (the login page — which doesn't exist yet, so it will 404, but the redirect itself proves middleware is working).

Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add middleware.ts
git commit -m "feat: middleware — protect /admin/* routes, redirect to login"
```

---

## Task 9: Admin layout and login page

**Files:**
- Create: `app/admin/layout.tsx`
- Create: `app/admin/login/page.tsx`

- [ ] **Step 1: Create admin layout**

The admin layout nests inside the existing root layout (public header remains visible above it). The admin layout adds an admin-specific sub-nav bar at the top of the content area.

```tsx
// app/admin/layout.tsx
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/src/lib/prisma";

async function getPendingKeywordCount(): Promise<number> {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  return prisma.learnedKeyword.count({
    where: { active: false, hits: { gte: minHits }, uniqueIps: { gte: minIps } },
  });
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect("/admin/login");

  const pendingCount = await getPendingKeywordCount();

  return (
    <div>
      <div className="border-b border-border/60 bg-secondary/40 mb-6 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-1 text-sm py-2 max-w-7xl mx-auto">
          <nav className="flex items-center gap-1 flex-1">
            <Link
              href="/admin"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Dashboard
            </Link>
            <Link
              href="/admin/keywords"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium flex items-center gap-1.5"
            >
              Keywords
              {pendingCount > 0 && (
                <span className="bg-amber-500 text-white rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold">
                  {pendingCount}
                </span>
              )}
            </Link>
            <Link
              href="/admin/rejections"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Rejections
            </Link>
            <Link
              href="/admin/flagged"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Flagged
            </Link>
          </nav>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{session.user?.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/admin/login" });
              }}
            >
              <button
                type="submit"
                className="hover:text-foreground transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create login page**

```tsx
// app/admin/login/page.tsx
import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="max-w-sm mx-auto py-16">
      <h1 className="font-heading text-2xl font-semibold text-foreground mb-2">
        Admin
      </h1>
      <p className="text-sm text-muted-foreground mb-8">
        Sign in to manage the pipeline.
      </p>

      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400 mb-4">
          Invalid email or password.
        </p>
      )}

      <form
        action={async (formData: FormData) => {
          "use server";
          try {
            await signIn("credentials", {
              email: formData.get("email"),
              password: formData.get("password"),
              redirectTo: "/admin",
            });
          } catch (e) {
            if (e instanceof AuthError) {
              redirect(`/admin/login?error=1`);
            }
            throw e;
          }
        }}
        className="space-y-4"
      >
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 4: Manual test**

```bash
pnpm dev
```

Open `http://localhost:3001/news/admin/login`. The login form should appear (below the public site header).

Try submitting with wrong credentials. Expected: stays on login page with "Invalid email or password."

Try submitting with correct credentials (the email/password from `.env`). Expected: redirected to `/news/admin` (which will 404 — that's fine, built in Task 10).

- [ ] **Step 5: Commit**

```bash
git add app/admin/layout.tsx app/admin/login/page.tsx
git commit -m "feat: admin layout + login page with NextAuth server action"
```

---

## Task 10: Admin dashboard

**Files:**
- Create: `app/admin/page.tsx`

- [ ] **Step 1: Create dashboard page**

```tsx
// app/admin/page.tsx
import { prisma } from "@/src/lib/prisma";
import Link from "next/link";

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function getDashboardData() {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pendingCount, staleCount, flaggedToday, recentFlagged] = await Promise.all([
    prisma.learnedKeyword.count({
      where: { active: false, hits: { gte: minHits }, uniqueIps: { gte: minIps } },
    }),
    prisma.learnedKeyword.count({
      where: { active: false, lastHitAt: { lt: thirtyDaysAgo } },
    }),
    prisma.article.count({
      where: { flaggedAt: { gte: yesterday } },
    }),
    prisma.article.findMany({
      where: { flaggedAt: { not: null } },
      orderBy: { flaggedAt: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        flaggedAt: true,
        source: { select: { name: true } },
      },
    }),
  ]);

  return { pendingCount, staleCount, flaggedToday, recentFlagged };
}

export default async function AdminDashboard() {
  const { pendingCount, staleCount, flaggedToday, recentFlagged } =
    await getDashboardData();

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Pipeline health at a glance.</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <Link
          href="/admin/keywords"
          className="rounded-lg border border-border p-4 hover:bg-secondary/40 transition-colors"
        >
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {pendingCount}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Pending keywords</div>
        </Link>
        <div className="rounded-lg border border-border p-4">
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {staleCount}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Stale keywords</div>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {flaggedToday}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Flagged today</div>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Recent user flags
        </p>
        {recentFlagged.length === 0 ? (
          <p className="text-sm text-muted-foreground">No flagged articles yet.</p>
        ) : (
          <div className="space-y-2">
            {recentFlagged.map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between gap-4 text-sm py-2 border-b border-border/60 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-foreground truncate">{a.title}</p>
                  <p className="text-xs text-muted-foreground">{a.source.name}</p>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                  {timeAgo(a.flaggedAt!)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 3: Manual test**

```bash
pnpm dev
```

Sign in at `http://localhost:3001/news/admin/login`. After sign-in, you should land on the dashboard at `/news/admin`. Verify:
- Three stat cards appear with real numbers
- Recent flags list appears (empty is fine if no articles flagged yet)
- Admin sub-nav visible above content
- Public site header still visible above admin sub-nav

- [ ] **Step 4: Commit**

```bash
git add app/admin/page.tsx
git commit -m "feat: admin dashboard — pending keywords, stale, flagged today, recent flags"
```

---

## Task 11: Keywords management page

**Files:**
- Create: `app/admin/keywords/page.tsx`
- Create: `app/admin/keywords/actions.ts`
- Create: `app/admin/keywords/KeywordsClient.tsx`

- [ ] **Step 1: Create server actions**

```ts
// app/admin/keywords/actions.ts
"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/src/lib/prisma";
import redis from "@/src/lib/redis";

async function requireAdmin() {
  const session = await auth();
  if (!session) redirect("/admin/login");
}

async function invalidateKeywordCaches() {
  await Promise.allSettled([
    redis.del("learned:keywords:en"),
    redis.del("learned:keywords:fi"),
  ]);
}

export async function activateKeyword(id: string) {
  await requireAdmin();
  await prisma.learnedKeyword.update({
    where: { id },
    data: { active: true },
  });
  await invalidateKeywordCaches();
}

export async function deactivateKeyword(id: string) {
  await requireAdmin();
  await prisma.learnedKeyword.update({
    where: { id },
    data: { active: false },
  });
  await invalidateKeywordCaches();
}

export async function deleteKeyword(id: string) {
  await requireAdmin();
  const kw = await prisma.learnedKeyword.findUnique({ where: { id } });
  if (!kw) return;
  await prisma.$transaction([
    prisma.learnedKeywordFlag.deleteMany({
      where: { keyword: kw.keyword, language: kw.language },
    }),
    prisma.learnedKeyword.delete({ where: { id } }),
  ]);
  await invalidateKeywordCaches();
}
```

- [ ] **Step 2: Create client component**

```tsx
// app/admin/keywords/KeywordsClient.tsx
"use client";

import { useTransition } from "react";
import { activateKeyword, deactivateKeyword, deleteKeyword } from "./actions";

interface Keyword {
  id: string;
  keyword: string;
  language: string;
  hits: number;
  uniqueIps: number;
  lastHitAt: Date | null;
  active: boolean;
}

function timeAgo(date: Date | null): string {
  if (!date) return "—";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function MutationButton({
  action,
  label,
  variant,
}: {
  action: () => Promise<void>;
  label: string;
  variant: "primary" | "danger" | "ghost";
}) {
  const [isPending, startTransition] = useTransition();

  const styles = {
    primary:
      "bg-emerald-600 text-white border-transparent hover:bg-emerald-700",
    danger:
      "bg-white text-rose-600 border-rose-200 hover:bg-rose-50 dark:bg-transparent dark:text-rose-400 dark:border-rose-800",
    ghost:
      "bg-white text-muted-foreground border-border hover:bg-secondary dark:bg-transparent",
  };

  return (
    <button
      onClick={() => startTransition(action)}
      disabled={isPending}
      className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${styles[variant]}`}
    >
      {isPending ? "…" : label}
    </button>
  );
}

export function PendingTable({ keywords }: { keywords: Keyword[] }) {
  if (keywords.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Keyword</th>
            <th className="text-left px-4 py-2.5 font-medium">Lang</th>
            <th className="text-right px-4 py-2.5 font-medium">Hits</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">IPs</th>
            <th className="text-right px-4 py-2.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr
              key={kw.id}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium">{kw.keyword}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{kw.language}</td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{kw.hits}</td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground hidden sm:table-cell">{kw.uniqueIps}</td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-2">
                  <MutationButton
                    action={() => activateKeyword(kw.id)}
                    label="Activate"
                    variant="primary"
                  />
                  <MutationButton
                    action={() => deleteKeyword(kw.id)}
                    label="Dismiss"
                    variant="ghost"
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActiveTable({ keywords }: { keywords: Keyword[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Keyword</th>
            <th className="text-left px-4 py-2.5 font-medium">Lang</th>
            <th className="text-right px-4 py-2.5 font-medium">Hits</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Last hit</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr
              key={kw.id}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium">{kw.keyword}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{kw.language}</td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{kw.hits}</td>
              <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden sm:table-cell">{timeAgo(kw.lastHitAt)}</td>
              <td className="px-4 py-3 text-right">
                <MutationButton
                  action={() => deactivateKeyword(kw.id)}
                  label="Deactivate"
                  variant="danger"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StaleTable({ keywords }: { keywords: Keyword[] }) {
  if (keywords.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden opacity-70">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Keyword</th>
            <th className="text-left px-4 py-2.5 font-medium">Lang</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Last hit</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr
              key={kw.id}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium text-muted-foreground">{kw.keyword}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{kw.language}</td>
              <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden sm:table-cell">{timeAgo(kw.lastHitAt)}</td>
              <td className="px-4 py-3 text-right">
                <MutationButton
                  action={() => activateKeyword(kw.id)}
                  label="Re-activate"
                  variant="ghost"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Create page (RSC)**

```tsx
// app/admin/keywords/page.tsx
import { prisma } from "@/src/lib/prisma";
import { PendingTable, ActiveTable, StaleTable } from "./KeywordsClient";

async function getKeywordData() {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pending, active, stale] = await Promise.all([
    prisma.learnedKeyword.findMany({
      where: { active: false, hits: { gte: minHits }, uniqueIps: { gte: minIps } },
      orderBy: { hits: "desc" },
    }),
    prisma.learnedKeyword.findMany({
      where: { active: true },
      orderBy: { hits: "desc" },
    }),
    prisma.learnedKeyword.findMany({
      where: { active: false, lastHitAt: { lt: thirtyDaysAgo } },
      orderBy: { lastHitAt: "asc" },
    }),
  ]);

  return { pending, active, stale };
}

export default async function KeywordsPage() {
  const { pending, active, stale } = await getKeywordData();

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Keywords</h1>
        <p className="text-sm text-muted-foreground">
          Learned from user flags. Activate to add to filter, deactivate to remove.
        </p>
      </div>

      {pending.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Pending activation
            </p>
            <span className="bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800 rounded-full px-2 py-0.5 text-[10px] font-semibold">
              {pending.length}
            </span>
          </div>
          <PendingTable keywords={pending} />
          <p className="text-xs text-muted-foreground mt-2">
            Auto-activates after {process.env.KEYWORD_AUTO_ACTIVATE_DAYS ?? "7"} days if not reviewed.
          </p>
        </div>
      )}

      <div className="mb-8">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Active ({active.length})
        </p>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active learned keywords yet.</p>
        ) : (
          <ActiveTable keywords={active} />
        )}
      </div>

      {stale.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
            Stale / deactivated ({stale.length})
          </p>
          <StaleTable keywords={stale} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 5: Manual test**

```bash
pnpm dev
```

Sign in and navigate to `http://localhost:3001/news/admin/keywords`.

Verify all three sections render. If you have any keywords in the DB, test Activate / Deactivate buttons. Verify the Redis cache is cleared (check the dev server logs for no errors).

- [ ] **Step 6: Commit**

```bash
git add app/admin/keywords/
git commit -m "feat: admin keywords page — pending/active/stale sections with server actions"
```

---

## Task 12: Rejection log page

**Files:**
- Create: `app/admin/rejections/page.tsx`

- [ ] **Step 1: Create rejections page**

```tsx
// app/admin/rejections/page.tsx
import { prisma } from "@/src/lib/prisma";

const PASS_LABELS: Record<number, string> = {
  0: "Keyword",
  1: "LLM-1",
  2: "LLM-2",
};

const PASS_COLORS: Record<number, string> = {
  0: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  1: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  2: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
};

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function getRejections() {
  return prisma.article.findMany({
    where: {
      isPositive: false,
      rejectionReason: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      title: true,
      rejectionReason: true,
      rejectionPass: true,
      createdAt: true,
      source: { select: { name: true } },
    },
  });
}

export default async function RejectionsPage() {
  const rejections = await getRejections();

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Rejections</h1>
        <p className="text-sm text-muted-foreground">
          Last 300 rejected articles with reason. Useful for spotting false positives.
        </p>
      </div>

      {rejections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rejections with reasons yet. Run the pipeline to populate this.
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Pass</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Reason</th>
                <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {rejections.map((a, i) => {
                const pass = a.rejectionPass ?? 0;
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
                  >
                    <td className="px-4 py-2.5 text-foreground">
                      <span className="line-clamp-2 text-xs">{a.title}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                      {a.source.name}
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${PASS_COLORS[pass] ?? PASS_COLORS[0]}`}>
                        {PASS_LABELS[pass] ?? `Pass ${pass}`}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                      <span className="font-mono">{a.rejectionReason}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground text-right hidden sm:table-cell whitespace-nowrap">
                      {formatDate(a.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 3: Manual test**

```bash
pnpm dev
```

Navigate to `http://localhost:3001/news/admin/rejections`. If the DB has rejected articles with `rejectionReason` populated, they should appear. Run a pipeline ingest if needed:

```bash
curl -X POST http://localhost:3001/news/api/ingest \
  -H "x-ingest-secret: $(grep INGEST_SECRET .env | cut -d= -f2)"
```

Then refresh the rejections page.

- [ ] **Step 4: Commit**

```bash
git add app/admin/rejections/page.tsx
git commit -m "feat: admin rejections page — last 300 rejections with pass badge and reason"
```

---

## Task 13: Flagged articles page

**Files:**
- Create: `app/admin/flagged/page.tsx`

- [ ] **Step 1: Create flagged page**

```tsx
// app/admin/flagged/page.tsx
import { prisma } from "@/src/lib/prisma";
import { extractKeywords } from "@/src/lib/keywords";

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function getFlaggedArticles() {
  return prisma.article.findMany({
    where: { flaggedAt: { not: null } },
    orderBy: { flaggedAt: "desc" },
    take: 300,
    select: {
      id: true,
      title: true,
      flaggedAt: true,
      source: { select: { name: true, language: true } },
    },
  });
}

export default async function FlaggedPage() {
  const flagged = await getFlaggedArticles();

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Flagged</h1>
        <p className="text-sm text-muted-foreground">
          Articles users flagged as &quot;not positive news.&quot; These are LLM false positives — use them to spot patterns and update rejection rules.
        </p>
      </div>

      {flagged.length === 0 ? (
        <p className="text-sm text-muted-foreground">No flagged articles yet.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Keywords extracted</th>
                <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Flagged</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((a, i) => {
                const keywords = extractKeywords(a.title, a.source.language ?? "en");
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
                  >
                    <td className="px-4 py-2.5 text-foreground">
                      <span className="line-clamp-2 text-xs">{a.title}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                      {a.source.name}
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {keywords.slice(0, 5).map((kw) => (
                          <span
                            key={kw}
                            className="bg-secondary text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-mono"
                          >
                            {kw}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground text-right hidden sm:table-cell whitespace-nowrap">
                      {formatDate(a.flaggedAt!)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 3: Manual test**

```bash
pnpm dev
```

Navigate to `http://localhost:3001/news/admin/flagged`. Flag an article from the public feed, refresh this page. Verify:
- The flagged article appears at the top
- Keywords extracted from the title show as chips
- Source name and timestamp correct

- [ ] **Step 4: Final full compile + build check**

```bash
pnpm tsc --noEmit && pnpm build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add app/admin/flagged/page.tsx
git commit -m "feat: admin flagged page — user-flagged articles with extracted keyword chips"
```

---

## Done

All 13 tasks complete. The pipeline now:
- Stores rejection reasons for every article (keyword filter and LLM passes 1 & 2)
- Requires 5 hits from 2+ distinct IPs before activating a learned keyword
- Auto-deactivates keywords with no hits in 30 days
- Auto-activates pending keywords after 7 days if admin hasn't reviewed

Admin panel at `/news/admin` provides:
- Dashboard with health stats
- Keywords page with pending/active/stale sections
- Rejections log with LLM reason and pass badge
- Flagged articles log with extracted keyword chips
