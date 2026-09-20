import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fingerprint, isIgnored, isVerify, plain, sha } from "./checks.js";
import { home, type Config } from "./config.js";
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

export type Entry =
  | { ts: number; type: "event"; phase: Phase; hookEvent: string; tool: string; fact: Fact }
  | { ts: number; type: "verdict"; phase: Phase; decision: string; message?: string }
  | ({ ts: number; type: "jev" } & JevLog);

export const sessionsDir = (): string => join(home(), "sessions");

export const sessionFile = (agent: Agent, session: string): string =>
  join(sessionsDir(), `${agent}-${session.replace(/[^\w.-]/g, "_")}.jsonl`);

/** Paths are kept relative to the session cwd so ledgers read the same on any machine. */
export const rel = (cwd: string, p: string): string =>
  plain(isAbsolute(p) ? relative(cwd, p) || p : p);

/**
 * The part of an event worth keeping: paths and outcomes, never file contents. Every string goes
 * through `plain`, because the ledger is printed to the user's terminal and into agent messages.
 */
export function toFact(event: Event, cwd: string, config: Config): Fact | null {
  const code = (paths: string[]): string[] => paths.filter((p) => !isIgnored(p, config));
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
export function append(file: string, entry: Entry): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function read(file: string): Entry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
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
      for (const p of f.code) if (!s.codeFiles.includes(p)) s.codeFiles.push(p);
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

export function listSessions(): { file: string; mtime: number }[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}
