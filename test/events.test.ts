import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectAgent,
  fileOps,
  normalize,
  parsePatch,
  transcriptExit,
  writeTargets,
} from "../src/events.js";

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

  it.each([
    [
      "MultiEdit",
      {
        file_path: "/repo/a.test.ts",
        edits: [
          { old_string: "it('a', f)", new_string: "" },
          { old_string: "x", new_string: "y" },
        ],
      },
      { path: "/repo/a.test.ts", added: "\ny", removed: "it('a', f)\nx" },
    ],
    [
      "NotebookEdit",
      { notebook_path: "/repo/n.ipynb", new_source: "print(1)" },
      { path: "/repo/n.ipynb", added: "print(1)", removed: "" },
    ],
  ])(
    "maps a Claude Code %s to one change holding all its text",
    (tool_name, tool_input, change) => {
      const ctx = normalize({ ...base, hook_event_name: "PreToolUse", tool_name, tool_input });
      expect(ctx.event).toEqual({ kind: "edit", changes: [change] });
    },
  );

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
    ["cat > notes.md <<\\EOF\n> a quote\nEOF", ["notes.md"]],
    ["printf 'code' | tee \"src/new.ts\"", ["src/new.ts"]],
    ["printf 'code' | tee -a 'src/new.ts'", ["src/new.ts"]],
    ["echo x | tee -a src/a.ts src/b.ts > /dev/null", ["src/a.ts", "src/b.ts"]],
  ])("%j -> %j", (cmd, files) => expect(writeTargets(cmd)).toEqual(files));

  it.each([
    ["cp src/a.ts src/b.ts", { written: ["src/b.ts"], removed: [], moved: [] }],
    ["mv -f a.ts 'b c.ts'", { written: ["b c.ts"], removed: [], moved: [["a.ts", "b c.ts"]] }],
    ["rm -f a.ts b.ts 2>/dev/null; ls", { written: [], removed: ["a.ts", "b.ts"], moved: [] }],
    ["git checkout -- src/a.ts", { written: ["src/a.ts"], removed: [], moved: [] }],
    ["git checkout main", { written: [], removed: [], moved: [] }],
    ["git restore --staged src/a.ts", { written: [], removed: [], moved: [] }],
    ["git restore src/a.ts", { written: ["src/a.ts"], removed: [], moved: [] }],
    ["git restore --source HEAD~1 src/a.ts", { written: ["src/a.ts"], removed: [], moved: [] }],
    ["git restore -s main src/a.ts", { written: ["src/a.ts"], removed: [], moved: [] }],
    ["git rm --dry-run test/a.test.ts", { written: [], removed: [], moved: [] }],
    ["git rm -n test/a.test.ts", { written: [], removed: [], moved: [] }],
    ["git mv --dry-run test/a.test.ts src/a.ts", { written: [], removed: [], moved: [] }],
    [
      "mv test/a.test.ts src/",
      { written: ["src/"], removed: [], moved: [["test/a.test.ts", "src/a.test.ts"]] },
    ],
    ["echo rm a.ts", { written: [], removed: [], moved: [] }],
  ])("fileOps %j", (cmd, ops) => expect(fileOps(cmd)).toEqual(ops));

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

  // Real commands that put phantom files in the ledger and blocked Stop with nothing to verify.
  const changed = (command: string): unknown =>
    (
      normalize({
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "", stderr: "" },
      }).event as { changedFiles: string[] }
    ).changedFiles;

  it.each([
    // A command quoted for another machine changes nothing here.
    ['ssh host "B=~/bk; mkdir -p \\$B/lp1 && cp /srv/lp1/index.html \\$B/lp1/"', []],
    ["ssh host 'sed -i s/a/b/ /srv/x.ts'", []],
    // A search pattern is text: `cp |mv ` inside quotes copies nothing.
    ['grep -nE "ignore|write|cp |mv " events.ts', []],
    ["grep -n 'rm -rf' notes.txt > hits.txt", ["hits.txt"]],
    // Quoted file names are still files.
    ['cp "a b.ts" c.ts', ["c.ts"]],
    // A heredoc body with an apostrophe does not swallow the shell after it.
    ["cat > a.md <<'EOF'\nit's\nEOF\nsed -i '' s/a/b/ x.ts", ["a.md", "x.ts"]],
    // A loop over literal files names those files; a variable nothing defines names no file.
    [
      "for f in web/a.html web/b.html; do sed -i '' -e 's/x/y/g' \"$f\"; done",
      ["web/a.html", "web/b.html"],
    ],
    ['for d in a b; do cp x.ts "$d/x.ts"; done', ["a/x.ts", "b/x.ts"]],
    ['sed -i "" s/a/b/ "$f"', []],
    ["cp a.ts $DST/a.ts", []],
    ["for f in *.html; do sed -i '' s/a/b/ \"$f\"; done", []],
    // A variable set to a literal by its own statement stands for that value.
    ["SRC=src/a.ts; echo x > $SRC", ["src/a.ts"]],
    ['export OUT="dist" && cp a.ts $OUT/a.ts', ["dist/a.ts"]],
    // A prefix assignment is set after `$OUT` is expanded, and a substitution is only known at run time.
    ["OUT=dist cp a.ts $OUT/a.ts", []],
    ['DST=$(mktemp -d); cp a.ts "$DST/a.ts"', []],
    // A substitution is one word and names no file Canny can know: not `+%Y%m%d)`.
    ["cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d)", []],
    ['cp a.ts "b-$(date +%s).ts"', []],
    ["cp a.ts b-`date`.ts", []],
    ['cp a.ts "${OUT:-dist}/a.ts"', []],
    // Relative paths follow a leading `cd`.
    ['cd "/repo/web"; sed -i "" s/a/b/ x.html', ["/repo/web/x.html"]],
    ["cd sub && echo hi > note.ts", ["sub/note.ts"]],
    ["cd /repo/web; cp a.ts /abs/b.ts", ["/abs/b.ts"]],
    // A home path is not relative to the `cd`, and after a second `cd` the directory is not known.
    ["cd web && echo x > ~/notes.ts", [join(homedir(), "notes.ts")]],
    ["cd web && pnpm test && cd .. && echo x > a.ts", ["a.ts"]],
    // A quote escaped outside a string opens nothing, so the `rm` between two of them still runs.
    ["echo it\\'s; rm tests/a.test.ts; echo that\\'s", ["tests/a.test.ts"]],
    ['echo \\"a\\"; rm tests/x.test.ts; echo "b"', ["tests/x.test.ts"]],
  ])("changedFiles %j -> %j", (cmd, files) => expect(changed(cmd)).toEqual(files));
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
