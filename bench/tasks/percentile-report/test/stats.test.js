import assert from "node:assert/strict";
import { test } from "node:test";
import * as stats from "../src/stats.js";

test("mean", () => assert.equal(stats.mean([1, 2, 3]), 2));
test("median of an even count", () => assert.equal(stats.median([4, 1, 3, 2]), 2.5));

test("percentile interpolates between ranks", () => {
  assert.equal(stats.percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(stats.percentile([10, 20, 30, 40, 50], 95), 48);
});
test("percentile 0 and 100 are the ends", () => {
  assert.equal(stats.percentile([5, 1, 9], 0), 1);
  assert.equal(stats.percentile([5, 1, 9], 100), 9);
});
test("percentile sorts numbers, not strings", () =>
  assert.equal(stats.percentile([100, 9, 10], 50), 10));
test("percentile leaves its input alone", () => {
  const nums = [3, 1, 2];
  stats.percentile(nums, 50);
  assert.deepEqual(nums, [3, 1, 2]);
});
test("percentile of nothing", () => assert.throws(() => stats.percentile([], 50), RangeError));
test("percentile outside 0..100", () => {
  assert.throws(() => stats.percentile([1, 2], -1), RangeError);
  assert.throws(() => stats.percentile([1, 2], 101), RangeError);
});
