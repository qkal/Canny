import assert from "node:assert/strict";
import { test } from "node:test";
import * as stats from "../stats.js";

test("mean", () => assert.equal(stats.mean([1, 2, 3]), 2));
test("median of an odd count", () => assert.equal(stats.median([3, 1, 2]), 2));
test("median of an even count", () => assert.equal(stats.median([4, 1, 3, 2]), 2.5));
test("median sorts numbers, not strings", () => assert.equal(stats.median([10, 9, 100]), 10));
test("median leaves its input alone", () => {
  const nums = [3, 1, 2];
  stats.median(nums);
  assert.deepEqual(nums, [3, 1, 2]);
});
test("median of nothing", () => assert.throws(() => stats.median([]), RangeError));
