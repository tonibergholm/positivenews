import type { NextRequest } from "next/server";
import { rejectionRateForCounts } from "@/src/lib/stats";
import { prisma } from "@/src/lib/prisma";
import { isPipelineRunning } from "@/src/lib/pipeline";

export const dynamic = "force-dynamic";

interface StatsSnapshot {
  pipeline: { running: boolean };
  articles: {
    total: number;
    positive: number;
    last24h: number;
    rejectionRate: number;
    oldest: Date | null;
    newest: Date | null;
  };
  byCategory: Record<string, number>;
  bySources: Array<{ name: string; count: number; rejectionRate: number; lastArticle: Date | null }>;
}

async function buildSnapshot(): Promise<StatsSnapshot> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const queries = [
    prisma.article.count(),
    prisma.article.count({ where: { isPositive: true, curatedAt: { not: null } } }),
    prisma.article.count({ where: { isPositive: true, curatedAt: null } }),
    prisma.article.count({ where: { publishedAt: { gte: yesterday } } }),
    prisma.article.aggregate({
      _min: { publishedAt: true },
      _max: { publishedAt: true },
    }),
    prisma.article.groupBy({ by: ["category"], _count: { id: true } }),
    prisma.article.groupBy({
      by: ["sourceId"],
      _count: { id: true },
      _max: { publishedAt: true },
      orderBy: { _count: { id: "desc" } },
    }),
    prisma.article.groupBy({
      by: ["sourceId"],
      where: { isPositive: true, curatedAt: { not: null } },
      _count: { id: true },
    }),
    prisma.article.groupBy({
      by: ["sourceId"],
      where: { isPositive: true, curatedAt: null },
      _count: { id: true },
    }),
    prisma.source.findMany({ select: { id: true, name: true } }),
  ] as const;
  const [total, positive, pending, last24h, range, byCategory, bySourceId, positiveBySourceId, pendingBySourceId, sources] = await prisma.$transaction([...queries], { isolationLevel: "RepeatableRead" });

  const sourceMap = new Map(sources.map((s) => [s.id, s.name]));
  const positiveCountBySource = new Map(
    positiveBySourceId.map((row) => [row.sourceId, row._count.id])
  );
  const pendingCountBySource = new Map(
    pendingBySourceId.map((row) => [row.sourceId, row._count.id])
  );
  // Articles awaiting a curator verdict are neither positive nor rejected.
  const rejectionRate = rejectionRateForCounts(total, positive, pending) / 100;

  return {
    pipeline: { running: isPipelineRunning() },
    articles: {
      total,
      positive,
      last24h,
      rejectionRate,
      oldest: range._min.publishedAt ?? null,
      newest: range._max.publishedAt ?? null,
    },
    byCategory: Object.fromEntries(
      byCategory.map((row) => [row.category, row._count.id])
    ),
    bySources: bySourceId.map((row) => {
      const positiveCount = positiveCountBySource.get(row.sourceId) ?? 0;
      const total = row._count.id;
      const pendingCount = pendingCountBySource.get(row.sourceId) ?? 0;
      return {
        name: sourceMap.get(row.sourceId) ?? "(unknown)",
        count: total,
        rejectionRate: rejectionRateForCounts(total, positiveCount, pendingCount),
        lastArticle: row._max.publishedAt ?? null,
      };
    }),
  };
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let lastJson: string | null = null;

      async function fetchAndPush() {
        let snapshot: StatsSnapshot;
        try {
          snapshot = await buildSnapshot();
        } catch {
          // Transient DB error — skip this tick, client will see staleness
          return;
        }
        const json = JSON.stringify(snapshot);
        if (json !== lastJson) {
          try {
            controller.enqueue(encoder.encode(`data: ${json}\n\n`));
            lastJson = json;
          } catch {
            // Stream is closed — clear interval
            clearInterval(intervalId);
          }
        }
      }

      if (request.signal.aborted) {
        return;
      }

      fetchAndPush();
      const intervalId = setInterval(fetchAndPush, 15_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(intervalId);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
