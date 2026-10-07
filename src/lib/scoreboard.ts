/**
 * Scores each filtering source against admin decisions (gold labels).
 * Random-cohort reviews are reported apart from targeted reviews, because
 * targeted buckets over-sample disagreements.
 */

export type Slice = "all" | "fi" | "en";
const SLICES: Slice[] = ["all", "fi", "en"];

export interface ScoreRow {
  language: string;
  bucket: string | null;
  admin: "keep" | "reject";
  keyword: boolean;
  ollama: "keep" | "reject" | null;
  jev: "keep" | "reject" | null;
  laya: "keep" | "reject" | null;
  flagged: boolean;
}

export interface BinaryScore { n: number; agree: number; agreement: number | null; rejects: number; rejectsCorrect: number; rejectPrecision: number | null; wronglyHidden: number }
export interface RejectOnlyScore { n: number; correct: number; rejectPrecision: number | null }
export interface ScoreTable {
  labels: Record<Slice, number>;
  ollama: Record<Slice, BinaryScore>;
  jev: Record<Slice, BinaryScore>;
  laya: Record<Slice, BinaryScore>;
  keyword: Record<Slice, RejectOnlyScore>;
  flags: Record<Slice, RejectOnlyScore>;
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
const perSlice = <T>(make: () => T): Record<Slice, T> => ({ all: make(), fi: make(), en: make() });
const emptyBinary = (): BinaryScore => ({ n: 0, agree: 0, agreement: null, rejects: 0, rejectsCorrect: 0, rejectPrecision: null, wronglyHidden: 0 });
const emptyRejectOnly = (): RejectOnlyScore => ({ n: 0, correct: 0, rejectPrecision: null });

function slicesFor(language: string): Slice[] {
  return language === "fi" || language === "en" ? ["all", language] : ["all"];
}

function scoreTable(rows: ScoreRow[]): ScoreTable {
  const t: ScoreTable = {
    labels: { all: 0, fi: 0, en: 0 },
    ollama: perSlice(emptyBinary),
    jev: perSlice(emptyBinary),
    laya: perSlice(emptyBinary),
    keyword: perSlice(emptyRejectOnly),
    flags: perSlice(emptyRejectOnly),
  };

  for (const r of rows) {
    for (const s of slicesFor(r.language)) {
      t.labels[s]++;
      for (const key of ["ollama", "jev", "laya"] as const) {
        const v = r[key];
        if (!v) continue;
        const b = t[key][s];
        b.n++;
        if (v === r.admin) b.agree++;
        if (v === "reject") {
          b.rejects++;
          if (r.admin === "reject") b.rejectsCorrect++;
          else b.wronglyHidden++;
        }
      }
      if (r.keyword) {
        t.keyword[s].n++;
        if (r.admin === "reject") t.keyword[s].correct++;
      }
      if (r.flagged) {
        t.flags[s].n++;
        if (r.admin === "reject") t.flags[s].correct++;
      }
    }
  }

  for (const s of SLICES) {
    for (const key of ["ollama", "jev", "laya"] as const) {
      const b = t[key][s];
      b.agreement = ratio(b.agree, b.n);
      b.rejectPrecision = ratio(b.rejectsCorrect, b.rejects);
    }
    for (const key of ["keyword", "flags"] as const) t[key][s].rejectPrecision = ratio(t[key][s].correct, t[key][s].n);
  }
  return t;
}

export function scoreSources(rows: ScoreRow[]): { cohort: ScoreTable; targeted: ScoreTable } {
  return {
    cohort: scoreTable(rows.filter((r) => r.bucket === "cohort")),
    targeted: scoreTable(rows.filter((r) => r.bucket !== "cohort")),
  };
}
