import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { normalize, type Agent } from "../src/events.js";
import { decideStop, handle, serialize, type Decision } from "../src/hook.js";
import type { Answers, Judge } from "../src/jev.js";
import { read, sessionFile, summarize } from "../src/ledger.js";

let cwd: string;
let file: string;
const answer =
  (a: Answers | null): Judge =>
  async () =>
    a;
const offline = answer(null);

beforeEach(() => {
  process.env.CANNY_HOME = mkdtempSync(join(tmpdir(), "canny-home-"));
  cwd = mkdtempSync(join(tmpdir(), "canny-repo-"));
  file = sessionFile("claude", "s1");
});

const run = (
  input: Record<string, unknown>,
  judge: Judge = offline,
  config: Config = {},
  agent: Agent = "claude",
): Promise<Decision> =>
  handle(normalize({ session_id: "s1", cwd, ...input }, agent), { config, judge, file });

const edit = (path = "src/a.ts") =>
  run({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(cwd, path), old_string: "a", new_string: "b" },
  });
const ran = (command: string, exit = 0) =>
  exit === 0
    ? run({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "ok", stderr: "" },
      })
    : run({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command },
        error: `Exit code ${exit}\nFAIL same thing`,
      });
const stop = (
  judge: Judge = offline,
  config: Config = {},
  stop_hook_active = false,
  message = "Done, all implemented.",
) =>
  run(
    { hook_event_name: "Stop", last_assistant_message: message, stop_hook_active },
    judge,
    config,
  );

describe("stop gate", () => {
  it("allows when nothing was edited", async () => {
    expect(await stop()).toEqual({ kind: "allow" });
  });

  it("allows edits to docs only", async () => {
    await edit("README.md");
    expect(await stop()).toEqual({ kind: "allow" });
  });

  it("blocks after a code edit with no passing check, offline", async () => {
    await edit();
    const d = await stop();
    expect(d.kind).toBe("block");
    expect(d).toMatchObject({ message: expect.stringContaining("src/a.ts changed") });
  });

  it("allows when a check passed after the last edit, and blocks when the edit came after", async () => {
    await edit();
    await ran("pnpm test");
    expect(await stop()).toEqual({ kind: "allow" });
    await edit("src/b.ts");
    expect((await stop()).kind).toBe("block");
  });

  it("names the failing command in the block reason", async () => {
    await edit();
    await ran("pnpm test", 1);
    expect(await stop()).toMatchObject({
      kind: "block",
      message: expect.stringContaining("`pnpm test` (exit 1)"),
    });
  });

  it.each([
    [0.02, "allow"],
    [0.5, "block"],
    [0.97, "block"],
  ])("with Jev claims_done=%s -> %s", async (p, kind) => {
    await edit();
    expect((await stop(answer({ claims_done: p }))).kind).toBe(kind);
  });

  it("lets the second stop through with a warning when nothing changed, unless strict", async () => {
    await edit();
    expect((await stop()).kind).toBe("block");
    expect((await stop(offline, {}, true)).kind).toBe("warn");
    expect((await stop(offline, { strict: true }, true)).kind).toBe("block");
  });

  it("blocks again when the agent did something else but still ran no check", async () => {
    await edit();
    expect((await stop()).kind).toBe("block");
    await ran("ls");
    expect((await stop(offline, {}, true)).kind).toBe("block");
  });

  it("counts files changed by a Bash command as edits", async () => {
    await run({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "sed -i x" },
      tool_response: {
        stdout: "",
        stderr: "",
        bashEditDiff: { changedFiles: [join(cwd, "src/z.ts")] },
      },
    });
    expect((await stop()).kind).toBe("block");
  });

  it("decideStop is pure over the summary", () => {
    const entries = read(file);
    expect(decideStop(summarize(entries), false, undefined, {})).toEqual({ kind: "allow" });
  });
});

