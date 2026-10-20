import { APIConnectionError, APIError, APITimeoutError } from "@typesafe-ai/sdk";
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
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
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

it.each([new APIConnectionError(), new APITimeoutError(30), new APIError(503, {}, new Headers())])("stops scheduling after consecutive availability failures: %s", async (error) => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(null);
  vi.mocked(evaluateArticle).mockRejectedValue(error);
  expect(await curateJev(Array.from({ length: 50 }, (_, i) => ({ ...article, id: String(i) })))).toEqual([]);
  expect(evaluateArticle).toHaveBeenCalledTimes(6);
});
it("stops scheduling Jev articles at the deadline", async () => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const deadline = Date.now() + 20;
  vi.mocked(prisma.jevEvaluation.findUnique).mockImplementation((async () => { vi.setSystemTime(deadline); return data; }) as never);
  expect(await curateJev(Array.from({ length: 50 }, (_, i) => ({ ...article, id: String(i) })), deadline)).toHaveLength(1);
  expect(prisma.jevEvaluation.findUnique).toHaveBeenCalledTimes(1);
});
it("caps Jev request timeout at the remaining budget", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(null);
  vi.mocked(evaluateArticle).mockResolvedValue(data);
  vi.mocked(prisma.jevEvaluation.create).mockResolvedValue(data as never);
  await curateJev([article], Date.now() + 100);
  expect(vi.mocked(evaluateArticle).mock.calls[0][1]?.timeout).toBeLessThanOrEqual(100);
});

it("continues after article-specific HTTP failures", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.mocked(prisma.jevEvaluation.findUnique).mockResolvedValue(null);
  vi.mocked(evaluateArticle).mockRejectedValue(new APIError(400, {}, new Headers()));
  expect(await curateJev(Array.from({ length: 12 }, (_, i) => ({ ...article, id: String(i) })))).toEqual([]);
  expect(evaluateArticle).toHaveBeenCalledTimes(12);
});
