import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Agent } from "./events.js";

type Hook = { command?: string };
type Group = { hooks?: Hook[] };
export type Hooks = Record<string, Group[]>;

/**
 * A hook command Canny wrote: `canny hook --agent …`, or node with a path to `cli.js`, which is what
 * `init` writes without a `canny` on PATH. Matching the word "canny" alone would also claim another
 * tool's hook that merely lives under a directory of that name.
 */
const CANNY_HOOK = /(?:^|[\s"'/\\])(?:canny|cli\.js)["']?\s+hook\s+--agent\s+(?:claude|codex)\b/;

export const isCannyHook = (h: Hook): boolean => CANNY_HOOK.test(h.command ?? "");

/** The hook entries for one agent. `command` is how to run this CLI, without the `hook` arguments. */
export function hookConfig(agent: Agent, command: string): Hooks {
  const handler = (timeout: number, matcher?: string): Group => ({
    ...(matcher && { matcher }),
    hooks: [
      {
        type: "command",
        command: `${command} hook --agent ${agent}`,
        timeout,
        statusMessage: "Canny",
      } as Hook,
    ],
  });
  if (agent === "codex")
    return {
      PreToolUse: [handler(10, "Bash|apply_patch")],
      PostToolUse: [handler(15, "Bash|apply_patch")],
      Stop: [handler(15)],
    };
  const tools = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell";
  return {
    PreToolUse: [handler(10, tools)],
    PostToolUse: [handler(15, tools)],
    PostToolUseFailure: [handler(15, "Bash|PowerShell")],
    Stop: [handler(15)],
  };
}

/**
 * Drop every earlier Canny hook, add ours, keep everything else as it was. An empty `ours` is a
 * removal. Returns the line to show the user; throws when the file holds something other than a
 * JSON object, since writing over it would lose the user's settings.
 */
export function merge(file: string, ours: Hooks): string {
  let existing: { hooks?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is not valid JSON; fix it and run again. ${String(e)}`, {
        cause: e,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${file} does not hold a JSON object; fix it and run again.`);
    existing = parsed;
  }
  const current = existing.hooks ?? {};
  if (typeof current !== "object" || Array.isArray(current))
    throw new Error(`"hooks" in ${file} is not a JSON object; fix it and run again.`);
  const hooks: Record<string, unknown> = current;
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    // Something this tool does not understand is the user's, and stays.
    if (!Array.isArray(groups)) continue;
    const kept = (groups as Group[]).flatMap((g) => {
      if (!Array.isArray(g?.hooks)) return [g];
      const others = g.hooks.filter((h) => !isCannyHook(h));
      removed += g.hooks.length - others.length;
      // A group can hold another tool's hook next to Canny's; only an emptied group goes.
      return others.length ? [{ ...g, hooks: others }] : [];
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const [event, groups] of Object.entries(ours))
    hooks[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as Group[]) : []), ...groups];
  const adding = Object.keys(ours).length > 0;
  if (!adding && !removed) return `no Canny hooks in ${file}`;
  if (Object.keys(hooks).length) existing.hooks = hooks;
  else delete existing.hooks;
  mkdirSync(dirname(file), { recursive: true });
  // Written beside the file and renamed over it, so a crash mid-write cannot leave half a settings
  // file. Through a symlink the real file is replaced, so a dotfiles link stays a link.
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode : undefined;
  const tmp = `${target}.canny-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", { mode });
  renameSync(tmp, target);
  return `${adding ? "wrote" : "removed Canny hooks from"} ${file}`;
}
