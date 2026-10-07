/**
 * Evaluates already-ingested non-trusted articles with Laya (shadow only).
 * Safe to re-run: articles already evaluated by the current checkpoint are skipped.
 *
 * Usage: pnpm laya:backfill [--days 30] [--limit 2000]
 */
import "./load-env";
import { prisma } from "../src/lib/prisma";
import { isLayaConfigured, layaShadowEvaluate } from "../src/lib/laya-shadow";

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1] ?? "";
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const days = intArg("days", 30);
  const limit = intArg("limit", 2000);
  if (!isLayaConfigured()) {
    console.log("[laya-backfill] LAYA_URL is not set; nothing to do.");
    return;
  }
  console.log(`[laya-backfill] last ${days} days, limit ${limit}`);
  const result = await layaShadowEvaluate({
    since: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    limit,
    budgetMs: 60 * 60 * 1000,
  });
  console.log(`[laya-backfill] ${JSON.stringify(result)}`);
}

main()
  .catch((err) => {
    console.error("[laya-backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
