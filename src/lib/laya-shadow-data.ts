/**
 * DB-wired Laya shadow evaluation (kept apart from laya-shadow.ts so tests of the
 * pure runner don't import prisma).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { layaEvaluateBatch, layaHealth } from "./laya";
import { runLayaShadow } from "./laya-shadow";
import { isTestCohort } from "./labels";
import { isUniqueViolation } from "./jev-pool";
import { FEED_SOURCES } from "@/src/config/sources";

const trustedUrls = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url);

export async function layaShadowEvaluate(opts: { since: Date; limit: number; budgetMs: number }) {
  const url = process.env.LAYA_URL;
  if (!url) return { status: "skipped" as const, reason: "LAYA_URL unset", evaluated: 0, duplicates: 0, failed: 0 };
  const timeoutMs = (() => {
    const n = Number.parseInt(process.env.LAYA_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 30000;
  })();
  let currentCheckpoint: string | null = null;

  const result = await runLayaShadow({ url, timeoutMs, ...opts }, {
    health: async (c) => {
      const h = await layaHealth(c);
      currentCheckpoint = h.checkpoint;
      return h;
    },
    evaluate: layaEvaluateBatch,
    now: () => Date.now(),
    loadCandidates: async (since, limit) => {
      const notDone = currentCheckpoint ? { layaEvaluations: { none: { checkpoint: currentCheckpoint } } } : {};
      const recent = await prisma.article.findMany({
        where: { createdAt: { gte: since }, source: { url: { notIn: trustedUrls } }, ...notDone },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, title: true, summary: true },
      });
      // All admin-labelled, not-yet-evaluated ids (ids only), filtered to the test cohort in JS,
      // so older cohort articles are never crowded out by a fixed-size pool.
      const labelled = await prisma.article.findMany({
        where: { labelEvents: { some: { source: "admin" } }, ...notDone },
        select: { id: true },
      });
      const cohortIds = labelled.map((a) => a.id).filter(isTestCohort);
      const cohort = cohortIds.length
        ? await prisma.article.findMany({
            where: { id: { in: cohortIds } },
            orderBy: { createdAt: "desc" },
            take: limit,
            select: { id: true, title: true, summary: true },
          })
        : [];
      const seen = new Set<string>();
      return [...cohort, ...recent].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))).slice(0, limit);
    },
    store: async (row) => {
      try {
        await prisma.layaEvaluation.create({ data: { ...row, answers: row.answers as Prisma.InputJsonValue } });
        return "stored";
      } catch (err) {
        if (isUniqueViolation(err)) return "duplicate";
        throw err;
      }
    },
  });
  if (result.status === "skipped") console.warn(`[laya] shadow skipped: ${result.reason}`);
  else console.log(`[laya] shadow done — ${result.evaluated} evaluated, ${result.duplicates} duplicate, ${result.failed} failed`);
  return result;
}
