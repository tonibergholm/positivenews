import { afterEach, expect, it, vi } from "vitest";
import { prisma } from "./prisma";

vi.mock("../../scripts/load-env", () => ({}));
vi.mock("./prisma", () => ({ prisma: {
  article: { count: vi.fn(), findMany: vi.fn() },
  labelEvent: { createMany: vi.fn() },
  $disconnect: vi.fn(),
} }));
afterEach(() => { vi.resetAllMocks(); vi.resetModules(); });

it.each(["ollama", "jev", "openai"])("does not backfill Ollama labels over live %s decisions", async (source) => {
  vi.mocked(prisma.article.count).mockResolvedValue(2);
  vi.mocked(prisma.article.findMany).mockResolvedValueOnce([null, 2].map((rejectionPass, i) => ({
    id: String(i), createdAt: new Date(), curatedAt: new Date(), flaggedAt: null,
    rejectionPass, rejectionReason: null, source: { url: "https://untrusted.test" },
    labelEvents: [{ source, verdict: i ? "reject" : "keep", prevState: null }],
  })) as never).mockResolvedValueOnce([]);
  await import("../../scripts/labels-backfill");
  await vi.waitFor(() => expect(prisma.$disconnect).toHaveBeenCalled());
  expect(prisma.labelEvent.createMany).not.toHaveBeenCalled();
});
