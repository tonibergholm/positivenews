# Stats Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stats` page that displays live pipeline operational metrics pushed via Server-Sent Events.

**Architecture:** A thin server component (`app/stats/page.tsx`) renders a client component (`StatsView`) that subscribes to an SSE route (`/api/stats/stream`). The stream route sends a stats snapshot immediately on connect, then polls every 15 seconds and pushes again only if data changed. Navigation links are added to the site menu and footer.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind CSS, Prisma 7, TypeScript. No new dependencies.

---

### Task 1: SSE Stream Route

**Files:**
- Create: `app/api/stats/stream/route.ts`

**Context:** This is a Next.js 16 App Router route handler that returns a `ReadableStream` with `Content-Type: text/event-stream`. The app runs behind nginx, so include `X-Accel-Buffering: no` to disable nginx response buffering. The existing `app/api/stats/route.ts` has the same 7-query Prisma pattern — replicate it here (do not extract a shared helper). The `basePath` is `/news`, so this route is reachable at `/news/api/stats/stream`.

- [ ] **Step 1: Create the route file**

```ts
// app/api/stats/stream/route.ts
import type { NextRequest } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { isPipelineRunning } from "@/src/lib/pipeline";

export const dynamic = "force-dynamic";

async function buildSnapshot() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [total, positive, last24h, range, byCategory, bySourceId, sources] =
    await Promise.all([
      prisma.article.count(),
      prisma.article.count({ where: { isPositive: true } }),
      prisma.article.count({ where: { publishedAt: { gte: yesterday } } }),
      prisma.article.aggregate({
        _min: { publishedAt: true },
        _max: { publishedAt: true },
      }),
      prisma.article.groupBy({ by: ["category"], _count: { id: true } }),
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

  return {
    pipeline: { running: isPipelineRunning() },
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
      name: sourceMap.get(row.sourceId) ?? "(unknown)",
      count: row._count.id,
      lastArticle: row._max.publishedAt ?? null,
    })),
  };
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let lastJson: string | null = null;

      async function fetchAndPush() {
        try {
          const snapshot = await buildSnapshot();
          const json = JSON.stringify(snapshot);
          if (json !== lastJson) {
            controller.enqueue(encoder.encode(`data: ${json}\n\n`));
            lastJson = json;
          }
        } catch {
          // Ignore — client will see staleness via the "updated Xs ago" counter
        }
      }

      fetchAndPush();
      const intervalId = setInterval(fetchAndPush, 15_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(intervalId);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Verify the route returns SSE**

Run the dev server: `pnpm dev`

In a terminal:
```bash
curl -N http://localhost:3000/news/api/stats/stream
```

Expected: a `data: {...}` line followed by `\n\n` appears within a couple of seconds. The connection stays open. `Ctrl-C` to stop.

- [ ] **Step 3: Commit**

```bash
git add app/api/stats/stream/route.ts
git commit -m "feat: add SSE stats stream route"
```

---

### Task 2: StatsView Client Component

**Files:**
- Create: `components/news/StatsView.tsx`

**Context:** This is a `"use client"` React component. It opens an `EventSource` connection to `/news/api/stats/stream` (full path including basePath). The skeleton renders before the first event arrives — it must have the same visual shape as the loaded content to avoid layout shift. The `CATEGORY_COLORS` map is copied verbatim from `app/sources/page.tsx` — do not extract it to a shared module.

- [ ] **Step 1: Create the component file**

```tsx
// components/news/StatsView.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const CATEGORY_COLORS: Record<string, string> = {
  Science:
    "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800",
  Environment:
    "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  Society:
    "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800",
  Health:
    "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800",
  Innovation:
    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
};

interface StatsPayload {
  pipeline: { running: boolean };
  articles: {
    total: number;
    positive: number;
    last24h: number;
    rejectionRate: number;
    oldest: string | null;
    newest: string | null;
  };
  byCategory: Record<string, number>;
  bySources: Array<{ name: string; count: number; lastArticle: string | null }>;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatLastArticle(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-24 rounded bg-secondary" />
        <div className="h-2 w-full rounded-full bg-secondary" />
        <div className="h-4 w-56 rounded bg-secondary" />
      </div>
      <div className="flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-6 w-20 rounded-full bg-secondary" />
        ))}
      </div>
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-9 w-full rounded bg-secondary" />
        ))}
      </div>
    </div>
  );
}

