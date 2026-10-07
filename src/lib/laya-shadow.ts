/**
 * Laya shadow evaluation. Runs on its own schedule (not inside runPipeline),
 * stores answers per article and checkpoint, never changes feed state.
 */

import { contractHash, layaEvaluateBatch, layaHealth } from "./laya";

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
): Promise<{ status: "skipped" | "done"; reason?: string; evaluated: number; duplicates: number; failed: number }> {
  const client = { url: opts.url, timeoutMs: opts.timeoutMs };
  let healthCheckpoint = "";
  try {
    const h = await deps.health(client);
    healthCheckpoint = h.checkpoint;
    if (h.contract_hash !== contractHash()) {
      return { status: "skipped", reason: `contract mismatch (server ${h.contract_hash.slice(0, 8)}, app ${contractHash().slice(0, 8)})`, evaluated: 0, duplicates: 0, failed: 0 };
    }
  } catch (err) {
    return { status: "skipped", reason: `health failed: ${err instanceof Error ? err.message : err}`, evaluated: 0, duplicates: 0, failed: 0 };
  }

  const candidates = await deps.loadCandidates(opts.since, opts.limit);
  const size = opts.batchSize ?? 8;
  const deadline = deps.now() + opts.budgetMs;
  let evaluated = 0;
  let duplicates = 0;
  let failed = 0;
  let warnedCheckpoint = false;

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
      if (answer.checkpoint !== healthCheckpoint && !warnedCheckpoint) {
        warnedCheckpoint = true;
        console.warn(`[laya] checkpoint changed mid-run: health ${healthCheckpoint}, response ${answer.checkpoint}`);
      }
      try {
        const s = await deps.store({ articleId: r.id, checkpoint: answer.checkpoint, experimental: answer.experimental, keepP: answer.keepP, reason: answer.reason, reasonP: answer.reasonP, answers: answer.answers, latencyMs });
        if (s === "stored") evaluated++;
        else duplicates++;
      } catch (err) {
        failed++;
        console.error(`[laya] store failed for ${r.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return { status: "done", evaluated, duplicates, failed };
}
