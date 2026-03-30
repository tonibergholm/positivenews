import cron from "node-cron";
import { ingestAll } from "./ingest";

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  // Run every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    console.log("[scheduler] Running scheduled feed ingestion…");
    await ingestAll();
  });

  console.log("[scheduler] Feed ingestion scheduled every 15 minutes");
}