export function StatsView() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    const es = new EventSource("/news/api/stats/stream");
    es.onmessage = (e: MessageEvent) => {
      try {
        setStats(JSON.parse(e.data) as StatsPayload);
        setLastUpdated(Date.now());
        setSecondsAgo(0);
      } catch {
        // malformed event — ignore
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (lastUpdated === null) return;
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated) / 1000));
    }, 1_000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const updatedText =
    secondsAgo <= 2 ? "updated just now" : `updated ${secondsAgo}s ago`;

  if (!stats) {
    return (
      <div className="max-w-3xl mx-auto py-8 px-0">
        <div className="mb-8">
          <h1 className="font-heading text-[22px] sm:text-[28px] font-semibold text-foreground mb-2">
            Pipeline Stats
          </h1>
        </div>
        <Skeleton />
      </div>
    );
  }

  const acceptancePct = Math.round((1 - stats.articles.rejectionRate) * 100);
  const rejectionPct = Math.round(stats.articles.rejectionRate * 100);
  const sortedCategories = Object.entries(stats.byCategory).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <div className="max-w-3xl mx-auto py-8 px-0">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="font-heading text-[22px] sm:text-[28px] font-semibold text-foreground mb-2">
          Pipeline Stats
        </h1>
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full shrink-0 ${
              stats.pipeline.running
                ? "bg-amber-500 animate-pulse"
                : "bg-emerald-600"
            }`}
          />
          {stats.pipeline.running ? "Pipeline running" : "Pipeline idle"}
          <span className="text-muted-foreground/50">·</span>
          {updatedText}
        </p>
      </div>

      {/* Articles */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Articles
        </p>
        <div className="flex items-baseline gap-3 flex-wrap mb-3">
          <span className="font-heading text-[28px] font-bold text-primary leading-none tabular-nums">
            {stats.articles.total.toLocaleString()}
          </span>
          <span className="text-sm text-muted-foreground">
            total &nbsp;·&nbsp;{" "}
            <span className="text-emerald-600 font-medium">
              {stats.articles.positive.toLocaleString()} positive
            </span>{" "}
            &nbsp;·&nbsp; {stats.articles.last24h.toLocaleString()} in last 24h
          </span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden mb-1.5">
          <div
            className="h-full rounded-full bg-emerald-600 transition-[width] duration-500"
            style={{ width: `${acceptancePct}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {acceptancePct}% acceptance rate &nbsp;·&nbsp; {rejectionPct}% rejected by
          pipeline
        </p>
        {(stats.articles.oldest ?? stats.articles.newest) && (
          <p className="text-xs text-muted-foreground mt-1">
            Archive: {formatShortDate(stats.articles.oldest)} –{" "}
            {formatShortDate(stats.articles.newest)}
          </p>
        )}
      </div>

      <div className="border-t border-border/60 mb-6" />

      {/* By Category */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          By Category
        </p>
        <div className="flex flex-wrap gap-2">
          {sortedCategories.map(([cat, count]) => {
            const colorClass =
              CATEGORY_COLORS[cat] ??
              "bg-gray-100 text-gray-600 border-gray-200";
            return (
              <span
                key={cat}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${colorClass}`}
              >
                {cat}
                <strong className="tabular-nums font-semibold">
                  {count.toLocaleString()}
                </strong>
              </span>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border/60 mb-6" />

      {/* By Source */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          By Source
        </p>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">Source</th>
                <th className="text-right px-4 py-2.5 font-medium">Articles</th>
                <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">
                  Last article
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.bySources.map((src, i) => (
                <tr
                  key={src.name}
                  className={`border-b border-border/60 last:border-0 transition-colors hover:bg-secondary/40 ${
                    i % 2 === 0 ? "" : "bg-background/50"
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {src.name}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
                    {src.count.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap hidden sm:table-cell">
                    <time dateTime={src.lastArticle ?? ""}>
                      {formatLastArticle(src.lastArticle)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-2 text-xs text-muted-foreground border-t border-border/60 pt-6">
        Stats refresh automatically while this page is open.{" "}
        <Link href="/" className="text-primary hover:underline">
          Back to feed &rarr;
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify in the browser**

Open `http://localhost:3000/news/stats` in the browser.

Expected:
- Skeleton renders instantly (no blank flash)
- Within ~1 second the skeleton is replaced with real data
- The "updated Xs ago" counter increments every second
- The status dot is green (pipeline idle)

- [ ] **Step 4: Commit**

```bash
git add components/news/StatsView.tsx
git commit -m "feat: add StatsView client component with SSE subscription"
```

---

### Task 3: Stats Page Shell

**Files:**
- Create: `app/stats/page.tsx`

**Context:** This is a server component that only supplies metadata and renders `<StatsView />`. All data fetching and live updating happens in the client component.

- [ ] **Step 1: Create the page file**

```tsx
// app/stats/page.tsx
import type { Metadata } from "next";
import { StatsView } from "@/components/news/StatsView";

export const metadata: Metadata = {
  title: "Pipeline Stats — PositiveNews",
  description: "Live operational metrics for the PositiveNews pipeline.",
};

export default function StatsPage() {
  return <StatsView />;
}
```

- [ ] **Step 2: Verify the page loads**

Navigate to `http://localhost:3000/news/stats`.

Expected:
- Page title in the browser tab reads "Pipeline Stats — PositiveNews"
- Stats render correctly (same as verified in Task 2 Step 3)

- [ ] **Step 3: Commit**

```bash
git add app/stats/page.tsx
git commit -m "feat: add stats page shell"
```

---

### Task 4: Navigation Links

**Files:**
- Modify: `components/news/SiteMenu.tsx`
- Modify: `app/layout.tsx`

**Context:** The site menu is a client component dropdown (`SiteMenu.tsx`). Currently it links to "News Sources", then a divider, then Privacy Policy and Terms. Add "Pipeline Stats" alongside "News Sources" (both above the divider). The footer in `app/layout.tsx` currently has: News Sources · Privacy Policy · Terms of Service. Add "Pipeline Stats" after "News Sources".

- [ ] **Step 1: Add link to SiteMenu**

In `components/news/SiteMenu.tsx`, find this block:

```tsx
          <Link
            href="/sources"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
          >
            News Sources
          </Link>
          <div className="my-1 border-t border-border/60" />
```

Replace with:

```tsx
          <Link
            href="/sources"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
          >
            News Sources
          </Link>
          <Link
            href="/stats"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
          >
            Pipeline Stats
          </Link>
          <div className="my-1 border-t border-border/60" />
```

- [ ] **Step 2: Add link to footer**

In `app/layout.tsx`, find this block in the footer:

```tsx
              <Link href="/sources" className="hover:text-foreground transition-colors">
                News Sources
              </Link>
              <span className="text-border">·</span>
              <Link href="/privacy" className="hover:text-foreground transition-colors">
                Privacy Policy
              </Link>
```

Replace with:

```tsx
              <Link href="/sources" className="hover:text-foreground transition-colors">
                News Sources
              </Link>
              <span className="text-border">·</span>
              <Link href="/stats" className="hover:text-foreground transition-colors">
                Pipeline Stats
              </Link>
              <span className="text-border">·</span>
              <Link href="/privacy" className="hover:text-foreground transition-colors">
                Privacy Policy
              </Link>
```

- [ ] **Step 3: Verify navigation**

In the browser:
1. Click the hamburger menu in the header — verify "Pipeline Stats" appears between "News Sources" and the divider
2. Click "Pipeline Stats" — verify it navigates to `/news/stats`
3. Scroll to the footer — verify "Pipeline Stats" appears between "News Sources" and "Privacy Policy"
4. Click the footer link — verify it also navigates to `/news/stats`

- [ ] **Step 4: Commit**

```bash
git add components/news/SiteMenu.tsx app/layout.tsx
git commit -m "feat: add Pipeline Stats nav links to menu and footer"
```
