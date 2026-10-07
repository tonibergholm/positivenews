/**
 * Laya shadow evaluation. Runs on its own schedule (not inside runPipeline),
 * stores answers per article and checkpoint, never changes feed state.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { contractHash, layaEvaluateBatch, layaHealth } from "./laya";
import { isTestCohort } from "./labels";
import { isUniqueViolation } from "./jev-pool";
import { FEED_SOURCES } from "@/src/config/sources";

export interface LayaStoreRow {
  articleId: string;
  checkpoint: string;
  experimental: boolean;
  keepP: number;
  reason: string;
  reasonP: number;
  answers: Record<string, unknown>;
  latencyMs: number;
}

export interface LayaShadowDeps {
  health: typeof layaHealth;
  evaluate: typeof layaEvaluateBatch;
  loadCandidates: (since: Date, limit: number) => Promise<{ id: string; title: string; summary: string | null }[]>;
  store: (row: LayaStoreRow) => Promise<"stored" | "duplicate">;
  now: () => number;
}

export function isLayaConfigured(): boolean {
  return Boolean(process.env.LAYA_URL);
}

export async function runLayaShadow(
  opts: { url: string; timeoutMs: number; since: Date; limit: number; budgetMs: number; batchSize?: number },
  deps: LayaShadowDeps,
): Promise<{ status: "skipped" | "done"; reason?: string; evaluated: number; failed: number }> {
  const client = { url: opts.url, timeoutMs: opts.timeoutMs };
  try {
    const h = await deps.health(client);
    if (h.contract_hash !== contractHash()) {
      return { status: "skipped", reason: `contract mismatch (server ${h.contract_hash.slice(0, 8)}, app ${contractHash().slice(0, 8)})`, evaluated: 0, failed: 0 };
    }
  } catch (err) {
    return { status: "skipped", reason: `health failed: ${err instanceof Error ? err.message : err}`, evaluated: 0, failed: 0 };
  }

  const candidates = await deps.loadCandidates(opts.since, opts.limit);
  const size = opts.batchSize ?? 8;
  const deadline = deps.now() + opts.budgetMs;
  let evaluated = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i += size) {
    if (deps.now() >= deadline) break;
    const batch = candidates.slice(i, i + size);
    const started = deps.now();
    let res;
    try {
      res = await deps.evaluate(batch, client);
    } catch (err) {
      console.error(`[laya] batch failed: ${err instanceof Error ? err.message : err}`);
      break; // server unhealthy (503/timeout): stop this run, retry next schedule
    }
    const latencyMs = Math.round((deps.now() - started) / Math.max(batch.length, 1));
    for (const r of res.results) {
      if ("error" in r) {
        failed++;
        console.error(`[laya] ${r.id}: ${r.error}`);
        continue;
      }
      const { answer } = r;
      const s = await deps.store({ articleId: r.id, checkpoint: answer.checkpoint, experimental: answer.experimental, keepP: answer.keepP, reason: answer.reason, reasonP: answer.reasonP, answers: answer.answers, latencyMs });
      if (s === "stored") evaluated++;
    }
  }
  return { status: "done", evaluated, failed };
}

const trustedUrls = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url);

export async function layaShadowEvaluate(opts: { since: Date; limit: number; budgetMs: number }) {
  const url = process.env.LAYA_URL;
  if (!url) return { status: "skipped" as const, reason: "LAYA_URL unset", evaluated: 0, failed: 0 };
  const timeoutMs = Number.parseInt(process.env.LAYA_TIMEOUT_MS ?? "30000", 10) || 30000;
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
      const cohortPool = await prisma.article.findMany({
        where: { labelEvents: { some: { source: "admin" } }, ...notDone },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, title: true, summary: true },
      });
      const cohort = cohortPool.filter((a) => isTestCohort(a.id));
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
  else console.log(`[laya] shadow done — ${result.evaluated} evaluated, ${result.failed} failed`);
  return result;
}
