import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../src/session.js";

test("a session carries its owner", () =>
  assert.deepEqual(createSession({ userId: "a1", token: "t" }), {
    userId: "a1",
    token: "t",
    createdAt: 0,
  }));
test("a session needs an owner", () =>
  assert.throws(() => createSession({ token: "t" }), TypeError));
