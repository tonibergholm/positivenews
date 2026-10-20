import { afterEach, expect, it, vi } from "vitest";
import { prisma } from "./prisma";
import { recordAdminDecision, recordCuratorResult } from "./article-decisions";

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn().mockResolvedValue([{ id: "a" }]),
  labelEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: "event" }) },
  article: { update: vi.fn(), findUniqueOrThrow: vi.fn().mockResolvedValue({ isPositive: true, curatedAt: null, rejectionPass: null, rejectionReason: null }) },
}));
vi.mock("./prisma", () => ({ prisma: { $transaction: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

it.each(["jev", "openai", "ollama"] as const)("sets curatedAt on a %s keep", async (source) => {
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: (value: typeof tx) => unknown) => fn(tx)) as never);
  expect(await recordCuratorResult("a", { outcome: "judged_keep", reason: "ok", pass: 2 }, "test", source)).toBe("applied");
  expect(tx.article.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { curatedAt: expect.any(Date) } });
});

it("sets curatedAt on an admin review keep", async () => {
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: (value: typeof tx) => unknown) => fn(tx)) as never);
  await recordAdminDecision("a", "keep", { bucket: "manual", actor: "test" });
  expect(tx.article.update).toHaveBeenCalledWith({ where: { id: "a" }, data: expect.objectContaining({ isPositive: true, curatedAt: expect.any(Date) }) });
});
