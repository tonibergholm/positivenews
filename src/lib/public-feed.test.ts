import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { GET as articles } from "../../app/api/articles/route";
import { GET as stats } from "../../app/api/stats/route";
import { GET as stream } from "../../app/api/stats/stream/route";

vi.mock("./prisma", () => ({ prisma: {
  article: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
  source: { findMany: vi.fn() },
} }));
vi.mock("./pipeline", () => ({ isPipelineRunning: () => false }));
afterEach(() => vi.resetAllMocks());

it("requires approval for both feed rows and pagination totals", async () => {
  vi.mocked(prisma.article.findMany).mockResolvedValue([]);
  vi.mocked(prisma.article.count).mockResolvedValue(0);
  await articles(new NextRequest("http://localhost/news/api/articles"));
  const where = expect.objectContaining({ isPositive: true, curatedAt: { not: null } });
  expect(prisma.article.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
  expect(prisma.article.count).toHaveBeenCalledWith({ where });
});

it.each(["json", "stream"])("counts only approved positives in %s stats", async (kind) => {
  vi.mocked(prisma.article.count).mockResolvedValue(0);
  vi.mocked(prisma.article.groupBy).mockResolvedValue([]);
  vi.mocked(prisma.article.aggregate).mockResolvedValue({ _min: {}, _max: {} } as never);
  vi.mocked(prisma.source.findMany).mockResolvedValue([]);
  if (kind === "json") await stats();
  else {
    const controller = new AbortController();
    const response = await stream(new NextRequest("http://localhost/news/api/stats/stream", { signal: controller.signal }));
    await response.body!.getReader().read();
    controller.abort();
  }
  const where = { isPositive: true, curatedAt: { not: null } };
  expect(prisma.article.count).toHaveBeenCalledWith({ where });
  expect(prisma.article.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ["sourceId"], where }));
});
