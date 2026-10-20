import { afterEach, expect, it, vi } from "vitest";
import { curateArticles } from "./index";
import { curateJev } from "./jev";
import { curateOpenAI } from "./openai";
import { curateOllama } from "./ollama";
vi.mock("./jev", () => ({ curateJev: vi.fn() }));
vi.mock("./openai", () => ({ curateOpenAI: vi.fn() }));
vi.mock("./ollama", () => ({ curateOllama: vi.fn() }));
const articles = [{ id: "a", title: "A", language: "en" }, { id: "b", title: "B", language: "en" }];
const decision = { id: "a", isPositive: false, reason: "negative", pass: 2 as const, outcome: "judged_reject" as const, source: "jev" as const, model: "jev" };
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); vi.useRealTimers(); });
it("falls back only for articles without decisions", async () => {
  vi.stubEnv("CURATOR_PROVIDER", "jev"); vi.stubEnv("CURATOR_FALLBACK", "openai");
  vi.mocked(curateJev).mockResolvedValue([decision]); vi.mocked(curateOpenAI).mockResolvedValue([]);
  expect(await curateArticles(articles)).toEqual([decision]);
  expect(curateOpenAI).toHaveBeenCalledWith([articles[1]], expect.any(Number));
  expect(curateOllama).not.toHaveBeenCalled();
});
it("skips everything when primary and fallback fail", async () => {
  vi.stubEnv("CURATOR_PROVIDER", "jev"); vi.stubEnv("CURATOR_FALLBACK", "openai");
  vi.mocked(curateJev).mockRejectedValue(new Error("fatal")); vi.mocked(curateOpenAI).mockRejectedValue(new Error("offline"));
  expect(await curateArticles(articles)).toEqual([]);
});
it("none disables curation including fallback", async () => {
  vi.stubEnv("CURATOR_PROVIDER", "none"); vi.stubEnv("CURATOR_FALLBACK", "ollama");
  expect(await curateArticles(articles)).toEqual([]); expect(curateOllama).not.toHaveBeenCalled();
});

it("shares the primary deadline with fallback", async () => {
  vi.useFakeTimers();
  vi.stubEnv("CURATOR_PROVIDER", "jev"); vi.stubEnv("CURATOR_FALLBACK", "openai");
  vi.stubEnv("CURATOR_BUDGET_MS", "100");
  const start = Date.now();
  vi.mocked(curateJev).mockImplementation(async () => { vi.setSystemTime(start + 60); return []; });
  vi.mocked(curateOpenAI).mockResolvedValue([]);
  await curateArticles(articles);
  expect(curateJev).toHaveBeenCalledWith(articles, start + 100);
  expect(curateOpenAI).toHaveBeenCalledWith(articles, start + 100);
});
it("does not invoke fallback after the budget expires", async () => {
  vi.useFakeTimers();
  vi.stubEnv("CURATOR_PROVIDER", "jev"); vi.stubEnv("CURATOR_FALLBACK", "openai");
  vi.stubEnv("CURATOR_BUDGET_MS", "100");
  vi.mocked(curateJev).mockImplementation(async () => { vi.setSystemTime(Date.now() + 100); return []; });
  await curateArticles(articles);
  expect(curateOpenAI).not.toHaveBeenCalled();
});
