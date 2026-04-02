# Adaptive Filtering & Admin Panel — Design Spec

## Goal

Make the filtering pipeline smarter with minimal ongoing user intervention, and add a protected admin panel for oversight and correction.

## Problems Being Solved

1. **Keywords can be poisoned** — 3 flags from any single IP activates a keyword
2. **Keywords never deactivate** — stale or mistaken keywords stay forever
3. **Rejection reasons are lost** — the LLM explains every decision but we discard it
4. **No admin visibility** — no way to see what got rejected, why, or what the filter learned

---

## Architecture Overview

```
Public site (unchanged)
/  /sources  /stats  /privacy  /terms

Admin area (new) — protected by NextAuth middleware
/admin            Dashboard
/admin/login      Login page
/admin/keywords   Learned keyword management
/admin/rejections LLM + keyword rejection log
/admin/flagged    User-flagged articles log
```

### Key principles
- Middleware (`middleware.ts`) enforces auth at the edge for all `/admin/*` routes
- Admin pages are React Server Components — data fetched server-side, no client fetching overhead
- Mutations (activate/deactivate/delete keyword) go through dedicated API routes under `/api/admin/*`
- Public site and pipeline are entirely unaffected

---

## 1. Auth

**Library:** NextAuth v5 (`next-auth@beta`)

**Provider:** `CredentialsProvider` with email + bcrypt password

**Env vars:**
```
ADMIN_EMAIL=toni@example.com
ADMIN_PASSWORD_HASH=<bcrypt hash>
```

Generate hash once: `node -e "require('bcryptjs').hash('yourpassword', 10).then(console.log)"`

**Files:**
- `auth.ts` (project root) — NextAuth config, `CredentialsProvider`, JWT session strategy, 8h expiry
- `middleware.ts` (project root) — redirects unauthenticated requests to `/admin/login`; excludes `/admin/login` itself from protection

**Session:** JWT stored in `next-auth.session-token` cookie (httpOnly, secure). No DB session table needed.

**Scaling path:** When multiple admins are needed, replace `CredentialsProvider` with GitHub/Google OAuth or add a `User` DB model. Middleware and admin UI are unchanged.

---

## 2. Smarter Keyword Learning

### Problem
Current threshold (3 hits from any IPs) is trivially bypassable. A single user can activate a keyword.

### New activation rule
`hits ≥ KEYWORD_MIN_HITS (default 5) AND uniqueIps ≥ KEYWORD_MIN_IPS (default 2)`

Both thresholds configurable via env vars without code deploys.

### New table: `LearnedKeywordFlag`
Tracks which IPs have contributed to each keyword — prevents double-counting.

```prisma
model LearnedKeywordFlag {
  id       String   @id @default(cuid())
  keyword  String
  language String
  ip       String
  createdAt DateTime @default(now())

  @@unique([keyword, language, ip])
}
```

### Changes to `LearnedKeyword`
```prisma
model LearnedKeyword {
  // existing fields unchanged
  uniqueIps  Int       @default(0)   // distinct IPs that have flagged this keyword
  lastHitAt  DateTime?               // updated on every flag, used for staleness
}
```

### Flag route changes (`app/api/articles/[id]/flag/route.ts`)
On each flag:
1. Attempt to insert `LearnedKeywordFlag(keyword, language, ip)` — unique constraint prevents duplicates
2. If insert succeeds (new IP for this keyword): increment `uniqueIps` on `LearnedKeyword`
3. Always increment `hits` and update `lastHitAt`
4. Auto-activate if `hits >= KEYWORD_MIN_HITS && uniqueIps >= KEYWORD_MIN_IPS`

### Auto-activation of pending keywords (no-action path)
If a keyword reaches the threshold but the admin never reviews it, it auto-activates after 7 days. This ensures the system keeps working automatically — admin review is an override, not a requirement.

Implementation: pipeline staleness check also queries for keywords where `active = false AND hits >= KEYWORD_MIN_HITS AND uniqueIps >= KEYWORD_MIN_IPS AND updatedAt < now - 7 days` and activates them.

### Auto-deactivation (staleness)
At the start of each pipeline run (`pipeline.ts`), deactivate keywords where:
- `active = true`
- `lastHitAt < now - 30 days`

Deactivated keywords appear in the admin "Stale" section and can be re-activated manually.

### Classifier unchanged
`classifier.ts` already reads active learned keywords from DB/Redis. No changes needed there.

---

## 3. Rejection Reason Storage

### Schema additions to `Article`
```prisma
rejectionReason  String?   // human-readable: "keyword: missile" or LLM reason text
rejectionPass    Int?      // 0 = keyword filter, 1 = LLM pass 1, 2 = LLM pass 2
```

### Keyword filter (`src/lib/classifier.ts`)
Change `classifyPositive()` return type from `boolean` to `{ positive: boolean; reason?: string }`.
- On rejection: `reason = "keyword: <matched_stem>"`
- On pass: `reason` is undefined

Update `classifyPositiveSync()` similarly (used only in backfill scripts).

