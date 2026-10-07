/**
 * LEGACY: bypasses the decision path; skips articles with an admin decision.
 *
 * Retroactively classifies all existing articles using keyword-based filter.
 * - Trusted sources (curated positive outlets) are skipped — kept as positive.
 * - General sources are classified; articles matching negative keywords get isPositive=false.
 * - Safe to re-run.
 *
 * Usage: npx tsx scripts/backfill-classify.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { classifyPositiveSync as classifyPositive } from "../src/lib/classifier";
import { FEED_SOURCES } from "../src/config/sources";

const BATCH_SIZE = 100;

const sourceInfo = new Map(
  FEED_SOURCES.map((s) => [s.name, { trusted: s.trusted ?? false, language: s.language }])
);

async function main() {
  const total = await prisma.article.count();
  console.log(`[backfill] ${total} articles in DB`);

  const trustedNames = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.name);
  console.log(`[backfill] Trusted sources (skipped): ${trustedNames.join(", ")}`);
  console.log();

  let processed = 0;
  let skipped = 0;
  let rejected = 0;
  let offset = 0;

  while (true) {
    const batch = await prisma.article.findMany({
      skip: offset,
      take: BATCH_SIZE,
      orderBy: { publishedAt: "asc" },
      select: {
        id: true,
        title: true,
        summary: true,
        source: { select: { name: true } },
      },
    });

    if (batch.length === 0) break;

    const updates: string[] = [];

    const adminDecided = new Set(
      (
        await prisma.labelEvent.findMany({
          where: { source: "admin", articleId: { in: batch.map((a) => a.id) } },
          select: { articleId: true },
        })
      ).map((e) => e.articleId)
    );

    for (const article of batch) {
      if (adminDecided.has(article.id)) {
        skipped++;
        processed++;
        continue;
      }

      const info = sourceInfo.get(article.source.name);
      const trusted = info?.trusted ?? false;
      const language = info?.language ?? "en";

      if (trusted) {
        skipped++;
      } else {
        const { positive: isPositive } = classifyPositive(article.title, article.summary, language);
        if (!isPositive) {
          updates.push(article.id);
          rejected++;
        }
      }
      processed++;
    }

    // Update each article under a row lock, re-checking for an admin decision made since the pre-filter.
    for (const id of updates) {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Article" WHERE id = ${id} FOR UPDATE`;
        if (locked.length === 0) return; // deleted since the batch was read
        const decided = await tx.labelEvent.findFirst({ where: { articleId: id, source: "admin" }, select: { id: true } });
        if (decided) return;
        await tx.article.update({ where: { id }, data: { isPositive: false } });
      });
    }

    const pct = ((processed / total) * 100).toFixed(1);
    console.log(
      `[backfill] ${processed}/${total} (${pct}%) — rejected: ${rejected}, trusted-skipped: ${skipped}`
    );

    offset += BATCH_SIZE;
  }

  console.log();
  console.log(`[backfill] Done.`);
  console.log(`  Total processed        : ${processed}`);
  console.log(`  Trusted (auto-positive): ${skipped}`);
  console.log(`  Classified             : ${processed - skipped}`);
  console.log(`  Rejected (negative)    : ${rejected}`);
  console.log(`  Kept (positive)        : ${processed - skipped - rejected}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
