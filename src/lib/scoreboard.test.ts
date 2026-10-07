import { describe, expect, it } from "vitest";
import { scoreSources, type ScoreRow } from "./scoreboard";

const row = (p: Partial<ScoreRow>): ScoreRow => ({ language: "fi", bucket: "leak", admin: "reject", keyword: false, ollama: null, jev: null, flagged: false, ...p });

describe("scoreSources", () => {
  it("splits cohort from targeted reviews", () => {
    const s = scoreSources([row({ bucket: "cohort" }), row({ bucket: "leak" }), row({ bucket: "manual" })]);
    expect(s.cohort.labels.all).toBe(1);
    expect(s.targeted.labels.all).toBe(2);
  });

  it("scores binary sources: agreement, reject precision, wrongly hidden", () => {
    const s = scoreSources([
      row({ admin: "reject", ollama: "reject", jev: "keep" }),
      row({ admin: "keep", ollama: "reject", jev: "keep" }),
      row({ admin: "keep", ollama: "keep", jev: null }),
    ]).targeted;
    expect(s.ollama.all).toEqual({ n: 3, agree: 2, agreement: 2 / 3, rejects: 2, rejectsCorrect: 1, rejectPrecision: 0.5, wronglyHidden: 1 });
    expect(s.jev.all).toMatchObject({ n: 2, agree: 1, rejects: 0, rejectPrecision: null, wronglyHidden: 0 });
  });

  it("scores reject-only sources by coverage and precision", () => {
    const s = scoreSources([
      row({ admin: "reject", keyword: true, flagged: true }),
      row({ admin: "keep", keyword: true }),
      row({ admin: "keep" }),
    ]).targeted;
    expect(s.keyword.all).toEqual({ n: 2, correct: 1, rejectPrecision: 0.5 });
    expect(s.flags.all).toEqual({ n: 1, correct: 1, rejectPrecision: 1 });
  });

  it("splits by language and returns null rates for empty slices", () => {
    const s = scoreSources([row({ language: "fi", ollama: "reject" })]).targeted;
    expect(s.ollama.fi.n).toBe(1);
    expect(s.ollama.en).toEqual({ n: 0, agree: 0, agreement: null, rejects: 0, rejectsCorrect: 0, rejectPrecision: null, wronglyHidden: 0 });
    expect(scoreSources([]).cohort.keyword.all.rejectPrecision).toBeNull();
  });
});
