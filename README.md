# PositiveNews

A positive news aggregator that collects articles from 25 RSS feeds (English and Finnish), applies a three-tier filtering pipeline to remove negative content, and presents an uplifting reading experience. Users can flag articles that slip through, teaching the system to improve over time.

Live at **bergholm.net/news**

## How it works

```
RSS Feeds (25 sources, every 15 min)
    │
    ▼
Keyword pre-filter (instant) ──► Negative? ──► Rejected
    │
    ▼
LLM Pass 1: Positive/negative classification (configured provider)
    │                                              │
    │                                              ▼
    │                                         Negative? ──► Rejected
    ▼
LLM Pass 2: Strict quality filter (catches marketing fluff)
    │                                              │
    │                                              ▼
    │                                         Low quality? ──► Rejected
    ▼
Approved articles shown in UI (curatedAt timestamp set)
    │
    ▼
User flags article ──► Keywords extracted ──► LearnedKeyword table
                                                   │
                                              3+ hits? ──► Auto-filter future articles
```

### Three-tier content filtering

#### Tier 1: Keyword pre-filter (during ingest)

Fast, deterministic keyword matching runs during RSS ingestion:

- **Trusted sources** (6 curated positive-news outlets) skip all filtering
- **Finnish compound words** handled with `includes()` matching (e.g. "tehdaspalo" matches "palo")
- **English** uses `startsWith()` stem matching
- **Positive overrides** prevent false negatives (e.g. "läpimurto"=breakthrough contains "murto")
- **Negative categories:** violence, crime, war, drones/military, geopolitics, sports scores/roster moves, cost complaints, inflation, labor disputes, court verdicts, police investigations, layoffs, discrimination, puzzles/filler, product reviews
- **Learned keywords** from user feedback auto-activate at 3 hits

#### Tier 2: LLM positive/negative classification (post-ingest)

With OpenAI or Ollama selected, articles that passed keywords go through two passes:

- Inclusion criteria: solutions journalism, scientific breakthroughs, acts of kindness, environmental recovery, cultural/sports triumphs, Finnish "sisu" stories, practical wellness
- Exclusion criteria: war, geopolitics, crime, alarmist headlines, opinion columns, sports non-triumphs, rising costs, filler content, health alarm stories, cancelled events, tech platform problems
- Batched (10 articles per LLM call), temperature 0.1 for consistency
- Failed calls try the configured fallback, then leave articles uncurated for retry

#### Tier 3: LLM strict quality filter

Articles that pass tier 2 go through a second, stricter LLM pass:

- Catches marketing disguised as news, CEO puff pieces, product promotions
- Rejects generic business deals, entrepreneurship clickbait, shopping sales
- Rejects environmental loss stories (framed neutrally but still negative)
- Rejects infrastructure hazards, conflict of interest stories, data breaches
- "Would this make someone smile, feel hopeful, or learn something good?" — if not, reject

### User feedback loop

When a user flags an article via the X button on the card:

1. Article is immediately hidden (`isPositive` set to `false`)
2. Significant words are extracted from the title (stop words removed, capped at 20)
3. Each keyword is upserted into the `LearnedKeyword` table with a hit counter
4. When a keyword reaches **3 hits** across different flagged articles, it auto-activates
5. Active learned keywords are applied during future ingestion

## Tech stack

- **Framework:** Next.js 16 with App Router
- **Database:** PostgreSQL with Prisma 7 (driver adapter: `@prisma/adapter-pg`)
- **Curator:** TypeSafe Jev, OpenAI-compatible APIs, or optional local Ollama
- **Styling:** Tailwind CSS 4, shadcn components
- **Typography:** Fraunces (serif headlines), DM Sans (body)
- **RSS parsing:** rss-parser
- **Scheduling:** node-cron (via Next.js instrumentation hook)
- **Process manager:** PM2

## RSS sources

### English (16 sources)

| Source | Category | Trusted |
|--------|----------|---------|
| Good News Network | Society | Yes |
| Positive News | Society | Yes |
| Reasons to be Cheerful | Society | Yes |
| Upworthy | Society | Yes |
| The Optimist Daily | Society | Yes |
| YES! Magazine | Society | Yes |
| Positive.news - Environment | Environment | |
| Science Daily - Health | Health | |
| Science Daily - Science | Science | |
| New Scientist - Health | Health | |
| Popular Science | Science | |
| Mongabay - Conservation | Environment | |
| Fast Company - Innovation | Innovation | |
| The Guardian - Environment | Environment | |
| Wired - Science | Science | |

### Finnish (9 sources)

