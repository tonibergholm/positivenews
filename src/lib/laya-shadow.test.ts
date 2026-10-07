import { describe, expect, it, vi } from "vitest";
import { contractHash } from "./laya";
import { runLayaShadow, type LayaShadowDeps } from "./laya-shadow";

const art = (i: number) => ({ id: `a${i}`, title: `T${i}`, summary: null });
const answer = (checkpoint: string) => ({ checkpoint, experimental: false, keepP: 0.7, reason: "cat_war", reasonP: 0.5, answers: {} });

function deps(over: Partial<LayaShadowDeps> = {}): LayaShadowDeps & { stored: unknown[] } {
  const stored: unknown[] = [];
  return {
    stored,
    health: vi.fn().mockResolvedValue({ checkpoint: "ck1", contract_hash: contractHash(), experimental: false }),
    evaluate: vi.fn().mockImplementation(async (arts: { id: string }[]) => ({ checkpoint: "ck-resp", experimental: false, results: arts.map((a) => ({ id: a.id, answer: answer("ck-resp") })) })),
    loadCandidates: vi.fn().mockResolvedValue(Array.from({ length: 20 }, (_, i) => art(i))),
    store: vi.fn().mockImplementation(async (r) => { stored.push(r); return "stored"; }),
    now: () => 0,
    ...over,
  };
}
const OPTS = { url: "http://laya", timeoutMs: 1000, since: new Date(0), limit: 80, budgetMs: 120000, batchSize: 8 };

describe("runLayaShadow", () => {
  it("skips on contract mismatch without evaluating", async () => {
    const d = deps({ health: vi.fn().mockResolvedValue({ checkpoint: "ck", contract_hash: "different", experimental: false }) });
    const r = await runLayaShadow(OPTS, d);
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/contract/) });
    expect(d.evaluate).not.toHaveBeenCalled();
  });
  it("evaluates in batches of 8 and stores the checkpoint from the response", async () => {
    const d = deps();
    const r = await runLayaShadow(OPTS, d);
    expect(d.evaluate).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ status: "done", evaluated: 20, failed: 0 });
    expect((d.stored[0] as { checkpoint: string }).checkpoint).toBe("ck-resp");
  });
  it("counts per-article errors and stops at the budget", async () => {
    let t = 0;
    const d = deps({
      now: () => t,
      evaluate: vi.fn().mockImplementation(async (arts: { id: string }[]) => { t += 70_000; return { checkpoint: "ck", experimental: false, results: arts.map((a, i) => (i === 0 ? { id: a.id, error: "bad" } : { id: a.id, answer: answer("ck") })) }; }),
    });
    const r = await runLayaShadow(OPTS, d);
    expect(d.evaluate).toHaveBeenCalledTimes(2);
    expect(r.failed).toBe(2);
    expect(r.evaluated).toBe(14);
  });
  it("skips when health fails or the batch throws, without throwing", async () => {
    expect((await runLayaShadow(OPTS, deps({ health: vi.fn().mockRejectedValue(new Error("down")) }))).status).toBe("skipped");
    const r = await runLayaShadow(OPTS, deps({ evaluate: vi.fn().mockRejectedValue(new Error("Laya HTTP 503")) }));
    expect(r).toMatchObject({ status: "done", evaluated: 0 });
  });
  it("treats duplicates as not failed", async () => {
    const r = await runLayaShadow(OPTS, deps({ store: vi.fn().mockResolvedValue("duplicate") }));
    expect(r).toMatchObject({ failed: 0, evaluated: 0, duplicates: 20 });
  });
  it("counts a throwing store as failed per row and continues", async () => {
    let n = 0;
    const store = vi.fn().mockImplementation(async () => { if (n++ === 0) throw new Error("db down"); return "stored"; });
    const r = await runLayaShadow(OPTS, deps({ store }));
    expect(r).toMatchObject({ status: "done", evaluated: 19, failed: 1 });
  });
  it("warns once when the response checkpoint differs from health", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runLayaShadow(OPTS, deps());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
