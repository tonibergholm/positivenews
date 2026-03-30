/**
 * Post-ingest curation job.
 *
 * Finds articles that passed the keyword pre-filter but haven't been
 * LLM-curated yet, and runs them through the two-tier Ollama curator.
 * Trusted-source articles are auto-approved without LLM.
 */

import { prisma } from "./prisma";
import { curateArticles } from "./llm-curator";
import { FEED_SOURCES } from "@/src/config/sources";

const trustedSourceUrls = new Set(
  FEED_SOURCES.filter((s) => s.trusted).map((s) => s.url)
);

export async function curateUnchecked(): Promise<{
  curated: number;
  rejected: number;
  skipped: number;
}> {
  // Find articles that passed keyword filter but haven't been LLM-curated
  // curatedAt is a new field — cast to any for local TS compat with Prisma 7
  const unchecked = await (prisma.article as any).findMany({
    where: {
      isPositive: true,
      curatedAt: null,
      flaggedAt: null,
    },
    include: {
      source: { select: { url: true, language: true } },
    },
    orderBy: { publishedAt: "desc" },
    take: 50, // cap per run to avoid long-running jobs
  }) as Array<{
    id: string;
    title: string;
    summary: string | null;
    source: { url: string; language: string };
  }>;

  if (unchecked.length === 0) {
    console.log("[curate] No unchecked articles found");
    return { curated: 0, rejected: 0, skipped: 0 };
  }

  console.log(`[curate] Found ${unchecked.length} unchecked articles`);

  // Auto-approve trusted sources
  const trusted = unchecked.filter((a) => trustedSourceUrls.has(a.source.url));
  const needsCuration = unchecked.filter(
    (a) => !trustedSourceUrls.has(a.source.url)
  );

  if (trusted.length > 0) {
    await (prisma.article as any).updateMany({
      where: { id: { in: trusted.map((a) => a.id) } },
      data: { curatedAt: new Date() },
    });
    console.log(`[curate] Auto-approved ${trusted.length} trusted-source articles`);
  }

  if (needsCuration.length === 0) {
    return { curated: trusted.length, rejected: 0, skipped: 0 };
  }

  // Run through LLM curator
  const inputs = needsCuration.map((a) => ({
    id: a.id,
    title: a.title,
    summary: a.summary,
    language: a.source.language ?? "en",
  }));

  const results = await curateArticles(inputs);

  let rejected = 0;

  for (const r of results) {
    if (r.isPositive) {
      await (prisma.article as any).update({
        where: { id: r.id },
        data: { curatedAt: new Date() },
      });
    } else {
      await (prisma.article as any).update({
        where: { id: r.id },
        data: { isPositive: false, curatedAt: new Date() },
      });
      rejected++;
      console.log(`[curate] Rejected: "${needsCuration.find((a) => a.id === r.id)?.title}" — ${r.reason} (pass ${r.pass})`);
    }
  }

  const curated = trusted.length + results.length - rejected;
  console.log(
    `[curate] Done — ${curated} approved, ${rejected} rejected, ${trusted.length} auto-trusted`
  );

  return { curated, rejected, skipped: trusted.length };
}
