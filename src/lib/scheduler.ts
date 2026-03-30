import cron from "node-cron";
import { ingestAll } from "./ingest";
import { curateUnchecked } from "./curate";

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  // Run every 15 minutes: ingest then curate
  cron.schedule("*/15 * * * *", async () => {
    console.log("[scheduler] Running scheduled feed ingestion…");
    await ingestAll();
    console.log("[scheduler] Running LLM curation…");
    await curateUnchecked();
  });

  console.log("[scheduler] Feed ingestion + LLM curation scheduled every 15 minutes");
}
