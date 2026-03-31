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
LLM Pass 1: Positive/negative classification (gemma3:4b via Ollama)
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

After ingestion, articles that passed keywords go through `gemma3:4b` via local Ollama:

- Inclusion criteria: solutions journalism, scientific breakthroughs, acts of kindness, environmental recovery, cultural/sports triumphs, Finnish "sisu" stories, practical wellness
- Exclusion criteria: war, geopolitics, crime, alarmist headlines, opinion columns, sports non-triumphs, rising costs, filler content, health alarm stories, cancelled events, tech platform problems
- Batched (10 articles per LLM call), temperature 0.1 for consistency
- Fail-open: if Ollama is unavailable, articles are kept

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
- **LLM:** Ollama with gemma3:4b (local, CPU inference)
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
- Ollama with `gemma3:4b` model

### Install

```bash
git clone https://github.com/tonibergholm/positivenews.git
cd positivenews
pnpm install
ollama pull gemma3:4b
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
# OLLAMA_MODEL=gemma3:4b
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
