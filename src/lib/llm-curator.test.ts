import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { curateArticles } from "./llm-curator";

function ollamaReply(obj: unknown) {
  return { ok: true, json: async () => ({ response: JSON.stringify(obj) }) } as Response;
}

const A = { id: "a", title: "A", language: "en" };
const B = { id: "b", title: "B", language: "en" };
const C = { id: "c", title: "C", language: "en" };

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("curateArticles outcomes", () => {
  it("judged reject in pass 1, judged keep and judged reject in pass 2", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ollamaReply({ results: [
        { id: "a", positive: false, reason: "war" },
        { id: "b", positive: true, reason: "ok" },
        { id: "c", positive: true, reason: "ok" },
      ] }))
      .mockResolvedValueOnce(ollamaReply({ results: [
        { id: "b", keep: true, reason: "uplifting" },
        { id: "c", keep: false, reason: "marketing" },
      ] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await curateArticles([A, B, C]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ outcome: "judged_reject", isPositive: false, pass: 1 });
    expect(by.b).toMatchObject({ outcome: "judged_keep", isPositive: true, pass: 2 });
    expect(by.c).toMatchObject({ outcome: "judged_reject", isPositive: false, pass: 2 });
  });

  it("missing ids are missing_result (kept), never judged_keep", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "b", positive: true, reason: "ok" }] })) // a missing in pass 1
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", keep: true, reason: "fine" }] })); // b missing in pass 2
    vi.stubGlobal("fetch", fetchMock);
    const r = await curateArticles([A, B]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by.a).toMatchObject({ outcome: "missing_result", isPositive: true });
    expect(by.b).toMatchObject({ outcome: "missing_result", isPositive: true, reason: "missing result" });
  });

  it("non-boolean verdicts are missing_result, not judged", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", positive: "false", reason: "war" }] }))
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", keep: "false", reason: "marketing" }] })));
    const r = await curateArticles([A]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: "missing_result", isPositive: true, reason: "missing result", pass: 2 });
  });

  it("a present pass-2 result without keep is missing_result", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", positive: true, reason: "ok" }] }))
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", reason: "no verdict" }] })));
    const r = await curateArticles([A]);
    expect(r[0]).toMatchObject({ outcome: "missing_result", isPositive: true, reason: "missing result", pass: 2 });
  });

  it("a boolean positive:false is still judged_reject", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", positive: false, reason: "war" }] })));
    const r = await curateArticles([A]);
    expect(r[0]).toMatchObject({ outcome: "judged_reject", isPositive: false, pass: 1 });
  });

  it("failed calls are unavailable (kept)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await curateArticles([A]);
    expect(r[0]).toMatchObject({ outcome: "unavailable", isPositive: true, reason: "LLM unavailable", pass: 1 });
  });

  it("pass 2 failure marks pass-1 positives unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(ollamaReply({ results: [{ id: "a", positive: true, reason: "ok" }] }))
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response));
    const r = await curateArticles([A]);
    expect(r[0]).toMatchObject({ outcome: "unavailable", isPositive: true, pass: 2 });
  });
});
