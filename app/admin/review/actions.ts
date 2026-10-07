"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
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

// The review actions don't call revalidatePath. In this Next version any revalidatePath call
// inside a server action re-renders the current route into the action response, which swaps
// in the next queued card and hides the reveal. Nothing needs it anyway: the admin pages are
// force-dynamic and the feed reads a force-dynamic API. The client refreshes after the reveal.

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

export async function decideAction(articleId: string, verdict: "keep" | "reject", category: string | null, bucket: string, redecide: boolean) {
  const who = await actor();
  if (verdict !== "keep" && verdict !== "reject") return { ok: false as const, error: "Invalid verdict" };
  if (!(REVIEW_BUCKETS as readonly string[]).includes(bucket)) return { ok: false as const, error: "Invalid bucket" };
  if (category && !Object.hasOwn(CATEGORIES, category)) return { ok: false as const, error: "Invalid category" };
  try {
    const r = await recordAdminDecision(articleId, verdict, { category, bucket: bucket as ReviewBucket, actor: who, requireUndecided: !redecide });
    if (r.status === "already_decided") return { ok: false as const, error: "Already decided elsewhere" };
    if (r.status === "not_found") return { ok: false as const, error: "Article not found" };
    // The decision is saved; a reveal failure must not turn it into an error.
    let reveal: Reveal;
    try {
      reveal = await loadReveal(articleId);
    } catch (err) {
      console.error("[review] reveal failed:", err);
      reveal = { ollama: null, keyword: false, jev: null };
    }
    return { ok: true as const, eventId: r.eventId, reveal };
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
    return { ok: true as const };
  } catch (err) {
    console.error("[review] undo failed:", err);
    return { ok: false as const, error: "Could not undo" };
  }
}
