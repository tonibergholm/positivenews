import { describe, expect, it } from "vitest";
import { bucketOf, DAILY_TARGET, helsinkiDate, QUOTAS, selectNext, startOfHelsinkiDay, type QueueBucket, type QueueCandidate } from "./review-queue";

let seq = 0;
function cand(p: Partial<QueueCandidate>): QueueCandidate {
  seq++;
  return { articleId: `a${seq}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)), flagged: false, inFeed: true, cohort: false, jev: null, ...p };
}
const zero = (): Record<QueueBucket, number> => ({ flagged: 0, leak: 0, miss: 0, cohort: 0 });
const DATE = "2026-10-07";

describe("bucketOf", () => {
  it("applies the bucket rules in order, reserving cohort articles", () => {
    expect(bucketOf(cand({ cohort: true, flagged: true }))).toBe("cohort");
    expect(bucketOf(cand({ flagged: true }))).toBe("flagged");
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0.1 } }))).toBe("leak");
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.9, upliftingP: 0.1, topCategoryP: 0.1 } }))).toBe("leak");
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.9, upliftingP: 0.9, topCategoryP: 0.81 } }))).toBe("leak");
    expect(bucketOf(cand({ inFeed: false, jev: { positiveP: 0.81, upliftingP: 0.81, topCategoryP: 0.29 } }))).toBe("miss");
    expect(bucketOf(cand({ inFeed: false, jev: { positiveP: 0.8, upliftingP: 0.9, topCategoryP: 0.1 } }))).toBeNull();
    expect(bucketOf(cand({ inFeed: true, jev: { positiveP: 0.5, upliftingP: 0.5, topCategoryP: 0.5 } }))).toBeNull();
    expect(bucketOf(cand({ inFeed: true, jev: null }))).toBeNull();
  });
});

describe("selectNext", () => {
  it("serves the cohort every fifth card while it has quota", () => {
    const pool = [
      ...Array.from({ length: 10 }, () => cand({ flagged: true })),
      ...Array.from({ length: 10 }, () => cand({ cohort: true })),
    ];
    const d = zero();
    d.flagged = 4; // 4 decided → the next is the 5th card
    expect(selectNext(pool, d, { date: DATE })?.bucket).toBe("cohort");
    d.flagged = 3;
    expect(selectNext(pool, d, { date: DATE })?.bucket).toBe("flagged");
  });

  it("picks the targeted bucket with most remaining quota, oldest first", () => {
    const oldLeak = cand({ inFeed: true, jev: { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0 }, createdAt: new Date(Date.UTC(2026, 8, 25)) });
    const newLeak = cand({ inFeed: true, jev: { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0 } });
    const flag = cand({ flagged: true });
    const d = zero();
    d.flagged = 5; // flagged has 1 left, leak has 5
    expect(selectNext([newLeak, flag, oldLeak], d, { date: DATE })?.candidate.articleId).toBe(oldLeak.articleId);
  });

  it("passes quota on when a bucket is empty and respects exclude", () => {
    const miss = cand({ inFeed: false, jev: { positiveP: 0.9, upliftingP: 0.9, topCategoryP: 0 } });
    const d = zero();
    d.miss = QUOTAS.miss; // miss quota used up, but it's the only candidate
    expect(selectNext([miss], d, { date: DATE })?.bucket).toBe("miss");
    expect(selectNext([miss], d, { date: DATE, exclude: new Set([miss.articleId]) })).toBeNull();
  });

  it("orders the cohort by a stable per-day hash", () => {
    const pool = Array.from({ length: 20 }, () => cand({ cohort: true }));
    const d = zero();
    d.flagged = 4;
    const a = selectNext(pool, d, { date: DATE })?.candidate.articleId;
    expect(selectNext([...pool].reverse(), d, { date: DATE })?.candidate.articleId).toBe(a);
    const other = selectNext(pool, d, { date: "2026-10-08" })?.candidate.articleId;
    expect(typeof other).toBe("string");
  });

  it("keeps serving after the daily target, in bucket order", () => {
    const pool = [cand({ cohort: true }), cand({ flagged: true })];
    const d: Record<QueueBucket, number> = { flagged: 6, leak: 5, miss: 5, cohort: 4 };
    expect(d.flagged + d.leak + d.miss + d.cohort).toBe(DAILY_TARGET);
    expect(selectNext(pool, d, { date: DATE })?.bucket).toBe("flagged");
  });

  it("breaks createdAt ties by article id, whatever the input order", () => {
    const at = new Date(Date.UTC(2026, 9, 2));
    const jev = { positiveP: 0.1, upliftingP: 0.9, topCategoryP: 0 };
    const x = cand({ articleId: "tie-b", createdAt: at, jev });
    const y = cand({ articleId: "tie-a", createdAt: at, jev });
    expect(selectNext([x, y], zero(), { date: DATE })?.candidate.articleId).toBe("tie-a");
    expect(selectNext([y, x], zero(), { date: DATE })?.candidate.articleId).toBe("tie-a");
  });

  it("ignores candidates that belong to no bucket", () => {
    expect(selectNext([cand({ inFeed: true, jev: null })], zero(), { date: DATE })).toBeNull();
  });
});

describe("Helsinki day", () => {
  it("handles summer (UTC+3) and winter (UTC+2)", () => {
    expect(helsinkiDate(new Date("2026-10-07T21:30:00Z"))).toBe("2026-10-08");
    expect(startOfHelsinkiDay(new Date("2026-10-07T21:30:00Z")).toISOString()).toBe("2026-10-07T21:00:00.000Z");
    expect(startOfHelsinkiDay(new Date("2026-12-01T10:00:00Z")).toISOString()).toBe("2026-11-30T22:00:00.000Z");
  });

  it("uses the offset at midnight on DST transition days", () => {
    expect(startOfHelsinkiDay(new Date("2026-10-25T05:00:00Z")).toISOString()).toBe("2026-10-24T21:00:00.000Z");
    expect(startOfHelsinkiDay(new Date("2027-03-28T10:00:00Z")).toISOString()).toBe("2027-03-27T22:00:00.000Z");
  });
});
