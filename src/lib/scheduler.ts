import cron from "node-cron";
import { runPipeline } from "./pipeline";

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

  console.log("[scheduler] Feed ingestion + LLM curation scheduled every 15 minutes");
}
