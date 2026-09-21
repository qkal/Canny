import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  const userHome = mkdtempSync(join(tmpdir(), "canny-user-"));
  mkdirSync(join(userHome, ".claude"));
  project = realpathSync(mkdtempSync(join(tmpdir(), "canny-project-")));
  env = { PATH: process.env.PATH, HOME: userHome, CANNY_HOME: join(userHome, ".canny") };
});

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
