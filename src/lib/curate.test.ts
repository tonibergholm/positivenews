import { afterEach, expect, it, vi } from "vitest";
import { curateUnchecked } from "./curate";
import { prisma } from "./prisma";
import { recordCuratorResult } from "./article-decisions";
vi.mock("./prisma", () => ({ prisma: { article: { findMany: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() } }));
vi.mock("./curator", () => ({ curateArticles: vi.fn().mockResolvedValue([]) }));
vi.mock("./article-decisions", () => ({ recordCuratorResult: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it("leaves failed articles uncurated and records no approval or rejection", async () => {
  vi.mocked(prisma.article.findMany).mockResolvedValue([{ id: "a", title: "A", summary: null, source: { url: "https://untrusted.test", language: "en" } }] as never);
  expect(await curateUnchecked()).toEqual({ curated: 0, rejected: 0, skipped: 1 });
  expect(recordCuratorResult).not.toHaveBeenCalled();
  expect(prisma.article.updateMany).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
