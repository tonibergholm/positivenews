import { expect, it } from "vitest";
import { rejectionRateForCounts } from "./stats";

it.each([
  [10, 3, 5, 40],
  [5, 3, 0, 40],
  [5, 0, 5, 0],
  [0, 0, 0, 0],
  [3, 2, 0, 33],
  [4, 0, 0, 100],
])("computes rejection percentage for total=%i positive=%i pending=%i", (total, positive, pending, expected) => {
  expect(rejectionRateForCounts(total, positive, pending)).toBe(expected);
});

it("keeps overall and source rates consistent across approval of pending rows", () => {
  expect(rejectionRateForCounts(10, 3, 5)).toBe(40);
  expect(rejectionRateForCounts(10, 4, 4)).toBe(33);
});
