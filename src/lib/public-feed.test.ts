import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { GET as articles } from "../../app/api/articles/route";
import { GET as stats } from "../../app/api/stats/route";
import { GET as stream } from "../../app/api/stats/stream/route";

vi.mock("./prisma", () => ({ prisma: {
  $transaction: vi.fn(),
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
  vi.mocked(prisma.$transaction).mockImplementation((async (queries: Promise<unknown>[]) => Promise.all(queries)) as never);
  if (kind === "json") await stats();
  else {
    const controller = new AbortController();
    const response = await stream(new NextRequest("http://localhost/news/api/stats/stream", { signal: controller.signal }));
    await response.body!.getReader().read();
    controller.abort();
  }
  expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array), { isolationLevel: "RepeatableRead" });
  const where = { isPositive: true, curatedAt: { not: null } };
  expect(prisma.article.count).toHaveBeenCalledWith({ where });
  expect(prisma.article.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ["sourceId"], where }));
});

it.each(["json", "stream"])("excludes pending articles from %s rejection rates", async (kind) => {
  // total 10, approved 3, pending 5 -> 2 rejected of 5 decided
  vi.mocked(prisma.article.count).mockImplementation((async (args?: { where?: { curatedAt?: unknown; isPositive?: boolean } }) => {
    if (!args?.where) return 10;
    return args.where.curatedAt === null ? 5 : 3;
  }) as never);
  vi.mocked(prisma.article.groupBy).mockImplementation((async (args: { by: string[]; where?: { curatedAt?: unknown } }) => {
    if (args.by[0] !== "sourceId") return [];
    if (!args.where) return [{ sourceId: "s", _count: { id: 10 }, _max: { publishedAt: null } }];
    return [{ sourceId: "s", _count: { id: args.where.curatedAt === null ? 5 : 3 } }];
  }) as never);
  vi.mocked(prisma.article.aggregate).mockResolvedValue({ _min: {}, _max: {} } as never);
  vi.mocked(prisma.source.findMany).mockResolvedValue([{ id: "s", name: "S" }] as never);
  let body;
  vi.mocked(prisma.$transaction).mockImplementation((async (queries: Promise<unknown>[]) => Promise.all(queries)) as never);
  if (kind === "json") body = await (await stats()).json();
  else {
    const controller = new AbortController();
    const response = await stream(new NextRequest("http://localhost/news/api/stats/stream", { signal: controller.signal }));
    const { value } = await response.body!.getReader().read();
    controller.abort();
    body = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ""));
  }
  expect(body.articles.rejectionRate).toBe(0.4);
  expect(body.bySources[0].rejectionRate).toBe(40);
});
