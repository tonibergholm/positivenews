import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { isPipelineRunning } from "@/src/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    total,
    positive,
    last24h,
    range,
    byCategory,
    bySourceId,
    positiveBySourceId,
    sources,
  ] = await Promise.all([
    prisma.article.count(),
    prisma.article.count({ where: { isPositive: true } }),
    prisma.article.count({ where: { publishedAt: { gte: yesterday } } }),
    prisma.article.aggregate({
      _min: { publishedAt: true },
      _max: { publishedAt: true },
    }),
    prisma.article.groupBy({
      by: ["category"],
      _count: { id: true },
    }),
    prisma.article.groupBy({
      by: ["sourceId"],
      _count: { id: true },
      _max: { publishedAt: true },
      orderBy: { _count: { id: "desc" } },
    }),
    prisma.article.groupBy({
      by: ["sourceId"],
      where: { isPositive: true },
      _count: { id: true },
    }),
    prisma.source.findMany({ select: { id: true, name: true } }),
  ]);

  const sourceMap = new Map(sources.map((s) => [s.id, s.name]));
  const positiveCountBySource = new Map(
    positiveBySourceId.map((row) => [row.sourceId, row._count.id])
  );

  const rejectionRate =
    total > 0 ? Math.round(((total - positive) / total) * 100) / 100 : 0;

  return NextResponse.json({
    pipeline: {
      running: isPipelineRunning(),
    },
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
      return {
        name: sourceMap.get(row.sourceId) ?? "(unknown)",
        count: total,
        rejectionRate: total > 0 ? Math.round(((total - positiveCount) / total) * 100) : 0,
        lastArticle: row._max.publishedAt ?? null,
      };
    }),
  });
}
