import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
/** Whether untrusted JSON is a plain object. `null` and arrays are not. */
export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => typeof v === "number" && Number.isInteger(v) ? v : null;
/** Codex adds `turn_id` and `model` to every event; Claude Code sends neither. */
export function detectAgent(input) {
    return typeof input.turn_id === "string" || typeof input.model === "string" ? "codex" : "claude";
}
/** Shells, which need the PostToolUseFailure hook as well. */
export const SHELL_TOOLS = ["Bash", "PowerShell"];
/** The tools `normalize` understands, and so the tools the installed hooks must match. */
export const TOOLS = {
    claude: ["Write", "Edit", "MultiEdit", "NotebookEdit", ...SHELL_TOOLS],
    codex: ["Bash", "apply_patch"],
};
/** Turn a raw hook payload from either agent into one event shape. */
export function normalize(raw, agent) {
    const input = obj(raw);
    const hookEvent = str(input.hook_event_name);
    const phase = phaseOf(hookEvent);
    const tool = str(input.tool_name);
    const ctx = {
        agent: agent ?? detectAgent(input),
        phase,
        hookEvent,
        session: str(input.session_id) || "unknown",
        cwd: str(input.cwd) || process.cwd(),
        tool,
        event: { kind: "other" },
    };
    if (phase === "stop") {
        ctx.event = {
            kind: "stop",
            message: str(input.last_assistant_message),
            stopHookActive: input.stop_hook_active === true,
        };
        return ctx;
    }
    if (phase === "other")
        return ctx;
    const ti = typeof input.tool_input === "string" ? { command: input.tool_input } : obj(input.tool_input);
    switch (tool) {
        case "Write":
            ctx.event = edit({
                path: str(ti.file_path),
                added: str(ti.content),
                removed: "",
                wholeFile: true,
            });
            break;
        case "Edit":
            ctx.event = edit({
                path: str(ti.file_path),
                added: str(ti.new_string),
                removed: str(ti.old_string),
            });
            break;
        case "MultiEdit": {
            const edits = Array.isArray(ti.edits) ? ti.edits.map(obj) : [];
            ctx.event = edit({
                path: str(ti.file_path),
                added: edits.map((e) => str(e.new_string)).join("\n"),
                removed: edits.map((e) => str(e.old_string)).join("\n"),
            });
            break;
        }
        case "NotebookEdit":
            ctx.event = edit({ path: str(ti.notebook_path), added: str(ti.new_source), removed: "" });
            break;
        case "apply_patch":
            ctx.event = {
                kind: "edit",
                changes: parsePatch(str(ti.command) || str(ti.patch) || str(ti.input)),
            };
            break;
        case "Bash":
        case "PowerShell":
            ctx.event = command(input, str(ti.command), phase, ctx.agent);
            break;
        default:
            break;
    }
    return ctx;
}
const edit = (c) => ({ kind: "edit", changes: c.path ? [c] : [] });
function phaseOf(name) {
    switch (name) {
        case "PreToolUse":
            return "pre";
        case "PostToolUse":
        case "PostToolUseFailure":
            return "post";
        case "Stop":
            return "stop";
        default:
            return "other";
    }
}
/** Codex apply_patch format: `*** Update File: path` sections with +/- lines. */
export function parsePatch(text) {
    const changes = [];
    let cur;
    for (const line of text.split("\n")) {
        const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
        if (m) {
            cur = { path: m[2].trim(), added: "", removed: "", deleted: m[1] === "Delete" };
            changes.push(cur);
            continue;
        }
        if (!cur || line.startsWith("*** ") || line.startsWith("@@"))
            continue;
        if (line.startsWith("+"))
            cur.added += line.slice(1) + "\n";
        else if (line.startsWith("-"))
            cur.removed += line.slice(1) + "\n";
    }
    return changes;
}
function command(input, cmd, phase, agent) {
    // Nothing has run yet, so there is no output and nothing has changed on disk.
    if (phase === "pre")
        return { kind: "command", command: cmd, exitCode: null, output: "", changedFiles: [] };
    // Read from the command text, so a command that failed or answered with a bare string still counts.
    const fromText = shellChanges(cmd);
    if (input.hook_event_name === "PostToolUseFailure") {
        const err = str(input.error);
        return {
            kind: "command",
            command: cmd,
            exitCode: leadingExit(err),
            output: err,
            changedFiles: [...new Set(fromText)],
        };
    }
    const resp = input.tool_response;
    const r = obj(resp);
    const output = typeof resp === "string"
        ? resp
        : [str(r.stdout), str(r.stderr), str(r.output)].filter(Boolean).join("\n");
    const meta = obj(r.metadata);
    const structured = num(r.exit_code) ?? num(r.exitCode) ?? num(meta.exit_code) ?? num(meta.exitCode);
    // Codex sends shell output with no exit status, so the session transcript is the source of truth
    // there. Claude Code only fires PostToolUse for commands that succeeded.
    const exitCode = structured ??
        (agent === "codex"
            ? (transcriptExit(str(input.transcript_path), str(input.tool_use_id)) ?? exitFromText(output))
            : (exitFromText(output) ?? 0));
    const diff = obj(r.bashEditDiff);
    const fromDiff = Array.isArray(diff.changedFiles)
        ? diff.changedFiles.filter((f) => typeof f === "string")
        : [];
    return {
        kind: "command",
        command: cmd,
        exitCode,
        output,
        changedFiles: [...new Set([...fromDiff, ...fromText])],
    };
}
const NOT_A_FILE = /^(&\d*|\/dev\/(null|stdout|stderr|tty)|-)$/;
/** The delimiter may be bare, quoted, or escaped as in `<<\EOF`. */
const HEREDOC = /<<-?\s*(?:\\|(["']?))([^\s"'<>|;&\\]+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;
/** Heredoc bodies hold text, not shell: `> quote` in markdown, `rm x` in a script being written. */
const withoutHeredocs = (cmd) => cmd.replace(HEREDOC, (m) => m.split("\n", 1)[0]);
const unquote = (t) => t.replace(/^["']|["']$/g, "");
/** A quoted shell string. Inside double quotes `\"` is text, not the end: `echo "{\"a\": 1};" > f`. */
const QUOTED = String.raw `"(?:\\.|[^"\\])*"|'[^']*'`;
/** Shell word splitting, kept in one place so every argument list splits the same way. */
// Safe to share: `String.prototype.match` with a `/g` regex resets `lastIndex`. Do not use with `.test`.
const TOKENS = new RegExp(String.raw `${QUOTED}|\S+`, "g");
/** Files a shell command copies, moves, deletes, or restores. No Write or Edit hook fires for these. */
// ponytail: reads rm, cp, mv and git at command position, after `then`/`do`/`else`, or by path; `find -exec rm`, `xargs rm`, and a second heredoc on one command line are not seen
export function fileOps(cmd) {
    const ops = { written: [], removed: [], moved: [] };
    const found = withoutHeredocs(cmd).matchAll(/(?:^|[;&|(\n]|\b(?:then|do|else)\s)\s*(?:sudo\s+)?(?:[^\s;&|]*\/)?(rm|cp|mv|git\s+(?:rm|mv|checkout|restore))\s+([^;&|\n]*)/g);
    for (const m of found) {
        const op = m[1].replace(/\s+/g, " ");
        let tokens = m[2].match(TOKENS) ?? [];
        const redirect = tokens.findIndex((t) => /^\d?[<>]/.test(t));
        if (redirect >= 0)
            tokens = tokens.slice(0, redirect);
        const dashes = tokens.indexOf("--");
        const paths = (op === "git checkout"
            ? tokens.slice(dashes < 0 ? tokens.length : dashes + 1)
            : tokens.filter((t, i) => !t.startsWith("-") && !/^(--source|-s)$/.test(tokens[i - 1] ?? ""))).map(unquote);
        // `git rm -n` and `git mv -n` only print what they would do.
        if (/^git (rm|mv)$/.test(op) && tokens.some((t) => t === "-n" || t === "--dry-run"))
            continue;
        if (op === "rm" || op === "git rm")
            ops.removed.push(...paths);
        else if (op === "git checkout")
            ops.written.push(...paths);
        else if (op === "git restore") {
            if (!tokens.includes("--staged") || tokens.includes("--worktree"))
                ops.written.push(...paths);
        }
        else if (paths.length >= 2) {
            const to = paths.at(-1);
            ops.written.push(to);
            // Into a directory the file keeps its name: `mv test/a.test.ts src/` lands at `src/a.test.ts`.
            const intoDir = to.endsWith("/") || paths.length > 2;
            if (op !== "cp")
                for (const from of paths.slice(0, -1))
                    ops.moved.push([from, intoDir ? join(to, basename(from)) : to]);
        }
    }
    return ops;
}
/** Every file a shell command changes, as far as its text shows. */
const shellChanges = (cmd) => {
    const ops = fileOps(cmd);
    return [...writeTargets(cmd), ...ops.written, ...ops.removed, ...ops.moved.map(([from]) => from)];
};
/** `echo` or `printf` as a word anywhere in the statement, so wrappers such as `command`, `env`, and `then` need no list. */
// ponytail: text written by an interpreter (`python -c`, `node -e`) is not read; add when it shows up in ledgers
const PRINTS = /(?:^|[\s|(/])(?:echo|printf)\s/;
/** Split at `;`, `&&`, `||`, and newlines, but not inside quotes: written code is full of `;`. */
function statements(cmd) {
    const out = [""];
    cmd.split(new RegExp(`(${QUOTED})`)).forEach((part, i) => {
        const pieces = i % 2 ? [part] : part.split(/&&|\|\||[;\n]/);
        out.push(out.pop() + pieces[0], ...pieces.slice(1));
    });
    return out;
}
/**
 * Literal text a command puts into files, with the files it goes to: heredoc bodies and `echo` or
 * `printf` statements that redirect or pipe into `tee`. A key in a `curl` header whose response is
 * saved is used, not written, so it is not part of this.
 */
export function shellWrites(cmd) {
    const out = [];
    for (const m of cmd.matchAll(HEREDOC)) {
        // The match starts at `<<`; the redirect can sit on either side of it on the same line.
        const opener = m[0].split("\n", 1)[0];
        const head = cmd.slice(cmd.lastIndexOf("\n", m.index) + 1, m.index) + opener;
        out.push({ text: m[0].slice(opener.length), head, targets: writeTargets(head) });
    }
    for (const statement of statements(withoutHeredocs(cmd)))
        if (PRINTS.test(statement))
            out.push({ text: statement, head: statement, targets: writeTargets(statement) });
    return out.filter((w) => w.targets.length);
}
/**
 * Files a shell command writes by redirection or in-place edit. Agents write files this way when
 * told to prefer the shell, and no Write or Edit hook fires for it.
 */
export function writeTargets(cmd) {
    const out = [];
    // Quoted strings hold text, not redirections: `a > b` in a commit message. A quoted string right
    // after `>` or `tee` is a file name and stays.
    const shell = withoutHeredocs(cmd).replace(new RegExp(String.raw `(>\s*|\btee\s+(?:-[ai]+\s+)*)?(${QUOTED})`, "g"), (m, keep) => (keep ? m : ""));
    const redirect = new RegExp(String.raw `(?:^|[\s;&|(])\d?>{1,2}\s*(${QUOTED}|[^\s;&|)<>]+)`, "g");
    for (const m of shell.matchAll(redirect))
        out.push(m[1]);
    for (const m of shell.matchAll(/\btee\s+([^;&|)<>]+)/g))
        for (const t of m[1].match(TOKENS) ?? [])
            if (!t.startsWith("-"))
                out.push(t);
    for (const e of inPlace(cmd))
        out.push(...e.files);
    return out.map(unquote).filter((t) => t && !NOT_A_FILE.test(t));
}
/** `-i`, alone or in a cluster such as `-Ei` or `-pi.bak`. Perl's `-M` and `-I` take a word, not flags. */
const IN_PLACE = { sed: /^(?:-[a-zA-Z]*i|--in-place)/, perl: /^-(?![MI])[a-zA-Z0]*i/ };
/** Options whose value is the script: `-e`, `-f`, a cluster ending in one (`-pie`), and sed's long forms. */
const TAKES_SCRIPT = /^(?:-[a-zA-Z]*[ef]|--expression|--file)$/;
/** Each in-place `sed` or `perl` in a command: its scripts, and the files it rewrites. */
function inPlace(cmd) {
    const out = [];
    // Quoted strings are whole arguments: a script holds `;` and `|` that end nothing.
    const call = new RegExp(String.raw `\b(sed|perl)\s+((?:${QUOTED}|[^;&|\n"'])+)`, "g");
    for (const m of cmd.matchAll(call)) {
        const flag = IN_PLACE[m[1]];
        const tokens = m[2].match(TOKENS) ?? [];
        if (!tokens.some((t) => flag.test(t)))
            continue;
        const edit = { scripts: [], files: [] };
        const named = tokens.some((t) => TAKES_SCRIPT.test(t) || t.startsWith("--expression="));
        for (const [i, t] of tokens.entries()) {
            const before = tokens[i - 1] ?? "";
            if (/^\d?[<>]/.test(t))
                break;
            if (TAKES_SCRIPT.test(before))
                edit.scripts.push(unquote(t));
            else if (t.startsWith("--expression="))
                edit.scripts.push(unquote(t.slice(13)));
            else if (t.startsWith("-"))
                continue;
            // BSD sed takes the backup suffix as its own argument: `sed -i '' …`, `sed -i .bak …`.
            else if (flag.test(before) && /^(?:''|""|\.\w+)$/.test(t))
                continue;
            // With no `-e`, the first operand is the script and the rest are files, quoted or not.
            else if (!named && !edit.scripts.length)
                edit.scripts.push(unquote(t));
            else
                edit.files.push(t);
        }
        out.push(edit);
    }
    return out;
}
// An address may come first: `/it(/s/a/b/`, `1,5s/a/b/`, `$s/a/b/`.
const SUBSTITUTE = /(?:^|[;{/\d$]|\s)\s*s([/|#,])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1/g;
/**
 * What a shell command does to files, in the shape of an edit, so the checks that read edits read
 * it too. A redirect replaces the file unless it appends. An in-place script is not run: the text
 * its `s` commands take out and put in, and the pattern of a delete, stand in for the change.
 */
// ponytail: a delete by line number (`5,10d`) and a script in a file (`-f`) say nothing about the text they remove
export function shellEdits(cmd) {
    const changes = [];
    for (const w of shellWrites(cmd)) {
        const wholeFile = !/>>|\btee\s+(?:-\S+\s+)*(?:-[a-zA-Z]*a|--append)\b/.test(
        // Quoted text is payload, not shell: `echo ">>" > file` replaces the file.
        w.head.replace(new RegExp(QUOTED, "g"), ""));
        for (const path of w.targets)
            changes.push({ path, added: w.text, removed: "", wholeFile });
    }
    for (const e of inPlace(cmd)) {
        let added = "";
        let removed = "";
        for (const script of e.scripts) {
            for (const m of script.matchAll(SUBSTITUTE)) {
                removed += m[2] + "\n";
                added += m[3] + "\n";
            }
            if (/d\s*\}?\s*$/.test(script) && !/^s\W/.test(script))
                removed += script + "\n";
        }
        // Regex escapes are not part of the text: `\bit\(` takes out `it(`.
        const text = (t) => t.replace(/\\(\W)/g, "$1").replace(/\\\w/g, " ");
        for (const path of e.files.map(unquote))
            changes.push({ path, added: text(added), removed: text(removed) });
    }
    return changes;
}
/** Claude Code's PostToolUseFailure error starts with `Exit code N` when the command ran at all. */
function leadingExit(err) {
    const m = /^Exit code (\d+)/.exec(err);
    return m ? Number(m[1]) : null;
}
/** Only the first and last lines of output are searched, so test output cannot spoof an exit status. */
function exitFromText(text) {
    const lines = text.split("\n");
    const edge = [...lines.slice(0, 3), ...lines.slice(-3)].join("\n");
    const m = /(?:exit(?:ed)? (?:with )?(?:code|status)|exit code)[:\s]+(-?\d+)/i.exec(edge);
    return m ? Number(m[1]) : null;
}
const TAIL_BYTES = 512 * 1024;
/**
 * Codex writes an `item_completed` record with the command's `exit_code` to the rollout file
 * before the hook runs. Only the tail of the file is read; short retries cover a record that is
 * still being flushed, and return as soon as it lands rather than sleeping out the whole budget.
 */
const FLUSH_TRIES = 5;
const FLUSH_WAIT_MS = 10;
export function transcriptExit(transcript, toolUseId) {
    if (!transcript || !toolUseId || !existsSync(transcript))
        return null;
    for (let attempt = 0;; attempt++) {
        const found = scanTail(transcript, toolUseId);
        if (found !== null || attempt === FLUSH_TRIES)
            return found;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FLUSH_WAIT_MS);
    }
}
function scanTail(file, toolUseId) {
    let fd;
    try {
        fd = openSync(file, "r");
    }
    catch {
        return null;
    }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, size - length);
        const lines = buf.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line.includes(toolUseId) || !line.includes("item_completed"))
                continue;
            try {
                const item = obj(obj(obj(JSON.parse(line)).payload).item);
                if (item.id === toolUseId)
                    return num(item.exit_code);
            }
            catch {
                // A partial first line or unrelated record; keep scanning.
            }
        }
        return null;
    }
    finally {
        closeSync(fd);
    }
}
