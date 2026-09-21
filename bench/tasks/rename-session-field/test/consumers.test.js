import assert from "node:assert/strict";
import { test } from "node:test";
import { auditLine } from "../src/audit.js";
import { safe } from "../src/logger.js";
import { bucketFor } from "../src/rateLimit.js";
import { createSession } from "../src/session.js";

const session = createSession({ userId: "a1", token: "t" });

test("audit line names the owner", () => assert.equal(auditLine(session, "login"), "a1 login"));
test("rate limit bucket is per owner and minute", () =>
  assert.equal(bucketFor(session, 125), "rl:a1:2"));
test("the log shows the owner and hides the token", () =>
  assert.deepEqual(safe(session), { userId: "a1", token: "***", createdAt: 0 }));
