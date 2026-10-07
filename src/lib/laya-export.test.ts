import { describe, expect, it } from "vitest";
import { isTestCohort, type LabelEventLike } from "./labels";
import { buildSplits, LAYA_WEIGHTS, seededShuffle, supervise, toRow, type ArticleSignals } from "./laya-export";

let seq = 0;
type Ev = LabelEventLike & { reason: string | null };
const ev = (p: Partial<Ev>): Ev => ({ id: `e${++seq}`, source: "ollama", verdict: "keep", category: null, eligible: true, bucket: null, retractsId: null, createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)), reason: null, ...p });
function idInCohort(want: boolean, from = 0): string {
  for (let i = from; i < 100000; i++) if (isTestCohort(`x${i}`) === want) return `x${i}`;
  throw new Error("no id");
}
const art = (p: Partial<ArticleSignals>): ArticleSignals => ({ id: idInCohort(false, seq++ * 13), title: "T", summary: "S", language: "fi", trusted: false, events: [], jev: null, ...p });
const JEV_KEEP = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.55 };
const JEV_REJECT = { positiveP: 0.1, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.2 };

describe("supervise precedence", () => {
  it("gold beats everything, with category", () => {
    const s = supervise(art({ events: [ev({ source: "reader_flag", verdict: "reject" }), ev({ source: "admin", verdict: "reject", category: "cat_sports" })], jev: JEV_KEEP }));
    expect(s).toEqual({ label: "reject", p: 0, source: "gold", category: "cat_sports" });
  });
  it("flags beat the Jev teacher", () => {
    expect(supervise(art({ events: [ev({ source: "reader_flag", verdict: "reject" })], jev: JEV_KEEP }))).toMatchObject({ source: "flag", label: "reject", p: 0.25 });
  });
  it("Jev teacher uses Jev's own rule (category 0.55 with 0.9/0.9 is keep)", () => {
    expect(supervise(art({ jev: JEV_KEEP }))).toMatchObject({ source: "jev", label: "keep", p: 0.8 });
    expect(supervise(art({ jev: JEV_REJECT }))).toMatchObject({ source: "jev", label: "reject", p: expect.closeTo(0.2) });
  });
  it("eligible Ollama (live or backfilled) next, then keyword, trusted, historical", () => {
    expect(supervise(art({ events: [ev({ source: "ollama", verdict: "reject" }), ev({ source: "keyword", verdict: "reject" })] }))).toMatchObject({ source: "ollama", p: expect.closeTo(0.3) });
    expect(supervise(art({ events: [ev({ source: "keyword", verdict: "reject" })], trusted: true }))).toMatchObject({ source: "keyword", p: expect.closeTo(0.35) });
    expect(supervise(art({ trusted: true }))).toMatchObject({ source: "trusted", label: "keep", p: expect.closeTo(0.65) });
    expect(supervise(art({ events: [ev({ source: "ollama", verdict: "keep", eligible: false, reason: "historical approval (unverified)" })] }))).toMatchObject({ source: "historical", p: expect.closeTo(0.6) });
  });
  it("ignores ineligible non-historical events and returns null without signal", () => {
    expect(supervise(art({ events: [ev({ source: "ollama", verdict: "keep", eligible: false, reason: "LLM unavailable" })] }))).toBeNull();
    expect(supervise(art({}))).toBeNull();
  });
  it("weights map to targets", () => {
    expect(LAYA_WEIGHTS).toEqual({ gold: 1, flag: 0.5, jev: 0.6, ollama: 0.4, keyword: 0.3, trusted: 0.3, historical: 0.2 });
  });
});

describe("toRow", () => {
  it("keep probabilities and reason only for categorised gold rejects", () => {
    const a = art({});
    expect(toRow(a, { label: "reject", p: 0, source: "gold", category: "cat_war" }).gold).toEqual({
      keep: { probabilities: { true: 0, false: 1 } },
      reason: { probabilities: { cat_war: 1 } },
    });
    expect(toRow(a, { label: "reject", p: 0.3, source: "ollama", category: null }).gold).toEqual({ keep: { probabilities: { true: 0.3, false: 0.7 } } });
    expect(toRow(a, { label: "reject", p: 0, source: "gold", category: null }).gold.reason).toBeUndefined();
  });
});

