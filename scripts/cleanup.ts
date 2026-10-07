/**
 * Cleanup script — deletes articles older than 14 days that have no training value.
 *
 * Kept regardless of age:
 *   - articles with any LabelEvent or JevEvaluation (training data)
 *   - articles from trusted sources (future positive training examples)
 * The feed itself only shows recent articles (FEED_MAX_AGE_DAYS in /api/articles),
 * so retention here is a safety net, not what keeps the feed fresh.
 *
 * Usage: npx tsx scripts/cleanup.ts [--dry-run]
 * Cron:  0 3 * * * cd /path/to/positivenews && npx tsx scripts/cleanup.ts >> $HOME/logs/positivenews-cleanup.log 2>&1
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { FEED_SOURCES } from "../src/config/sources";

const RETENTION_DAYS = 14;
const BATCH = 500;
const trustedUrls = FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `[cleanup] ${new Date().toISOString()} ${dryRun ? "DRY RUN — " : ""}articles published before ${cutoff.toISOString()} without labels, Jev evaluations or a trusted source…`,
  );

  if (dryRun) {
    const count = await prisma.article.count({
      where: {
        publishedAt: { lt: cutoff },
        labelEvents: { none: {} },
        jevEvaluations: { none: {} },
        source: { url: { notIn: trustedUrls } },
      },
    });
    console.log(`[cleanup] Would delete ${count} articles`);
    return;
  }

  let total = 0;
  for (;;) {
    // Each batch locks its candidates first (SKIP LOCKED), so a concurrent admin decision, which
    // locks the article, can't be cascade-deleted. The locking query skips rows that are already
    // kept (a row labelled mid-run may be locked briefly); the delete re-checks with a fresh statement.
    const { candidates, deleted } = await prisma.$transaction(
      async (tx) => {
        const candidates = await tx.$queryRaw<{ id: string }[]>`
          SELECT a.id FROM "Article" a
          JOIN "Source" s ON s.id = a."sourceId"
          WHERE a."publishedAt" < ${cutoff}
            AND NOT (s.url = ANY(${trustedUrls}))
            AND NOT EXISTS (SELECT 1 FROM "LabelEvent" l WHERE l."articleId" = a.id)
            AND NOT EXISTS (SELECT 1 FROM "JevEvaluation" j WHERE j."articleId" = a.id)
          ORDER BY a.id
          LIMIT ${BATCH}
          FOR UPDATE OF a SKIP LOCKED`;
        if (candidates.length === 0) return { candidates: 0, deleted: 0 };
        const { count } = await tx.article.deleteMany({
          where: { id: { in: candidates.map((c) => c.id) }, labelEvents: { none: {} }, jevEvaluations: { none: {} } },
        });
        return { candidates: candidates.length, deleted: count };
      },
      { timeout: 30_000 },
    );
    // Stop only when nothing qualifies; a batch that all gained labels mid-run deletes 0 but isn't the end.
    if (candidates === 0) break;
    total += deleted;
  }

  console.log(`[cleanup] Done — deleted ${total} articles`);
}

main()
  .catch((err) => {
    console.error("[cleanup] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
