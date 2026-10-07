import { describe, expect, it, vi } from "vitest";
import { CATEGORIES } from "./jev";
import { contractHash, LAYA_QUESTIONS, layaContract, layaEvaluateBatch, layaHealth, parseLayaAnswers } from "./laya";

const okAnswers = {
  keep: { type: "noul", noul: 0.8 },
  reason: { type: "choice", choice: "cat_war", confidence: 0.4, probabilities: { cat_war: 0.6 } },
};

describe("contract", () => {
  it("has keep (noul) and reason (choice over every category)", () => {
    expect(LAYA_QUESTIONS.keep.type).toBe("noul");
    expect(LAYA_QUESTIONS.reason.type).toBe("choice");
    expect(Object.keys((LAYA_QUESTIONS.reason as { criteria: Record<string, string> }).criteria)).toEqual(Object.keys(CATEGORIES));
  });
  it("hash is stable 64-hex and covers the questions", () => {
    expect(contractHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(contractHash()).toBe(contractHash());
    expect(layaContract().version).toBe("1");
  });
});

describe("parseLayaAnswers", () => {
  it("extracts keepP, reason and reasonP", () => {
    expect(parseLayaAnswers(okAnswers, "ck1", false)).toMatchObject({ checkpoint: "ck1", keepP: 0.8, reason: "cat_war", reasonP: 0.6, experimental: false });
  });
  it("rejects out-of-range keep, unknown reason, wrong types", () => {
    expect(() => parseLayaAnswers({ ...okAnswers, keep: { type: "noul", noul: 1.2 } }, "c", false)).toThrow(/keep/);
    expect(() => parseLayaAnswers({ ...okAnswers, reason: { type: "choice", choice: "cat_nope", probabilities: {} } }, "c", false)).toThrow(/reason/);
    expect(() => parseLayaAnswers({ keep: okAnswers.keep }, "c", false)).toThrow(/reason/);
  });
});

function fakeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response);
}

describe("client", () => {
  it("health returns contract hash", async () => {
    const f = fakeFetch({ checkpoint: "ck", contract_hash: "h", experimental: true });
    expect(await layaHealth({ url: "http://x", timeoutMs: 1000, fetchImpl: f })).toEqual({ checkpoint: "ck", contract_hash: "h", experimental: true });
  });
  it("batch takes the checkpoint from the response and isolates bad answers", async () => {
    const f = fakeFetch({ model: "ck-resp", experimental: false, results: [{ answers: okAnswers }, { answers: { keep: { type: "noul", noul: 5 } } }] });
    const r = await layaEvaluateBatch(
      [{ id: "a", title: "A", summary: null }, { id: "b", title: "B", summary: "S" }],
      { url: "http://x", timeoutMs: 1000, fetchImpl: f },
    );
    expect(r.checkpoint).toBe("ck-resp");
    expect(r.results[0]).toMatchObject({ id: "a", answer: { keepP: 0.8, checkpoint: "ck-resp" } });
    expect(r.results[1]).toMatchObject({ id: "b" });
    expect("error" in r.results[1]).toBe(true);
    const sent = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.states).toEqual([{ title: "A" }, { title: "B", summary: "S" }]);
    expect(Object.keys(sent.questions)).toEqual(["keep", "reason"]);
  });
  it("throws on HTTP errors (e.g. 503)", async () => {
    await expect(layaEvaluateBatch([{ id: "a", title: "A", summary: null }], { url: "http://x", timeoutMs: 1000, fetchImpl: fakeFetch({}, 503) })).rejects.toThrow(/503/);
  });
});
