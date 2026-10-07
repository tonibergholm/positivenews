import { prisma } from "./prisma";
import { QUESTION_SET } from "./jev";
import { currentAdminAuthority, isTestCohort, type ReviewBucket } from "./labels";
import { bucketOf, helsinkiDate, QUOTAS, selectNext, startOfHelsinkiDay, type QueueBucket, type QueueCandidate } from "./review-queue";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ADMIN_EVENT_SELECT = { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true } as const;

export interface ReviewCard {
  articleId: string;
  title: string;
  summary: string | null;
  url: string;
  imageUrl: string | null;
  sourceName: string;
  language: string;
  bucket: ReviewBucket;
}

export async function loadCandidates(now = new Date()): Promise<QueueCandidate[]> {
  const rows = await prisma.article.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - WINDOW_MS) } },
    select: {
      id: true,
      createdAt: true,
      isPositive: true,
      flaggedAt: true,
      labelEvents: { where: { source: { in: ["admin", "reader_flag"] } }, select: ADMIN_EVENT_SELECT },
      jevEvaluations: { where: { questionSet: QUESTION_SET }, select: { positiveP: true, upliftingP: true, topCategoryP: true }, take: 1 },
    },
  });

  return rows
    .filter((r) => currentAdminAuthority(r.labelEvents) === null)
    .map((r) => ({
      articleId: r.id,
      createdAt: r.createdAt,
      flagged: Boolean(r.flaggedAt) || r.labelEvents.some((e) => e.source === "reader_flag"),
      inFeed: r.isPositive,
      cohort: isTestCohort(r.id),
      jev: r.jevEvaluations[0] ?? null,
    }));
}

async function todaysDecisions(now: Date) {
  const since = startOfHelsinkiDay(now);
  const events = await prisma.labelEvent.findMany({
    where: { source: "admin", createdAt: { gte: since } },
    select: ADMIN_EVENT_SELECT,
  });
  const retracted = new Set(events.filter((e) => e.verdict === "retract").map((e) => e.retractsId));
  return events.filter((e) => e.verdict !== "retract" && e.bucket && !retracted.has(e.id));
}

export async function loadDecidedToday(now = new Date()): Promise<Record<QueueBucket, number>> {
  const counts: Record<QueueBucket, number> = { flagged: 0, leak: 0, miss: 0, cohort: 0 };
  for (const e of await todaysDecisions(now)) {
    if (e.bucket && e.bucket in QUOTAS) counts[e.bucket as QueueBucket]++;
  }
  return counts;
}

export async function todayCount(now = new Date()): Promise<number> {
  return (await todaysDecisions(now)).length;
}

export async function loadNextCard(opts: { exclude: ReadonlySet<string>; focus?: string | null; now?: Date }) {
  const now = opts.now ?? new Date();
  const [candidates, decided, doneToday] = await Promise.all([loadCandidates(now), loadDecidedToday(now), todayCount(now)]);

  let chosen: { candidate: QueueCandidate; bucket: ReviewBucket } | null = null;
  if (opts.focus) {
    const c = candidates.find((x) => x.articleId === opts.focus);
    if (c) chosen = { candidate: c, bucket: bucketOf(c) ?? "manual" };
  }
  chosen ??= selectNext(candidates, decided, { date: helsinkiDate(now), exclude: opts.exclude });
  if (!chosen) return { card: null, doneToday };

  const a = await prisma.article.findUniqueOrThrow({
    where: { id: chosen.candidate.articleId },
    select: { id: true, title: true, summary: true, url: true, imageUrl: true, source: { select: { name: true, language: true } } },
  });
  const card: ReviewCard = {
    articleId: a.id,
    title: a.title,
    summary: a.summary,
    url: a.url,
    imageUrl: a.imageUrl,
    sourceName: a.source.name,
    language: a.source.language,
    bucket: chosen.bucket,
  };
  return { card, doneToday };
}
