"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/src/lib/prisma";
import { recordAdminDecision, retractAdminDecision } from "@/src/lib/article-decisions";
import { CATEGORIES, deriveVerdict, QUESTION_SET } from "@/src/lib/jev";
import { REVIEW_BUCKETS, type ReviewBucket } from "@/src/lib/labels";

export interface Reveal {
  ollama: string | null;  // "keep" | "reject" | null
  keyword: boolean;
  jev: { keep: boolean; positiveP: number; upliftingP: number; topCategory: string } | null;
}

async function actor(): Promise<string | null> {
  const session = await auth();
  if (!session) redirect("/admin/login");
  return session.user?.email ?? null;
}

function revalidate() {
  for (const p of ["/", "/admin/review", "/admin/rejections", "/admin/flagged"]) revalidatePath(p);
}

async function loadReveal(articleId: string): Promise<Reveal> {
  const [events, jev] = await Promise.all([
    prisma.labelEvent.findMany({
      where: { articleId, source: { in: ["ollama", "keyword"] }, eligible: true },
      orderBy: { createdAt: "desc" },
      select: { source: true, verdict: true },
    }),
    prisma.jevEvaluation.findFirst({ where: { articleId, questionSet: QUESTION_SET } }),
  ]);
  return {
    ollama: events.find((e) => e.source === "ollama")?.verdict ?? null,
    keyword: events.some((e) => e.source === "keyword"),
    jev: jev
      ? { keep: deriveVerdict(jev).keep, positiveP: jev.positiveP, upliftingP: jev.upliftingP, topCategory: CATEGORIES[jev.topCategory]?.label ?? jev.topCategory }
      : null,
  };
}

export async function decideAction(articleId: string, verdict: "keep" | "reject", category: string | null, bucket: string) {
  const who = await actor();
  if (verdict !== "keep" && verdict !== "reject") return { ok: false as const, error: "Invalid verdict" };
  if (!(REVIEW_BUCKETS as readonly string[]).includes(bucket)) return { ok: false as const, error: "Invalid bucket" };
  if (category && !Object.hasOwn(CATEGORIES, category)) return { ok: false as const, error: "Invalid category" };
  try {
    const r = await recordAdminDecision(articleId, verdict, { category, bucket: bucket as ReviewBucket, actor: who });
    if (r.status === "not_found") return { ok: false as const, error: "Article not found" };
    revalidate();
    return { ok: true as const, eventId: r.eventId, reveal: await loadReveal(articleId) };
  } catch (err) {
    console.error("[review] decide failed:", err);
    return { ok: false as const, error: "Could not save decision" };
  }
}

export async function undoAction(eventId: string) {
  const who = await actor();
  try {
    const r = await retractAdminDecision(eventId, who);
    if (r === "stale") return { ok: false as const, error: "Decision changed elsewhere" };
    if (r === "not_found") return { ok: false as const, error: "Decision not found" };
    revalidate();
    return { ok: true as const };
  } catch (err) {
    console.error("[review] undo failed:", err);
    return { ok: false as const, error: "Could not undo" };
  }
}
