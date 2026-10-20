import { afterEach, expect, it, vi } from "vitest";
import { curateJev } from "./jev";
import { prisma } from "../prisma";
import { evaluateArticle } from "../jev";
vi.mock("../prisma", () => ({ prisma: { jevEvaluation: { findUnique: vi.fn(), create: vi.fn() } } }));
vi.mock("../jev", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jev")>();
  return { DEFAULT_THRESHOLDS: actual.DEFAULT_THRESHOLDS, deriveVerdict: actual.deriveVerdict, QUESTION_SET: "v1", evaluateArticle: vi.fn() };
});
const article = { id: "a", title: "A", language: "en" };
const data = { positiveP: 0.7, upliftingP: 0.8, model: "jev", answers: {}, upliftScore: 2, topCategory: "cat_war", topCategoryP: 0.2, inputTokens: 1, latencyMs: 1 };
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
it("stores evaluations before returning a decision", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(null);
  vi.mocked(evaluateArticle).mockResolvedValue(data);
  vi.mocked(prisma.jevEvaluation.create).mockResolvedValue(data as never);
  expect(await curateJev([article])).toMatchObject([{ source: "jev", isPositive: true }]);
  expect(prisma.jevEvaluation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ articleId: "a", questionSet: "v1", positiveP: 0.7 }) });
});
it("reuses a stored shadow evaluation", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(data as never);
  expect(await curateJev([article])).toMatchObject([{ isPositive: true }]);
  expect(evaluateArticle).not.toHaveBeenCalled();
});
it("does not decide if evaluation persistence fails", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(null);
  vi.mocked(evaluateArticle).mockResolvedValue(data);
  vi.mocked(prisma.jevEvaluation.create).mockRejectedValue(new Error("database offline"));
  expect(await curateJev([article])).toEqual([]);
});
it("uses the evaluation stored by a concurrent writer", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(null);
  vi.mocked(evaluateArticle).mockResolvedValue(data);
  vi.mocked(prisma.jevEvaluation.create).mockRejectedValue({ code: "P2002" });
  const findUniqueOrThrow = vi.fn().mockResolvedValue({ ...data, positiveP: 0.1 });
  Object.assign(prisma.jevEvaluation, { findUniqueOrThrow });
  expect(await curateJev([article])).toMatchObject([{ isPositive: false }]);
});
it("applies the report's category veto", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue({ ...data, topCategoryP: 0.9 } as never);
  expect(await curateJev([article])).toMatchObject([{ isPositive: false, outcome: "judged_reject" }]);
});
