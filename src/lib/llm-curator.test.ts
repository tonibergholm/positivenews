import { afterEach, expect, it, vi } from "vitest";
import { curateArticles } from "./llm-curator";
const article = { id: "a", title: "A", language: "en" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("does not call Ollama without a URL", async () => {
  vi.stubEnv("OLLAMA_URL", "");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(curateArticles([article])).rejects.toThrow("OLLAMA_URL");
  expect(fetch).not.toHaveBeenCalled();
});
it("skips failed or missing Ollama verdicts", async () => {
  vi.stubEnv("OLLAMA_URL", "http://ollama.test");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: '{"results":[]}' }) }));
  expect(await curateArticles([article])).toEqual([]);
});
it("keeps only after both Ollama passes", async () => {
  vi.stubEnv("OLLAMA_URL", "http://ollama.test");
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ response: JSON.stringify({ results: [{ id: "a", positive: true, reason: "ok" }] }) }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ response: JSON.stringify({ results: [{ id: "a", keep: true, reason: "ok" }] }) }) });
  vi.stubGlobal("fetch", fetch);
  expect(await curateArticles([article])).toMatchObject([{ isPositive: true, source: "ollama", model: "llama3.2:1b" }]);
});