### Ingest (`src/lib/ingest.ts`)
After calling `classifyPositive()`, if rejected: write `rejectionReason` and `rejectionPass: 0` to the article.

### Curate (`src/lib/curate.ts`)
`curateArticles()` already returns `CurationResult[]` with `reason` and `pass`. After batch completes, update rejected articles with `rejectionReason` and `rejectionPass`.

---

## 4. Admin Panel

### Layout
Top navigation bar (consistent with public site header), same design tokens (Tailwind classes, dark mode support). No Fraunces headings — clean table-focused UI.

### Navigation
```
[⚡ Admin]  Dashboard  Keywords (badge)  Rejections  Flagged  [Sign out]
```
Badge on Keywords shows count of pending keywords (hits threshold reached, awaiting review).

---

### Page: Dashboard `/admin`

Three stat cards:
- **Pending keywords** — count of keywords meeting threshold but not yet activated
- **Stale keywords** — count auto-deactivated in last 7 days
- **Flagged today** — count of user flags in last 24h

Recent activity list: last 10 user-flagged articles (title, source, time ago).

---

### Page: Keywords `/admin/keywords`

Three sections:

**Pending activation** (amber badge with count)
Table: keyword | language | hits | unique IPs | [Activate] [Dismiss]
- Footnote: "Auto-activates after 7 days if not reviewed."
- Dismiss = permanently delete the keyword entry (not enough signal)
- Activate = force-activate immediately

**Active** (count)
Table: keyword | language | hits | last hit | [Deactivate]
Filter input for searching large lists.

**Stale / deactivated** (count, dimmed)
Table: keyword | language | last hit | [Re-activate]

---

### Page: Rejections `/admin/rejections`

Last 300 rejected articles, most recent first.

Table: title (truncated) | source | pass (Keyword / LLM-1 / LLM-2) | reason | date

Pass column uses colored badges:
- `Keyword` — gray
- `LLM-1` — amber
- `LLM-2` — orange

Useful for spotting: sources with abnormally high rejection rates, recurring false positives, LLM reason patterns.

---

### Page: Flagged `/admin/flagged`

Last 300 user-flagged articles, most recent first.

Table: title | source | flagged at | extracted keywords (chips)

This is the raw signal for what the LLM is incorrectly approving. Admin can use this to spot patterns and manually update `SHARED_REJECTION_RULES` in `llm-curator.ts`.

---

## 5. API Routes (Admin Mutations)

All under `/api/admin/*`, session-checked via `auth()` from NextAuth.

| Route | Method | Action |
|-------|--------|--------|
| `/api/admin/keywords/[id]/activate` | POST | Set `active: true` |
| `/api/admin/keywords/[id]/deactivate` | POST | Set `active: false` |
| `/api/admin/keywords/[id]` | DELETE | Delete keyword + its flags |

After any keyword mutation: invalidate Redis cache for that language.

---

## 6. Schema Migration Summary

```prisma
model Article {
  // add:
  rejectionReason  String?
  rejectionPass    Int?
}

model LearnedKeyword {
  // add:
  uniqueIps  Int       @default(0)
  lastHitAt  DateTime?
}

model LearnedKeywordFlag {
  id        String   @id @default(cuid())
  keyword   String
  language  String
  ip        String
  createdAt DateTime @default(now())
  @@unique([keyword, language, ip])
}
```

One Prisma migration; additive only, no data loss.

---

## 7. File Map

**New files:**
- `auth.ts` — NextAuth config
- `middleware.ts` — edge auth guard
- `app/admin/layout.tsx` — top nav, session provider
- `app/admin/page.tsx` — dashboard (RSC)
- `app/admin/login/page.tsx` — login form
- `app/admin/keywords/page.tsx` — keywords management (RSC)
- `app/admin/rejections/page.tsx` — rejection log (RSC)
- `app/admin/flagged/page.tsx` — flagged articles (RSC)
- `app/api/admin/keywords/[id]/activate/route.ts`
- `app/api/admin/keywords/[id]/deactivate/route.ts`
- `app/api/admin/keywords/[id]/route.ts` (DELETE)

**Modified files:**
- `prisma/schema.prisma` — schema additions above
- `src/lib/classifier.ts` — return `{ positive, reason? }` instead of `boolean`
- `src/lib/ingest.ts` — write `rejectionReason` / `rejectionPass: 0`
- `src/lib/curate.ts` — write `rejectionReason` / `rejectionPass` for LLM rejections
- `src/lib/pipeline.ts` — run keyword staleness check at pipeline start
- `app/api/articles/[id]/flag/route.ts` — track `LearnedKeywordFlag`, update `uniqueIps` / `lastHitAt`, new activation threshold

---

## Out of Scope

- LLM prompt auto-editing (can be added later once flagged article data accumulates)
- Source management UI (isActive toggle) — separate project
- Multi-user admin (env-var credentials sufficient for now)
- Pagination on admin tables (last 300 rows, sufficient for a personal tool)
