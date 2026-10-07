/**
 * Cleanup script — deletes articles older than 14 days.
 * Articles with any LabelEvent or JevEvaluation are kept: they are training data.
 * Usage: npx tsx scripts/cleanup.ts
 * Cron:  0 3 * * * cd /path/to/positivenews && npx tsx scripts/cleanup.ts >> /var/log/positivenews-cleanup.log 2>&1
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  console.log(`[cleanup] Deleting articles published before ${cutoff.toISOString()}…`);

  // Lock candidate rows first (SKIP LOCKED) so a concurrent admin decision, which locks the article,
  // can't be cascade-deleted; the delete then re-checks labels with a fresh statement.
  const count = await prisma.$transaction(
    async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Article" WHERE "publishedAt" < ${cutoff} FOR UPDATE SKIP LOCKED`;
      if (candidates.length === 0) return 0;
      // Fresh statement after acquiring locks: sees any label/evaluation committed before we locked.
      const { count } = await tx.article.deleteMany({
        where: { id: { in: candidates.map((c) => c.id) }, labelEvents: { none: {} }, jevEvaluations: { none: {} } },
      });
      return count;
    },
    { timeout: 60_000 },
  );

  console.log(`[cleanup] Done — deleted ${count} articles`);
}

main()
  .catch((err) => {
    console.error("[cleanup] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
