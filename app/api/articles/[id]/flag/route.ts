import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { extractKeywords } from "@/src/lib/keywords";

export const dynamic = "force-dynamic";

const ACTIVATION_THRESHOLD = 3;

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

  // Mark article as not positive
  await prisma.article.update({
    where: { id },
    data: { isPositive: false, flaggedAt: new Date() },
  });

  // Extract keywords and upsert into learned keywords
  const language = article.source.language;
  const keywords = extractKeywords(article.title, language);

  if (keywords.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const keyword of keywords) {
        await tx.learnedKeyword.upsert({
          where: {
            keyword_language: { keyword, language },
          },
          update: {
            hits: { increment: 1 },
          },
          create: { keyword, language, hits: 1, active: false },
        });
      }

      await tx.learnedKeyword.updateMany({
        where: {
          keyword: { in: keywords },
          language,
          hits: { gte: ACTIVATION_THRESHOLD },
          active: false,
        },
        data: { active: true },
      });
    });
  }

  return NextResponse.json({ success: true });
}
