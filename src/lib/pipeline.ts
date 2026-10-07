import { curateUnchecked } from "./curate";
import { ingestAll } from "./ingest";
import { deactivateStaleKeywords, activatePendingKeywords } from "./keywords-maintenance";
import { shadowEvaluate } from "./jev-shadow";

const JEV_SHADOW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const JEV_SHADOW_LIMIT = 100;

interface PipelineResult {
  total: number;
  errors: string[];
  curation: {
    curated: number;
    rejected: number;
    skipped: number;
  };
}

let pipelineRun: Promise<PipelineResult> | null = null;

export async function runPipeline(): Promise<PipelineResult> {
  if (pipelineRun) return pipelineRun;

  pipelineRun = (async () => {
    // Keyword maintenance runs before ingest so fresh keywords are available
    await deactivateStaleKeywords();
    await activatePendingKeywords();

    const ingestResult = await ingestAll();
    const curationResult = await curateUnchecked();

    // Shadow mode: Jev results are stored for comparison only and must never
    // affect ingest or curation.
    try {
      await shadowEvaluate({
        since: new Date(Date.now() - JEV_SHADOW_WINDOW_MS),
        limit: JEV_SHADOW_LIMIT,
      });
    } catch (err) {
      console.error("[pipeline] Jev shadow evaluation failed:", err);
    }

    return {
      ...ingestResult,
      curation: curationResult,
    };
  })();

  try {
    return await pipelineRun;
  } finally {
    pipelineRun = null;
  }
}

export function isPipelineRunning(): boolean {
  return pipelineRun !== null;
}
