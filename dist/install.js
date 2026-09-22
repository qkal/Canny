import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { dirname, resolve } from "node:path";
import { isObj, SHELL_TOOLS, TOOLS } from "./events.js";
const STATUS = "Canny";
const RUNS_CANNY = /^["']?canny["']?\s+hook\s+--agent\s+(?:claude|codex)\b/;
const RUNS_A_HOOK = /\shook\s+--agent\s+(?:claude|codex)\b/;
/**
 * A hook entry Canny wrote. Every version has set `statusMessage: "Canny"`, so that marker plus the
 * `hook --agent` arguments identifies the `node "<checkout>/dist/cli.js"` form; `cli.js` alone would
 * also claim another tool's hook. A command that starts with `canny hook --agent …` counts without it.
 */
export const isCannyHook = (h) => {
    // Parsed JSON: an entry can be `null` or a bare string, which is not Canny's and stays.
    const command = String(h?.command ?? "");
    return RUNS_CANNY.test(command) || (h?.statusMessage === STATUS && RUNS_A_HOOK.test(command));
};
/** The hook entries for one agent. `command` is how to run this CLI, without the `hook` arguments. */
export function hookConfig(agent, command) {
    const handler = (timeout, matcher) => ({
        ...(matcher && { matcher }),
        hooks: [
            {
                type: "command",
                command: `${command} hook --agent ${agent}`,
                timeout,
                statusMessage: STATUS,
            },
        ],
    });
    const tools = TOOLS[agent].join("|");
    if (agent === "codex")
        return {
            SessionStart: [handler(10)],
            PreToolUse: [handler(10, tools)],
            PostToolUse: [handler(15, tools)],
            Stop: [handler(15)],
        };
    return {
        SessionStart: [handler(10)],
        PreToolUse: [handler(10, tools)],
        PostToolUse: [handler(15, tools)],
        PostToolUseFailure: [handler(15, SHELL_TOOLS.join("|"))],
        Stop: [handler(15)],
    };
}
/**
 * Drop every earlier Canny hook, add ours, keep everything else as it was. An empty `ours` is a
 * removal. Returns the line to show the user; throws when the file holds something other than a
 * JSON object, since writing over it would lose the user's settings.
 */
export function merge(file, ours) {
    let existing = {};
    if (existsSync(file)) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, "utf8"));
        }
        catch (e) {
            throw new Error(`${file} is not valid JSON; fix it and run again. ${String(e)}`, {
                cause: e,
            });
        }
        if (!isObj(parsed))
            throw new Error(`${file} does not hold a JSON object; fix it and run again.`);
        existing = parsed;
    }
    // `"hooks": null` says "no hooks" and holds nothing to lose, so it reads as absent.
    const current = existing.hooks ?? {};
    if (!isObj(current))
        throw new Error(`"hooks" in ${file} is not a JSON object; fix it and run again.`);
    const hooks = current;
    let removed = 0;
    for (const [event, groups] of Object.entries(hooks)) {
        // Something this tool does not understand is the user's, and stays.
        if (!Array.isArray(groups))
            continue;
        const kept = groups.flatMap((g) => {
            if (!Array.isArray(g?.hooks))
                return [g];
            const others = g.hooks.filter((h) => !isCannyHook(h));
            removed += g.hooks.length - others.length;
            // A group can hold another tool's hook next to Canny's; only an emptied group goes.
            return others.length ? [{ ...g, hooks: others }] : [];
        });
        if (kept.length)
            hooks[event] = kept;
        else
            delete hooks[event];
    }
    for (const [event, groups] of Object.entries(ours)) {
        const there = hooks[event] ?? [];
        if (!Array.isArray(there))
            throw new Error(`"${event}" in ${file} is not a JSON array; fix it and run again.`);
        hooks[event] = [...there, ...groups];
    }
    const adding = Object.keys(ours).length > 0;
    if (!adding && !removed)
        return `no Canny hooks in ${file}`;
    if (Object.keys(hooks).length)
        existing.hooks = hooks;
    else
        delete existing.hooks;
    // Written beside the file and renamed over it, so a crash mid-write cannot leave half a settings
    // file. Through a symlink the real file is replaced, so a dotfiles link stays a link.
    const target = realTarget(file);
    mkdirSync(dirname(target), { recursive: true });
    const mode = existsSync(target) ? statSync(target).mode : undefined;
    const tmp = `${target}.canny-${process.pid}.tmp`;
    try {
        // Exclusive: a path already there, such as a planted symlink, is refused and never written through.
        writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", { mode, flag: "wx" });
        renameSync(tmp, target);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
    return `${adding ? "wrote" : "removed Canny hooks from"} ${file}`;
}
/** Where a write to `file` lands. A link whose target does not exist yet still points somewhere. */
function realTarget(file) {
    try {
        return realpathSync(file);
    }
    catch {
        return lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
            ? resolve(dirname(file), readlinkSync(file))
            : file;
    }
}
