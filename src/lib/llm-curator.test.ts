import { afterEach, expect, it, vi } from "vitest";
import { curateArticles } from "./llm-curator";
const article = { id: "a", title: "A", language: "en" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("uses the default Ollama URL when unset", async () => {
  vi.stubEnv("OLLAMA_URL", "");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: '{"results":[]}' }) }); vi.stubGlobal("fetch", fetch);
  expect(await curateArticles([article])).toEqual([]);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:11434/api/generate", expect.any(Object));
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
  expect(await curateArticles([article])).toMatchObject([{ isPositive: true, source: "ollama", model: "gemma3:4b" }]);
});
