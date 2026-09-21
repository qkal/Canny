import { describe, expect, it } from "vitest";
import { findSecrets, fingerprint, isVerify, plain } from "../src/checks.js";
import { fileOps, normalize, shellEdits, shellWrites, writeTargets } from "../src/events.js";
import { handle } from "../src/hook.js";
import { sessionFile } from "../src/ledger.js";
import { extractRules } from "../src/rules.js";

// The CLI catches a throw and answers `{}`, so a payload that crashes the hook switches every
// check off without anyone seeing it. Whatever arrives has to come out as a decision.
describe("malformed hook payloads", () => {
  const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionStart", 7];
  const tools = ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "Bash", "Nope", null];
  const junk = [undefined, null, 0, "text", [], [null], {}, { file_path: 1, edits: "x" }];
  const payloads: unknown[] = [null, 42, "text", [], [{}]];
  for (const hook_event_name of events)
    for (const tool_name of tools)
      for (const j of junk)
        payloads.push({
          hook_event_name,
          tool_name,
          session_id: j,
          cwd: typeof j === "string" ? undefined : j,
          tool_input: j,
          tool_response: j,
          error: j,
          last_assistant_message: j,
          stop_hook_active: j,
          transcript_path: j,
          tool_use_id: j,
        });

  it(`answers every one of ${payloads.length} shapes with a decision`, async () => {
    for (const payload of payloads) {
      const ctx = normalize(payload, "claude");
      const decision = await handle(ctx, {
        config: {},
        judge: async () => null,
        file: sessionFile(ctx.agent, ctx.session),
      });
      expect(decision.kind, JSON.stringify(payload)).toBeTypeOf("string");
    }
  });
});

// Commands, output, and rule files are written by the agent. A regex that backtracks on them turns
// into a hook timeout, and a timed-out hook checks nothing.
describe("hostile text", () => {
  const N = 10_000;
  const inputs: [string, string][] = [
    ["unclosed heredocs", "cat <<A\n".repeat(N / 8)],
    ["unclosed quotes", "\"'".repeat(N / 2)],
    ["escaped quotes that never close", '"' + '\\"'.repeat(N / 2)],
    ["bare redirects", "> ".repeat(N / 2)],
    ["tee flags", "tee " + "-a ".repeat(N / 3)],
    ["one long path", "rm " + "a/".repeat(N / 2)],
    ["one long blank", "rm" + " ".repeat(N) + "x"],
    ["half-open credentials", "token='".repeat(N / 7)],
    ["exit status with no number", "exit code" + " ".repeat(N)],
    ["unclosed markdown links", "- must " + "[".repeat(N)],
    ["unclosed bold and code", "- must " + "**`".repeat(N / 3)],
    ["one line of digits", "9".repeat(N)],
    ["chained statements", "a && b | c; ".repeat(N / 12)],
  ];
  const parsers: ((text: string) => unknown)[] = [
    writeTargets,
    fileOps,
    shellWrites,
    shellEdits,
    findSecrets,
    plain,
    extractRules,
    (t) => isVerify(t, {}),
    (t) => fingerprint(t, t),
    (t) =>
      normalize({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: t },
        tool_response: t,
      }),
  ];

  it.each(inputs)("every parser gets through %s quickly", (_, text) => {
    const started = performance.now();
    for (const parse of parsers) parse(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
