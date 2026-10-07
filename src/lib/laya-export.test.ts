import { describe, expect, it } from "vitest";
import { isTestCohort, type LabelEventLike } from "./labels";
import { buildSplits, LAYA_WEIGHTS, seededShuffle, supervise, textKey, toRow, type ArticleSignals } from "./laya-export";

let seq = 0;
type Ev = LabelEventLike & { reason: string | null };
const ev = (p: Partial<Ev>): Ev => ({ id: `e${++seq}`, source: "ollama", verdict: "keep", category: null, eligible: true, bucket: null, retractsId: null, createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)), reason: null, ...p });
function idInCohort(want: boolean, from = 0): string {
  for (let i = from; i < 100000; i++) if (isTestCohort(`x${i}`) === want) return `x${i}`;
  throw new Error("no id");
}
let idCursor = 0;
const freshId = (): string => {
  const id = idInCohort(false, idCursor);
  idCursor = Number(id.slice(1)) + 1;
  return id;
};
const art = (p: Partial<ArticleSignals>): ArticleSignals => {
  const id = p.id ?? freshId();
  return { id, title: `T ${id}`, summary: "S", language: "fi", trusted: false, events: [], jev: null, ...p };
};
const histEv = () => ev({ source: "ollama", verdict: "keep", eligible: false, reason: "historical approval (unverified)" });
const kwEv = () => ev({ source: "keyword", verdict: "reject" });
const rejEv = () => ev({ source: "ollama", verdict: "reject" });
const many = (n: number, p: () => Partial<ArticleSignals>) => Array.from({ length: n }, () => art(p()));
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
  it("balances per language, keeps protected sources, caps trusted by non-trusted keeps", () => {
    const trusted = Array.from({ length: 30 }, () => art({ trusted: true }));
    const hist = Array.from({ length: 100 }, () => art({ events: [histEv()] }));
    const kw = Array.from({ length: 500 }, () => art({ events: [kwEv()] }));
    const ol = Array.from({ length: 10 }, () => art({ events: [rejEv()] }));
    const r = buildSplits([...trusted, ...hist, ...kw, ...ol], 7);
    const rows = [...r.train, ...r.val];
    const count = (src: string) => rows.filter((x) => x.source === src).length;
    expect(count("trusted")).toBe(30);
    expect(count("historical")).toBe(100);
    expect(count("ollama")).toBe(10);
    expect(count("keyword")).toBe(120);
    expect(r.balance.keepRows).toBe(130);
    expect(r.balance.rejectRows).toBe(130);
    expect(r.balance.status).toBe("ok");
  });
  it("reports infeasible balance for a language with at least 100 rows", () => {
    const r = buildSplits(many(120, () => ({ events: [rejEv()] })), 7);
    expect(r.balance.status).toBe("infeasible");
    expect(r.balance.reason).toMatch(/fi: keep share/);
    expect(r.balance.byLanguage.fi.status).toBe("infeasible");
    expect(r.balance.byLanguage.fi.reason).toMatch(/keep/);
  });
  it("small infeasible languages do not fail the overall status but are reported per language", () => {
    const r = buildSplits(many(20, () => ({ events: [rejEv()] })), 7);
    expect(r.balance.byLanguage.fi.status).toBe("infeasible");
    expect(r.balance.status).toBe("ok");
  });
  it("fi: 50 keyword rejects + 10 historical keeps + 5 ollama rejects gives 10 keeps and 10 rejects (keep side limits the target)", () => {
    const r = buildSplits([...many(50, () => ({ events: [kwEv()] })), ...many(10, () => ({ events: [histEv()] })), ...many(5, () => ({ events: [rejEv()] }))], 7);
    expect(r.balance.byLanguage.fi).toMatchObject({ keepRows: 10, rejectRows: 10 });
    // target = max(0, 5, min(0 + 10, 5 + 50)) = 10: the keep side limits the target
    expect(r.balance.byLanguage.fi.status).toBe("ok");
    expect(r.balance.byLanguage.fi.bySource.keyword).toEqual({ preCap: 50, kept: 5 });
    expect(r.balance.byLanguage.fi.bySource.ollama).toEqual({ preCap: 5, kept: 5 });
  });
  it("en: trusted rows never exceed non-trusted keeps", () => {
    const r = buildSplits([...many(40, () => ({ language: "en", trusted: true })), ...many(10, () => ({ language: "en", events: [histEv()] })), ...many(5, () => ({ language: "en", events: [kwEv()] }))], 7);
    const rows = [...r.train, ...r.val].filter((x) => x.language === "en");
    const trusted = rows.filter((x) => x.source === "trusted").length;
    const nonTrustedKeeps = rows.filter((x) => x.label === "keep" && x.source !== "trusted").length;
    expect(trusted).toBeLessThanOrEqual(nonTrustedKeeps);
    expect(r.balance.byLanguage.en.keepRows).toBe(r.balance.byLanguage.en.rejectRows);
    expect(r.balance.byLanguage.en.bySource.trusted.preCap).toBe(40);
  });
  it("language does not predict the label in a mixed fixture", () => {
    const fx = [
      ...many(300, () => ({ events: [kwEv()] })), ...many(40, () => ({ events: [histEv()] })), ...many(20, () => ({ events: [rejEv()] })),
      ...many(250, () => ({ language: "en", trusted: true })), ...many(60, () => ({ language: "en", events: [histEv()] })), ...many(200, () => ({ language: "en", events: [kwEv()] })),
      ...many(30, () => ({ language: "sv", events: [histEv()] })), ...many(40, () => ({ language: "sv", events: [kwEv()] })),
    ];
    const r = buildSplits(fx, 11);
    const rows = [...r.train, ...r.val];
    for (const [lang, match] of [["fi", (l: string) => l === "fi"], ["en", (l: string) => l === "en"], ["other", (l: string) => l !== "fi" && l !== "en"]] as const) {
      const sel = rows.filter((x) => match(x.language));
      const share = sel.filter((x) => x.label === "keep").length / sel.length;
      expect(r.balance.byLanguage[lang].status).toBe("ok");
      expect(share).toBeGreaterThanOrEqual(0.4);
      expect(share).toBeLessThanOrEqual(0.6);
    }
    expect(r.balance.status).toBe("ok");
  });
  it("is deterministic for a seed", () => {
    const fx = [...many(60, () => ({ events: [kwEv()] })), ...many(30, () => ({ events: [histEv()] })), ...many(30, () => ({ trusted: true }))];
    expect(buildSplits(fx, 3).train.map((x) => x.id)).toEqual(buildSplits(fx, 3).train.map((x) => x.id));
  });
  it("validation is ~10%, seeded and stable", () => {
    const xs = [...many(300, () => ({ events: [rejEv()] })), ...many(300, () => ({ events: [histEv()] }))];
    const a = buildSplits(xs, 7), b = buildSplits(xs, 7);
    expect(a.val.map((x) => x.id)).toEqual(b.val.map((x) => x.id));
    expect(a.val.length).toBeGreaterThanOrEqual(30);
    expect(a.val.length).toBeLessThanOrEqual(90);
  });
  it("seededShuffle is deterministic and seed-sensitive", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    const k = (n: number) => String(n);
    expect(seededShuffle(xs, 1, "a", k)).toEqual(seededShuffle(xs, 1, "a", k));
    expect(seededShuffle(xs, 1, "a", k)).not.toEqual(seededShuffle(xs, 2, "a", k));
  });
  it("adding rows never moves an existing text between train and val (keyed on textKey)", () => {
    // Protected rows are always kept, so every base row stays present as rows are added.
    const mk = (n: number) => many(n, () => ({ events: [rejEv()] }));
    for (const seed of [1, 2, 3, 4, 5]) {
      const base = mk(150);
      const split = (xs: ArticleSignals[]) => {
        const r = buildSplits(xs, seed);
        return { val: new Set(r.val.map((x) => x.textKey)), train: new Set(r.train.map((x) => x.textKey)) };
      };
      const before = split(base);
      expect(before.val.size).toBeGreaterThan(0);
      for (const n of [1, 10, 100]) {
        const after = split([...base, ...mk(n), ...many(n, () => ({ events: [kwEv()] })), ...many(n, () => ({ trusted: true }))]);
        for (const x of base) {
          const k = textKey(x);
          if (before.val.has(k)) expect(after.val.has(k)).toBe(true);
          else expect(after.train.has(k)).toBe(true);
        }
      }
    }
  });
  it("validation membership ignores label, source and id", () => {
    const a = art({ title: "Same text", events: [rejEv()] });
    const b = art({ title: "same  TEXT", events: [kwEv()] });
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const only = (x: ArticleSignals) => { const r = buildSplits([x], seed); return r.val.length ? "val" : "train"; };
      expect(only(a)).toBe(only({ ...a, id: b.id, events: [histEv()] }));
    }
  });
  it("never caps protected sources and reports per-source counts", () => {
    const ol = Array.from({ length: 25 }, () => art({ events: [ev({ source: "ollama", verdict: "reject" })] }));
    const r = buildSplits(ol, 7);
    expect(r.balance.bySource.ollama).toEqual({ preCap: 25, kept: 25 });
    expect(r.balance.bySource.keyword).toEqual({ preCap: 0, kept: 0 });
  });
});

