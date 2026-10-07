import { describe, expect, it } from "vitest";
import { baselineGroup, buildReport, type ReportRow } from "./jev-report";

const KEEP = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.1 };
const REJECT = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.9 };

let seq = 0;
function row(overrides: Partial<ReportRow>, jev: typeof KEEP = KEEP): ReportRow {
  seq++;
  return {
    articleId: `a${seq}`,
    title: `Article ${seq}`,
    sourceName: "Yle",
    language: "fi",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    curatedAt: null,
    flaggedAt: null,
    rejectionPass: null,
    rejectionReason: null,
    model: "jev-1.13.0",
    ...jev,
    ...overrides,
  };
}

const curated = new Date(Date.UTC(2026, 9, 1));

describe("baselineGroup", () => {
  it("classifies keyword, Ollama reject, Ollama keep and pending", () => {
    expect(baselineGroup({ rejectionPass: 0, curatedAt: null })).toBe("keyword");
    expect(baselineGroup({ rejectionPass: 1, curatedAt: curated })).toBe("ollama_reject");
    expect(baselineGroup({ rejectionPass: 2, curatedAt: curated })).toBe("ollama_reject");
    expect(baselineGroup({ rejectionPass: null, curatedAt: curated })).toBe("ollama_keep");
    expect(baselineGroup({ rejectionPass: null, curatedAt: null })).toBe("pending");
  });
});

describe("buildReport", () => {
  it("returns null rates and empty lists for no rows", () => {
    const r = buildReport([]);
    expect(r.evaluated).toBe(0);
    expect(r.agreement.all.rate).toBeNull();
    expect(r.agreement.fi.rate).toBeNull();
    expect(r.flagged.rate).toBeNull();
    expect(r.keyword.rate).toBeNull();
    expect(r.disagreements).toEqual([]);
    expect(r.models).toEqual([]);
  });

  it("computes agreement and the 2x2 matrix over Ollama groups only", () => {
    const rows = [
      row({ curatedAt: curated }, KEEP),                         // keep / keep
      row({ curatedAt: curated }, REJECT),                       // keep / reject
      row({ curatedAt: curated, rejectionPass: 1 }, KEEP),       // reject / keep
      row({ curatedAt: curated, rejectionPass: 2 }, REJECT),     // reject / reject
      row({ rejectionPass: 0 }, KEEP),                           // keyword: excluded
      row({}, REJECT),                                           // pending: excluded
    ];
    const a = buildReport(rows).agreement.all;
    expect(a).toEqual({ total: 4, agree: 2, rate: 0.5, keepKeep: 1, keepReject: 1, rejectKeep: 1, rejectReject: 1 });
  });

  it("splits agreement by language and leaves an empty language null", () => {
    const rows = [
      row({ curatedAt: curated, language: "fi" }, KEEP),
      row({ curatedAt: curated, language: "fi" }, REJECT),
      row({ curatedAt: curated, language: "sv" }, KEEP),
    ];
    const r = buildReport(rows);
    expect(r.agreement.fi).toMatchObject({ total: 2, agree: 1, rate: 0.5 });
    expect(r.agreement.en).toMatchObject({ total: 0, rate: null });
    expect(r.agreement.all.total).toBe(3);
  });

  it("measures flagged articles Jev rejects and keyword rejects Jev keeps", () => {
    const rows = [
      row({ curatedAt: curated, flaggedAt: curated }, REJECT),
      row({ curatedAt: curated, flaggedAt: curated }, KEEP),
      row({ rejectionPass: 0 }, KEEP),
      row({ rejectionPass: 0 }, KEEP),
      row({ rejectionPass: 0 }, REJECT),
      row({ flaggedAt: curated }, REJECT), // flagged before curation: pending, not counted
    ];
    const r = buildReport(rows);
    expect(r.flagged).toEqual({ total: 2, jevRejects: 1, rate: 0.5 });
    expect(r.keyword.total).toBe(3);
    expect(r.keyword.jevKeeps).toBe(2);
    expect(r.keyword.rate).toBeCloseTo(2 / 3);
    expect(r.groups).toEqual({ keyword: 3, ollama_reject: 0, ollama_keep: 2, pending: 1 });
  });

  it("lists disagreements newest first with direction, excluding pending", () => {
    const older = row({ curatedAt: curated, rejectionPass: 1 }, KEEP);
    const newer = row({ curatedAt: curated }, REJECT);
    const kw = row({ rejectionPass: 0 }, KEEP);
    const agreeing = row({ curatedAt: curated }, KEEP);
    const pending = row({}, REJECT);
    const d = buildReport([older, newer, kw, agreeing, pending]).disagreements;
    expect(d.map((x) => x.row.articleId)).toEqual([kw.articleId, newer.articleId, older.articleId]);
    expect(d.map((x) => x.direction)).toEqual(["jev_keeps", "jev_rejects", "jev_keeps"]);
    expect(d[1].verdict.topCategory).toBe("cat_war");
  });

  it("applies custom thresholds", () => {
    const rows = [row({ curatedAt: curated }, { ...KEEP, topCategoryP: 0.5 })];
    expect(buildReport(rows).agreement.all.agree).toBe(1);
    expect(buildReport(rows, { positiveMin: 0.5, upliftingMin: 0.5, categoryMax: 0.4 }).agreement.all.agree).toBe(0);
  });

  it("lists distinct models", () => {
    const rows = [row({ model: "jev-1.13.0" }), row({ model: "jev-1.13.0" }), row({ model: "jev-1.14.0" })];
    expect(buildReport(rows).models).toEqual(["jev-1.13.0", "jev-1.14.0"]);
  });
});
