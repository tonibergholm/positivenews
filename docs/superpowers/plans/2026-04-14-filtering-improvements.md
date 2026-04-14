# Filtering Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add missing admin actions (add keyword, un-reject, unflag) and surface LLM rejection reasons as one-click keyword candidates.

**Architecture:** Four independent changes share the same pattern — server action in `actions.ts` + client component for interactivity + server page for data fetching. LLM candidate extraction is a pure lib function that reads `rejectionReason` strings already stored in the DB. No schema changes required.

**Tech Stack:** Next.js 16 App Router, Server Actions (`"use server"`), `useTransition` for optimistic UI, Prisma 7, Redis (keyword cache invalidation)

---

## File Map

| File | Change |
|------|--------|
| `app/admin/keywords/actions.ts` | Add `addKeyword(keyword, language)` |
| `app/admin/keywords/KeywordsClient.tsx` | Add `AddKeywordForm`, `LlmCandidatesSection`; widen `MutationButton` action type |
| `app/admin/keywords/page.tsx` | Call `getLlmCandidates()`; render `AddKeywordForm` + `LlmCandidatesSection` |
| `src/lib/llm-candidates.ts` | New — `getLlmCandidates()` pure lib function |
| `app/admin/rejections/actions.ts` | New — `unrejectArticle(id)` |
| `app/admin/rejections/RejectionsClient.tsx` | New — table with Un-reject button |
| `app/admin/rejections/page.tsx` | Use `RejectionsTable` instead of inline table |
| `app/admin/flagged/actions.ts` | New — `unflagArticle(id)` |
| `app/admin/flagged/FlaggedClient.tsx` | New — table with Unflag button |
| `app/admin/flagged/page.tsx` | Use `FlaggedTable` instead of inline table |

---

## Task 1: Add keyword manually — action + form

**Files:**
- Modify: `app/admin/keywords/actions.ts`
- Modify: `app/admin/keywords/KeywordsClient.tsx`
- Modify: `app/admin/keywords/page.tsx`

- [ ] **Step 1: Add `addKeyword` server action**

Open `app/admin/keywords/actions.ts`. Append after the existing `deleteKeyword` export:

```typescript
export async function addKeyword(
  keyword: string,
  language: string
): Promise<{ error: string } | undefined> {
  await requireAdmin();
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) return { error: "Keyword cannot be empty" };
  if (language !== "en" && language !== "fi") return { error: "Invalid language" };

  try {
    await prisma.learnedKeyword.create({
      data: { keyword: trimmed, language, active: true, hits: 0, uniqueIps: 0 },
    });
  } catch {
    return { error: "Keyword already exists" };
  }

  await invalidateKeywordCaches();
  revalidatePath("/admin/keywords");
}
```

- [ ] **Step 2: Widen `MutationButton` action type and add `AddKeywordForm`**

Open `app/admin/keywords/KeywordsClient.tsx`.

At the top of the file, add to the imports:

```typescript
import { useState } from "react";
import { activateKeyword, deactivateKeyword, deleteKeyword, addKeyword } from "./actions";
```

Change the `MutationButton` props interface — replace `action: () => Promise<void>` with `action: () => Promise<unknown>`:

```typescript
function MutationButton({
  action,
  label,
  variant,
}: {
  action: () => Promise<unknown>;
  label: string;
  variant: "primary" | "danger" | "ghost";
}) {
```

Add the `AddKeywordForm` export at the bottom of the file (before the closing):

```typescript
export function AddKeywordForm() {
  const [keyword, setKeyword] = useState("");
  const [language, setLanguage] = useState("en");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addKeyword(keyword, language);
      if (result?.error) {
        setError(result.error);
      } else {
        setKeyword("");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 mb-6">
      <input
        type="text"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="Add keyword…"
        className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        disabled={isPending}
      />
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        disabled={isPending}
      >
        <option value="en">EN</option>
        <option value="fi">FI</option>
      </select>
      <button
        type="submit"
        disabled={isPending || !keyword.trim()}
        className="rounded border border-transparent bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
      >
        {isPending ? "…" : "Add"}
      </button>
      {error && <span className="text-xs text-rose-500">{error}</span>}
    </form>
  );
}
```

