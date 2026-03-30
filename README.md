# PositiveNews

A positive news aggregator that collects articles from 23 RSS feeds (English and Finnish), filters out negative content, and presents an uplifting reading experience. Users can flag articles that slip through, teaching the system to improve over time.

## How it works

```
RSS Feeds (23 sources)
    |
    v
Ingestion (every 15 min)
    |
    v
Keyword classifier ──> Negative? ──> Rejected (isPositive=false)
    |
    v
Positive articles shown in UI
    |
    v
User flags article ──> Keywords extracted ──> LearnedKeyword table
                                                   |
                                              3+ hits? ──> Auto-filter future articles
```

### Content filtering

Articles are classified using deterministic keyword matching with Finnish stem awareness:

- **Trusted sources** (Good News Network, Positive News, etc.) skip classification entirely
- **General sources** are checked against negative keyword lists (violence, crime, war, disasters)
- **Finnish compound words** are handled with `includes()` matching (e.g. "tehdaspalo" matches the "palo" stem)
- **Positive overrides** prevent false negatives (e.g. "läpimurto"=breakthrough contains "murto" but is kept)
- **Irrelevant content** like sports scores and car reviews is also filtered
- **Learned keywords** from user feedback are loaded alongside built-in keywords and cached for 5 minutes

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
- **Styling:** Tailwind CSS 4, Base UI components
- **RSS parsing:** rss-parser
- **Scheduling:** node-cron (via Next.js instrumentation hook)
- **Process manager:** PM2

## RSS sources

### English (14 sources)

| Source | Category | Trusted |
|--------|----------|---------|
| Good News Network | Society | Yes |
| Positive News | Society | Yes |
| Reasons to be Cheerful | Society | Yes |
| Upworthy | Society | Yes |
| The Optimist Daily | Society | Yes |
| YES! Magazine | Society | Yes |
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

### Install

```bash
git clone https://github.com/tonibergholm/positivenews.git
cd positivenews
pnpm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/positivenews
INGEST_SECRET=<generate with: openssl rand -hex 32>
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

The feed scheduler starts automatically on server boot via the Next.js instrumentation hook. No separate cron setup needed.

### Initial seed

On first run, wait 15 minutes for the scheduler to trigger, or seed manually:

```bash
pnpm seed
```

### Backfill classifier

To retroactively classify all existing articles:

```bash
pnpm tsx scripts/backfill-classify.ts
```

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

Flags an article as not positive. Rate limited to 10 requests per IP per minute.

### `POST /news/api/ingest`

Triggers a manual feed ingestion. Requires `x-ingest-secret` header.

```bash
curl -X POST https://your-domain.com/news/api/ingest \
  -H "x-ingest-secret: $INGEST_SECRET"
```

## Production deployment

The app is designed to run behind nginx as a reverse proxy:

```
Client --> nginx (SSL, /news) --> PM2 (port 3001) --> Next.js
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
  sourceId -> Source, category, isPositive, flaggedAt, createdAt

LearnedKeyword
  id, keyword (unique), language, hits, active
```

## License

MIT
