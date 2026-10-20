import { APIConnectionError, APIError } from "@typesafe-ai/sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { DEFAULT_THRESHOLDS, deriveVerdict, evaluateArticle, QUESTION_SET, type JevThresholds } from "../jev";
import { isFatalJevError, isUniqueViolation, runPool } from "../jev-pool";
import { budgetMs, requestTimeoutMs } from "./config";
import type { ArticleInput, CurationResult } from "./types";

function threshold(name: string, defaultValue: number): number {
  const value = Number(process.env[name]?.trim() || defaultValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${name}`);
  return value;
}

export function jevThresholds(): JevThresholds {
  return {
    positiveMin: threshold("JEV_KEEP_POSITIVE_THRESHOLD", DEFAULT_THRESHOLDS.positiveMin),
    upliftingMin: threshold("JEV_KEEP_UPLIFTING_THRESHOLD", DEFAULT_THRESHOLDS.upliftingMin),
    categoryMax: threshold("JEV_CATEGORY_VETO_THRESHOLD", DEFAULT_THRESHOLDS.categoryMax),
  };
}

/** Same rule as the admin Jev report (deriveVerdict), with env-overridable thresholds. */
export function jevDecision(data: { positiveP: number; upliftingP: number; topCategory: string; topCategoryP: number }) {
  return deriveVerdict(data, jevThresholds());
}

export function jevKeep(data: { positiveP: number; upliftingP: number; topCategory: string; topCategoryP: number }): boolean {
  return jevDecision(data).keep;
}

export async function curateJev(articles: ArticleInput[], deadline = Date.now() + budgetMs()): Promise<CurationResult[]> {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
  const thresholds = jevThresholds(); // fail the provider once, before any paid evaluation
  const results: CurationResult[] = [];
  let availabilityFailures = 0;
  await runPool(articles, 5, async (article) => {
    try {
      let data = await prisma.jevEvaluation.findUnique({ where: { articleId_questionSet: { articleId: article.id, questionSet: QUESTION_SET } } });
      if (!data) {
        const evaluated = await evaluateArticle(article, { timeout: requestTimeoutMs(deadline), retry: { maxRetries: 0 } });
        try {
          data = await prisma.jevEvaluation.create({ data: { ...evaluated, articleId: article.id, questionSet: QUESTION_SET, answers: evaluated.answers as Prisma.InputJsonValue } });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          data = await prisma.jevEvaluation.findUniqueOrThrow({ where: { articleId_questionSet: { articleId: article.id, questionSet: QUESTION_SET } } });
        }
      }
      availabilityFailures = 0;
      const verdict = deriveVerdict(data, thresholds);
      const keep = verdict.keep;
      const reason = `${verdict.reason ?? "jev: keep"} (positive=${data.positiveP.toFixed(2)}, uplifting=${data.upliftingP.toFixed(2)}, ${data.topCategory}=${data.topCategoryP.toFixed(2)})`;
      results.push({ id: article.id, isPositive: keep, reason, pass: 2, outcome: keep ? "judged_keep" : "judged_reject", source: "jev", model: data.model });
    } catch (err) {
      console.error(`[curator] Jev failed for ${article.id}`, err);
      throw err;
    }
  }, (err) => {
    const unavailable = err instanceof APIConnectionError || (err instanceof APIError && err.status >= 500);
    availabilityFailures = unavailable ? availabilityFailures + 1 : 0;
    return isFatalJevError(err) || availabilityFailures >= 2;
  }, deadline);
  return results;
}
