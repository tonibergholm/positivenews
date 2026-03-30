/**
 * Seed script — runs feed ingestion immediately on first launch.
 * Usage: npx tsx scripts/seed.ts
 */
import "dotenv/config";
import { ingestAll } from "../src/lib/ingest";

async function main() {
  console.log("🌱 Seeding PositiveNews database…");
  const { total, errors } = await ingestAll();
  console.log(`\n✅ Seed complete — ${total} articles ingested`);
  if (errors.length > 0) {
    console.warn(`⚠️  ${errors.length} feed(s) failed:`);
    errors.forEach((e) => console.warn("  •", e));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
