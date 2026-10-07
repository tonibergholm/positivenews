/**
 * Writes Laya training data: train/val/test JSONL, test-compare.jsonl,
 * contract.json, manifest.json and train-ids.txt into --out <dir>.
 * Snapshot: only events created before the start time.
 *
 * Usage: pnpm laya:export --out <dir> [--seed 7] [--distill]
 */
import "./load-env";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { DEFAULT_THRESHOLDS, deriveVerdict, QUESTION_SET } from "../src/lib/jev";
import { contractHash, layaContract } from "../src/lib/laya";
import { buildSplits, LAYA_WEIGHTS, type ArticleSignals, type LayaRow } from "../src/lib/laya-export";
import { FEED_SOURCES } from "../src/config/sources";

const BATCH = 1000;
const trusted = new Set(FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const out = arg("out");
  if (!out) {
    console.error("Usage: pnpm laya:export --out <dir> [--seed 7] [--distill]");
    process.exit(1);
  }
  if (process.argv.includes("--distill")) {
    console.error("[laya-export] --distill is phase 2 and not implemented yet");
    process.exit(1);
  }
  const seed = Number.parseInt(arg("seed") ?? "7", 10);
  const cutoff = new Date();
  const articles: ArticleSignals[] = [];
  const compareInfo = new Map<string, { ollama: string | null; jev: { keep: boolean; model: string; questionSet: string } | null }>();
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.article.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      take: BATCH,
      select: {
        id: true,
        title: true,
        summary: true,
        source: { select: { url: true, language: true } },
        labelEvents: {
          where: { createdAt: { lt: cutoff } },
          select: { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true, reason: true },
        },
        jevEvaluations: { where: { questionSet: QUESTION_SET, createdAt: { lt: cutoff } }, select: { positiveP: true, upliftingP: true, topCategory: true, topCategoryP: true, model: true }, take: 1 },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    for (const a of batch) {
      const jev = a.jevEvaluations[0] ?? null;
      articles.push({ id: a.id, title: a.title, summary: a.summary, language: a.source.language, trusted: trusted.has(a.source.url), events: a.labelEvents, jev });
      const ollama = a.labelEvents.filter((e) => e.source === "ollama" && e.eligible).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
      compareInfo.set(a.id, {
        ollama: ollama ? ollama.verdict : null,
        jev: jev ? { keep: deriveVerdict(jev, DEFAULT_THRESHOLDS).keep, model: jev.model, questionSet: QUESTION_SET } : null,
      });
    }
  }

  const r = buildSplits(articles, seed);
  mkdirSync(out, { recursive: true });
  const jsonl = (rows: object[]) => rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : "");
  const strip = (row: LayaRow) => ({ id: row.id, state: row.state, language: row.language, questions: row.questions, gold: row.gold });
  const files: Record<string, string> = {
    "train.jsonl": jsonl(r.train.map(strip)),
    "val.jsonl": jsonl(r.val.map(strip)),
    "test.jsonl": jsonl(r.test.map(strip)),
    "test-compare.jsonl": jsonl(r.test.map((row) => ({ id: row.id, language: row.language, label: row.label, ...compareInfo.get(row.id) }))),
    "contract.json": JSON.stringify({ ...layaContract(), hash: contractHash() }, null, 2),
    "train-ids.txt": r.train.map((x) => x.id).join("\n") + "\n",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);

  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const count = (rows: LayaRow[], key: "source" | "label" | "language") => rows.reduce<Record<string, number>>((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {});
  const stamp = cutoff.toISOString().replace(/[-:]/g, "").slice(0, 13);
  const exportId = `${stamp}-${sha(files["train-ids.txt"]).slice(0, 6)}`;
  const manifest = {
    exportId,
    cutoff: cutoff.toISOString(),
    seed,
    questionSet: QUESTION_SET,
    contractHash: contractHash(),
    weights: LAYA_WEIGHTS,
    balance: r.balance,
    counts: Object.fromEntries((["train", "val", "test"] as const).map((k) => [k, { total: r[k].length, bySource: count(r[k], "source"), byLabel: count(r[k], "label"), byLanguage: count(r[k], "language") }])),
    files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha(c)])),
  };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[laya-export] ${exportId} → ${out}`);
  console.log(JSON.stringify({ balance: r.balance, counts: manifest.counts }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[laya-export] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
