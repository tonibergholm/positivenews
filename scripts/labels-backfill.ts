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

interface Prev {
  rejectionPass: number | null;
  rejectionReason: string | null;
  curatedAt: Date | null;
}

/** Reads an admin event's prevState JSON ({ isPositive, curatedAt, rejectionPass, rejectionReason }). */
function parsePrev(v: unknown): Prev | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pass = typeof o.rejectionPass === "number" ? o.rejectionPass : null;
  const reason = typeof o.rejectionReason === "string" ? o.rejectionReason : null;
  const cur = typeof o.curatedAt === "string" ? new Date(o.curatedAt) : null;
  return { rejectionPass: pass, rejectionReason: reason, curatedAt: cur && !Number.isNaN(cur.getTime()) ? cur : null };
}

async function main() {
  const before = beforeArg();
  const counts = { scanned: 0, keyword: 0, ollama_reject: 0, ollama_keep_unverified: 0, flag: 0, excludedLive: 0, skipped: 0 };
  let cursor: string | undefined;

  const toScan = await prisma.article.count({ where: { createdAt: { lt: before } } });
  console.log(`[labels-backfill] articles created before ${before.toISOString()}: ${toScan} to scan`);

  for (;;) {
    const batch = await prisma.article.findMany({
      where: { createdAt: { lt: before }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
      select: {
        id: true,
        createdAt: true,
        curatedAt: true,
        flaggedAt: true,
        rejectionPass: true,
        rejectionReason: true,
        source: { select: { url: true } },
        labelEvents: {
          // Live events only; admin keep/reject rows carry prevState (the state before the decision).
          where: { backfilled: false },
          orderBy: { createdAt: "asc" },
          select: { source: true, verdict: true, prevState: true },
        },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const a of batch) {
      counts.scanned++;
      const live = new Set(a.labelEvents.map((e) => e.source));
      // An admin decision overwrote the article's fields; map the state it replaced instead.
      const adminPrev = parsePrev(
        a.labelEvents.find((e) => e.source === "admin" && (e.verdict === "keep" || e.verdict === "reject"))?.prevState,
      );
      const hist = adminPrev
        ? { rejectionPass: adminPrev.rejectionPass, rejectionReason: adminPrev.rejectionReason, curatedAt: adminPrev.curatedAt }
        : { rejectionPass: a.rejectionPass, rejectionReason: a.rejectionReason, curatedAt: a.curatedAt };
      const rows: Array<{ kind: Kind; data: RowData }> = [];

      if (hist.rejectionPass === 0) {
        if (live.has("keyword")) counts.excludedLive++;
        else rows.push({ kind: "keyword", data: { source: "keyword", verdict: "reject", reason: hist.rejectionReason, createdAt: a.createdAt } });
      } else if (hist.rejectionPass === 1 || hist.rejectionPass === 2) {
        if (live.has("ollama")) counts.excludedLive++;
        else rows.push({ kind: "ollama", data: { source: "ollama", verdict: "reject", reason: hist.rejectionReason, pass: hist.rejectionPass, createdAt: hist.curatedAt ?? a.createdAt } });
      } else if (hist.curatedAt && hist.rejectionPass === null && !trusted.has(a.source.url)) {
        // An admin keep also sets curatedAt with no rejection; it must not become a made-up Ollama event.
        if (live.has("ollama") || (!adminPrev && live.has("admin"))) counts.excludedLive++;
        else rows.push({ kind: "ollama", data: { source: "ollama", verdict: "keep", reason: "historical approval (unverified)", pass: 2, eligible: false, createdAt: hist.curatedAt } });
      }
      if (a.flaggedAt) {
        if (live.has("reader_flag")) counts.excludedLive++;
        else rows.push({ kind: "flag", data: { source: "reader_flag", verdict: "reject", createdAt: a.flaggedAt } });
      }

      if (rows.length === 0) continue;

      const toData = (r: { kind: Kind; data: RowData }) => ({
        articleId: a.id,
        backfilled: true,
        dedupeKey: `backfill:${a.id}:${r.kind}`,
        ...r.data,
      });

      // One row: createMany is exact. Several rows: insert one by one so a partial conflict is counted exactly.
      const inserted: typeof rows = [];
      if (rows.length === 1) {
        const result = await prisma.labelEvent.createMany({ data: [toData(rows[0])], skipDuplicates: true });
        if (result.count === 1) inserted.push(rows[0]);
      } else {
        for (const r of rows) {
          try {
            await prisma.labelEvent.create({ data: toData(r) });
            inserted.push(r);
          } catch (err) {
            if ((err as { code?: string }).code !== "P2002") throw err;
          }
        }
      }
      counts.skipped += rows.length - inserted.length;
      for (const r of inserted) {
        if (r.kind === "keyword") counts.keyword++;
        else if (r.kind === "flag") counts.flag++;
        else if (r.data.verdict === "reject") counts.ollama_reject++;
        else counts.ollama_keep_unverified++;
      }
    }
    console.log(`[labels-backfill] ${counts.scanned}/${toScan} scanned…`);
  }

  console.log("[labels-backfill] done", counts);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[labels-backfill] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
