import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// `cli.ts` runs its command switch on import, so it is compiled to a scratch directory and run as a
// process. The committed `dist/` is not used: it can be stale while `src/` is being edited.
let cli: string;
let project: string;
let env: NodeJS.ProcessEnv;

const canny = (args: string[], input = ""): string =>
  execFileSync("node", [cli, ...args], {
    cwd: project,
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

beforeAll(() => {
  const build = realpathSync(mkdtempSync(join(tmpdir(), "canny-build-")));
  writeFileSync(join(build, "package.json"), '{"type":"module"}');
  execFileSync("pnpm", ["exec", "tsc", "--outDir", build], { stdio: "inherit" });
  cli = join(build, "cli.js");
  fresh();
});

/** A user, a project, and a ledger home that no earlier test has touched. */
const fresh = (): void => {
  const userHome = mkdtempSync(join(tmpdir(), "canny-user-"));
  mkdirSync(join(userHome, ".claude"));
  project = realpathSync(mkdtempSync(join(tmpdir(), "canny-project-")));
  env = { PATH: process.env.PATH, HOME: userHome, CANNY_HOME: join(userHome, ".canny") };
};

describe("every command runs from a fresh process", () => {
  it("init writes hooks for the agent it finds, with a command that runs this CLI", () => {
    expect(canny(["init"])).toContain(`wrote ${join(project, ".claude", "settings.json")}`);
    const settings = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    expect(settings).toContain(`node \\"${cli}\\" hook --agent claude`);
    expect(settings).not.toContain("codex");
  });

  it("hook answers with one JSON object and records the session for this project", () => {
    const event = {
      hook_event_name: "PostToolUse",
      session_id: "smoke",
      cwd: project,
      tool_name: "Edit",
      tool_input: { file_path: join(project, "src/a.ts"), old_string: "a", new_string: "b" },
    };
    expect(JSON.parse(canny(["hook", "--agent", "claude"], JSON.stringify(event)))).toEqual({});
    expect(canny(["status"])).toMatch(/session {3}claude-smoke\.jsonl[\s\S]*edited {4}src\/a\.ts/);
    expect(canny(["sessions"])).toContain(project);
    expect(canny(["replay"])).toContain("all Stop verdicts reproduced");
  });

  it("status names the full command when a config is untrusted, and trust accepts it", () => {
    writeFileSync(join(project, ".canny.json"), '{"allow":["secrets"]}');
    expect(canny(["status"])).toContain(`\`node "${cli}" trust\` accepts it`);
    expect(canny(["trust"])).toContain("allow now take effect");
  });

  it("remove takes the hooks out again, and no arguments prints help", () => {
    expect(canny(["remove"])).toContain("removed Canny hooks from");
    expect(JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"))).toEqual({});
    expect(canny([])).toContain("canny init");
  });

  it("init fails without touching a settings file it cannot parse", () => {
    const file = join(project, ".claude", "settings.json");
    writeFileSync(file, "{ not json");
    expect(() => canny(["init", "--claude"])).toThrow(/is not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("a whole session through the hook process", () => {
  beforeAll(fresh);

  const hook = (event: Record<string, unknown>): unknown =>
    JSON.parse(
      canny(
        ["hook", "--agent", "claude"],
        JSON.stringify({ session_id: "flow", cwd: project, ...event }),
      ),
    );

  it("denies, blocks, warns, then allows, and replay re-derives every Stop from the ledger", () => {
    const file_path = join(project, "src/a.ts");
    const write = { file_path, content: "const k = 'AKIAIOSFODNN7EXAMPLE'" };
    expect(hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: write })).toEqual(
      expect.objectContaining({
        hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }),
      }),
    );
    const edit = { file_path, old_string: "a", new_string: "b" };
    expect(hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: edit })).toEqual(
      {},
    );
    const stop = { hook_event_name: "Stop", last_assistant_message: "Done." };
    expect(hook(stop)).toMatchObject({ decision: "block" });
    expect(hook({ ...stop, stop_hook_active: true })).toEqual({
      systemMessage: expect.stringContaining("Verify by hand"),
    });
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "ok", stderr: "" },
    });
    expect(hook(stop)).toEqual({});

    const ledger = join(env.CANNY_HOME!, "sessions", "claude-flow.jsonl");
    expect(canny(["status", ledger])).toContain("stops     block, warn, allow");
    expect(canny(["replay", ledger]).match(/ ok$/gm)).toHaveLength(3);
    // A ledger edited after the fact no longer replays, which is what makes it evidence.
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace('"decision":"block"', '"decision":"allow"'),
    );
    const replayed = spawnSync("node", [cli, "replay", ledger], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    expect(replayed.status).toBe(1);
    expect(replayed.stdout).toContain("recorded=allow  replayed=block  MISMATCH");
  });
});

describe("outside a session", () => {
  beforeAll(fresh);

  it("answers anything on stdin with one JSON object, and status reports what it could not read", () => {
    for (const input of ["", "null", "[]", '"text"', "{ not json"])
      expect(canny(["hook", "--agent", "claude"], input)).toBe("{}");
    expect(canny(["status"])).toMatch(/errors {4}1 hook crash in .*errors\.log/);
  });

  it("init --global writes into the home directory, not the project, and remove --global undoes it", () => {
    const file = join(env.HOME!, ".codex", "hooks.json");
    expect(canny(["init", "--codex", "--global"])).toContain(`wrote ${file}`);
    expect(readFileSync(file, "utf8")).toContain("hook --agent codex");
    expect(existsSync(join(project, ".codex"))).toBe(false);
    expect(canny(["remove", "--global"])).toContain(`removed Canny hooks from ${file}`);
  });
});
