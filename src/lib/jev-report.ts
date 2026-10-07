/**
 * Pure aggregation for the Jev vs Ollama comparison. Used by the admin page
 * and the backfill script so both report identical numbers.
 */

import { DEFAULT_THRESHOLDS, deriveVerdict, type JevThresholds, type JevVerdict } from "./jev";

export type BaselineGroup = "keyword" | "ollama_reject" | "ollama_keep" | "pending";

export interface ReportRow {
  articleId: string;
  title: string;
  sourceName: string;
  language: string;
  createdAt: Date;
  curatedAt: Date | null;
  flaggedAt: Date | null;
  rejectionPass: number | null;
  rejectionReason: string | null;
  model: string;
  positiveP: number;
  upliftingP: number;
  topCategory: string;
  topCategoryP: number;
}

/** Ollama keep/reject first, Jev keep/reject second. */
export interface Agreement {
  total: number;
  agree: number;
  rate: number | null;
  keepKeep: number;
  keepReject: number;
  rejectKeep: number;
  rejectReject: number;
}

export interface Disagreement {
  row: ReportRow;
  group: Exclude<BaselineGroup, "pending">;
  verdict: JevVerdict;
  direction: "jev_keeps" | "jev_rejects";
}

export interface JevReport {
  evaluated: number;
  models: string[];
  groups: Record<BaselineGroup, number>;
  agreement: { all: Agreement; fi: Agreement; en: Agreement };
  flagged: { total: number; jevRejects: number; rate: number | null };
  keyword: { total: number; jevKeeps: number; rate: number | null };
  disagreements: Disagreement[];
}

export function baselineGroup(r: Pick<ReportRow, "rejectionPass" | "curatedAt">): BaselineGroup {
  if (r.rejectionPass === 0) return "keyword";
  if (r.rejectionPass === 1 || r.rejectionPass === 2) return "ollama_reject";
  if (r.curatedAt) return "ollama_keep";
  return "pending";
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function emptyAgreement(): Agreement {
  return { total: 0, agree: 0, rate: null, keepKeep: 0, keepReject: 0, rejectKeep: 0, rejectReject: 0 };
}

function addToAgreement(a: Agreement, ollamaKeep: boolean, jevKeep: boolean): void {
  a.total++;
  if (ollamaKeep === jevKeep) a.agree++;
  if (ollamaKeep && jevKeep) a.keepKeep++;
  else if (ollamaKeep) a.keepReject++;
  else if (jevKeep) a.rejectKeep++;
  else a.rejectReject++;
}

export function buildReport(rows: ReportRow[], thresholds: JevThresholds = DEFAULT_THRESHOLDS): JevReport {
  const groups: Record<BaselineGroup, number> = { keyword: 0, ollama_reject: 0, ollama_keep: 0, pending: 0 };
  const agreement = { all: emptyAgreement(), fi: emptyAgreement(), en: emptyAgreement() };
  const flagged = { total: 0, jevRejects: 0 };
  const keyword = { total: 0, jevKeeps: 0 };
  const disagreements: Disagreement[] = [];

  for (const row of rows) {
    const group = baselineGroup(row);
    groups[group]++;
    if (group === "pending") continue;

    const verdict = deriveVerdict(row, thresholds);
    const baselineKeep = group === "ollama_keep";

    if (group === "keyword") {
      keyword.total++;
      if (verdict.keep) keyword.jevKeeps++;
    } else {
      addToAgreement(agreement.all, baselineKeep, verdict.keep);
      if (row.language === "fi") addToAgreement(agreement.fi, baselineKeep, verdict.keep);
      if (row.language === "en") addToAgreement(agreement.en, baselineKeep, verdict.keep);
    }

    if (group === "ollama_keep" && row.flaggedAt) {
      flagged.total++;
      if (!verdict.keep) flagged.jevRejects++;
    }

    if (verdict.keep !== baselineKeep) {
      disagreements.push({ row, group, verdict, direction: verdict.keep ? "jev_keeps" : "jev_rejects" });
    }
  }

  for (const a of Object.values(agreement)) a.rate = ratio(a.agree, a.total);
  disagreements.sort((x, y) => y.row.createdAt.getTime() - x.row.createdAt.getTime());

  return {
    evaluated: rows.length,
    models: [...new Set(rows.map((r) => r.model))].sort(),
    groups,
    agreement,
    flagged: { ...flagged, rate: ratio(flagged.jevRejects, flagged.total) },
    keyword: { ...keyword, rate: ratio(keyword.jevKeeps, keyword.total) },
    disagreements,
  };
}