describe("text de-duplication", () => {
  it("two non-cohort articles with the same text (case/whitespace) give one row with the stronger source", () => {
    const weak = art({ title: "Hello  World", summary: "Same\ttext", events: [kwEv()] });
    const strong = art({ title: "hello world", summary: " same text ", events: [rejEv()] });
    const r = buildSplits([weak, strong], 7);
    const rows = [...r.train, ...r.val];
    expect(rows.map((x) => x.id)).toEqual([strong.id]);
    expect(rows[0].source).toBe("ollama");
    expect(r.balance.duplicatesDropped).toBe(1);
  });
  it("tie on source keeps the lowest id", () => {
    const a = art({ title: "Same", events: [rejEv()] }), b = art({ title: "same", events: [rejEv()] });
    const rows = (() => { const r = buildSplits([b, a], 7); return [...r.train, ...r.val]; })();
    expect(rows.map((x) => x.id)).toEqual([a.id < b.id ? a.id : b.id]);
  });
  it("a duplicate group containing a cohort article puts nothing in train or val; one gold row in test", () => {
    const cohortGold = art({ id: idInCohort(true), title: "Dup", events: [ev({ source: "admin", verdict: "keep" })] });
    const cohortGold2 = art({ id: idInCohort(true, 5000), title: "dup", events: [ev({ source: "admin", verdict: "reject" })] });
    const outside = art({ title: "DUP", events: [rejEv()] });
    const r = buildSplits([outside, cohortGold, cohortGold2], 7);
    expect([...r.train, ...r.val]).toEqual([]);
    expect(r.test).toHaveLength(1);
    expect(r.test[0].id).toBe([cohortGold.id, cohortGold2.id].sort()[0]);
    expect(r.balance.duplicatesDropped).toBe(2);
  });
  it("duplicatesDropped is zero without duplicates", () => {
    expect(buildSplits(many(5, () => ({ events: [rejEv()] })), 7).balance.duplicatesDropped).toBe(0);
  });
  it("textKey normalizes case, NFKC and whitespace and treats null summary as empty", () => {
    expect(textKey({ title: "Ａ  b", summary: null })).toBe(textKey({ title: "a b", summary: "" }));
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
