/**
 * Concurrency and error helpers for Jev shadow runs. Kept free of Prisma
 * so they can be unit-tested without a database.
 */

import { APIError } from "@typesafe-ai/sdk";

/**
 * Runs fn over items with at most `concurrency` calls in flight. A failing
 * item is counted and the run continues; a fatal error stops new items
 * from starting (in-flight ones still finish). Once `deadline` (epoch ms)
 * passes, no new items start either and `timedOut` reports the leftovers.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  isFatal: (err: unknown) => boolean,
  deadline?: number,
): Promise<{ succeeded: number; failed: number; aborted: boolean; timedOut: boolean }> {
  let next = 0;
  let succeeded = 0;
  let failed = 0;
  let aborted = false;
  let timedOut = false;

  async function worker(): Promise<void> {
    while (!aborted && next < items.length) {
      if (deadline !== undefined && Date.now() >= deadline) {
        timedOut = true;
        return;
      }
      const item = items[next++];
      try {
        await fn(item);
        succeeded++;
      } catch (err) {
        failed++;
        if (isFatal(err)) aborted = true;
      }
    }
  }

  const workers = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return { succeeded, failed, aborted, timedOut };
}

/** Bad key, no permission or unknown model: every later request would fail the same way. */
export function isFatalJevError(err: unknown): boolean {
  return err instanceof APIError && (err.status === 401 || err.status === 403 || err.status === 404);
}

export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && "code" in (err as object) && (err as { code: unknown }).code === "P2002";
}
