import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { hookConfig, isCannyHook, merge } from "../src/install.js";

let dir: string;
let file: string;
const json = (): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const ours = hookConfig("claude", "canny");
const foreign = { type: "command", command: "/Users/kal/canny/other-tool/run.sh --hook" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "canny-install-"));
  file = join(dir, ".claude", "settings.json");
});

describe("isCannyHook", () => {
  it.each([
    [{ command: "canny hook --agent claude" }, true],
    [
      {
        command: 'node "/Users/me/.canny/src/dist/cli.js" hook --agent codex',
        statusMessage: "Canny",
      },
      true,
    ],
    [
      {
        command: "/opt/node/bin/node /store/canny-warden/dist/cli.js hook --agent claude",
        statusMessage: "Canny",
      },
      true,
    ],
    [{ command: "node /opt/guardian/cli.js hook --agent claude" }, false],
    [
      { command: "node /opt/guardian/cli.js hook --agent claude", statusMessage: "Guardian" },
      false,
    ],
    [{ command: "/Users/kal/canny/other-tool/run.sh --hook", statusMessage: "Canny" }, false],
    [{ command: "echo canny hook --agent claude" }, false],
    [{ command: "uncanny hook --agent claude" }, false],
    [{ command: "canny status" }, false],
  ])("%j -> %s", (hook, yes) => expect(isCannyHook(hook)).toBe(yes));
});

describe("hookConfig", () => {
  // A tool `normalize` understands but no matcher names is an edit the ledger never sees.
  it.each([
    ["claude", ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"]],
    ["codex", ["Bash", "apply_patch"]],
  ] as const)("routes every tool %s edits or runs with through both phases", (agent, tools) => {
    const config = hookConfig(agent, "canny");
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const [group] = config[event] as { matcher?: string }[];
      for (const tool of tools) expect(tool).toMatch(new RegExp(`^(?:${group?.matcher})$`));
    }
    expect(config.Stop).toHaveLength(1);
    expect(isCannyHook(config.Stop![0]!.hooks![0]!)).toBe(true);
  });
});

describe("merge", () => {
  it("creates the file with Canny's hooks when there is none", () => {
    expect(merge(file, ours)).toBe(`wrote ${file}`);
    expect(Object.keys(json().hooks as object)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
    ]);
  });

  it("keeps every other setting and hook, and does not stack entries when run twice", () => {
    merge(file, ours);
    writeFileSync(
      file,
      JSON.stringify({
        model: "x",
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: { Stop: [{ hooks: [foreign] }], Notification: [{ hooks: [foreign] }] },
      }),
    );
    merge(file, ours);
    merge(file, hookConfig("claude", 'node "/new/place/dist/cli.js"'));
    const out = json();
    expect(out.model).toBe("x");
    expect(out.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    const hooks = out.hooks as Record<string, { hooks: { command: string }[] }[]>;
    expect(hooks.Notification).toEqual([{ hooks: [foreign] }]);
    expect(hooks.Stop!.map((g) => g.hooks[0]!.command)).toEqual([
      foreign.command,
      'node "/new/place/dist/cli.js" hook --agent claude',
    ]);
  });

  it("removes only Canny's hook from a group it shares with another tool", () => {
    merge(file, ours);
    const shared = json() as { hooks: Record<string, { hooks: unknown[] }[]> };
    shared.hooks.Stop![0]!.hooks.push(foreign);
    writeFileSync(file, JSON.stringify(shared));
    expect(merge(file, {})).toBe(`removed Canny hooks from ${file}`);
    expect(json()).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
  });

  it("leaves no empty hooks object behind, and says so when there was nothing to remove", () => {
    writeFileSync(join(dir, "s.json"), JSON.stringify({ model: "x" }));
    file = join(dir, "s.json");
    merge(file, ours);
    merge(file, {});
    expect(json()).toEqual({ model: "x" });
    expect(merge(file, {})).toBe(`no Canny hooks in ${file}`);
  });

  it("keeps hook entries it cannot read and still removes its own", () => {
    merge(file, ours);
    const odd = json() as { hooks: Record<string, { hooks: unknown[] }[]> };
    odd.hooks.Stop![0]!.hooks.push(null, "text");
    writeFileSync(file, JSON.stringify(odd));
    merge(file, {});
    expect(json()).toEqual({ hooks: { Stop: [{ hooks: [null, "text"] }] } });
  });

  it("reads a null hooks value as no hooks", () => {
    file = join(dir, "s.json");
    writeFileSync(file, '{"model":"x","hooks":null}');
    merge(file, ours);
    expect(json().model).toBe("x");
    expect(Object.keys(json().hooks as object)).toContain("Stop");
  });

  it.each([
    "{ not json",
    "[]",
    "null",
    '{"hooks": []}',
    '{"hooks": "x"}',
    '{"hooks":{"Stop":"x"}}',
  ])("refuses %s and leaves the file as it was", (text) => {
    file = join(dir, "s.json");
    writeFileSync(file, text);
    expect(() => merge(file, ours)).toThrow(/fix it and run again/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("does not write through a symlink planted at its temp path", () => {
    merge(file, ours);
    const before = readFileSync(file, "utf8");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, `${file}.canny-${process.pid}.tmp`);
    expect(() => merge(file, {})).toThrow(/EEXIST/);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("writes to where a dangling symlink points, and keeps the link", () => {
    const real = join(dir, "not-yet", "settings.json");
    file = join(dir, "settings.json");
    symlinkSync(real, file);
    merge(file, ours);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(real, "utf8")) as object)).toEqual(["hooks"]);
  });

  it("writes through a symlink, keeps the file mode, and leaves no temp file", () => {
    const real = join(dir, "dotfiles-settings.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    file = join(dir, "settings.json");
    symlinkSync(real, file);
    merge(file, ours);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(real, "utf8")) as object)).toEqual(["hooks"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
