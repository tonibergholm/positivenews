/**
 * One-off import of historical judgements into LabelEvent (backfilled = true).
 * Idempotent: every event has dedupeKey backfill:<articleId>:<kind>.
 *
 * Usage: pnpm labels:backfill [--before 2026-10-08T00:00:00Z]
 */
import "./load-env";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { FEED_SOURCES } from "../src/config/sources";

const BATCH = 500;
const trusted = new Set(FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url));

function beforeArg(): Date {
  const i = process.argv.indexOf("--before");
  if (i === -1) return new Date();
  const d = new Date(process.argv[i + 1] ?? "");
  if (Number.isNaN(d.getTime())) {
    console.error("--before must be an ISO date");
    process.exit(1);
  }
  return d;
}

type Kind = "keyword" | "ollama" | "flag";
type RowData = Omit<Prisma.LabelEventCreateManyInput, "articleId" | "backfilled" | "dedupeKey">;

async function main() {
  const before = beforeArg();
  const counts = { scanned: 0, keyword: 0, ollama_reject: 0, ollama_keep_unverified: 0, flag: 0, skipped: 0 };
  let cursor: string | undefined;

  console.log(`[labels-backfill] articles created before ${before.toISOString()}`);

  for (;;) {
    const batch = await prisma.article.findMany({
      where: { createdAt: { lt: before } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        createdAt: true,
        curatedAt: true,
        flaggedAt: true,
        rejectionPass: true,
        rejectionReason: true,
        source: { select: { url: true } },
        labelEvents: { where: { backfilled: false }, select: { source: true } },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const a of batch) {
      counts.scanned++;
      const live = new Set(a.labelEvents.map((e) => e.source));
      const rows: Array<{ kind: Kind; data: RowData }> = [];

      if (a.rejectionPass === 0 && !live.has("keyword")) {
        rows.push({ kind: "keyword", data: { source: "keyword", verdict: "reject", reason: a.rejectionReason, createdAt: a.createdAt } });
      } else if ((a.rejectionPass === 1 || a.rejectionPass === 2) && !live.has("ollama")) {
        rows.push({ kind: "ollama", data: { source: "ollama", verdict: "reject", reason: a.rejectionReason, pass: a.rejectionPass, createdAt: a.curatedAt ?? a.createdAt } });
      } else if (a.curatedAt && a.rejectionPass === null && !trusted.has(a.source.url) && !live.has("ollama")) {
        rows.push({ kind: "ollama", data: { source: "ollama", verdict: "keep", reason: "historical approval (unverified)", pass: 2, eligible: false, createdAt: a.curatedAt } });
      }
      if (a.flaggedAt && !live.has("reader_flag")) {
        rows.push({ kind: "flag", data: { source: "reader_flag", verdict: "reject", createdAt: a.flaggedAt } });
      }

      if (rows.length === 0) continue;

      const result = await prisma.labelEvent.createMany({
        data: rows.map((r) => ({ articleId: a.id, backfilled: true, dedupeKey: `backfill:${a.id}:${r.kind}`, ...r.data })),
        skipDuplicates: true,
      });
      counts.skipped += rows.length - result.count;
      if (result.count === 0) continue;
      for (const r of rows) {
        if (r.kind === "keyword") counts.keyword++;
        else if (r.kind === "flag") counts.flag++;
        else if (r.data.verdict === "reject") counts.ollama_reject++;
        else counts.ollama_keep_unverified++;
      }
    }
    console.log(`[labels-backfill] ${counts.scanned} scanned…`);
  }

  console.log("[labels-backfill] done", counts);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[labels-backfill] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
