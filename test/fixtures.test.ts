import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { normalize } from "../src/events.js";
import { handle } from "../src/hook.js";
import { sessionFile } from "../src/ledger.js";

const fixtures = join(import.meta.dirname, "fixtures");

beforeEach(() => {
  process.env.CANNY_HOME = mkdtempSync(join(tmpdir(), "canny-fixtures-"));
});

// Payloads recorded from real agent sessions and scrubbed by `fixtures/scrub.mjs`. The payloads in the
// other test files are written by hand and show what Canny expects; these show what the agents send.
// Each session writes a file, edits it, runs a command that exits 3, runs one that passes, and stops.
describe("recorded sessions", () => {
  it.each(["claude-code", "codex"])(
    "%s: every event reads as it did when recorded, and the Stop is blocked",
    async (name) => {
      const payloads = readFileSync(join(fixtures, `${name}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        // Codex keeps exit codes in its rollout file, so the recorded one stands in for it.
        .map((p) =>
          p.transcript_path === "ROLLOUT"
            ? { ...p, transcript_path: join(fixtures, "codex-rollout.jsonl") }
            : p,
        );
      const read = [];
      for (const payload of payloads) {
        const ctx = normalize(payload);
        const file = sessionFile(ctx.agent, ctx.session);
        const decision = await handle(ctx, { config: {}, judge: async () => null, file });
        read.push({ ...ctx, decision: decision.kind });
      }
      expect(read).toMatchSnapshot();
      expect(read.at(-1)).toMatchObject({ phase: "stop", decision: "block" });
      expect(read.filter((r) => r.event.kind === "command").map((r) => r.event)).toMatchObject([
        { exitCode: null },
        { exitCode: 3 },
        { exitCode: null },
        { exitCode: 0, changedFiles: ["gen.txt"] },
      ]);
    },
  );
});
