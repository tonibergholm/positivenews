// src/lib/keywords-maintenance.ts
import { prisma } from "./prisma";
import redis from "./redis";

const STALE_DAYS = parseInt(process.env.KEYWORD_STALE_DAYS ?? "30", 10);
const AUTO_ACTIVATE_DAYS = parseInt(process.env.KEYWORD_AUTO_ACTIVATE_DAYS ?? "7", 10);
const KEYWORD_MIN_HITS = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
const KEYWORD_MIN_IPS = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);

async function invalidateKeywordCaches(): Promise<void> {
  await Promise.allSettled([
    redis.del("learned:keywords:en"),
    redis.del("learned:keywords:fi"),
  ]);
}

export async function deactivateStaleKeywords(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.learnedKeyword.updateMany({
    where: {
      active: true,
      lastHitAt: { lt: cutoff },
    },
    data: { active: false },
  });
  if (result.count > 0) {
    await invalidateKeywordCaches();
    console.log(`[keywords] Deactivated ${result.count} stale keywords (no hits in ${STALE_DAYS} days)`);
  }
  return result.count;
}

export async function activatePendingKeywords(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_ACTIVATE_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.learnedKeyword.updateMany({
    where: {
      active: false,
      hits: { gte: KEYWORD_MIN_HITS },
      uniqueIps: { gte: KEYWORD_MIN_IPS },
      createdAt: { lt: cutoff },
    },
    data: { active: true },
  });
  if (result.count > 0) {
    await invalidateKeywordCaches();
    console.log(`[keywords] Auto-activated ${result.count} keywords (pending > ${AUTO_ACTIVATE_DAYS} days)`);
  }
  return result.count;
}
