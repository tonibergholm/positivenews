import { describe, expect, it } from "vitest";
import {
  currentAdminAuthority,
  isTestCohort,
  resolveLabel,
  TIER_WEIGHTS,
  type LabelEventLike,
} from "./labels";

let seq = 0;
function ev(p: Partial<LabelEventLike>): LabelEventLike {
  seq++;
  return {
    id: `e${seq}`,
    source: "ollama",
    verdict: "keep",
    category: null,
    eligible: true,
    bucket: null,
    retractsId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    ...p,
  };
}

// Find ids on either side of the cohort split.
function idInCohort(want: boolean): string {
  for (let i = 0; i < 10_000; i++) if (isTestCohort(`a${i}`) === want) return `a${i}`;
  throw new Error("no id");
}
const TRAIN_ID = idInCohort(false);
const TEST_ID = idInCohort(true);

describe("isTestCohort", () => {
  it("is deterministic and selects roughly 10%", () => {
    expect(isTestCohort(TEST_ID)).toBe(true);
    expect(isTestCohort(TEST_ID)).toBe(true);
    let n = 0;
    for (let i = 0; i < 5000; i++) if (isTestCohort(`article-${i}`)) n++;
    expect(n / 5000).toBeGreaterThan(0.08);
    expect(n / 5000).toBeLessThan(0.12);
  });
});

describe("isTestCohort pinned ids", () => {
  // Pins the hash split: changing the implementation would silently move the held-out cohort.
  it("keeps known ids on the same side", () => {
    expect(isTestCohort("article-13")).toBe(true);
    expect(isTestCohort("article-0")).toBe(false);
  });
});

describe("currentAdminAuthority", () => {
  it("returns the latest admin keep/reject", () => {
    const a1 = ev({ source: "admin", verdict: "keep" });
    const a2 = ev({ source: "admin", verdict: "reject", category: "cat_war" });
    expect(currentAdminAuthority([a2, a1])?.id).toBe(a2.id);
  });

  it("ignores retracted decisions and falls back to the previous one", () => {
    const a1 = ev({ source: "admin", verdict: "keep" });
    const a2 = ev({ source: "admin", verdict: "reject" });
    const r = ev({ source: "admin", verdict: "retract", retractsId: a2.id });
    expect(currentAdminAuthority([a1, a2, r])?.id).toBe(a1.id);
    const r1 = ev({ source: "admin", verdict: "retract", retractsId: a1.id });
    expect(currentAdminAuthority([a1, a2, r, r1])).toBeNull();
  });

  it("ignores non-admin events and breaks timestamp ties by id", () => {
    const t = new Date(Date.UTC(2026, 9, 2));
    const x = ev({ id: "x1", source: "admin", verdict: "keep", createdAt: t });
    const y = ev({ id: "x2", source: "admin", verdict: "reject", createdAt: t });
    const f = ev({ source: "reader_flag", verdict: "reject" });
    expect(currentAdminAuthority([y, f, x])?.id).toBe("x2");
    expect(currentAdminAuthority([f])).toBeNull();
  });
});

describe("resolveLabel", () => {
  it("gold: admin authority wins over everything", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "keyword", verdict: "reject" }),
      ev({ source: "reader_flag", verdict: "reject" }),
      ev({ source: "admin", verdict: "keep", bucket: "leak" }),
    ]);
    expect(r).toEqual({ label: "keep", category: null, tier: "gold", weight: TIER_WEIGHTS.gold, split: "train", bucket: "leak" });
  });

  it("gold carries the reject category", () => {
    const r = resolveLabel(TRAIN_ID, [ev({ source: "admin", verdict: "reject", category: "cat_sports", bucket: "flagged" })]);
    expect(r?.category).toBe("cat_sports");
  });

  it("flag tier beats Ollama and keyword", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "ollama", verdict: "keep" }),
      ev({ source: "reader_flag", verdict: "reject", eligible: true }),
    ]);
    expect(r).toMatchObject({ label: "reject", tier: "flag", weight: TIER_WEIGHTS.flag });
  });

  it("weak: latest eligible Ollama verdict, ignoring ineligible events", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "ollama", verdict: "reject" }),
      ev({ source: "ollama", verdict: "keep", eligible: false }),
    ]);
    expect(r).toMatchObject({ label: "reject", tier: "weak", weight: TIER_WEIGHTS.ollama });
  });

  it("weak: keyword reject when there is no eligible Ollama event", () => {
    const r = resolveLabel(TRAIN_ID, [
      ev({ source: "keyword", verdict: "reject" }),
      ev({ source: "ollama", verdict: "keep", eligible: false }),
    ]);
    expect(r).toMatchObject({ label: "reject", tier: "weak", weight: TIER_WEIGHTS.keyword });
  });

  it("a retracted admin decision no longer counts as gold", () => {
    const a = ev({ source: "admin", verdict: "reject" });
    const r = resolveLabel(TRAIN_ID, [ev({ source: "ollama", verdict: "keep" }), a, ev({ source: "admin", verdict: "retract", retractsId: a.id })]);
    expect(r).toMatchObject({ tier: "weak", label: "keep" });
  });

  it("marks cohort articles as test", () => {
    expect(resolveLabel(TEST_ID, [ev({ source: "ollama", verdict: "keep" })])?.split).toBe("test");
  });

  it("returns null without usable signal", () => {
    expect(resolveLabel(TRAIN_ID, [])).toBeNull();
    expect(resolveLabel(TRAIN_ID, [ev({ source: "ollama", verdict: "keep", eligible: false })])).toBeNull();
  });
});