- [ ] **Step 3: Render `AddKeywordForm` in the Keywords page**

Open `app/admin/keywords/page.tsx`. Add `AddKeywordForm` to the imports:

```typescript
import { PendingTable, ActiveTable, StaleTable, AddKeywordForm } from "./KeywordsClient";
```

Add `<AddKeywordForm />` just before the `{pending.length > 0 && ...}` block, inside the returned JSX:

```tsx
<div className="mb-8">
  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
    Add keyword
  </p>
  <AddKeywordForm />
</div>
```

- [ ] **Step 4: Verify**

Start the dev server with `pnpm dev`. Navigate to `/news/admin/keywords`. Confirm:
- The "Add keyword" form appears at the top
- Typing a word, selecting a language, and clicking "Add" creates an active keyword in the Active section (page reloads)
- Submitting a duplicate shows the "Keyword already exists" error inline
- Submitting an empty string keeps the button disabled

- [ ] **Step 5: Commit**

```bash
git add app/admin/keywords/actions.ts app/admin/keywords/KeywordsClient.tsx app/admin/keywords/page.tsx
git commit -m "feat(admin): add manual keyword entry form"
```

---

## Task 2: LLM-derived keyword candidates

**Files:**
- Create: `src/lib/llm-candidates.ts`
- Modify: `app/admin/keywords/page.tsx`
- Modify: `app/admin/keywords/KeywordsClient.tsx`

- [ ] **Step 1: Create `src/lib/llm-candidates.ts`**

```typescript
/**
 * Extracts candidate filter keywords from recent LLM rejection reasons.
 *
 * The LLM writes a short English reason for every rejection. This function
 * tokenises those reasons, counts term frequency, filters out terms already
 * in LearnedKeyword, and returns the top candidates for admin review.
 */

import { prisma } from "./prisma";
import { extractKeywords } from "./keywords";

export interface LlmCandidate {
  keyword: string;
  count: number;
}

export async function getLlmCandidates(
  lookbackDays = 30,
  limit = 20,
  minCount = 3
): Promise<LlmCandidate[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rejections = await prisma.article.findMany({
    where: {
      isPositive: false,
      rejectionPass: { in: [1, 2] },
      rejectionReason: { not: null },
      createdAt: { gte: since },
    },
    select: { rejectionReason: true },
    take: 500,
  });

  const termCounts = new Map<string, number>();
  for (const { rejectionReason } of rejections) {
    if (!rejectionReason) continue;
    const terms = extractKeywords(rejectionReason, "en");
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  const existing = new Set(
    (await prisma.learnedKeyword.findMany({ select: { keyword: true } }))
      .map((k) => k.keyword)
  );

  return [...termCounts.entries()]
    .filter(([term, count]) => count >= minCount && !existing.has(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}
```

- [ ] **Step 2: Add `LlmCandidatesSection` to `KeywordsClient.tsx`**

`LlmCandidate` is a plain `{ keyword: string; count: number }` — define it locally in the client file so no server-only module is imported.

Add this interface near the top of `KeywordsClient.tsx` (below the existing `Keyword` interface):

```typescript
interface LlmCandidate {
  keyword: string;
  count: number;
}
```

Add the `LlmCandidatesSection` export at the bottom of the file:

