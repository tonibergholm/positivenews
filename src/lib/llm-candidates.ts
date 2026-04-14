/**
 * Extracts candidate filter keywords from recent LLM rejection reasons.
 *
 * The LLM writes a short English reason for every rejection. This function
 * tokenises those reasons, counts term frequency, filters out terms already
 * in LearnedKeyword, and returns the top candidates for admin review.
 */

import { prisma } from "./prisma";
import { extractKeywords } from "./keywords";

export interface LlmCandidate {
  keyword: string;
  count: number;
}

export async function getLlmCandidates(
  lookbackDays = 30,
  limit = 20,
  minCount = 3
): Promise<LlmCandidate[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rejections = await prisma.article.findMany({
    where: {
      isPositive: false,
      rejectionPass: { in: [1, 2] },
      rejectionReason: { not: null },
      createdAt: { gte: since },
    },
    select: { rejectionReason: true },
    take: 500,
  });

  const termCounts = new Map<string, number>();
  for (const { rejectionReason } of rejections) {
    if (!rejectionReason) continue;
    const terms = extractKeywords(rejectionReason, "en");
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  const existing = new Set(
    (await prisma.learnedKeyword.findMany({ select: { keyword: true } }))
      .map((k) => k.keyword)
  );

  return [...termCounts.entries()]
    .filter(([term, count]) => count >= minCount && !existing.has(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}