describe("buildSplits", () => {
  it("never leaks cohort articles; test holds only gold cohort rows", () => {
    const cohortWeak = art({ id: idInCohort(true), events: [ev({ source: "keyword", verdict: "reject" })] });
    const cohortGold = art({ id: idInCohort(true, 5000), events: [ev({ source: "admin", verdict: "keep" })] });
    const r = buildSplits([cohortWeak, cohortGold, art({ trusted: true }), art({ events: [ev({ source: "keyword", verdict: "reject" })] })], 7);
    const all = [...r.train, ...r.val].map((x) => x.id);
    expect(all).not.toContain(cohortWeak.id);
    expect(all).not.toContain(cohortGold.id);
    expect(r.test.map((x) => x.id)).toEqual([cohortGold.id]);
  });
  it("balances by hard count, keeps protected sources, samples historical to trusted count", () => {
    const trusted = Array.from({ length: 30 }, () => art({ trusted: true }));
    const hist = Array.from({ length: 100 }, () => art({ events: [ev({ source: "ollama", verdict: "keep", eligible: false, reason: "historical approval (unverified)" })] }));
    const kw = Array.from({ length: 500 }, () => art({ events: [ev({ source: "keyword", verdict: "reject" })] }));
    const ol = Array.from({ length: 10 }, () => art({ events: [ev({ source: "ollama", verdict: "reject" })] }));
    const r = buildSplits([...trusted, ...hist, ...kw, ...ol], 7);
    const rows = [...r.train, ...r.val];
    const count = (src: string) => rows.filter((x) => x.source === src).length;
    expect(count("trusted")).toBe(30);
    expect(count("historical")).toBe(30);
    expect(count("ollama")).toBe(10);
    expect(r.balance.keepRows).toBe(60);
    expect(r.balance.rejectRows).toBe(60);
    expect(r.balance.status).toBe("ok");
  });
  it("reports infeasible balance", () => {
    const r = buildSplits(Array.from({ length: 20 }, () => art({ events: [ev({ source: "ollama", verdict: "reject" })] })), 7);
    expect(r.balance.status).toBe("infeasible");
    expect(r.balance.reason).toMatch(/keep/);
  });
  it("validation is ~10%, seeded and stable", () => {
    const xs = Array.from({ length: 200 }, (_, i) => art({ trusted: i % 2 === 0, events: i % 2 ? [ev({ source: "ollama", verdict: "reject" })] : [] }));
    const a = buildSplits(xs, 7), b = buildSplits(xs, 7);
    expect(a.val.map((x) => x.id)).toEqual(b.val.map((x) => x.id));
    expect(a.val.length).toBeGreaterThanOrEqual(18);
    expect(a.val.length).toBeLessThanOrEqual(22);
  });
  it("seededShuffle is deterministic and seed-sensitive", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    const k = (n: number) => String(n);
    expect(seededShuffle(xs, 1, "a", k)).toEqual(seededShuffle(xs, 1, "a", k));
    expect(seededShuffle(xs, 1, "a", k)).not.toEqual(seededShuffle(xs, 2, "a", k));
  });
  it("adding an unrelated row does not reshuffle existing validation ids", () => {
    const xs = Array.from({ length: 200 }, (_, i) => art({ trusted: i % 2 === 0, events: i % 2 ? [ev({ source: "ollama", verdict: "reject" })] : [] }));
    const extra = art({ events: [ev({ source: "ollama", verdict: "reject" })] });
    const before = new Set(buildSplits(xs, 7).val.map((x) => x.id));
    const after = new Set(buildSplits([...xs, extra], 7).val.map((x) => x.id));
    for (const id of before) if (!after.has(id)) expect.fail(`${id} left validation`);
    const added = [...after].filter((id) => !before.has(id));
    expect(added.every((id) => id === extra.id)).toBe(true);
  });
  it("never caps protected sources and reports per-source counts", () => {
    const ol = Array.from({ length: 25 }, () => art({ events: [ev({ source: "ollama", verdict: "reject" })] }));
    const r = buildSplits(ol, 7);
    expect(r.balance.bySource.ollama).toEqual({ preCap: 25, kept: 25 });
    expect(r.balance.bySource.keyword).toEqual({ preCap: 0, kept: 0 });
  });
});

describe("retraction and eligibility", () => {
  it("ignores an ineligible keyword event", () => {
    expect(supervise(art({ events: [ev({ source: "keyword", verdict: "reject", eligible: false })] }))).toBeNull();
    expect(supervise(art({ events: [ev({ source: "keyword", verdict: "reject", eligible: false })], trusted: true }))).toMatchObject({ source: "trusted" });
  });
  it("ignores an ineligible reader_flag", () => {
    expect(supervise(art({ events: [ev({ source: "reader_flag", verdict: "reject", eligible: false })] }))).toBeNull();
    expect(supervise(art({ events: [ev({ source: "reader_flag", verdict: "reject", eligible: false })], jev: JEV_KEEP }))).toMatchObject({ source: "jev" });
  });
  it("a retracted admin decision falls through to the weaker source", () => {
    const gold = ev({ source: "admin", verdict: "reject", category: "cat_war" });
    const retract = ev({ source: "admin", verdict: "retract", retractsId: gold.id });
    expect(supervise(art({ events: [gold, retract], jev: JEV_KEEP }))).toMatchObject({ source: "jev" });
  });
  it("a cohort article whose only gold decision was retracted is not in test", () => {
    const gold = ev({ source: "admin", verdict: "keep" });
    const retract = ev({ source: "admin", verdict: "retract", retractsId: gold.id });
    const a = art({ id: idInCohort(true), events: [gold, retract] });
    expect(buildSplits([a], 7).test).toEqual([]);
  });
});
