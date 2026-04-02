import cron from "node-cron";
import { ingestAll } from "./ingest";
import { curateUnchecked } from "./curate";

let started = false;
let running = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  // Run every 15 minutes: ingest then curate
  cron.schedule("*/15 * * * *", async () => {
    if (running) {
      console.warn("[scheduler] Previous run still in progress, skipping this tick");
      return;
    }

    running = true;
    console.log("[scheduler] Running scheduled feed ingestion…");
    try {
      await ingestAll();
      console.log("[scheduler] Running LLM curation…");
      await curateUnchecked();
    } catch (error) {
      console.error("[scheduler] Scheduled run failed:", error);
    } finally {
      running = false;
    }
  });

  console.log("[scheduler] Feed ingestion + LLM curation scheduled every 15 minutes");
}
