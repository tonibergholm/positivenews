import Parser from "rss-parser";
import { prisma } from "./prisma";
import { classifyPositive } from "./classifier";
import { FEED_SOURCES, type FeedSource } from "@/src/config/sources";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "PositiveNews/1.0 (+https://github.com)" },
});

async function upsertSource(feed: FeedSource): Promise<string> {
  const source = await prisma.source.upsert({
    where: { url: feed.url },
    update: { name: feed.name, category: feed.category, isActive: true },
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
  if (media?.$?.url) return media.$.url;

  const enclosure = item.enclosure as { url?: string } | undefined;
  if (enclosure?.url?.match(/\.(jpe?g|png|webp|gif)/i)) return enclosure.url;

  // Try to extract first img from content
  const content = (item["content:encoded"] as string | undefined) ?? item.content ?? "";
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) return match[1];

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
    const url = item.link ?? item.guid;
    const title = item.title;
    if (!url || !title) continue;

    const publishedAt = item.isoDate
      ? new Date(item.isoDate)
      : item.pubDate
      ? new Date(item.pubDate)
      : new Date();

    const summary =
      item.contentSnippet?.slice(0, 500) ??
      item.summary?.slice(0, 500) ??
      null;

    const imageUrl = extractImageUrl(item as Parser.Item & Record<string, unknown>);

    try {
      const exists = await prisma.article.findUnique({
        where: { url },
        select: { id: true },
      });
      if (exists) continue;

      const isPositive = await classifyPositive(title, summary);

      await prisma.article.create({
        data: {
          title,
          url,
          summary,
          imageUrl,
          publishedAt,
          sourceId,
          category: feed.category,
          isPositive,
        },
      });
      saved++;
    } catch {
      // constraint violation — skip silently
    }
  }

  console.log(`[ingest] ${feed.name}: saved ${saved} articles`);
  return saved;
}

export async function ingestAll(): Promise<{ total: number; errors: string[] }> {
  const errors: string[] = [];
  let total = 0;

  const activeSources = FEED_SOURCES.filter(() => true); // all active

  await Promise.allSettled(
    activeSources.map(async (feed) => {
      try {
        const count = await ingestFeed(feed);
        total += count;
      } catch (err) {
        errors.push(`${feed.name}: ${err}`);
      }
    })
  );

  console.log(`[ingest] Done — ${total} articles ingested`);
  return { total, errors };
}
