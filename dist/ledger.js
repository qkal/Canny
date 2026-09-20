import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fingerprint, isIgnored, isVerify, plain, sha } from "./checks.js";
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
    const code = (paths) => paths.filter((p) => !isIgnored(p, config));
    switch (event.kind) {
        case "edit": {
            const files = event.changes.filter((c) => !c.deleted).map((c) => rel(cwd, c.path));
            const deleted = event.changes.filter((c) => c.deleted).map((c) => rel(cwd, c.path));
            return { kind: "edit", files, deleted, code: code([...files, ...deleted]) };
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
                code: code(event.changedFiles.map((p) => rel(cwd, p))),
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
export function read(file) {
    if (!existsSync(file))
        return [];
    return readFileSync(file, "utf8")
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
export function listSessions() {
    const dir = sessionsDir();
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
}
