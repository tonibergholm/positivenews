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
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("falls back only for articles without decisions", async () => {
  vi.stubEnv("CURATOR_PROVIDER", "jev"); vi.stubEnv("CURATOR_FALLBACK", "openai");
  vi.mocked(curateJev).mockResolvedValue([decision]); vi.mocked(curateOpenAI).mockResolvedValue([]);
  expect(await curateArticles(articles)).toEqual([decision]);
  expect(curateOpenAI).toHaveBeenCalledWith([articles[1]]);
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