| Source | Category |
|--------|----------|
| Yle Uutiset | Society |
| Yle Kotimaa | Society |
| Yle Kulttuuri | Society |
| Yle Ulkomaat | Society |
| Helsingin Sanomat | Society |
| Ilta-Sanomat - Tiede | Science |
| Ilta-Sanomat - Terveys | Health |
| Tekniikka&Talous | Innovation |
| Tivi | Innovation |

To add a source, edit `src/config/sources.ts`.

## Setup

### Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL
- Optional Ollama with `llama3.2:1b` model

### Install

```bash
git clone https://github.com/tonibergholm/positivenews.git
cd positivenews
pnpm install
# Only if using Ollama:
ollama pull llama3.2:1b
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/positivenews
INGEST_SECRET=<generate with: openssl rand -hex 32>
# Optional Ollama overrides:
# OLLAMA_URL=http://127.0.0.1:11434
# OLLAMA_MODEL=llama3.2:1b
```

### Database

```bash
npx prisma migrate deploy
```

### Run

```bash
# Development
pnpm dev

# Production
pnpm build
PORT=3001 pnpm start
```

The feed scheduler starts automatically on server boot via the Next.js instrumentation hook. Ingestion and LLM curation run every 15 minutes. No separate cron setup needed.

### Jev shadow evaluation (optional)

