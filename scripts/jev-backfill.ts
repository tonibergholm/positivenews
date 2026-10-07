/**
 * Evaluates already-ingested non-trusted articles with Jev and prints the
 * comparison against Ollama. Safe to re-run: evaluated articles are skipped.
 *
 * Usage: pnpm jev:backfill [--days 30] [--limit 500] [--concurrency 5]
 */
import "./load-env";
import { prisma } from "../src/lib/prisma";
import { DEFAULT_THRESHOLDS, isJevConfigured, QUESTION_SET } from "../src/lib/jev";
import { shadowEvaluate } from "../src/lib/jev-shadow";
import { buildReport, type Agreement } from "../src/lib/jev-report";
import { loadReportRows } from "../src/lib/jev-report-data";

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number.parseInt(process.argv[i + 1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const line = (label: string, a: Agreement) =>
  `  ${label.padEnd(4)} ${pct(a.rate).padStart(4)} of ${a.total}  ` +
  `(O keep/J keep ${a.keepKeep}, O keep/J reject ${a.keepReject}, O reject/J keep ${a.rejectKeep}, O reject/J reject ${a.rejectReject})`;

async function main() {
  if (!isJevConfigured()) {
    console.error("TYPESAFE_API_KEY is not set (.env.local or .env)");
    process.exit(1);
  }

  const days = intArg("days", 30);
  const limit = intArg("limit", 500);
  const concurrency = intArg("concurrency", 5);

  console.log(`[jev-backfill] question set ${QUESTION_SET}, last ${days} days, limit ${limit}, concurrency ${concurrency}`);
  const { evaluated, failed } = await shadowEvaluate({
    since: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    limit,
    concurrency,
  });
  console.log(`[jev-backfill] ${evaluated} evaluated, ${failed} failed\n`);

  const report = buildReport(await loadReportRows(), DEFAULT_THRESHOLDS);
  console.log(`Evaluations: ${report.evaluated} (models: ${report.models.join(", ") || "—"})`);
  console.log(`Groups: ${JSON.stringify(report.groups)}`);
  console.log("Agreement with Ollama:");
  console.log(line("all", report.agreement.all));
  console.log(line("fi", report.agreement.fi));
  console.log(line("en", report.agreement.en));
  console.log(`Reader-flagged that Jev rejects: ${pct(report.flagged.rate)} of ${report.flagged.total}`);
  console.log(`Keyword-rejected that Jev keeps: ${pct(report.keyword.rate)} of ${report.keyword.total}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[jev-backfill] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
