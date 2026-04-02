import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { extractKeywords } from "@/src/lib/keywords";
import redis from "@/src/lib/redis";

export const dynamic = "force-dynamic";

const KEYWORD_MIN_HITS = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
const KEYWORD_MIN_IPS = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);

const flagRateMap = new Map<string, { count: number; resetAt: number }>();
const FLAG_WINDOW_MS = 60_000;
const FLAG_LIMIT = 10;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // CSRF: reject cross-origin POSTs
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Rate limit: 10 flags per IP per minute
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const entry = flagRateMap.get(ip);
  if (!entry || entry.resetAt < now) {
    flagRateMap.set(ip, { count: 1, resetAt: now + FLAG_WINDOW_MS });
  } else if (entry.count >= FLAG_LIMIT) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  } else {
    entry.count++;
  }

  const { id } = await params;

  const article = await prisma.article.findUnique({
    where: { id },
    include: { source: { select: { language: true } } },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }

  if (article.flaggedAt) {
    return NextResponse.json({ success: true, duplicate: true });
  }

  const language = article.source.language;
  const keywords = extractKeywords(article.title, language);

  await prisma.$transaction(async (tx) => {
    const result = await tx.article.updateMany({
      where: { id, flaggedAt: null },
      data: { isPositive: false, flaggedAt: new Date() },
    });

    if (result.count === 0 || keywords.length === 0) return;

    // Upsert keywords: increment hits and lastHitAt
    for (const keyword of keywords) {
      await tx.learnedKeyword.upsert({
        where: { keyword_language: { keyword, language } },
        update: {
          hits: { increment: 1 },
          lastHitAt: new Date(),
        },
        create: { keyword, language, hits: 1, active: false, lastHitAt: new Date() },
      });
    }

    // Record this IP's contribution (skip if already recorded)
    await tx.learnedKeywordFlag.createMany({
      data: keywords.map((keyword) => ({ keyword, language, ip })),
      skipDuplicates: true,
    });

    // Recount uniqueIps from LearnedKeywordFlag for each keyword
    for (const keyword of keywords) {
      const count = await tx.learnedKeywordFlag.count({
        where: { keyword, language },
      });
      await tx.learnedKeyword.update({
        where: { keyword_language: { keyword, language } },
        data: { uniqueIps: count },
      });
    }

    // Auto-activate keywords that meet threshold
    await tx.learnedKeyword.updateMany({
      where: {
        keyword: { in: keywords },
        language,
        hits: { gte: KEYWORD_MIN_HITS },
        uniqueIps: { gte: KEYWORD_MIN_IPS },
        active: false,
      },
      data: { active: true },
    });
  });

  try {
    await redis.del(`learned:keywords:${language}`);
  } catch (err) {
    console.error("[flag] Redis cache invalidation failed:", err);
  }

  return NextResponse.json({ success: true });
}
