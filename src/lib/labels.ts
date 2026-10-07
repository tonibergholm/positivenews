/**
 * Label vocabulary and pure label logic for the self-learning filter.
 *
 * LabelEvent rows are an append-only record of judgements. These helpers
 * decide which admin decision is current, which articles form the
 * held-out test cohort, and what single training label an article gets.
 */

import { createHash } from "node:crypto";

export const LABEL_SOURCES = ["reader_flag", "admin", "ollama", "keyword"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const VERDICTS = ["keep", "reject", "retract"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REVIEW_BUCKETS = ["flagged", "leak", "miss", "cohort", "manual"] as const;
export type ReviewBucket = (typeof REVIEW_BUCKETS)[number];

/** Provisional; piece 3 recalibrates these from scoreboard precision. */
export const TIER_WEIGHTS = { gold: 1, flag: 0.5, ollama: 0.4, keyword: 0.3 } as const;
export type LabelTier = "gold" | "flag" | "weak";

/** Article.rejectionPass value for admin rejections (0 keyword, 1–2 Ollama). */
export const ADMIN_REJECTION_PASS = 3;

export interface LabelEventLike {
  id: string;
  source: string;
  verdict: string;
  category: string | null;
  eligible: boolean;
  bucket: string | null;
  retractsId: string | null;
  createdAt: Date;
}

/** ~10% of articles, chosen by hash, never used for training. */
export function isTestCohort(articleId: string): boolean {
  return createHash("sha256").update(articleId).digest().readUInt32BE(0) % 10 === 0;
}

function byTime(a: LabelEventLike, b: LabelEventLike): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function latest<E extends LabelEventLike>(events: E[]): E | null {
  return events.length === 0 ? null : [...events].sort(byTime)[events.length - 1];
}

/** The newest admin keep/reject that has not been retracted. */
export function currentAdminAuthority<E extends LabelEventLike>(events: E[]): E | null {
  const retracted = new Set(
    events
      .filter((e) => e.source === "admin" && e.verdict === "retract" && e.retractsId)
      .map((e) => e.retractsId as string),
  );
  return latest(
    events.filter(
      (e) => e.source === "admin" && (e.verdict === "keep" || e.verdict === "reject") && !retracted.has(e.id),
    ),
  );
}

export interface ResolvedLabel {
  label: "keep" | "reject";
  category: string | null;
  tier: LabelTier;
  weight: number;
  split: "train" | "test";
  bucket: string | null;
}

export function resolveLabel(articleId: string, events: LabelEventLike[]): ResolvedLabel | null {
  const split = isTestCohort(articleId) ? "test" : "train";

  const admin = currentAdminAuthority(events);
  if (admin) {
    return {
      label: admin.verdict as "keep" | "reject",
      category: admin.category,
      tier: "gold",
      weight: TIER_WEIGHTS.gold,
      split,
      bucket: admin.bucket,
    };
  }

  const usable = events.filter((e) => e.eligible);

  if (usable.some((e) => e.source === "reader_flag")) {
    return { label: "reject", category: null, tier: "flag", weight: TIER_WEIGHTS.flag, split, bucket: null };
  }

  const ollama = latest(usable.filter((e) => e.source === "ollama" && (e.verdict === "keep" || e.verdict === "reject")));
  if (ollama) {
    return { label: ollama.verdict as "keep" | "reject", category: null, tier: "weak", weight: TIER_WEIGHTS.ollama, split, bucket: null };
  }

  if (usable.some((e) => e.source === "keyword")) {
    return { label: "reject", category: null, tier: "weak", weight: TIER_WEIGHTS.keyword, split, bucket: null };
  }

  return null;
}
