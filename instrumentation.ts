/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Starts the background cron scheduler for feed ingestion.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./src/lib/scheduler");
    startScheduler();
  }
}
