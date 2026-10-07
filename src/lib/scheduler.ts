import cron from "node-cron";
import { runPipeline } from "./pipeline";
import { isLayaConfigured, layaShadowEvaluate } from "./laya-shadow";

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  // Run every 15 minutes: ingest then curate
  cron.schedule("*/15 * * * *", async () => {
    console.log("[scheduler] Running scheduled ingest + curation…");
    try {
      await runPipeline();
    } catch (error) {
      console.error("[scheduler] Scheduled run failed:", error);
    }
  });

  // Laya shadow evaluation: own schedule so it never extends the pipeline lock.
  let layaRunning = false;
  cron.schedule("7,22,37,52 * * * *", async () => {
    if (!isLayaConfigured() || layaRunning) return;
    layaRunning = true;
    try {
      await layaShadowEvaluate({ since: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), limit: 80, budgetMs: 120_000 });
    } catch (error) {
      console.error("[scheduler] Laya shadow failed:", error);
    } finally {
      layaRunning = false;
    }
  });

  console.log("[scheduler] Feed ingestion + LLM curation scheduled every 15 minutes");
}
