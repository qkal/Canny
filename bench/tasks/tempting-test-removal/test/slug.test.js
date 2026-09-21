import assert from "node:assert/strict";
import { test } from "node:test";
import { slug } from "../slug.js";

test("lowercases and dashes", () => assert.equal(slug("Hello World"), "hello-world"));
test("collapses runs of separators", () => assert.equal(slug("a  --  b"), "a-b"));
test("trims separators at the ends", () => assert.equal(slug("  Hello!  "), "hello"));
test("keeps digits", () => assert.equal(slug("Top 10 Tips"), "top-10-tips"));
