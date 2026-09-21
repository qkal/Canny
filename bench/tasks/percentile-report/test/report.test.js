import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../src/report.js";

test("one line with the p95 last", () =>
  assert.equal(summarize([1, 2, 3, 4]), "n=4 mean=2.50 median=2.50 p95=3.85"));
test("a single sample", () => assert.equal(summarize([7]), "n=1 mean=7.00 median=7.00 p95=7.00"));
