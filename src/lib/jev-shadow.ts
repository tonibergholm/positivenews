/**
 * Jev shadow evaluation.
 *
 * Evaluates recent non-trusted articles that have no JevEvaluation for the
 * current question set and stores the answers. Never changes Article rows,
 * so live feed decisions are unaffected.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { evaluateArticle, isJevConfigured, QUESTION_SET, type JevEvaluationData } from "./jev";
import { isFatalJevError, isUniqueViolation, runPool } from "./jev-pool";
import { FEED_SOURCES } from "@/src/config/sources";

const trustedSourceUrls = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url);

export interface ShadowOptions {
  since: Date;
  limit: number;
  concurrency?: number;
}

export async function shadowEvaluate({
  since,
  limit,
  concurrency = 5,
}: ShadowOptions): Promise<{ evaluated: number; failed: number }> {
  if (!isJevConfigured()) return { evaluated: 0, failed: 0 };

  const articles = await prisma.article.findMany({
    where: {
      createdAt: { gte: since },
      source: { url: { notIn: trustedSourceUrls } },
      jevEvaluations: { none: { questionSet: QUESTION_SET } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, title: true, summary: true },
  });

  if (articles.length === 0) return { evaluated: 0, failed: 0 };

  console.log(`[jev] Evaluating ${articles.length} articles…`);

  const result = await runPool(
    articles,
    concurrency,
    async (article) => {
      let data: JevEvaluationData;
      try {
        data = await evaluateArticle(article);
      } catch (err) {
        console.error(`[jev] Article ${article.id} failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }

      try {
        await prisma.jevEvaluation.create({
          data: {
            articleId: article.id,
            model: data.model,
            questionSet: QUESTION_SET,
            answers: data.answers as Prisma.InputJsonValue,
            positiveP: data.positiveP,
            upliftingP: data.upliftingP,
            upliftScore: data.upliftScore,
            topCategory: data.topCategory,
            topCategoryP: data.topCategoryP,
            inputTokens: data.inputTokens,
            latencyMs: data.latencyMs,
          },
        });
      } catch (err) {
        // Another run (backfill or scheduler) stored this article first.
        if (isUniqueViolation(err)) return;
        console.error(`[jev] Failed to store evaluation for ${article.id}:`, err);
        throw err;
      }
    },
    isFatalJevError,
  );

  if (result.aborted) console.error("[jev] Stopped early after a non-retryable API error");
  console.log(`[jev] Done — ${result.succeeded} evaluated, ${result.failed} failed`);

  return { evaluated: result.succeeded, failed: result.failed };
}