describe("shell file operations in the ledger", () => {
  it.each([
    ["rm src/a.ts", "block"],
    ["cp src/a.ts src/b.ts", "block"],
    ["git checkout -- src/a.ts", "block"],
    ["rm -rf node_modules /tmp/canny-scratch.json /var/tmp/x.json", "allow"],
    ["rm ../../../../../../../../tmp/canny-scratch.ts", "allow"],
  ])("%s then stop -> %s", async (command, kind) => {
    await ran(command);
    expect((await stop()).kind).toBe(kind);
  });
  it("counts files a failed command changed before it failed", async () => {
    await ran("rm src/a.ts; false", 1);
    expect((await stop()).kind).toBe("block");
  });
});

describe("pre checks", () => {
  it("denies writing a secret unless allowed", async () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(cwd, "src/k.ts"), content: "const k = 'AKIAIOSFODNN7EXAMPLE'" },
    };
    expect(await run(input)).toMatchObject({
      kind: "deny",
      message: expect.stringContaining("AWS access key"),
    });
    expect(await run(input, offline, { allow: ["secrets"] })).toEqual({ kind: "allow" });
  });

  const bash = (command: string, config: Config = {}) =>
    run(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      offline,
      config,
    );

  it("denies a shell command that writes a secret into a file, but not one that only uses it", async () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    expect(await bash(`echo "const k = '${key}'" > src/k.ts`)).toMatchObject({
      kind: "deny",
      message: expect.stringContaining("src/k.ts"),
    });
    expect(await bash(`cat > src/k.ts <<'EOF'\nconst k = '${key}'\nEOF`)).toMatchObject({
      kind: "deny",
    });
    for (const prefix of ["X=1 ", "/bin/", "if true; then ", "(", "command ", "env X=1 "])
      expect(await bash(`${prefix}echo AWS_KEY=${key} > src/config.ts`)).toMatchObject({
        kind: "deny",
      });
    expect(await bash(`aws configure set aws_access_key_id ${key}`)).toEqual({ kind: "allow" });
    expect(await bash(`curl -H 'X-Key: ${key}' https://example.com > response.json`)).toEqual({
      kind: "allow",
    });
    expect(await bash(`echo ${key} > src/k.ts`, { allow: ["secrets"] })).toEqual({ kind: "allow" });
  });

  it("lets a key into an env file only when git ignores that file", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".env.local\n");
    const write = (name: string) =>
      run({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(cwd, name), content: "AWS_KEY=AKIAIOSFODNN7EXAMPLE" },
      });
    expect(await write(".env.local")).toEqual({ kind: "allow" });
    expect(await bash("cd sub && echo AWS_KEY=AKIAIOSFODNN7EXAMPLE > .env.local")).toMatchObject({
      kind: "deny",
    });
    expect(await bash("echo AWS_KEY=AKIAIOSFODNN7EXAMPLE >> .env.local")).toEqual({
      kind: "allow",
    });
    expect(await bash("echo AWS_KEY=AKIAIOSFODNN7EXAMPLE | tee .env.local src/k.ts")).toMatchObject(
      {
        kind: "deny",
        message: expect.stringContaining("src/k.ts"),
      },
    );
    expect(await write(".env")).toMatchObject({ kind: "deny" });
    writeFileSync(join(cwd, ".gitignore"), ".env.local\n.env.prod\n");
    symlinkSync(join(cwd, "src-config.ts"), join(cwd, ".env.prod"));
    expect(await write(".env.prod")).toMatchObject({ kind: "deny" });
    expect(await write(".env.example")).toMatchObject({ kind: "deny" });
  });

  it.each([
    ["rm test/a.test.ts", "ask"],
    ["rm -rf tests", "ask"],
    ["cd web && git rm src/a.spec.ts", "ask"],
    ["mv test/a.test.ts /tmp/a.bak", "ask"],
    ["mv test/a.test.ts test/b.test.ts", "allow"],
    ["if true; then rm test/a.test.ts; fi", "ask"],
    ["/bin/rm test/a.test.ts", "ask"],
    ["rm src/a.ts dist/a.js", "allow"],
    ['git commit -m "rm test/a.test.ts"', "allow"],
    ["cat > cleanup.sh <<'EOF'\nrm test/a.test.ts\nEOF", "allow"],
  ])("%s -> %s", async (command, kind) => expect((await bash(command)).kind).toBe(kind));

  it("leaves shell test removal alone when test-removal is off", async () => {
    expect(await bash("rm test/a.test.ts", { allow: ["test-removal"] })).toEqual({ kind: "allow" });
  });

  it("asks before a test is removed, and Codex gets a deny", async () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: join(cwd, "test/a.test.ts"),
        old_string: "it('a', f)",
        new_string: "",
      },
    };
    const d = await run(input);
    expect(d).toMatchObject({
      kind: "ask",
      message: expect.stringContaining("removes 1 test case"),
    });
    expect(serialize(normalize({ hook_event_name: "PreToolUse" }, "claude"), d)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    expect(serialize(normalize({ hook_event_name: "PreToolUse" }, "codex"), d)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("notes the second identical failure and denies the fourth attempt", async () => {
    expect((await ran("pnpm test", 1)).kind).toBe("allow");
    expect(await ran("pnpm test", 1)).toMatchObject({
      kind: "note",
      message: expect.stringContaining("failed 2 times"),
    });
    await ran("pnpm test", 1);
    const pre = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    };
    expect((await run(pre)).kind).toBe("deny");
    expect(
      (await run({ ...pre, tool_input: { command: "pnpm test -- --reporter=verbose" } })).kind,
    ).toBe("allow");
  });
});

