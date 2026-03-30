import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { CATEGORIES } from "@/src/config/sources";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.min(Math.max(1, isNaN(rawPage) ? 1 : rawPage), 1000);

  const rawCategory = searchParams.get("category");
  const category = rawCategory && (CATEGORIES as string[]).includes(rawCategory) ? rawCategory : null;

  const rawSourceId = searchParams.get("sourceId");
  const sourceId = rawSourceId?.match(/^c[a-z0-9]{24}$/) ? rawSourceId : null;

  const where = {
    isPositive: true,
    ...(category && category !== "All" ? { category } : {}),
    ...(sourceId ? { sourceId } : {}),
  };

  const [articles, total] = await Promise.all([
    prisma.article.findMany({
      where,
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        source: { select: { name: true, category: true } },
      },
    }),
    prisma.article.count({ where }),
  ]);

  return NextResponse.json({
    articles,
    pagination: {
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    },
  });
}
