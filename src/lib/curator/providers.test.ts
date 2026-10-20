import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { budgetMs, curatorConfig, timeoutMs } from "./config";
import { curateOpenAI } from "./openai";
import { curateOllama } from "./ollama";
import { twoPass } from "./two-pass";
import { jevThresholds, jevKeep } from "./jev";
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
it("defaults to legacy Ollama regardless of available keys", () => {
  expect(curatorConfig().primary).toBe("ollama");
  vi.stubEnv("TYPESAFE_API_KEY", "test"); expect(curatorConfig().primary).toBe("ollama");
  vi.stubEnv("CURATOR_PROVIDER", ""); expect(curatorConfig().primary).toBe("ollama");
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

it.each([undefined, "", "   "])("uses duration defaults for %s", (value) => {
  vi.stubEnv("CURATOR_TIMEOUT_MS", value);
  vi.stubEnv("CURATOR_BUDGET_MS", value);
  expect(timeoutMs()).toBe(30000);
  expect(budgetMs()).toBe(120000);
});
it.each(["0", "-1", "1.5", "1e3", "Infinity", "abc", "9007199254740992"])("rejects invalid duration %s", (value) => {
  vi.stubEnv("CURATOR_TIMEOUT_MS", value);
  vi.stubEnv("CURATOR_BUDGET_MS", value);
  expect(timeoutMs).toThrow("Invalid CURATOR_TIMEOUT_MS");
  expect(budgetMs).toThrow("Invalid CURATOR_BUDGET_MS");
});
it("trims positive integer durations", () => {
  vi.stubEnv("CURATOR_TIMEOUT_MS", " 42 ");
  vi.stubEnv("CURATOR_BUDGET_MS", " 123 ");
  expect(timeoutMs()).toBe(42);
  expect(budgetMs()).toBe(123);
});
it.each(["", "   ", "0", "NaN", "Infinity", "-0.1", "1.1"])("handles Jev threshold %s", (value) => {
  vi.stubEnv("JEV_KEEP_POSITIVE_THRESHOLD", value);
  if (["", "   ", "0"].includes(value)) expect(jevThresholds().positiveMin).toBe(value.trim() ? 0 : 0.5);
  else expect(jevThresholds).toThrow();
});
it("uses Ollama's legacy URL and model defaults", async () => {
  vi.stubEnv("OLLAMA_MODEL", undefined);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: JSON.stringify({ results: [{ id: "a", positive: false, reason: "negative" }] }) }) });
  vi.stubGlobal("fetch", fetch);
  expect(await curateOllama([article])).toMatchObject([{ source: "ollama", model: "gemma3:4b" }]);
  expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/generate");
  expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("gemma3:4b");
});
it.each(["ollama", "openai"] as const)("stops %s batches at the deadline", async (source) => {
  vi.useFakeTimers();
  const deadline = Date.now() + 10;
  const call = vi.fn().mockImplementation(async () => {
    vi.setSystemTime(deadline);
    return { results: [{ id: "a", positive: false, reason: "negative" }] };
  });
  expect(await twoPass(Array.from({ length: 11 }, (_, i) => ({ ...article, id: i ? String(i) : "a" })), call, source, "test", deadline)).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(1);
});
it("does not start pass two after the deadline", async () => {
  vi.useFakeTimers();
  const deadline = Date.now() + 10;
  const call = vi.fn().mockImplementation(async () => {
    vi.setSystemTime(deadline);
    return { results: [{ id: "a", positive: true, reason: "positive" }] };
  });
  expect(await twoPass([article], call, "openai", "test", deadline)).toEqual([]);
  expect(call).toHaveBeenCalledTimes(1);
});
it("caps an HTTP request at the remaining budget", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply([])));
  await curateOpenAI([article], Date.now() + 100);
  expect(timeout).toHaveBeenCalledWith(expect.any(Number));
  expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(100);
  timeout.mockRestore();
});

it("respects explicit Ollama URL and production model overrides", async () => {
  vi.stubEnv("OLLAMA_URL", "http://ollama.test/");
  vi.stubEnv("OLLAMA_MODEL", "llama3.2:1b");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: JSON.stringify({ results: [{ id: "a", positive: false, reason: "negative" }] }) }) });
  vi.stubGlobal("fetch", fetch);
  expect(await curateOllama([article])).toMatchObject([{ model: "llama3.2:1b" }]);
  expect(fetch.mock.calls[0][0]).toBe("http://ollama.test/api/generate");
  expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("llama3.2:1b");
});

it("treats empty or whitespace Ollama and OpenAI model/URL overrides as unset", async () => {
  vi.stubEnv("OLLAMA_MODEL", "  ");
  const ollama = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: JSON.stringify({ results: [{ id: "a", positive: false, reason: "negative" }] }) }) });
  vi.stubGlobal("fetch", ollama);
  await curateOllama([article]);
  expect(JSON.parse(ollama.mock.calls[0][1].body).model).toBe("gemma3:4b");
  vi.stubEnv("CURATOR_OPENAI_BASE_URL", "");
  vi.stubEnv("CURATOR_OPENAI_MODEL", " ");
  const openai = vi.fn().mockResolvedValue(reply([{ id: "a", positive: false, reason: "negative" }]));
  vi.stubGlobal("fetch", openai);
  await curateOpenAI([article]);
  expect(openai.mock.calls[0][0]).toBe("https://api.mistral.ai/v1/chat/completions");
  expect(JSON.parse(openai.mock.calls[0][1].body).model).toBe("ministral-8b-2512");
});

it("stops scheduling batches after two consecutive failures so fallback keeps budget", async () => {
  const call = vi.fn().mockRejectedValue(new Error("timeout"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const articles = Array.from({ length: 50 }, (_, i) => ({ ...article, id: String(i) }));
  expect(await twoPass(articles, call, "openai", "test")).toEqual([]);
  expect(call).toHaveBeenCalledTimes(2);
});
it("resets the failure count after a successful batch", async () => {
  const ok = { results: [{ id: "x", positive: false, reason: "negative" }] };
  const call = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error("x")).mockResolvedValue(ok);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const articles = Array.from({ length: 40 }, (_, i) => ({ ...article, id: String(i) }));
  await twoPass(articles, call, "openai", "test");
  expect(call).toHaveBeenCalledTimes(4);
});
