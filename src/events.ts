import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

export type Agent = "claude" | "codex";
export type Phase = "pre" | "post" | "stop" | "other";

export interface FileChange {
  path: string;
  added: string;
  removed: string;
  /** Write replaces the whole file, so `removed` is only known by reading the file from disk. */
  wholeFile?: boolean;
  deleted?: boolean;
}

export type Event =
  | { kind: "edit"; changes: FileChange[] }
  | {
      kind: "command";
      command: string;
      exitCode: number | null;
      output: string;
      changedFiles: string[];
    }
  | { kind: "stop"; message: string; stopHookActive: boolean }
  | { kind: "other" };

export interface Ctx {
  agent: Agent;
  phase: Phase;
  hookEvent: string;
  session: string;
  cwd: string;
  tool: string;
  event: Event;
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

/** Codex adds `turn_id` and `model` to every event; Claude Code sends neither. */
export function detectAgent(input: Obj): Agent {
  return typeof input.turn_id === "string" || typeof input.model === "string" ? "codex" : "claude";
}

/** Turn a raw hook payload from either agent into one event shape. */
export function normalize(raw: unknown, agent?: Agent): Ctx {
  const input = obj(raw);
  const hookEvent = str(input.hook_event_name);
  const phase = phaseOf(hookEvent);
  const tool = str(input.tool_name);
  const ctx: Ctx = {
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
  if (phase === "other") return ctx;
  const ti =
    typeof input.tool_input === "string" ? { command: input.tool_input } : obj(input.tool_input);
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

const edit = (c: FileChange): Event => ({ kind: "edit", changes: c.path ? [c] : [] });

function phaseOf(name: string): Phase {
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
export function parsePatch(text: string): FileChange[] {
  const changes: FileChange[] = [];
  let cur: FileChange | undefined;
  for (const line of text.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      cur = { path: m[2]!.trim(), added: "", removed: "", deleted: m[1] === "Delete" };
      changes.push(cur);
      continue;
    }
    if (!cur || line.startsWith("*** ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) cur.added += line.slice(1) + "\n";
    else if (line.startsWith("-")) cur.removed += line.slice(1) + "\n";
  }
  return changes;
}

function command(input: Obj, cmd: string, phase: Phase, agent: Agent): Event {
  const base = {
    kind: "command" as const,
    command: cmd,
    exitCode: null as number | null,
    output: "",
    // Read from the command text, so a command that failed or answered with a bare string still counts.
    changedFiles: phase === "pre" ? [] : shellChanges(cmd),
  };
  if (phase === "pre") return base;
  if (input.hook_event_name === "PostToolUseFailure") {
    const err = str(input.error);
    return { ...base, exitCode: leadingExit(err), output: err };
  }
  const resp = input.tool_response;
  const r = obj(resp);
  const output =
    typeof resp === "string"
      ? resp
      : [str(r.stdout), str(r.stderr), str(r.output)].filter(Boolean).join("\n");
  const meta = obj(r.metadata);
  const structured =
    num(r.exit_code) ?? num(r.exitCode) ?? num(meta.exit_code) ?? num(meta.exitCode);
  // Codex sends shell output with no exit status, so the session transcript is the source of truth
  // there. Claude Code only fires PostToolUse for commands that succeeded.
  const exitCode =
    structured ??
    (agent === "codex"
      ? (transcriptExit(str(input.transcript_path), str(input.tool_use_id)) ?? exitFromText(output))
      : (exitFromText(output) ?? 0));
  if (typeof resp === "string") return { ...base, exitCode, output };
  const diff = obj(r.bashEditDiff);
  const fromDiff = Array.isArray(diff.changedFiles)
    ? diff.changedFiles.filter((f): f is string => typeof f === "string")
    : [];
  const changedFiles = [...new Set([...fromDiff, ...base.changedFiles])];
  return { ...base, exitCode, output, changedFiles };
}

const NOT_A_FILE = /^(&\d*|\/dev\/(null|stdout|stderr|tty)|-)$/;

const HEREDOC = /<<-?\s*(["']?)([^\s"'<>|;&]+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;

/** Heredoc bodies hold text, not shell: `> quote` in markdown, `rm x` in a script being written. */
const withoutHeredocs = (cmd: string): string => cmd.replace(HEREDOC, (m) => m.split("\n", 1)[0]!);

const unquote = (t: string): string => t.replace(/^["']|["']$/g, "");

export interface FileOps {
  /** Destinations of `cp` and `mv`, and files `git checkout --` or `git restore` overwrite. */
  written: string[];
  /** Arguments of `rm` and `git rm`. */
  removed: string[];
  /** Source and destination of each `mv` and `git mv`. */
  moved: [from: string, to: string][];
}

/** Files a shell command copies, moves, deletes, or restores. No Write or Edit hook fires for these. */
// ponytail: reads rm, cp, mv and git at command position, after `then`/`do`/`else`, or by path; `find -exec rm`, `xargs rm`, and a second heredoc on one command line are not seen
export function fileOps(cmd: string): FileOps {
  const ops: FileOps = { written: [], removed: [], moved: [] };
  const found = withoutHeredocs(cmd).matchAll(
    /(?:^|[;&|(\n]|\b(?:then|do|else)\s)\s*(?:sudo\s+)?(?:[^\s;&|]*\/)?(rm|cp|mv|git\s+(?:rm|mv|checkout|restore))\s+([^;&|\n]*)/g,
  );
  for (const m of found) {
    const op = m[1]!.replace(/\s+/g, " ");
    let tokens: string[] = m[2]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const redirect = tokens.findIndex((t) => /^\d?[<>]/.test(t));
    if (redirect >= 0) tokens = tokens.slice(0, redirect);
    const dashes = tokens.indexOf("--");
    const paths = (
      op === "git checkout"
        ? tokens.slice(dashes < 0 ? tokens.length : dashes + 1)
        : tokens.filter(
            (t, i) => !t.startsWith("-") && !/^(--source|-s)$/.test(tokens[i - 1] ?? ""),
          )
    ).map(unquote);
    // `git rm -n` only prints what it would remove.
    if (op === "git rm" && tokens.some((t) => t === "-n" || t === "--dry-run")) continue;
    if (op === "rm" || op === "git rm") ops.removed.push(...paths);
    else if (op === "git checkout") ops.written.push(...paths);
    else if (op === "git restore") {
      if (!tokens.includes("--staged") || tokens.includes("--worktree")) ops.written.push(...paths);
    } else if (paths.length >= 2) {
      const to = paths.at(-1)!;
      ops.written.push(to);
      if (op !== "cp") for (const from of paths.slice(0, -1)) ops.moved.push([from, to]);
    }
  }
  return ops;
}

/** Every file a shell command changes, as far as its text shows. */
const shellChanges = (cmd: string): string[] => {
  const ops = fileOps(cmd);
  return [...writeTargets(cmd), ...ops.written, ...ops.removed, ...ops.moved.map(([from]) => from)];
};

/** `echo` or `printf` as a word anywhere in the statement, so wrappers such as `command`, `env`, and `then` need no list. */
// ponytail: text written by an interpreter (`python -c`, `node -e`) is not read; add when it shows up in ledgers
const PRINTS = /(?:^|[\s|(/])(?:echo|printf)\s/;

/**
 * Literal text a command puts into files, with the files it goes to: heredoc bodies and `echo` or
 * `printf` statements that redirect or pipe into `tee`. A key in a `curl` header whose response is
 * saved is used, not written, so it is not part of this.
 */
export function shellWrites(cmd: string): { text: string; targets: string[] }[] {
  const out: { text: string; targets: string[] }[] = [];
  for (const m of cmd.matchAll(HEREDOC)) {
    // The match starts at `<<`; the redirect can sit on either side of it on the same line.
    const opener = m[0].split("\n", 1)[0]!;
    const head = cmd.slice(cmd.lastIndexOf("\n", m.index) + 1, m.index) + opener;
    out.push({ text: m[0].slice(opener.length), targets: writeTargets(head) });
  }
  for (const statement of withoutHeredocs(cmd).split(/&&|\|\||[;\n]/))
    if (PRINTS.test(statement)) out.push({ text: statement, targets: writeTargets(statement) });
  return out.filter((w) => w.targets.length);
}

/**
 * Files a shell command writes by redirection or in-place edit. Agents write files this way when
 * told to prefer the shell, and no Write or Edit hook fires for it.
 */
export function writeTargets(cmd: string): string[] {
  const out: string[] = [];
  // Quoted strings hold text, not redirections: `a > b` in a commit message. A quoted string right
  // after `>` or `tee` is a file name and stays.
  const shell = withoutHeredocs(cmd).replace(
    /(>\s*|\btee\s+(?:-[ai]+\s+)*)?("[^"]*"|'[^']*')/g,
    (m, keep?: string) => (keep ? m : ""),
  );
  for (const m of shell.matchAll(/(?:^|[\s;&|(])\d?>{1,2}\s*("[^"]*"|'[^']*'|[^\s;&|)<>]+)/g))
    out.push(m[1]!);
  for (const m of shell.matchAll(/\btee\s+([^;&|)<>]+)/g))
    for (const t of m[1]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) if (!t.startsWith("-")) out.push(t);
  for (const m of cmd.matchAll(/\b(?:sed\s+-i\S*|perl\s+-p?i\S*)\s+([^;&|]+)/g)) {
    const tokens = m[1]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let skipNext = false;
    for (const t of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (t === "-e" || t === "-f") skipNext = true;
      else if (!t.startsWith("-") && !/^["']/.test(t) && !/^s[/|#]/.test(t)) out.push(t);
    }
  }
  return out.map(unquote).filter((t) => t && !NOT_A_FILE.test(t));
}

/** Claude Code's PostToolUseFailure error starts with `Exit code N` when the command ran at all. */
function leadingExit(err: string): number | null {
  const m = /^Exit code (\d+)/.exec(err);
  return m ? Number(m[1]) : null;
}

/** Only the first and last lines of output are searched, so test output cannot spoof an exit status. */
function exitFromText(text: string): number | null {
  const lines = text.split("\n");
  const edge = [...lines.slice(0, 3), ...lines.slice(-3)].join("\n");
  const m = /(?:exit(?:ed)? (?:with )?(?:code|status)|exit code)[:\s]+(-?\d+)/i.exec(edge);
  return m ? Number(m[1]) : null;
}

const TAIL_BYTES = 512 * 1024;

/**
 * Codex writes an `item_completed` record with the command's `exit_code` to the rollout file
 * before the hook runs. Only the tail of the file is read; one short retry covers a record that
 * is still being flushed.
 */
export function transcriptExit(transcript: string, toolUseId: string): number | null {
  if (!transcript || !toolUseId || !existsSync(transcript)) return null;
  for (let attempt = 0; ; attempt++) {
    const found = scanTail(transcript, toolUseId);
    if (found !== null || attempt === 1) return found;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function scanTail(file: string, toolUseId: string): number | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes(toolUseId) || !line.includes("item_completed")) continue;
      try {
        const item = obj(obj(obj(JSON.parse(line)).payload).item);
        if (item.id === toolUseId) return num(item.exit_code);
      } catch {
        // A partial first line or unrelated record; keep scanning.
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
