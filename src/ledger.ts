import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fingerprint, inside, isIgnored, isScratch, isVerify, plain, sha } from "./checks.js";
import { errorLog, home, type Config } from "./config.js";
import type { Agent, Event, Phase } from "./events.js";
import type { JevLog } from "./jev.js";

export interface CommandFact {
  kind: "command";
  command: string;
  exitCode: number | null;
  verify: boolean;
  fingerprint: string;
  summary: string;
  /** Code files the command wrote, by redirection or as reported by the agent. */
  code: string[];
}

export type Fact =
  | { kind: "edit"; files: string[]; deleted: string[]; code: string[] }
  | CommandFact
  | { kind: "stop"; stopHookActive: boolean; messageHash: string };

/**
 * A forensic record as well as the gate's input: `files`, `deleted`, `messageHash`, `hookEvent` and
 * `tool` are written for the user reading the jsonl, not read back by `summarize`.
 * `cwd` is missing from ledgers written before it was recorded.
 */
export type Entry =
  | {
      ts: number;
      type: "event";
      cwd?: string;
      phase: Phase;
      hookEvent: string;
      tool: string;
      fact: Fact;
    }
  | { ts: number; type: "verdict"; cwd?: string; phase: Phase; decision: string; message?: string }
  | ({ ts: number; type: "jev" } & JevLog);

export const sessionsDir = (): string => join(home(), "sessions");

export const sessionFile = (agent: Agent, session: string): string =>
  join(sessionsDir(), `${agent}-${session.replace(/[^\w.-]/g, "_")}.jsonl`);

/**
 * Paths are kept relative to the session cwd so ledgers read the same on any machine, and in one
 * spelling: `./src/a.ts` and `lib/../src/a.ts` are `src/a.ts`, so an `ignore` pattern matches all three.
 */
export const rel = (cwd: string, p: string): string => plain(relative(cwd, resolve(cwd, p)) || p);

/**
 * The part of an event worth keeping: paths and outcomes, never file contents. Every string goes
 * through `plain`, because the ledger is printed to the user's terminal and into agent messages.
 */
export function toFact(event: Event, cwd: string, config: Config): Fact | null {
  const code = (paths: string[]): string[] =>
    paths
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
export function append(file: string, entry: Entry): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

/** A ledger that is missing, unreadable, or not a file reads as empty, so one bad file never hides the others. */
export function read(file: string): Entry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Entry];
      } catch {
        return [];
      }
    });
}

export interface Summary {
  /** Code files edited this session, in first-seen order. */
  codeFiles: string[];
  /** The passing check that ran after the last code edit, if any. */
  verified: CommandFact | null;
  lastCommand: CommandFact | null;
  /** Failure fingerprint to how often it happened, with the command that produced it. */
  repeats: Record<string, { command: string; n: number }>;
  /** Edits and commands recorded since the last Stop block. -1 when nothing was ever blocked. */
  factsSinceBlock: number;
}

export function summarize(entries: Entry[]): Summary {
  const seen = new Set<string>();
  const s: Summary = {
    codeFiles: [],
    verified: null,
    lastCommand: null,
    repeats: {},
    factsSinceBlock: -1,
  };
  for (const e of entries) {
    if (e.type === "verdict") {
      if (e.decision === "block") s.factsSinceBlock = 0;
      continue;
    }
    if (e.type !== "event" || e.fact.kind === "stop") continue;
    const f = e.fact;
    if (f.code.length) {
      s.verified = null;
      for (const p of f.code)
        if (!seen.has(p)) {
          seen.add(p);
          s.codeFiles.push(p);
        }
    }
    if (f.kind === "command") {
      s.lastCommand = f;
      if (f.exitCode !== null && f.exitCode !== 0) {
        const r = (s.repeats[f.fingerprint] ??= { command: f.command, n: 0 });
        r.n++;
      }
      if (f.verify && f.exitCode === 0) s.verified = f;
    }
    if ((f.code.length || f.kind === "command") && s.factsSinceBlock >= 0) s.factsSinceBlock++;
  }
  return s;
}

/** The directory the agent was working in, which says which project a session belongs to. */
export const sessionCwd = (entries: Entry[]): string | undefined => {
  for (const e of entries) if (e.type !== "jev" && e.cwd) return e.cwd;
  return undefined;
};

/** One directory is the other, or sits inside it: the agent may run in a subdirectory of where the user stands, or the reverse. */
export const sameProject = (a: string, b: string): boolean => inside(a, b) || inside(b, a);

/** The most recent session recorded for the project at `cwd`. */
// ponytail: reads whole ledgers newest first until one matches; add an index file if ~/.canny/sessions grows into the thousands
export function latestSession(cwd: string): { file: string; entries: Entry[] } | null {
  const here = real(cwd);
  for (const { file } of listSessions()) {
    const entries = read(file);
    const at = sessionCwd(entries);
    if (at && sameProject(real(at), here)) return { file, entries };
  }
  return null;
}

/** The agent may report a path through a symlink (`/tmp` on macOS) that the shell resolves, or the reverse. */
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The hook fails open, so its crashes are only visible here. */
export function hookErrors(): { count: number; last: string } | null {
  let lines: string[];
  try {
    lines = readFileSync(errorLog(), "utf8").split("\n").filter(Boolean);
  } catch {
    // No log, or one that cannot be read: `status` still has a session to show.
    return null;
  }
  return lines.length ? { count: lines.length, last: plain(lines.at(-1)!).slice(0, 200) } : null;
}

export function listSessions(): { file: string; mtime: number }[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => {
      // A file can vanish between the listing and the stat.
      const stat = statSync(join(dir, f), { throwIfNoEntry: false });
      return stat ? [{ file: join(dir, f), mtime: stat.mtimeMs }] : [];
    })
    .sort((a, b) => b.mtime - a.mtime);
}
