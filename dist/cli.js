#!/usr/bin/env node
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findConfig, home, loadConfig, trust, WEAKENING } from "./config.js";
import { normalize } from "./events.js";
import { decideStop, handle, serialize } from "./hook.js";
import { makeJudge } from "./jev.js";
import { append, listSessions, read, sessionFile, summarize } from "./ledger.js";
const { values: opts, positionals } = parseArgs({
    options: {
        agent: { type: "string" },
        claude: { type: "boolean" },
        codex: { type: "boolean" },
        global: { type: "boolean" },
    },
    allowPositionals: true,
});
const [cmd, target] = positionals;
switch (cmd) {
    case "hook":
        await hook();
        break;
    case "init":
        init();
        break;
    case "status":
        status();
        break;
    case "sessions":
        for (const s of listSessions())
            console.log(`${new Date(s.mtime).toISOString()}  ${s.file}`);
        break;
    case "replay":
        replay();
        break;
    case "remove":
        remove();
        break;
    case "trust":
        trustConfig();
        break;
    default:
        console.log([
            "canny: a warden for AI coding agents",
            "",
            "  canny init [--claude] [--codex] [--global]   write hook config for this project (or your home)",
            "  canny hook --agent claude|codex              run as a hook; reads the event on stdin",
            "  canny status [session-file]                  what the ledger knows about the latest session",
            "  canny sessions                               list recorded sessions",
            "  canny replay [session-file]                  re-derive every Stop verdict from the ledger",
            "  canny remove [--global]                      take Canny's hook entries out again",
            "  canny trust                                  let this project's .canny.json turn checks off",
            "",
            `Sessions and the Jev cache live in ${home()}. Set TYPESAFE_API_KEY to enable Jev.`,
        ].join("\n"));
}
/** Stdout must hold exactly one JSON object; anything else confuses the agent. Errors go to a file. */
async function hook() {
    let out = {};
    try {
        const raw = JSON.parse(readFileSync(0, "utf8") || "{}");
        const ctx = normalize(raw, opts.agent);
        const file = sessionFile(ctx.agent, ctx.session);
        const judge = makeJudge({ log: (e) => append(file, { ts: Date.now(), type: "jev", ...e }) });
        out = serialize(ctx, await handle(ctx, { config: loadConfig(ctx.cwd), judge, file }));
    }
    catch (e) {
        mkdirSync(home(), { recursive: true, mode: 0o700 });
        appendFileSync(join(home(), "errors.log"), `${new Date().toISOString()} ${String(e)}\n`, {
            mode: 0o600,
        });
    }
    process.stdout.write(JSON.stringify(out));
}
function init() {
    // Without flags, write for the agents installed here, or for both when neither left a trace.
    const found = {
        claude: existsSync(join(homedir(), ".claude")),
        codex: existsSync(join(homedir(), ".codex")),
    };
    const explicit = Boolean(opts.claude || opts.codex);
    const neither = !found.claude && !found.codex;
    const want = {
        claude: explicit ? Boolean(opts.claude) : found.claude || neither,
        codex: explicit ? Boolean(opts.codex) : found.codex || neither,
    };
    // A PATH lookup survives upgrades of canny and of Node. Absolute paths into a package store do not.
    const portable = onPath("canny");
    const cli = fileURLToPath(import.meta.url);
    const command = (agent) => portable ? `canny hook --agent ${agent}` : `node "${cli}" hook --agent ${agent}`;
    if (!portable)
        console.log(`Hooks call node with the path of this checkout, ${cli}. Keep it there.`);
    const handler = (agent, timeout, matcher) => ({
        ...(matcher && { matcher }),
        hooks: [{ type: "command", command: command(agent), timeout, statusMessage: "Canny" }],
    });
    const root = opts.global ? homedir() : process.cwd();
    if (want.claude) {
        const tools = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell";
        merge(join(root, ".claude", "settings.json"), {
            PreToolUse: [handler("claude", 10, tools)],
            PostToolUse: [handler("claude", 15, tools)],
            PostToolUseFailure: [handler("claude", 15, "Bash|PowerShell")],
            Stop: [handler("claude", 15)],
        });
    }
    if (want.codex) {
        merge(join(root, ".codex", "hooks.json"), {
            PreToolUse: [handler("codex", 10, "Bash|apply_patch")],
            PostToolUse: [handler("codex", 15, "Bash|apply_patch")],
            Stop: [handler("codex", 15)],
        });
        console.log("Codex asks you to trust new hooks once: run /hooks inside Codex.");
    }
}
/** Whether a command of this name resolves on the current PATH. */
function onPath(name) {
    const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
    return (process.env.PATH ?? "").split(delimiter).some((dir) => names.some((n) => {
        try {
            accessSync(join(dir, n), constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    }));
}
/** Drop every earlier Canny entry, add ours, keep everything else as it was. */
function merge(file, ours) {
    let existing = {};
    if (existsSync(file)) {
        try {
            existing = JSON.parse(readFileSync(file, "utf8"));
        }
        catch (e) {
            console.error(`${file} is not valid JSON; fix it and run again. ${String(e)}`);
            return;
        }
    }
    const hooks = (existing.hooks ??= {});
    const isCanny = (g) => (g.hooks ?? []).some((h) => /\bcanny\b.*\bhook\b/.test(h.command ?? ""));
    let removed = 0;
    for (const [event, groups] of Object.entries(hooks)) {
        const kept = groups.filter((g) => !isCanny(g));
        removed += groups.length - kept.length;
        if (kept.length)
            hooks[event] = kept;
        else
            delete hooks[event];
    }
    for (const [event, groups] of Object.entries(ours))
        hooks[event] = [...(hooks[event] ?? []), ...groups];
    const adding = Object.keys(ours).length > 0;
    if (!adding && !removed) {
        console.log(`no Canny hooks in ${file}`);
        return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
    console.log(`${adding ? "wrote" : "removed Canny hooks from"} ${file}`);
}
function remove() {
    const root = opts.global ? homedir() : process.cwd();
    for (const file of [join(root, ".claude", "settings.json"), join(root, ".codex", "hooks.json")])
        if (existsSync(file))
            merge(file, {});
}
/** A project config can only turn checks off once the user has seen it and said so. */
function trustConfig() {
    const found = findConfig(process.cwd());
    if (!found) {
        console.log(`no .canny.json at or above ${process.cwd()}`);
        return;
    }
    trust(found.file);
    const fields = WEAKENING.filter((f) => found.config[f] !== undefined);
    console.log(fields.length
        ? `trusted ${found.file}: ${fields.join(", ")} now take effect`
        : `trusted ${found.file}`);
}
function pick() {
    const file = target ?? listSessions()[0]?.file;
    if (!file) {
        console.log(`no sessions recorded under ${home()}`);
        return null;
    }
    return { file, entries: read(file) };
}
function status() {
    // Before the session lookup: a fresh project has no sessions yet but can already have a config.
    const config = findConfig(process.cwd());
    if (config && !config.trusted) {
        const ignored = WEAKENING.filter((f) => config.config[f] !== undefined);
        if (ignored.length)
            console.log(`config    ${config.file} is untrusted, so ${ignored.join(", ")} ${ignored.length > 1 ? "are" : "is"} ignored; \`canny trust\` accepts it`);
    }
    const picked = pick();
    if (!picked)
        return;
    const { file, entries } = picked;
    const s = summarize(entries);
    const stops = entries.filter((e) => e.type === "verdict" && e.phase === "stop");
    const jev = entries.filter((e) => e.type === "jev");
    console.log(`session   ${basename(file)}`);
    console.log(`events    ${entries.filter((e) => e.type === "event").length}`);
    console.log(`edited    ${s.codeFiles.length ? s.codeFiles.join(", ") : "nothing that needs a check"}`);
    console.log(`verified  ${s.verified ? `yes: \`${s.verified.command}\` passed after the last edit` : "no passing check since the last edit"}`);
    if (s.lastCommand)
        console.log(`last cmd  \`${s.lastCommand.command}\` exit ${s.lastCommand.exitCode ?? "?"}: ${s.lastCommand.summary}`);
    const repeats = Object.values(s.repeats).filter((r) => r.n > 1);
    if (repeats.length)
        console.log(`repeats   ${repeats.map((r) => `\`${r.command}\` x${r.n}`).join("; ")}`);
    console.log(`stops     ${stops.map((e) => (e.type === "verdict" ? e.decision : "")).join(", ") || "none yet"}`);
    console.log(`jev       ${jev.length} calls, ${jev.filter((e) => e.type === "jev" && e.cached).length} cached, ${jev.filter((e) => e.type === "jev" && e.error).length} failed`);
}
/** Re-run the gate over the recorded facts with the recorded Jev answers. Any mismatch means the gate is not deterministic. */
function replay() {
    const picked = pick();
    if (!picked)
        return;
    const { entries } = picked;
    const config = loadConfig(process.cwd());
    let mismatches = 0;
    entries.forEach((e, i) => {
        if (e.type !== "event" || e.fact.kind !== "stop")
            return;
        const rest = entries.slice(i + 1);
        const verdictAt = rest.findIndex((x) => x.type === "verdict");
        const verdict = verdictAt >= 0 ? rest[verdictAt] : undefined;
        const jev = rest.slice(0, verdictAt >= 0 ? verdictAt : 0).find((x) => x.type === "jev");
        const answers = jev?.type === "jev" ? jev.answers : null;
        const decision = decideStop(summarize(entries.slice(0, i + 1)), e.fact.stopHookActive, answers?.claims_done, config);
        const recorded = verdict?.type === "verdict" ? verdict.decision : "(none)";
        const ok = decision.kind === recorded;
        if (!ok)
            mismatches++;
        console.log(`#${i} stop  recorded=${recorded}  replayed=${decision.kind}  ${ok ? "ok" : "MISMATCH"}`);
    });
    console.log(mismatches ? `${mismatches} mismatch(es)` : "all Stop verdicts reproduced");
    process.exitCode = mismatches ? 1 : 0;
}