describe("rule check", () => {
  it("turns a confident Jev yes into a note naming the rule", async () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "- Never hardcode model IDs.\n- Prefer pnpm.\n");
    const asked: unknown[] = [];
    const judge: Judge = async (state, q) => {
      asked.push(state, q);
      return { rule_0: 0.95, rule_1: 0.3 };
    };
    const d = await edit();
    expect(d).toEqual({ kind: "allow" });
    const noted = await handle(
      normalize(
        {
          session_id: "s1",
          cwd,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: join(cwd, "src/a.ts"),
            old_string: "x",
            new_string: "model = 'claude-3'",
          },
        },
        "claude",
      ),
      { config: {}, judge, file },
    );
    expect(noted).toMatchObject({
      kind: "note",
      message: expect.stringContaining("- Never hardcode model IDs."),
    });
    expect(noted).not.toMatchObject({ message: expect.stringContaining("Prefer pnpm") });
    expect(asked[0]).toMatchObject({
      rules: ["Never hardcode model IDs.", "Prefer pnpm."],
      change: { file: "src/a.ts", added: "model = 'claude-3'" },
    });
    expect(Object.keys(asked[1] as object)).toEqual(["rule_0", "rule_1"]);
    expect(serialize(normalize({ hook_event_name: "PostToolUse" }), noted)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: (noted as { message: string }).message,
      },
    });
  });
});

describe("serialize", () => {
  it("emits an empty object for allow and the block shape for block", () => {
    const ctx = normalize({ hook_event_name: "Stop" });
    expect(serialize(ctx, { kind: "allow" })).toEqual({});
    expect(serialize(ctx, { kind: "block", message: "r" })).toEqual({
      decision: "block",
      reason: "r",
      systemMessage: "r",
    });
  });
});

describe("ledger file", () => {
  it("is owner-only and holds no terminal escapes from command output", async () => {
    await run({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "ok\nverified  yes\r\x1b[2Kfine", stderr: "" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { lastCommand } = summarize(read(file));
    expect(lastCommand?.summary).toBe("verified  yes [2Kfine");
  });

  it("still denies a multi-line command that keeps failing the same way", async () => {
    for (let i = 0; i < 3; i++) await ran("cd web &&\n  pnpm test", 1);
    const d = await run({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cd web &&\n  pnpm test" },
    });
    expect(d.kind).toBe("deny");
  });
});
