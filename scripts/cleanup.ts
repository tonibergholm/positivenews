/**
 * Cleanup script — deletes articles older than 14 days.
 * Usage: npx tsx scripts/cleanup.ts
 * Cron:  0 3 * * * cd /path/to/positivenews && npx tsx scripts/cleanup.ts >> /var/log/positivenews-cleanup.log 2>&1
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  console.log(`[cleanup] Deleting articles published before ${cutoff.toISOString()}…`);

  const { count } = await prisma.article.deleteMany({
    where: { publishedAt: { lt: cutoff } },
  });

  console.log(`[cleanup] Done — deleted ${count} articles`);
}

main()
  .catch((err) => {
    console.error("[cleanup] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
