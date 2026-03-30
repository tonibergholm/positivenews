import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { extractKeywords } from "@/src/lib/keywords";

export const dynamic = "force-dynamic";

const ACTIVATION_THRESHOLD = 3;

// Use `as any` for new schema fields — resolves after `prisma generate` on deploy
const db = prisma as any;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const article = await prisma.article.findUnique({
    where: { id },
    include: { source: { select: { language: true } } },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }

  // Mark article as not positive
  await db.article.update({
    where: { id },
    data: { isPositive: false, flaggedAt: new Date() },
  });

  // Extract keywords and upsert into learned keywords
  const language = article.source.language;
  const keywords = extractKeywords(article.title, language);

  for (const keyword of keywords) {
    const existing = await db.learnedKeyword.findUnique({
      where: { keyword },
    });

    if (existing) {
      const newHits = existing.hits + 1;
      await db.learnedKeyword.update({
        where: { keyword },
        data: {
          hits: newHits,
          active: newHits >= ACTIVATION_THRESHOLD,
        },
      });
    } else {
      await db.learnedKeyword.create({
        data: { keyword, language, hits: 1, active: false },
      });
    }
  }

  return NextResponse.json({ success: true });
}
