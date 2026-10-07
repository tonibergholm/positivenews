import { prisma } from "./prisma";
import { QUESTION_SET } from "./jev";
import type { ReportRow } from "./jev-report";

/** Latest evaluations for the current question set, flattened for buildReport. */
export async function loadReportRows(max = 5000): Promise<ReportRow[]> {
  const evaluations = await prisma.jevEvaluation.findMany({
    where: { questionSet: QUESTION_SET },
    orderBy: { createdAt: "desc" },
    take: max,
    select: {
      model: true,
      positiveP: true,
      upliftingP: true,
      topCategory: true,
      topCategoryP: true,
      article: {
        select: {
          id: true,
          title: true,
          createdAt: true,
          curatedAt: true,
          flaggedAt: true,
          rejectionPass: true,
          rejectionReason: true,
          source: { select: { name: true, language: true } },
        },
      },
    },
  });

  return evaluations.map((e) => ({
    articleId: e.article.id,
    title: e.article.title,
    sourceName: e.article.source.name,
    language: e.article.source.language,
    createdAt: e.article.createdAt,
    curatedAt: e.article.curatedAt,
    flaggedAt: e.article.flaggedAt,
    rejectionPass: e.article.rejectionPass,
    rejectionReason: e.article.rejectionReason,
    model: e.model,
    positiveP: e.positiveP,
    upliftingP: e.upliftingP,
    topCategory: e.topCategory,
    topCategoryP: e.topCategoryP,
  }));
}