```typescript
export function LlmCandidatesSection({ candidates }: { candidates: LlmCandidate[] }) {
  if (candidates.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          LLM-derived candidates
        </p>
        <span className="bg-blue-100 text-blue-800 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800 rounded-full px-2 py-0.5 text-[10px] font-semibold">
          {candidates.length}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Terms extracted from recent LLM rejection reasons (English only, ≥3 appearances).
      </p>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Term</th>
              <th className="text-right px-4 py-2.5 font-medium">Appearances</th>
              <th className="text-right px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c, i) => (
              <tr
                key={c.keyword}
                className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
              >
                <td className="px-4 py-3 font-mono text-xs font-medium">{c.keyword}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground text-xs">
                  {c.count}
                </td>
                <td className="px-4 py-3 text-right">
                  <MutationButton
                    action={() => addKeyword(c.keyword, "en")}
                    label="Add to filter"
                    variant="primary"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire `getLlmCandidates` into the Keywords page**

Open `app/admin/keywords/page.tsx`.

Add to imports:

```typescript
import { getLlmCandidates } from "@/src/lib/llm-candidates";
import { PendingTable, ActiveTable, StaleTable, AddKeywordForm, LlmCandidatesSection } from "./KeywordsClient";
```

Update `getKeywordData` to fetch candidates in parallel:

```typescript
async function getKeywordData() {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pending, active, stale, llmCandidates] = await Promise.all([
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
    getLlmCandidates(),
  ]);

  return { pending, active, stale, llmCandidates };
}
```

In the page component, render `LlmCandidatesSection` between the "Add keyword" form section and "Pending activation":

```tsx
export default async function KeywordsPage() {
  const { pending, active, stale, llmCandidates } = await getKeywordData();

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Keywords</h1>
        <p className="text-sm text-muted-foreground">
          Learned from user flags. Activate to add to filter, deactivate to remove.
        </p>
      </div>

      <div className="mb-8">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Add keyword
        </p>
        <AddKeywordForm />
      </div>

      <LlmCandidatesSection candidates={llmCandidates} />

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

- [ ] **Step 4: Verify**

Navigate to `/news/admin/keywords`. If there are LLM rejections in the DB, the "LLM-derived candidates" section appears with terms sorted by frequency. Clicking "Add to filter" activates a keyword and refreshes the page (the row disappears from candidates since it's now in `LearnedKeyword`).

If the DB has no LLM rejections yet, the section is hidden — that's correct.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm-candidates.ts app/admin/keywords/KeywordsClient.tsx app/admin/keywords/page.tsx
git commit -m "feat(admin): surface LLM rejection reasons as keyword candidates"
```

---

## Task 3: Rejections page — Un-reject action

**Files:**
- Create: `app/admin/rejections/actions.ts`
- Create: `app/admin/rejections/RejectionsClient.tsx`
- Modify: `app/admin/rejections/page.tsx`

- [ ] **Step 1: Create `app/admin/rejections/actions.ts`**

```typescript
"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/src/lib/prisma";

async function requireAdmin() {
  const session = await auth();
  if (!session) redirect("/admin/login");
}

export async function unrejectArticle(id: string): Promise<void> {
  await requireAdmin();
  await prisma.article.update({
    where: { id },
    data: {
      isPositive: true,
      rejectionReason: null,
      rejectionPass: null,
      curatedAt: new Date(),
    },
  });
  revalidatePath("/admin/rejections");
}
```

- [ ] **Step 2: Create `app/admin/rejections/RejectionsClient.tsx`**

```typescript
"use client";

import { useTransition } from "react";
import { unrejectArticle } from "./actions";

interface Rejection {
  id: string;
  title: string;
  rejectionReason: string | null;
  rejectionPass: number | null;
  createdAt: Date;
  source: { name: string };
}

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

function UnrejectButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => unrejectArticle(id))}
      disabled={isPending}
      className="rounded border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:bg-transparent dark:border-emerald-800 dark:text-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap"
    >
      {isPending ? "…" : "Un-reject"}
    </button>
  );
}

