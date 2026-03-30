/**
 * Retroactively classifies all existing articles using the local Ollama model.
 * Processes articles sequentially to avoid overwhelming the CPU.
 * Safe to re-run — skips articles that were already classified (isPositive = false).
 *
 * Usage: npx tsx scripts/backfill-classify.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { classifyPositive } from "../src/lib/classifier";

const BATCH_SIZE = 50;

async function main() {
  const total = await prisma.article.count();
  console.log(`[backfill] ${total} articles in DB — starting classification…`);
  console.log(`[backfill] Using model: ${process.env.OLLAMA_MODEL ?? "llama3.2:1b"}`);
  console.log();

  let processed = 0;
  let rejected = 0;
  let offset = 0;

  while (true) {
    const batch = await prisma.article.findMany({
      skip: offset,
      take: BATCH_SIZE,
      orderBy: { publishedAt: "desc" },
      select: { id: true, title: true, summary: true, isPositive: true },
    });

    if (batch.length === 0) break;

    for (const article of batch) {
      const isPositive = await classifyPositive(article.title, article.summary);

      if (!isPositive) {
        await prisma.article.update({
          where: { id: article.id },
          data: { isPositive: false },
        });
        rejected++;
      }

      processed++;
      if (processed % 25 === 0 || processed === total) {
        const pct = ((processed / total) * 100).toFixed(1);
        console.log(
          `[backfill] ${processed}/${total} (${pct}%) — rejected so far: ${rejected}`
        );
      }
    }

    offset += BATCH_SIZE;
  }

  console.log();
  console.log(`[backfill] Done.`);
  console.log(`  Total processed : ${processed}`);
  console.log(`  Rejected (negative): ${rejected}`);
  console.log(`  Kept (positive)    : ${processed - rejected}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
