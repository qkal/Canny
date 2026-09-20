import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAgent, normalize, parsePatch, transcriptExit, writeTargets } from "../src/events.js";

const base = { session_id: "s1", cwd: "/repo" };

describe("normalize", () => {
  it("maps a Claude Code Write to a whole-file edit", () => {
    const ctx = normalize({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/repo/a.ts", content: "x" },
    });
    expect(ctx.agent).toBe("claude");
    expect(ctx.phase).toBe("pre");
    expect(ctx.event).toEqual({
      kind: "edit",
      changes: [{ path: "/repo/a.ts", added: "x", removed: "", wholeFile: true }],
    });
  });

  it("maps a Claude Code Edit to old and new text", () => {
    const ctx = normalize({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
    });
    expect(ctx.event).toEqual({
      kind: "edit",
      changes: [{ path: "/repo/a.ts", added: "b", removed: "a" }],
    });
  });

  it("reads a successful Claude Code Bash result as exit 0 with changed files", () => {
    const ctx = normalize({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: {
        stdout: "ok",
        stderr: "",
        interrupted: false,
        isImage: false,
        bashEditDiff: { changedFiles: ["/repo/gen.ts"] },
      },
    });
    expect(ctx.event).toEqual({
      kind: "command",
      command: "pnpm test",
      exitCode: 0,
      output: "ok",
      changedFiles: ["/repo/gen.ts"],
    });
  });

  it("reads a Claude Code PostToolUseFailure exit code from the error text", () => {
    const ctx = normalize({
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      error: "Exit code 1\nFAIL a.test.ts",
    });
    expect(ctx.phase).toBe("post");
    expect(ctx.event).toMatchObject({
      kind: "command",
      exitCode: 1,
      output: "Exit code 1\nFAIL a.test.ts",
    });
  });

  it("reads a Codex Bash result from metadata or text", () => {
    const codex = {
      ...base,
      turn_id: "t1",
      model: "gpt",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    };
    expect(
      normalize({ ...codex, tool_response: { output: "boom", metadata: { exit_code: 2 } } }).event,
    ).toMatchObject({ exitCode: 2, output: "boom" });
    expect(
      normalize({ ...codex, tool_response: "Process exited with code 3\nboom" }).event,
    ).toMatchObject({ exitCode: 3 });
    expect(normalize({ ...codex, tool_response: "all good" }).agent).toBe("codex");
  });

  it("does not read an exit code from the middle of output", () => {
    const text = ["a", "b", "c", "d", "assert 'exit code 7' in msg", "e", "f", "g", "h"].join("\n");
    const ctx = normalize({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "x" },
      tool_response: text,
    });
    expect(ctx.event).toMatchObject({ exitCode: 0 });
  });

  it("maps Stop", () => {
    const ctx = normalize({
      ...base,
      hook_event_name: "Stop",
      last_assistant_message: "Done.",
      stop_hook_active: true,
    });
    expect(ctx.event).toEqual({ kind: "stop", message: "Done.", stopHookActive: true });
  });

  it("detects the agent from Codex-only fields", () => {
    expect(detectAgent({ turn_id: "x" })).toBe("codex");
    expect(detectAgent({ permission_mode: "default" })).toBe("claude");
  });
});

describe("parsePatch", () => {
  it("splits a Codex apply_patch into per-file changes", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+created",
      "*** Delete File: test/c.test.ts",
      "*** End Patch",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      { path: "src/a.ts", added: "new\n", removed: "old\n", deleted: false },
      { path: "src/b.ts", added: "created\n", removed: "", deleted: false },
      { path: "test/c.test.ts", added: "", removed: "", deleted: true },
    ]);
    const ctx = normalize({
      ...base,
      turn_id: "t",
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: patch },
    });
    expect(ctx.event.kind).toBe("edit");
  });
});

describe("writeTargets", () => {
  it.each([
    ["cat > math.js <<'EOF'\nx\nEOF", ["math.js"]],
    ["echo hi >> /repo/log.txt", ["/repo/log.txt"]],
    ["pnpm test > /dev/null 2>&1", []],
    ["pnpm test 2>/dev/null", []],
    ["cmd 2>&1 | tee -a out.log", ["out.log"]],
    ["sed -i '' 's/a/b/' src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
    ["sed -i.bak -e 's/a/b/' src/a.ts", ["src/a.ts"]],
    ["perl -pi -e 's/a/b/' src/c.ts", ["src/c.ts"]],
    ["printf 'x' >\"quoted name.js\"", ["quoted name.js"]],
    ["ls -la", []],
    ['git commit -m "perf: a > b now"', []],
    ["node -e 'if (a > b) process.exit(1)'", []],
    ["cat > notes.md <<'EOF'\n> a quote\nif (a > b)\nEOF", ["notes.md"]],
    ["cat > notes.md <<'END-JSON'\n> a quote\nEND-JSON", ["notes.md"]],
    ["printf 'code' | tee \"src/new.ts\"", ["src/new.ts"]],
    ["printf 'code' | tee -a 'src/new.ts'", ["src/new.ts"]],
  ])("%j -> %j", (cmd, files) => expect(writeTargets(cmd)).toEqual(files));

  it("adds shell write targets to a Bash result's changed files", () => {
    const ctx = normalize({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat > a.js <<'EOF'\nx\nEOF" },
      tool_response: { stdout: "", stderr: "" },
    });
    expect(ctx.event).toMatchObject({ changedFiles: ["a.js"] });
  });
});

describe("Codex exit codes", () => {
  it("reads exit_code from the rollout transcript by tool_use_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "canny-rollout-"));
    const transcript = join(dir, "rollout.jsonl");
    const line = (id: string, exit_code: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id,
            exit_code,
            status: exit_code ? "failed" : "completed",
          },
        },
      });
    writeFileSync(transcript, ["garbage", line("call_1", 0), line("call_2", 3)].join("\n") + "\n");
    expect(transcriptExit(transcript, "call_2")).toBe(3);
    expect(transcriptExit(transcript, "call_1")).toBe(0);
    const ctx = normalize({
      ...base,
      turn_id: "t",
      transcript_path: transcript,
      tool_use_id: "call_2",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "node -e 'process.exit(3)'" },
      tool_response: "out\nerr\n",
    });
    expect(ctx.event).toMatchObject({ kind: "command", exitCode: 3, output: "out\nerr\n" });
  });

  it("leaves the exit code unknown when Codex gives nothing to go on", () => {
    const ctx = normalize({
      ...base,
      turn_id: "t",
      transcript_path: "/nonexistent/rollout.jsonl",
      tool_use_id: "call_9",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all good\n",
    });
    expect(ctx.event).toMatchObject({ exitCode: null });
  });
});
