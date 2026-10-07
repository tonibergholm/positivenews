import { prisma } from "./prisma";
import { DEFAULT_THRESHOLDS, deriveVerdict, QUESTION_SET } from "./jev";
import { currentAdminAuthority, isTestCohort } from "./labels";
import { layaHealth } from "./laya";
import type { ScoreRow } from "./scoreboard";

const EVENT_SELECT = { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true } as const;

export interface LayaCheckpoint { checkpoint: string; experimental: boolean }

/** Current checkpoint from the live Laya service; null when LAYA_URL is unset or the call fails. */
async function liveCheckpoint(): Promise<LayaCheckpoint | null> {
  const url = process.env.LAYA_URL;
  if (!url) return null;
  try {
    const h = await layaHealth({ url, timeoutMs: 3000 });
    return { checkpoint: h.checkpoint, experimental: h.experimental };
  } catch {
    return null;
  }
}

export async function loadScoreRows(): Promise<{ rows: ScoreRow[]; laya: LayaCheckpoint | null }> {
  const laya =
    (await liveCheckpoint()) ??
    (await prisma.layaEvaluation.findFirst({
      orderBy: { createdAt: "desc" },
      select: { checkpoint: true, experimental: true },
    }));
  const articles = await prisma.article.findMany({
    where: { labelEvents: { some: { source: "admin" } } },
    select: {
      id: true,
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
    const keepP = isTestCohort(a.id) ? a.layaEvaluations?.[0]?.keepP : undefined;
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
