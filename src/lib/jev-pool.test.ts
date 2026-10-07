import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { isFatalJevError, isUniqueViolation, runPool } from "./jev-pool";

const apiError = (status: number) => APIError.fromResponse(status, {}, new Headers());

describe("runPool", () => {
  it("never exceeds the concurrency limit and processes every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const result = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      inFlight--;
    }, () => false);
    expect(peak).toBeLessThanOrEqual(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result).toEqual({ succeeded: 7, failed: 0, aborted: false, timedOut: false });
  });

  it("counts non-fatal failures and keeps going", async () => {
    const result = await runPool([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 0) throw new Error("boom");
    }, () => false);
    expect(result).toEqual({ succeeded: 2, failed: 2, aborted: false, timedOut: false });
  });

  it("stops starting new items after a fatal error", async () => {
    const started: number[] = [];
    const result = await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1, async (n) => {
      started.push(n);
      if (n === 2) throw apiError(401);
    }, isFatalJevError);
    expect(started).toEqual([1, 2]);
    expect(result).toEqual({ succeeded: 1, failed: 1, aborted: true, timedOut: false });
  });

  it("starts nothing when the deadline has already passed", async () => {
    let started = 0;
    const result = await runPool([1, 2, 3], 2, async () => {
      started++;
    }, () => false, Date.now() - 1);
    expect(started).toBe(0);
    expect(result).toEqual({ succeeded: 0, failed: 0, aborted: false, timedOut: true });
  });

  it("stops starting items once the deadline passes mid-run", async () => {
    let started = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const result = await runPool(items, 1, async () => {
      started++;
      await new Promise((r) => setTimeout(r, 20));
    }, () => false, Date.now() + 30);
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThan(items.length);
    expect(result.timedOut).toBe(true);
    expect(result.succeeded).toBe(started);
  });

  it("reports timedOut false without a deadline", async () => {
    expect((await runPool([1, 2], 1, async () => {}, () => false)).timedOut).toBe(false);
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 5, async () => {}, () => false)).toEqual({ succeeded: 0, failed: 0, aborted: false, timedOut: false });
  });
});

describe("isFatalJevError", () => {
  it("treats auth, permission and not found as fatal", () => {
    for (const status of [401, 403, 404]) expect(isFatalJevError(apiError(status))).toBe(true);
  });

  it("does not treat bad request, unprocessable, rate limits, server errors or generic errors as fatal", () => {
    expect(isFatalJevError(apiError(400))).toBe(false);
    expect(isFatalJevError(apiError(422))).toBe(false);
    expect(isFatalJevError(apiError(429))).toBe(false);
    expect(isFatalJevError(apiError(500))).toBe(false);
    expect(isFatalJevError(new Error("network"))).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  it("detects Prisma P2002 only", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
