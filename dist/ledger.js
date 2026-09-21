import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fingerprint, isIgnored, isScratch, isVerify, plain, sha } from "./checks.js";
import { home } from "./config.js";
export const sessionsDir = () => join(home(), "sessions");
export const sessionFile = (agent, session) => join(sessionsDir(), `${agent}-${session.replace(/[^\w.-]/g, "_")}.jsonl`);
/** Paths are kept relative to the session cwd so ledgers read the same on any machine. */
export const rel = (cwd, p) => plain(isAbsolute(p) ? relative(cwd, p) || p : p);
/**
 * The part of an event worth keeping: paths and outcomes, never file contents. Every string goes
 * through `plain`, because the ledger is printed to the user's terminal and into agent messages.
 */
export function toFact(event, cwd, config) {
    const code = (paths) => paths
        .filter((p) => !isScratch(p, cwd))
        .map((p) => rel(cwd, p))
        .filter((p) => !isIgnored(p, config));
    switch (event.kind) {
        case "edit": {
            const files = event.changes.filter((c) => !c.deleted).map((c) => rel(cwd, c.path));
            const deleted = event.changes.filter((c) => c.deleted).map((c) => rel(cwd, c.path));
            return { kind: "edit", files, deleted, code: code(event.changes.map((c) => c.path)) };
        }
        case "command": {
            const lines = event.output.split("\n").filter((l) => l.trim());
            return {
                kind: "command",
                command: plain(event.command),
                exitCode: event.exitCode,
                verify: isVerify(event.command, config),
                fingerprint: fingerprint(event.command, event.output),
                summary: plain(lines.at(-1) ?? "").slice(0, 200),
                code: code(event.changedFiles),
            };
        }
        case "stop":
            return {
                kind: "stop",
                stopHookActive: event.stopHookActive,
                messageHash: sha(event.message).slice(0, 16),
            };
        default:
            return null;
    }
}
/** Append-only so parallel hook processes never clobber each other. Owner-only: command lines can hold credentials. */
export function append(file, entry) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}
/** A ledger that is missing, unreadable, or not a file reads as empty, so one bad file never hides the others. */
export function read(file) {
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch {
        return [];
    }
    return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
}
export function summarize(entries) {
    const s = {
        codeFiles: [],
        verified: null,
        lastCommand: null,
        repeats: {},
        factsSinceBlock: -1,
    };
    for (const e of entries) {
        if (e.type === "verdict") {
            if (e.decision === "block")
                s.factsSinceBlock = 0;
            continue;
        }
        if (e.type !== "event" || e.fact.kind === "stop")
            continue;
        const f = e.fact;
        if (f.code.length) {
            s.verified = null;
            for (const p of f.code)
                if (!s.codeFiles.includes(p))
                    s.codeFiles.push(p);
        }
        if (f.kind === "command") {
            s.lastCommand = f;
            if (f.exitCode !== null && f.exitCode !== 0) {
                const r = (s.repeats[f.fingerprint] ??= { command: f.command, n: 0 });
                r.n++;
            }
            if (f.verify && f.exitCode === 0)
                s.verified = f;
        }
        if ((f.code.length || f.kind === "command") && s.factsSinceBlock >= 0)
            s.factsSinceBlock++;
    }
    return s;
}
/** The directory the agent was working in, which says which project a session belongs to. */
export const sessionCwd = (entries) => entries.flatMap((e) => (e.type !== "jev" && e.cwd ? [e.cwd] : []))[0];
/** One directory is the other, or sits inside it: the agent may run in a subdirectory of where the user stands, or the reverse. */
export const sameProject = (a, b) => inside(a, b) || inside(b, a);
/** `relative` gets the filesystem root and Windows drives right, which string prefixes do not. */
const inside = (parent, child) => {
    const r = relative(parent, child);
    return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};
/** The most recent session recorded for the project at `cwd`. */
// ponytail: reads whole ledgers newest first until one matches; add an index file if ~/.canny/sessions grows into the thousands
export function latestSession(cwd) {
    for (const { file } of listSessions()) {
        const entries = read(file);
        const at = sessionCwd(entries);
        if (at && sameProject(at, cwd))
            return { file, entries };
    }
    return null;
}
/** The hook fails open, so its crashes are only visible here. */
export function hookErrors() {
    const file = join(home(), "errors.log");
    if (!existsSync(file))
        return null;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.length ? { count: lines.length, last: plain(lines.at(-1)).slice(0, 200) } : null;
}
export function listSessions() {
    const dir = sessionsDir();
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
}
