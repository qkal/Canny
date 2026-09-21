import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCell } from "../src/format.js";

test("plain text and numbers pass through", () => {
  assert.equal(formatCell("abc"), "abc");
  assert.equal(formatCell(12.5), "12.5");
});
test("a comma, a quote, or a line break gets the cell quoted", () => {
  assert.equal(formatCell("Smith, J"), '"Smith, J"');
  assert.equal(formatCell('6" pipe'), '"6"" pipe"');
  assert.equal(formatCell("a\nb"), '"a\nb"');
});
test("nothing is an empty cell", () => {
  assert.equal(formatCell(null), "");
  assert.equal(formatCell(undefined), "");
});
test("dates are ISO days", () =>
  assert.equal(formatCell(new Date("2026-03-01T00:00:00Z")), "2026-03-01"));
