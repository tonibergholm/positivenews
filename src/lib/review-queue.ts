/**
 * Pure selection logic for the admin review queue. Each decision records
 * its bucket, so remaining quotas are derived from today's decisions and
 * the selection stays consistent across reloads and devices.
 */

import { createHash } from "node:crypto";

export const DAILY_TARGET = 20;
export const QUOTAS = { flagged: 6, leak: 5, miss: 5, cohort: 4 } as const;
export type QueueBucket = keyof typeof QUOTAS;
const TARGETED: QueueBucket[] = ["flagged", "leak", "miss"];
const FALLBACK_ORDER: QueueBucket[] = ["flagged", "leak", "miss", "cohort"];
const COHORT_EVERY = 5;

export interface QueueCandidate {
  articleId: string;
  createdAt: Date;
  flagged: boolean;
  inFeed: boolean;
  cohort: boolean;
  jev: { positiveP: number; upliftingP: number; topCategoryP: number } | null;
}

export function bucketOf(c: QueueCandidate): QueueBucket | null {
  if (c.cohort) return "cohort";
  if (c.flagged) return "flagged";
  if (c.jev && c.inFeed && (c.jev.positiveP < 0.2 || c.jev.upliftingP < 0.2 || c.jev.topCategoryP > 0.8)) return "leak";
  if (c.jev && !c.inFeed && c.jev.positiveP > 0.8 && c.jev.upliftingP > 0.8 && c.jev.topCategoryP < 0.3) return "miss";
  return null;
}

function dayHash(articleId: string, date: string): string {
  return createHash("sha256").update(`${articleId}:${date}`).digest("hex");
}

export function selectNext(
  candidates: QueueCandidate[],
  decidedToday: Record<QueueBucket, number>,
  opts: { date: string; exclude?: ReadonlySet<string> },
): { candidate: QueueCandidate; bucket: QueueBucket } | null {
  const groups: Record<QueueBucket, QueueCandidate[]> = { flagged: [], leak: [], miss: [], cohort: [] };
  for (const c of candidates) {
    if (opts.exclude?.has(c.articleId)) continue;
    const b = bucketOf(c);
    if (b) groups[b].push(c);
  }
  for (const b of TARGETED) groups[b].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  groups.cohort.sort((x, y) => (dayHash(x.articleId, opts.date) < dayHash(y.articleId, opts.date) ? -1 : 1));

  const pick = (b: QueueBucket) => (groups[b].length > 0 ? { candidate: groups[b][0], bucket: b } : null);
  const total = (Object.keys(QUOTAS) as QueueBucket[]).reduce((s, b) => s + decidedToday[b], 0);
  const remaining = (b: QueueBucket) => Math.max(0, QUOTAS[b] - decidedToday[b]);

  if (total < DAILY_TARGET) {
    if ((total + 1) % COHORT_EVERY === 0 && remaining("cohort") > 0) {
      const c = pick("cohort");
      if (c) return c;
    }
    const targeted = TARGETED.filter((b) => remaining(b) > 0 && groups[b].length > 0).sort(
      (x, y) => remaining(y) - remaining(x) || TARGETED.indexOf(x) - TARGETED.indexOf(y),
    );
    if (targeted.length > 0) return pick(targeted[0]);
    if (remaining("cohort") > 0) {
      const c = pick("cohort");
      if (c) return c;
    }
  }

  for (const b of FALLBACK_ORDER) {
    const c = pick(b);
    if (c) return c;
  }
  return null;
}

const DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit" });
const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Helsinki",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function helsinkiDate(d: Date): string {
  return DATE_FMT.format(d);
}

/** Midnight Europe/Helsinki of d's Helsinki date (uses d's UTC offset). */
export function startOfHelsinkiDay(d: Date): Date {
  const parts = Object.fromEntries(PARTS_FMT.formatToParts(d).map((p) => [p.type, p.value]));
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offsetMs = wallAsUtc - Math.floor(d.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
}
