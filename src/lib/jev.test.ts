import { describe, expect, it } from "vitest";
import {
  buildState,
  CATEGORIES,
  DEFAULT_THRESHOLDS,
  deriveVerdict,
  QUESTIONS,
  summarizeAnswers,
} from "./jev";

const CATEGORY_KEYS = Object.keys(CATEGORIES);

function answers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    positive: { type: "noul", noul: 0.9 },
    uplifting: { type: "noul", noul: 0.8 },
    uplift: { type: "score", score: 2.5, confidence: 0.7, legend: {}, probabilities: {} },
  };
  for (const key of CATEGORY_KEYS) base[key] = { type: "noul", noul: 0.05 };
  return { ...base, ...overrides };
}

describe("buildState", () => {
  it("includes a trimmed summary cut to 300 characters", () => {
    const state = buildState({ title: "T", summary: `  ${"a".repeat(400)}  ` });
    expect(state).toEqual({ title: "T", summary: "a".repeat(300) });
  });

  it("omits a missing, null, empty or whitespace-only summary", () => {
    expect(buildState({ title: "T" })).toEqual({ title: "T" });
    expect(buildState({ title: "T", summary: null })).toEqual({ title: "T" });
    expect(buildState({ title: "T", summary: "" })).toEqual({ title: "T" });
    expect(buildState({ title: "T", summary: "   " })).toEqual({ title: "T" });
    expect("summary" in buildState({ title: "T", summary: " " })).toBe(false);
  });
});

describe("QUESTIONS", () => {
  it("asks the two mirror Nouls, the uplift Score and all 17 categories", () => {
    expect(CATEGORY_KEYS).toHaveLength(17);
    expect(QUESTIONS.positive.type).toBe("noul");
    expect(QUESTIONS.uplifting.type).toBe("noul");
    expect(QUESTIONS.uplift.type).toBe("score");
    for (const key of CATEGORY_KEYS) {
      expect(key.startsWith("cat_")).toBe(true);
      expect(QUESTIONS[key].type).toBe("noul");
    }
    expect(Object.keys(QUESTIONS)).toHaveLength(20);
  });
});

describe("summarizeAnswers", () => {
  it("extracts mirror probabilities, uplift score and the top category", () => {
    const s = summarizeAnswers(answers({ cat_sports: { type: "noul", noul: 0.7 } }));
    expect(s).toEqual({
      positiveP: 0.9,
      upliftingP: 0.8,
      upliftScore: 2.5,
      topCategory: "cat_sports",
      topCategoryP: 0.7,
    });
  });

  it("breaks ties in favour of the first category in CATEGORIES order", () => {
    const [first, second] = CATEGORY_KEYS;
    const s = summarizeAnswers(
      answers({
        [second]: { type: "noul", noul: 0.8 },
        [first]: { type: "noul", noul: 0.8 },
      }),
    );
    expect(s.topCategory).toBe(first);
  });

  it("throws when a question is missing", () => {
    const a = answers();
    delete a.cat_war;
    expect(() => summarizeAnswers(a)).toThrow(/cat_war/);
  });

  it("throws when an answer has the wrong type or a non-finite value", () => {
    expect(() => summarizeAnswers(answers({ positive: { type: "score", score: 1 } }))).toThrow(/positive/);
    expect(() => summarizeAnswers(answers({ uplifting: { type: "noul", noul: Number.NaN } }))).toThrow(/uplifting/);
    expect(() => summarizeAnswers(answers({ uplift: { type: "noul", noul: 1 } }))).toThrow(/uplift/);
  });

  it("throws, naming the key, when a value is out of range", () => {
    expect(() => summarizeAnswers(answers({ positive: { type: "noul", noul: 1.5 } }))).toThrow(/positive/);
    expect(() => summarizeAnswers(answers({ cat_war: { type: "noul", noul: -0.1 } }))).toThrow(/cat_war/);
    expect(() => summarizeAnswers(answers({ uplift: { type: "score", score: 3.5 } }))).toThrow(/uplift/);
  });
});

describe("deriveVerdict", () => {
  const ok = { positiveP: 0.9, upliftingP: 0.9, topCategory: "cat_war", topCategoryP: 0.1 };

  it("keeps an article that passes every threshold", () => {
    expect(deriveVerdict(ok)).toEqual({ keep: true, reason: null, topCategory: null });
  });

  it("rejects on a category strictly above categoryMax, using its label", () => {
    const v = deriveVerdict({ ...ok, topCategoryP: 0.61 });
    expect(v).toEqual({ keep: false, reason: `jev: ${CATEGORIES.cat_war.label}`, topCategory: "cat_war" });
    expect(deriveVerdict({ ...ok, topCategoryP: 0.6 }).keep).toBe(true);
  });

  it("rejects when positive or uplifting is strictly below its minimum", () => {
    expect(deriveVerdict({ ...ok, positiveP: 0.49 }).reason).toBe("jev: not positive");
    expect(deriveVerdict({ ...ok, upliftingP: 0.49 }).reason).toBe("jev: not uplifting");
    expect(deriveVerdict({ ...ok, positiveP: 0.5, upliftingP: 0.5 }).keep).toBe(true);
  });

  it("reports the category first, then not positive, then not uplifting", () => {
    expect(deriveVerdict({ positiveP: 0.1, upliftingP: 0.1, topCategory: "cat_war", topCategoryP: 0.9 }).topCategory).toBe("cat_war");
    expect(deriveVerdict({ ...ok, positiveP: 0.1, upliftingP: 0.1 }).reason).toBe("jev: not positive");
  });

  it("accepts custom thresholds", () => {
    expect(deriveVerdict({ ...ok, positiveP: 0.6 }, { ...DEFAULT_THRESHOLDS, positiveMin: 0.7 }).keep).toBe(false);
  });
});