With `TYPESAFE_API_KEY` set, every pipeline run also evaluates recent non-trusted articles with [TypeSafe Jev](https://docs.typesafe.ai) and stores the answers in `JevEvaluation`. When another provider is selected, Jev runs in shadow and does not change the feed. With Jev selected as primary, its probabilities decide the feed. Compare it with the Ollama curator at `/news/admin/jev`.

Migrations run automatically during deploy (`prisma migrate deploy`).

```bash
pnpm jev:smoke                          # live check of fixed FI/EN headlines
pnpm jev:backfill --days 30 --limit 500 # evaluate existing articles and print the comparison
```

Bump `QUESTION_SET` in `src/lib/jev.ts` after changing any question so old and new results are not mixed.

### Feed window and cleanup

The public feed only shows articles published in the last 14 days (`FEED_MAX_AGE_DAYS`). Older articles stay in the database as training data. A nightly cron deletes only old articles that have no labels or Jev evaluations and aren't from a trusted source:

```bash
mkdir -p ~/logs
# crontab -e
0 3 * * * cd /home/toni/apps/positivenews && npx tsx scripts/cleanup.ts >> $HOME/logs/positivenews-cleanup.log 2>&1
npx tsx scripts/cleanup.ts --dry-run   # show what would be deleted
```

### Labels and review queue

Every filtering judgement is stored as a `LabelEvent`: keyword rejects, Ollama verdicts, reader flags and admin decisions. Review about 20 articles a day at `/news/admin/review`. Your decisions are final and update the feed. They also train and test the filter: a fixed ~10% test cohort never appears in training exports.

```bash
pnpm labels:backfill                 # one-off: import historical judgements (idempotent)
pnpm labels:export --out labels.jsonl  # train rows → labels.jsonl, test rows → labels.jsonl.test.jsonl
```

Run `pnpm labels:backfill` (with no `--before`) right after the deploy and before the first review.

The unbiased test set is the rows of `<out>.test.jsonl` with `tier = gold` and `bucket = cohort`. Other test rows are cohort articles with weaker labels.

The scoreboard at `/news/admin/jev` ("Against your decisions") rates each source against your reviews.

### Initial seed

On first run, wait 15 minutes for the scheduler to trigger, or seed manually:

```bash
curl -X POST http://localhost:3001/news/api/ingest \
  -H "x-ingest-secret: $INGEST_SECRET"
```

This triggers both ingestion and LLM curation in one call.

## API

All endpoints are under the `basePath` `/news`.

### `GET /news/api/articles`

Returns paginated articles. Only returns articles where `isPositive = true`.

| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Page number (default: 1, max: 1000) |
| `category` | string | Filter by category (Science, Environment, Society, Health, Innovation) |
| `sourceId` | string | Filter by source ID |

### `POST /news/api/articles/:id/flag`

Flags an article as not positive. Rate limited to 10 requests per IP per minute. CSRF origin check enforced.

### `POST /news/api/ingest`

Triggers a manual feed ingestion + LLM curation. Requires `x-ingest-secret` header. Timeout: 300s (LLM inference on CPU is slow).

```bash
curl -X POST https://your-domain.com/news/api/ingest \
  -H "x-ingest-secret: $INGEST_SECRET"
```

## Pages

| Path | Description |
|------|-------------|
| `/news` | Main feed with category filtering, infinite scroll |
| `/news/sources` | All RSS sources with article counts and last ingest time |
| `/news/privacy` | Privacy policy (GDPR compliant) |
| `/news/terms` | Terms of service |

## Production deployment

The app is designed to run behind nginx as a reverse proxy:

```
Client ──► nginx (SSL, /news) ──► PM2 (port 3001) ──► Next.js
                                                        ├── Ollama (localhost:11434)
                                                        └── PostgreSQL
```

Deploy updates:

```bash
cd /path/to/positivenews && \
  git pull && \
  pnpm install --frozen-lockfile && \
  npx prisma migrate deploy && \
  pnpm build && \
  pm2 restart positivenews --update-env
```

## Database schema

```
Source
  id, name, url (unique), category, language, isActive, createdAt
  -> has many Articles

Article
  id, title, url (unique), summary, imageUrl, publishedAt
  sourceId -> Source, category, isPositive, flaggedAt, curatedAt, createdAt

LearnedKeyword
  id, keyword (unique), language, hits, active
```

## Key files

| File | Purpose |
|------|---------|
| `src/lib/classifier.ts` | Keyword pre-filter with Finnish stem awareness |
| `src/lib/llm-curator.ts` | Two-tier Ollama LLM curation (pass 1 + pass 2 prompts) |
| `src/lib/curate.ts` | Post-ingest curation job orchestrator |
| `src/lib/ingest.ts` | RSS ingestion with URL dedup and validation |
| `src/lib/keywords.ts` | Keyword extraction from flagged article titles |
| `src/lib/scheduler.ts` | node-cron scheduler (ingest + curate every 15 min) |
| `src/config/sources.ts` | RSS feed configuration (25 sources, 6 trusted) |
| `DESIGN.md` | Design system (typography, colors, spacing) |

## License

MIT

## Curator providers

`CURATOR_PROVIDER` selects `jev`, `openai`, `ollama`, or `none`. When unset,
it selects Jev if `TYPESAFE_API_KEY` exists, otherwise Ollama if `OLLAMA_URL`
exists, otherwise none. `none` disables automated decisions for untrusted
articles. Trusted sources still receive automatic approval.

Jev keeps an article iff both `positiveP >= JEV_KEEP_POSITIVE_THRESHOLD`
and `upliftingP >= JEV_KEEP_UPLIFTING_THRESHOLD`. Both default to 0.5, matching
the existing report probability thresholds. Primary decisions do not apply the
report's extra category veto. Evaluations are stored before decisions and reused
on retry. The primary Jev provider replaces its shadow pipeline step.

`CURATOR_FALLBACK` accepts `openai`, `ollama`, or `none` and defaults to `none`.
Only articles without valid decisions go to fallback. Failed requests, invalid
verdicts, and timeouts never approve articles. If neither provider decides,
`curatedAt` stays null and no keep/reject label is recorded. The next run retries.
There is currently no retry count or age limit, so permanently failing articles
can retry indefinitely and occupy the 50-article run limit. Monitor skipped logs;
add a persisted retry limit if these failures accumulate.

OpenAI-compatible requests use `CURATOR_OPENAI_API_KEY`,
`CURATOR_OPENAI_BASE_URL`, and `CURATOR_OPENAI_MODEL`. Defaults are Mistral at
`https://api.mistral.ai/v1` with `ministral-8b-2512`, Ministral 3 8B.
For Gemini 2.5 Flash-Lite, set the base to
`https://generativelanguage.googleapis.com/v1beta/openai` and model to
`gemini-2.5-flash-lite`. Scaleway Generative APIs offers an EU option at
`https://api.scaleway.ai/v1`; select a model available there. All use the same
two-pass prompts, JSON output, and temperature 0.1.

Ollama is optional and is contacted only when selected as primary or fallback.
Set `OLLAMA_URL` and optionally `OLLAMA_MODEL`, which defaults to `llama3.2:1b`.
`CURATOR_TIMEOUT_MS` defaults to 30000 per request for all providers.
Laya remains an independent shadow job, skipped when `LAYA_URL` is unset.

For rollout, explicitly retain your current provider while Jev runs in shadow,
compare results on the scoreboard, tune the two probability thresholds, then
switch to `CURATOR_PROVIDER=jev`. The scoreboard uses its fixed default thresholds and category veto; primary
threshold overrides do not change that comparison verdict. Account for both
differences when tuning. Existing
installations with a TypeSafe key select Jev automatically unless they pin the
provider. Keep API keys in deployment secrets, never in version control.

Jev and OpenAI label events retain their provider source. Existing weak-label
training exports consume Ollama verdicts only, so these new providers do not
add automated training labels. Reader and admin labels remain available.
