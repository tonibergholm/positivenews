import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { curatorConfig } from "./config";
import { curateOpenAI } from "./openai";
import { jevKeep } from "./jev";
vi.mock("../prisma", () => ({ prisma: {} }));
const article = { id: "a", title: "A", language: "en" };
const reply = (results: unknown) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ results }) } }] }) });
beforeEach(() => {
  for (const key of ["CURATOR_PROVIDER", "CURATOR_FALLBACK", "TYPESAFE_API_KEY", "OLLAMA_URL", "JEV_KEEP_POSITIVE_THRESHOLD", "JEV_KEEP_UPLIFTING_THRESHOLD", "JEV_CATEGORY_VETO_THRESHOLD"]) vi.stubEnv(key, "");
  delete process.env.CURATOR_PROVIDER; delete process.env.CURATOR_FALLBACK;
  delete process.env.JEV_KEEP_POSITIVE_THRESHOLD; delete process.env.JEV_KEEP_UPLIFTING_THRESHOLD; delete process.env.JEV_CATEGORY_VETO_THRESHOLD;
  delete process.env.TYPESAFE_API_KEY; delete process.env.OLLAMA_URL;
  vi.stubEnv("CURATOR_OPENAI_API_KEY", "test-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("defaults safely: keeps Ollama when configured, else Jev, else none", () => {
  expect(curatorConfig().primary).toBe("none");
  vi.stubEnv("TYPESAFE_API_KEY", "test"); expect(curatorConfig().primary).toBe("jev");
  // Existing deployments (Ollama + Jev shadow key) keep Ollama until CURATOR_PROVIDER is set.
  vi.stubEnv("OLLAMA_URL", "http://ollama.test"); expect(curatorConfig().primary).toBe("ollama");
  vi.stubEnv("CURATOR_PROVIDER", "jev"); expect(curatorConfig().primary).toBe("jev");
  vi.stubEnv("CURATOR_PROVIDER", "openai"); expect(curatorConfig().primary).toBe("openai");
});
it("validates provider configuration", () => {
  vi.stubEnv("CURATOR_PROVIDER", "typo"); expect(curatorConfig).toThrow();
});
it("uses the report's Jev verdict rule with env-overridable thresholds", () => {
  const ok = { topCategory: "cat_war", topCategoryP: 0.1 };
  expect(jevKeep({ positiveP: 0.5, upliftingP: 0.5, ...ok })).toBe(true);
  expect(jevKeep({ positiveP: 0.49, upliftingP: 1, ...ok })).toBe(false);
  expect(jevKeep({ positiveP: 1, upliftingP: 0.49, ...ok })).toBe(false);
  expect(jevKeep({ positiveP: 1, upliftingP: 1, topCategory: "cat_war", topCategoryP: 0.61 })).toBe(false);
  vi.stubEnv("JEV_KEEP_POSITIVE_THRESHOLD", "0.8");
  expect(jevKeep({ positiveP: 0.79, upliftingP: 1, ...ok })).toBe(false);
  vi.stubEnv("JEV_CATEGORY_VETO_THRESHOLD", "0.9");
  expect(jevKeep({ positiveP: 1, upliftingP: 1, topCategory: "cat_war", topCategoryP: 0.7 })).toBe(true);
});
describe("OpenAI-compatible HTTP", () => {
  it("sends two JSON passes with authentication and defaults", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply([{ id: "a", positive: true, reason: "ok" }])).mockResolvedValueOnce(reply([{ id: "a", keep: true, reason: "uplifting" }]));
    vi.stubGlobal("fetch", fetch);
    expect(await curateOpenAI([article])).toMatchObject([{ isPositive: true, source: "openai", pass: 2 }]);
    expect(fetch.mock.calls[0][0]).toBe("https://api.mistral.ai/v1/chat/completions");
    const options = fetch.mock.calls[0][1];
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(options.body)).toMatchObject({ model: "ministral-8b-2512", response_format: { type: "json_object" }, temperature: 0.1 });
  });
  it.each(["500", "invalid JSON", "invalid verdict", "network"])("skips %s failures", async (failure) => {
    const fetch = vi.fn();
    if (failure === "network") fetch.mockRejectedValue(new Error("network"));
    else if (failure === "500") fetch.mockResolvedValue({ ok: false, status: 500 });
    else if (failure === "invalid JSON") fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "broken" } }] }) });
    else fetch.mockResolvedValue(reply([{ id: "a", positive: "true", reason: "invalid" }]));
    vi.stubGlobal("fetch", fetch);
    expect(await curateOpenAI([article])).toEqual([]);
  });
  it("aborts a timed out request", async () => {
    vi.stubEnv("CURATOR_TIMEOUT_MS", "5");
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })));
    expect(await curateOpenAI([article])).toEqual([]);
  });
});