export function RejectionsTable({ rejections }: { rejections: Rejection[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
            <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Pass</th>
            <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Reason</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Date</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rejections.map((a, i) => {
            const pass = a.rejectionPass ?? 0;
            return (
              <tr
                key={a.id}
                className={`border-b border-border/60 last:border-0 ${
                  i % 2 === 0 ? "" : "bg-background/50"
                }`}
              >
                <td className="px-4 py-2.5 text-foreground">
                  <span className="line-clamp-2 text-xs">{a.title}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                  {a.source.name}
                </td>
                <td className="px-4 py-2.5 hidden md:table-cell">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      PASS_COLORS[pass] ?? PASS_COLORS[0]
                    }`}
                  >
                    {PASS_LABELS[pass] ?? `Pass ${pass}`}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                  <span className="font-mono">{a.rejectionReason}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground text-right hidden sm:table-cell whitespace-nowrap">
                  {formatDate(a.createdAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <UnrejectButton id={a.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Update `app/admin/rejections/page.tsx`**

Replace the entire file:

```typescript
// app/admin/rejections/page.tsx
import { prisma } from "@/src/lib/prisma";
import { RejectionsTable } from "./RejectionsClient";

export const dynamic = "force-dynamic";

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
        <RejectionsTable rejections={rejections} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Navigate to `/news/admin/rejections`. Each row now has an "Un-reject" button. Click one — the row disappears from the list (page revalidates) and the article is now `isPositive: true` with `curatedAt` set, so it will appear in the public feed.

- [ ] **Step 5: Commit**

```bash
git add app/admin/rejections/actions.ts app/admin/rejections/RejectionsClient.tsx app/admin/rejections/page.tsx
git commit -m "feat(admin): add un-reject action to rejections page"
```

---

## Task 4: Flagged page — Unflag action

**Files:**
- Create: `app/admin/flagged/actions.ts`
- Create: `app/admin/flagged/FlaggedClient.tsx`
- Modify: `app/admin/flagged/page.tsx`

- [ ] **Step 1: Create `app/admin/flagged/actions.ts`**

```typescript
"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/src/lib/prisma";

async function requireAdmin() {
  const session = await auth();
  if (!session) redirect("/admin/login");
}

export async function unflagArticle(id: string): Promise<void> {
  await requireAdmin();
  await prisma.article.update({
    where: { id },
    data: {
      flaggedAt: null,
      isPositive: true,
      curatedAt: new Date(),
    },
  });
  revalidatePath("/admin/flagged");
}
```

- [ ] **Step 2: Create `app/admin/flagged/FlaggedClient.tsx`**

Note: `extractKeywords` is a pure function (no DB or server imports) so it is safe to call in a client component.

```typescript
"use client";

import { useTransition } from "react";
import { extractKeywords } from "@/src/lib/keywords";
import { unflagArticle } from "./actions";

interface FlaggedArticle {
  id: string;
  title: string;
  flaggedAt: Date | null;
  source: { name: string; language: string };
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UnflagButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => unflagArticle(id))}
      disabled={isPending}
      className="rounded border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:bg-transparent dark:border-emerald-800 dark:text-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap"
    >
      {isPending ? "…" : "Unflag"}
    </button>
  );
}

export function FlaggedTable({ articles }: { articles: FlaggedArticle[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
            <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Keywords extracted</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Flagged</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {articles.map((a, i) => {
            const keywords = extractKeywords(a.title, a.source.language ?? "en");
            return (
              <tr
                key={a.id}
                className={`border-b border-border/60 last:border-0 ${
                  i % 2 === 0 ? "" : "bg-background/50"
                }`}
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
                  {a.flaggedAt ? formatDate(a.flaggedAt) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <UnflagButton id={a.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Update `app/admin/flagged/page.tsx`**

Replace the entire file:

```typescript
// app/admin/flagged/page.tsx
import { prisma } from "@/src/lib/prisma";
import { FlaggedTable } from "./FlaggedClient";

export const dynamic = "force-dynamic";

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
        <FlaggedTable articles={flagged} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Navigate to `/news/admin/flagged`. Each row now has an "Unflag" button. Click one — the row disappears and the article re-enters the feed (`isPositive: true`, `flaggedAt: null`, `curatedAt` set). Keyword hit counts are intentionally not rolled back.

- [ ] **Step 5: Commit**

```bash
git add app/admin/flagged/actions.ts app/admin/flagged/FlaggedClient.tsx app/admin/flagged/page.tsx
git commit -m "feat(admin): add unflag action to flagged page"
```
