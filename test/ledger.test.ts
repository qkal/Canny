import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { append, read, sessionFile, sessionsDir, summarize, type Entry } from "../src/ledger.js";

beforeEach(() => {
  process.env.CANNY_HOME = mkdtempSync(join(tmpdir(), "canny-ledger-"));
});

describe("sessionFile", () => {
  // The session id comes from the hook payload, so it must never choose where the ledger lands.
  it.each(["../../escape", "/etc/passwd", "a/b\\c", "..", "id\0null", "id\nline"])(
    "keeps the session id %j inside the sessions directory",
    (session) => {
      const file = sessionFile("claude", session);
      expect(dirname(file)).toBe(sessionsDir());
      expect(file).toMatch(/\/claude-[\w.-]+\.jsonl$/);
    },
  );
});

describe("read", () => {
  // Hooks run in parallel and can be killed mid-append, so a ledger can hold a half-written line.
  it("skips a line that is not JSON and keeps the ones around it", () => {
    const file = sessionFile("claude", "torn");
    const verdict = (decision: string): Entry => ({
      ts: 1,
      type: "verdict",
      phase: "stop",
      decision,
    });
    append(file, verdict("block"));
    writeFileSync(file, '{"ts":2,"type":"verd', { flag: "a" });
    writeFileSync(file, "\n", { flag: "a" });
    append(file, verdict("allow"));
    expect(read(file).map((e) => e.type === "verdict" && e.decision)).toEqual(["block", "allow"]);
    expect(summarize(read(file)).factsSinceBlock).toBe(0);
  });
});
