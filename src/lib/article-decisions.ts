/**
 * The serialised decision path. This module is the only code allowed to
 * change an article's feed state or write a LabelEvent. Every function
 * locks the article row first, so admin decisions stay final regardless
 * of what curation or readers do concurrently.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { CATEGORIES } from "./jev";
import { ADMIN_REJECTION_PASS, currentAdminAuthority, REVIEW_BUCKETS, type ReviewBucket } from "./labels";

export type Tx = Prisma.TransactionClient;
export type OllamaOutcome = "judged_keep" | "judged_reject" | "unavailable" | "missing_result";

const AUTHORITY_SELECT = {
  id: true,
  source: true,
  verdict: true,
  category: true,
  eligible: true,
  bucket: true,
  retractsId: true,
  createdAt: true,
  prevState: true,
} as const;

async function lockArticle(tx: Tx, articleId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Article" WHERE id = ${articleId} FOR UPDATE`;
  return rows.length > 0;
}

async function loadAuthority(tx: Tx, articleId: string) {
  const events = await tx.labelEvent.findMany({ where: { articleId, source: "admin" }, select: AUTHORITY_SELECT });
  return currentAdminAuthority(events);
}

export async function recordKeywordReject(tx: Tx, articleId: string, reason: string): Promise<void> {
  // New row inside the ingest create transaction: nothing else can see it yet.
  await tx.labelEvent.create({
    data: { articleId, source: "keyword", verdict: "reject", reason, createdAt: new Date() },
  });
}

export async function recordOllamaResult(
  articleId: string,
  r: { outcome: OllamaOutcome; reason: string; pass: 1 | 2 },
  model: string,
): Promise<"applied" | "recorded_only" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockArticle(tx, articleId))) return "not_found";
    const authority = await loadAuthority(tx, articleId);
    const reject = r.outcome === "judged_reject";

    await tx.labelEvent.create({
      data: {
        articleId,
        source: "ollama",
        verdict: reject ? "reject" : "keep",
        reason: r.reason,
        pass: r.pass,
        actor: model,
        eligible: r.outcome === "judged_keep" || r.outcome === "judged_reject",
        createdAt: new Date(),
      },
    });

    if (authority) return "recorded_only";

    const now = new Date();
    await tx.article.update({
      where: { id: articleId },
      data: reject
        ? { isPositive: false, curatedAt: now, rejectionReason: r.reason, rejectionPass: r.pass }
        : { curatedAt: now },
    });
    return "applied";
  });
}

export async function recordReaderFlag(
  articleId: string,
  actorHash: string | null,
  onHide: (tx: Tx) => Promise<void>,
): Promise<"not_found" | "duplicate" | "recorded" | "hidden"> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockArticle(tx, articleId))) return "not_found";

    const dedupeKey = actorHash ? `flag:${articleId}:${actorHash}` : null;
    if (dedupeKey && (await tx.labelEvent.findUnique({ where: { dedupeKey }, select: { id: true } }))) {
      return "duplicate";
    }

    await tx.labelEvent.create({
      data: { articleId, source: "reader_flag", verdict: "reject", actor: actorHash, dedupeKey, createdAt: new Date() },
    });

    const article = await tx.article.findUniqueOrThrow({ where: { id: articleId }, select: { flaggedAt: true } });
    if (article.flaggedAt || (await loadAuthority(tx, articleId))) return "recorded";

    await tx.article.update({ where: { id: articleId }, data: { isPositive: false, flaggedAt: new Date() } });
    await onHide(tx);
    return "hidden";
  });
}

function adminRejectReason(category: string | null): string {
  if (!category) return "admin";
  return `admin: ${CATEGORIES[category]?.label ?? category}`;
}

export async function recordAdminDecision(
  articleId: string,
  verdict: "keep" | "reject",
  opts: { category?: string | null; bucket: ReviewBucket; actor: string | null },
): Promise<{ status: "ok"; eventId: string } | { status: "not_found" }> {
  if (!(REVIEW_BUCKETS as readonly string[]).includes(opts.bucket)) throw new Error(`Invalid bucket: ${opts.bucket}`);
  const category = verdict === "reject" ? (opts.category ?? null) : null;
  if (category && !(category in CATEGORIES)) throw new Error(`Invalid category: ${category}`);

  return prisma.$transaction(async (tx) => {
    if (!(await lockArticle(tx, articleId))) return { status: "not_found" as const };

    const a = await tx.article.findUniqueOrThrow({
      where: { id: articleId },
      select: { isPositive: true, curatedAt: true, rejectionPass: true, rejectionReason: true },
    });
    const prevState = {
      isPositive: a.isPositive,
      curatedAt: a.curatedAt ? a.curatedAt.toISOString() : null,
      rejectionPass: a.rejectionPass,
      rejectionReason: a.rejectionReason,
    };

    const event = await tx.labelEvent.create({
      data: {
        articleId,
        source: "admin",
        verdict,
        category,
        bucket: opts.bucket,
        actor: opts.actor,
        prevState,
        createdAt: new Date(),
      },
    });

    await tx.article.update({
      where: { id: articleId },
      data:
        verdict === "keep"
          ? { isPositive: true, curatedAt: a.curatedAt ?? new Date(), rejectionPass: null, rejectionReason: null }
          : { isPositive: false, rejectionPass: ADMIN_REJECTION_PASS, rejectionReason: adminRejectReason(category) },
    });

    return { status: "ok" as const, eventId: event.id };
  });
}

interface PrevState {
  isPositive: boolean;
  curatedAt: string | null;
  rejectionPass: number | null;
  rejectionReason: string | null;
}

export async function retractAdminDecision(eventId: string, actor: string | null): Promise<"ok" | "stale" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.labelEvent.findUnique({ where: { id: eventId }, select: AUTHORITY_SELECT });
    if (!target || target.source !== "admin" || (target.verdict !== "keep" && target.verdict !== "reject")) {
      return "not_found";
    }
    const articleId = (await tx.labelEvent.findUniqueOrThrow({ where: { id: eventId }, select: { articleId: true } })).articleId;
    if (!(await lockArticle(tx, articleId))) return "not_found";

    const authority = await loadAuthority(tx, articleId);
    if (authority?.id !== eventId) return "stale";

    await tx.labelEvent.create({
      data: { articleId, source: "admin", verdict: "retract", retractsId: eventId, actor, reason: "undo", createdAt: new Date() },
    });

    const prev = target.prevState as unknown as PrevState | null;
    if (prev) {
      await tx.article.update({
        where: { id: articleId },
        data: {
          isPositive: prev.isPositive,
          curatedAt: prev.curatedAt ? new Date(prev.curatedAt) : null,
          rejectionPass: prev.rejectionPass,
          rejectionReason: prev.rejectionReason,
        },
      });
    }
    return "ok";
  });
}
