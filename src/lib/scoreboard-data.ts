import { prisma } from "./prisma";
import { DEFAULT_THRESHOLDS, deriveVerdict, QUESTION_SET } from "./jev";
import { currentAdminAuthority } from "./labels";
import type { ScoreRow } from "./scoreboard";

const EVENT_SELECT = { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true } as const;

export interface LayaCheckpoint { checkpoint: string; experimental: boolean }

export async function loadScoreRows(): Promise<{ rows: ScoreRow[]; laya: LayaCheckpoint | null }> {
  const laya = await prisma.layaEvaluation.findFirst({
    orderBy: { createdAt: "desc" },
    select: { checkpoint: true, experimental: true },
  });
  const articles = await prisma.article.findMany({
    where: { labelEvents: { some: { source: "admin" } } },
    select: {
      flaggedAt: true,
      source: { select: { language: true } },
      labelEvents: { select: EVENT_SELECT, orderBy: { createdAt: "asc" } },
      jevEvaluations: { where: { questionSet: QUESTION_SET }, take: 1 },
      ...(laya ? { layaEvaluations: { where: { checkpoint: laya.checkpoint }, take: 1, select: { keepP: true } } } : {}),
    },
  });

  const rows: ScoreRow[] = [];
  for (const a of articles) {
    const authority = currentAdminAuthority(a.labelEvents);
    if (!authority) continue;
    const ollama = a.labelEvents.filter((e) => e.source === "ollama" && e.eligible).at(-1);
    const jev = a.jevEvaluations[0];
    const keepP = a.layaEvaluations?.[0]?.keepP;
    rows.push({
      language: a.source.language,
      bucket: authority.bucket,
      admin: authority.verdict as "keep" | "reject",
      keyword: a.labelEvents.some((e) => e.source === "keyword" && e.eligible),
      ollama: ollama ? (ollama.verdict as "keep" | "reject") : null,
      jev: jev ? (deriveVerdict(jev, DEFAULT_THRESHOLDS).keep ? "keep" : "reject") : null,
      laya: keepP === undefined ? null : keepP >= 0.5 ? "keep" : "reject",
      flagged: Boolean(a.flaggedAt) || a.labelEvents.some((e) => e.source === "reader_flag"),
    });
  }
  return { rows, laya };
}
