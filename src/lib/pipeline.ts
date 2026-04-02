import { curateUnchecked } from "./curate";
import { ingestAll } from "./ingest";

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
    const ingestResult = await ingestAll();
    const curationResult = await curateUnchecked();

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
