import { describe, expect, it } from "vitest";
import { isTestCohort, type LabelEventLike } from "./labels";
import { toExportRow, type ExportArticle } from "./labels-export";

function idInCohort(want: boolean): string {
  for (let i = 0; i < 10_000; i++) if (isTestCohort(`x${i}`) === want) return `x${i}`;
  throw new Error("no id");
}
const ev = (p: Partial<LabelEventLike>): LabelEventLike => ({ id: "e1", source: "ollama", verdict: "keep", category: null, eligible: true, bucket: null, retractsId: null, createdAt: new Date(0), ...p });
const art = (id: string, events: LabelEventLike[]): ExportArticle => ({ id, title: "T", summary: "  S  ", language: "fi", createdAt: new Date("2026-10-01T00:00:00Z"), events, jev: null });

describe("toExportRow", () => {
  it("builds a train row with state, tier, weight and split", () => {
    const id = idInCohort(false);
    expect(toExportRow(art(id, [ev({ source: "admin", verdict: "reject", category: "cat_war", bucket: "leak" })]))).toEqual({
      articleId: id, state: { title: "T", summary: "S" }, language: "fi", createdAt: "2026-10-01T00:00:00.000Z",
      label: "reject", category: "cat_war", tier: "gold", weight: 1, bucket: "leak", split: "train", jev: null,
    });
  });

  it("marks cohort articles as test and skips articles without a label", () => {
    expect(toExportRow(art(idInCohort(true), [ev({})]))?.split).toBe("test");
    expect(toExportRow(art(idInCohort(false), []))).toBeNull();
  });
});
