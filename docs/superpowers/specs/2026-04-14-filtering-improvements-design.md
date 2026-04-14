# Filtering Improvements — Design Spec
**Date:** 2026-04-14  
**Scope:** Admin action gaps + LLM signal feedback loop

---

## Problem

The admin has read-only views where actions are missing:

- **Rejections page** — no way to un-reject a falsely-rejected article
- **Flagged page** — no way to unflag a falsely-flagged article
- **Keywords page** — no way to add a keyword manually; must wait for user flags to accumulate

Additionally, the LLM writes a `rejectionReason` string for every article it rejects (e.g. `"marketing language"`, `"product launch"`, `"sports roster move"`), but this data is never read back. It is rich signal that could feed the keyword pre-filter automatically.

---

## Approach: Admin Actions + LLM Signal Loop (Approach B)

### 1. Missing admin actions

Three additions, all following the existing `KeywordsClient.tsx` / `actions.ts` pattern.

#### Un-reject (Rejections page)

- New `RejectionsClient.tsx` wraps the existing table rows with interactive buttons.
- New `app/admin/rejections/actions.ts` with `unrejectArticle(id: string)`:
  - Sets `isPositive = true`
  - Clears `rejectionReason = null`, `rejectionPass = null`
  - Sets `curatedAt = new Date()`
  - Requires admin session
  - Revalidates `/admin/rejections`
- The article re-enters the feed immediately (it now has `isPositive = true` and `curatedAt` set).
- No re-scan of old articles; only new incoming articles are affected by filter changes.

#### Unflag (Flagged page)

- New `FlaggedClient.tsx` wraps the flagged table with interactive buttons.
- New `app/admin/flagged/actions.ts` with `unflagArticle(id: string)`:
  - Sets `flaggedAt = null`
  - Sets `isPositive = true`
  - Sets `curatedAt = new Date()`
  - Requires admin session
  - Revalidates `/admin/flagged`
- Keyword hit counts are **not** rolled back. They are approximate signals; admin can manually deactivate any keyword that was wrongly boosted via the Keywords page.

#### Add keyword manually (Keywords page)

- A form at the top of the Keywords page: text input + language selector (`en` / `fi`) + "Add" button.
- New server action `addKeyword(keyword: string, language: string)` in `app/admin/keywords/actions.ts`:
  - Creates `LearnedKeyword` with `active: true`, `hits: 0`, `uniqueIps: 0`
  - If the keyword already exists: returns an error (handled gracefully in the UI)
  - Invalidates Redis keyword caches for the relevant language
  - Revalidates `/admin/keywords`
- The keyword is active immediately — admin intent is explicit.

---

### 2. LLM-derived keyword candidates

#### How it works

At Keywords page render time:
1. Query last 500 LLM-rejected articles (`rejectionPass IN (1, 2)`, last 30 days) — their `rejectionReason` strings.
2. Run each reason through the existing `extractKeywords()` function to tokenize and filter stop words.
3. Count term frequency across all reasons.
4. Filter out: terms already present in `LearnedKeyword` (any state), terms fewer than 3 appearances.
5. Return the top 20 by frequency as candidate suggestions.

#### UI

A new **"LLM-derived candidates"** section on the Keywords page, above "Pending activation." Each candidate shows the term and its frequency count. A one-click "Add to filter" button creates the `LearnedKeyword` as `active: true` immediately (same action as manual add).

#### Constraints

- LLM rejection reasons are always written in English (prompts are English), so all extracted candidates are `language: "en"`. For Finnish filter additions, admin uses the manual "Add keyword" form.
- Minimum frequency threshold: 3 appearances. Below this, the term is not shown.
- No new DB tables or scheduled jobs — purely a read-time computation.

---

## Files to create / modify

| File | Change |
|------|--------|
| `app/admin/keywords/actions.ts` | Add `addKeyword(keyword, language)` action |
| `app/admin/keywords/KeywordsClient.tsx` | Add "Add keyword" form; add LLM candidates section |
| `app/admin/keywords/page.tsx` | Query LLM candidates; pass to client |
| `app/admin/rejections/RejectionsClient.tsx` | New — interactive table with un-reject button |
| `app/admin/rejections/actions.ts` | New — `unrejectArticle(id)` server action |
| `app/admin/rejections/page.tsx` | Import and use `RejectionsClient` |
| `app/admin/flagged/FlaggedClient.tsx` | New — interactive table with unflag button |
| `app/admin/flagged/actions.ts` | New — `unflagArticle(id)` server action |
| `app/admin/flagged/page.tsx` | Import and use `FlaggedClient` |

---

## What is not in scope

- Re-scanning already-approved articles when a keyword activates (new articles only)
- Auto-activating LLM-derived candidates without admin review
- Per-source rejection rate tracking or auto-promoting sources to trusted
- Rolling back keyword hit counts when an article is unflagged
