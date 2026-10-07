/**
 * Writes resolved labels as JSONL: train rows to <out>, test (cohort) rows
 * to <out>.test.jsonl. Snapshot: only events created before the start time.
 *
 * Usage: pnpm labels:export --out labels.jsonl [--split train|test]
 */
import "./load-env";
import { createWriteStream, type WriteStream } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { QUESTION_SET } from "../src/lib/jev";
import { toExportRow } from "../src/lib/labels-export";

const BATCH = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const out = arg("out");
  const only = arg("split");
  if (!out || (only && only !== "train" && only !== "test")) {
    console.error("Usage: pnpm labels:export --out <file> [--split train|test]");
    process.exit(1);
  }
  const cutoff = new Date();
  const streams: Partial<Record<"train" | "test", WriteStream>> = {};
  if (only !== "test") streams.train = createWriteStream(out);
  if (only !== "train") streams.test = createWriteStream(only === "test" ? out : `${out}.test.jsonl`);

  // A failed write (disk full, bad path) must fail the run, never leave a truncated file behind a success line.
  let streamError: Error | null = null;
  for (const [name, s] of Object.entries(streams)) {
    s!.on("error", (err) => {
      streamError ??= new Error(`[labels-export] write failed (${name}, ${s!.path}): ${err.message}`);
    });
  }
  const assertStreams = () => {
    if (streamError) throw streamError;
  };

  const summary: Record<string, number> = {};
  const bump = (k: string) => (summary[k] = (summary[k] ?? 0) + 1);
  let cursor: string | undefined;

  for (;;) {
    assertStreams();
    const batch = await prisma.article.findMany({
      where: { labelEvents: { some: { createdAt: { lt: cutoff } } }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
      select: {
        id: true,
        title: true,
        summary: true,
        createdAt: true,
        source: { select: { language: true } },
        labelEvents: {
          where: { createdAt: { lt: cutoff } },
          select: { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true },
        },
        jevEvaluations: { where: { questionSet: QUESTION_SET }, select: { model: true, questionSet: true, answers: true }, take: 1 },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const a of batch) {
      const row = toExportRow({
        id: a.id,
        title: a.title,
        summary: a.summary,
        language: a.source.language,
        createdAt: a.createdAt,
        events: a.labelEvents,
        jev: a.jevEvaluations[0] ?? null,
      });
      if (!row) continue;
      const stream = streams[row.split];
      if (!stream) continue;
      stream.write(`${JSON.stringify(row)}\n`);
      bump(`split:${row.split}`);
      bump(`tier:${row.tier}`);
      bump(`lang:${row.language}`);
      if (row.bucket) bump(`bucket:${row.bucket}`);
    }
  }

  await Promise.all(
    Object.values(streams).map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          if (streamError) return reject(streamError);
          s!.once("finish", resolve);
          s!.once("error", reject);
          s!.end();
        }),
    ),
  );
  assertStreams();
  console.log(`[labels-export] snapshot ${cutoff.toISOString()}`, summary);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message.startsWith("[labels-export]") ? message : `[labels-export] failed: ${message}`);
  await prisma.$disconnect();
  process.exit(1);
});
