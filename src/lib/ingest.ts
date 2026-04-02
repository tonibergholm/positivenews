import Parser from "rss-parser";
import { prisma } from "./prisma";
import { classifyPositive } from "./classifier";
import { FEED_SOURCES, type FeedSource } from "@/src/config/sources";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "PositiveNews/1.0 (+https://github.com)" },
});

function normalizeHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

function parsePublishedAt(item: Parser.Item): Date | null {
  const raw = item.isoDate ?? item.pubDate;
  if (!raw) return new Date();

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function upsertSource(feed: FeedSource): Promise<string> {
  const source = await prisma.source.upsert({
    where: { url: feed.url },
    update: {
      name: feed.name,
      category: feed.category,
      // isActive: true is intentional — sources inactive in the config
      // never reach upsertSource (filtered by ingestAll). The DB column
      // reflects "was processed at least once" and resets on each run.
      isActive: true,
    },
    create: {
      name: feed.name,
      url: feed.url,
      category: feed.category,
      language: feed.language,
    },
  });
  return source.id;
}

function extractImageUrl(item: Parser.Item & Record<string, unknown>): string | null {
  // Try media:content or enclosure
  const media = item["media:content"] as { $?: { url?: string } } | undefined;
  if (media?.$?.url) return normalizeHttpUrl(media.$.url);

  const enclosure = item.enclosure as { url?: string } | undefined;
  if (enclosure?.url?.match(/\.(jpe?g|png|webp|gif)/i)) {
    return normalizeHttpUrl(enclosure.url);
  }

  // Try to extract first img from content
  const content = (item["content:encoded"] as string | undefined) ?? item.content ?? "";
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) return normalizeHttpUrl(match[1]);

  return null;
}

async function ingestFeed(feed: FeedSource): Promise<number> {
  let sourceId: string;
  try {
    sourceId = await upsertSource(feed);
  } catch (err) {
    console.error(`[ingest] Failed to upsert source ${feed.name}:`, err);
    return 0;
  }

  let parsed: Parser.Output<Record<string, unknown>>;
  try {
    parsed = await parser.parseURL(feed.url);
  } catch (err) {
    console.error(`[ingest] Failed to fetch feed "${feed.name}": ${err}`);
    return 0;
  }

  let saved = 0;

  for (const item of parsed.items ?? []) {
    const rawUrl = normalizeHttpUrl(item.link ?? item.guid);
    const title = item.title;
    if (!rawUrl || !title) continue;
    const publishedAt = parsePublishedAt(item);
    if (!publishedAt) continue;

    const url = rawUrl;
    const safeTitle = title.slice(0, 500);

    const summary =
      item.contentSnippet?.slice(0, 500) ??
      item.summary?.slice(0, 500) ??
      null;

    const imageUrl = extractImageUrl(item as Parser.Item & Record<string, unknown>);

    try {
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
    } catch (error) {
      // Duplicate URLs are expected across repeated ingest runs.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      ) {
        continue;
      }

      console.error(`[ingest] Failed to save article from ${feed.name}:`, error);
    }
  }

  console.log(`[ingest] ${feed.name}: saved ${saved} articles`);
  return saved;
}

export async function ingestAll(): Promise<{ total: number; errors: string[] }> {
  const errors: string[] = [];

  const activeSources = FEED_SOURCES.filter((f) => f.isActive !== false);

  const results = await Promise.allSettled(
    activeSources.map(async (feed) => {
      try {
        return await ingestFeed(feed);
      } catch (err) {
        errors.push(`${feed.name}: ${err}`);
        return 0;
      }
    })
  );

  const total = results.reduce(
    (acc, r) => acc + (r.status === "fulfilled" ? r.value : 0),
    0
  );

  console.log(`[ingest] Done — ${total} articles ingested`);
  return { total, errors };
}
