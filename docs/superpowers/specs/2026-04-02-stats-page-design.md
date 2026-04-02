# Stats Page Design

**Date:** 2026-04-02
**Status:** Approved

## Overview

A `/stats` page showing live pipeline operational metrics: article totals, acceptance/rejection rate, category breakdown, and per-source article counts. Data is pushed from the server via SSE while the page is open. Linked from the site menu and footer.

---

## Architecture

| File | Role |
|------|------|
| `app/stats/page.tsx` | Server component — metadata only, renders `<StatsView />` |
| `components/news/StatsView.tsx` | Client component — EventSource subscriber, state, full UI |
| `app/api/stats/stream/route.ts` | SSE route — initial snapshot + 15s polling push |
| `components/news/SiteMenu.tsx` | Add "Pipeline Stats" nav link |
| `app/layout.tsx` | Add "Pipeline Stats" footer link |

No new dependencies.

---

## SSE Stream Route — `app/api/stats/stream/route.ts`

```ts
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Returns Response with Content-Type: text/event-stream
  // Uses ReadableStream
}
```

**Behaviour:**
1. On connect: immediately fetch stats (same 7 parallel Prisma queries as `/api/stats`) and push as `data: <json>\n\n`.
2. Start a `setInterval` every 15 000 ms. On each tick, fetch stats again. If the JSON string differs from the last sent value, push a new event.
3. Listen for `request.signal` `"abort"` event — clear the interval when client disconnects.

**Event format:** plain `data:` lines (no named event type needed). Each event is the full stats JSON payload — same shape as `/api/stats` response:

```json
{
  "pipeline": { "running": false },
  "articles": {
    "total": 1988, "positive": 890, "last24h": 43,
    "rejectionRate": 0.54, "oldest": "...", "newest": "..."
  },
  "byCategory": { "Society": 430, "Science": 210, ... },
  "bySources": [
    { "name": "Good News Network", "count": 140, "lastArticle": "..." },
    ...
  ]
}
```

Note: `rejectionRate` in the stream is `(total - positive) / total` rounded to 2 decimal places, same formula as `/api/stats`.

---

## StatsView Client Component — `components/news/StatsView.tsx`

`"use client"` component. Receives no props.

**State:**
- `stats: StatsPayload | null` — null until first SSE event received
- `lastUpdated: number | null` — `Date.now()` timestamp of last event
- `secondsAgo: number` — updated every second by a `setInterval`

**Mount/unmount:**
- `useEffect`: open `new EventSource("/news/api/stats/stream")`, set `stats` and `lastUpdated` on each `message` event, close on cleanup.
- Second `useEffect` (depends on `lastUpdated`): when `lastUpdated` is non-null, start a `setInterval` every 1 000 ms to update `secondsAgo = Math.floor((Date.now() - lastUpdated) / 1000)`. Clear on cleanup or when `lastUpdated` changes.

**Before first event:** render a skeleton — muted placeholder blocks in the same shape as the loaded state (no spinner, no loading text).

**TypeScript type:**

```ts
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
```

---

## UI Layout (single-column editorial)

Follows the pattern of `app/sources/page.tsx`: `max-w-3xl mx-auto py-8`.

### Page header

```
Pipeline Stats
[status dot] Pipeline idle · updated 3s ago
```

- Status dot: `bg-emerald-600` when `pipeline.running === false`, `bg-amber-500 animate-pulse` when running.
- "updated Xs ago" derived from `secondsAgo`. Text: "updated just now" for 0–2s, "updated Xs ago" for 3+s.

### Articles section

```
ARTICLES                    (section label)
1,988  total · 890 positive · 43 in last 24h
[==============================            ]   (progress bar, width = acceptance %)
46% acceptance rate · 54% rejected by pipeline
Archive: Mar 19 – Apr 2, 2026
```

- Big number (`1,988`) in `text-primary` (amber), `text-[28px]` Fraunces.
- Progress bar: `bg-emerald-600` fill, `bg-secondary` track, `h-2 rounded-full`. Width = `${Math.round((1 - stats.articles.rejectionRate) * 100)}%`.
- Archive dates: formatted as "MMM D, YYYY" using `toLocaleDateString`. Hidden if `oldest`/`newest` are null.

### By Category section

Category pills using the same `CATEGORY_COLORS` map as `app/sources/page.tsx`. Duplicate the constant inline in `StatsView.tsx` — do not extract it to a shared module (two usages doesn't warrant an abstraction):

```
[Society 430] [Innovation 225] [Science 210] [Health 190] [Environment 185]
```

Pills sorted descending by count. Each pill: `rounded-full border px-2.5 py-1 text-xs font-medium` with category color classes.

### By Source section

Bordered table, same visual style as the sources page table:

| Source | Articles | Last article |
|--------|----------|-------------|
| Good News Network | 140 | Apr 2, 14:32 |
| … | … | … |

- All sources listed (no truncation).
- "Last article" formatted as "MMM D, HH:mm" using `toLocaleString`. Shows `—` if null.
- Alternating row backgrounds: `bg-background/50` on odd rows.

### Footer note

```
Stats refresh automatically while this page is open. Back to feed →
```

---

## Navigation

**`SiteMenu.tsx`:** Add a "Pipeline Stats" `<Link href="/stats">` entry above the divider (alongside "News Sources").

**`app/layout.tsx` footer:** Add a "Pipeline Stats" link in the footer nav, alongside the existing "News Sources", "Privacy Policy", "Terms of Service" links.

---

## Skeleton (loading state)

Before the first SSE event, render muted placeholder blocks:
- A `h-7 w-24 rounded bg-secondary animate-pulse` for the big number
- A `h-2 rounded-full bg-secondary animate-pulse` for the progress bar
- Three `h-6 w-20 rounded-full bg-secondary animate-pulse` pills for categories
- Three rows of `h-4 bg-secondary animate-pulse rounded` for the source table

---

## Error Handling

If the `EventSource` fires an `error` event and `readyState` is `CLOSED`, the browser will attempt automatic reconnection per the SSE spec — no manual retry logic needed. The "updated Xs ago" counter continues ticking and will show the staleness naturally.

---

## Files Changed / Created

| File | Change |
|------|--------|
| `app/stats/page.tsx` | **New** — server component shell |
| `components/news/StatsView.tsx` | **New** — client component |
| `app/api/stats/stream/route.ts` | **New** — SSE stream route |
| `components/news/SiteMenu.tsx` | Add "Pipeline Stats" link |
| `app/layout.tsx` | Add "Pipeline Stats" footer link |
