#!/usr/bin/env node
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorLog, findConfig, home, loadConfig, trust, weakened } from "./config.js";
import { normalize, type Agent } from "./events.js";
import { CLAIMS_DONE_ID, decideStop, handle, serialize } from "./hook.js";
import { hookConfig, merge, type Hooks } from "./install.js";
import { makeJudge } from "./jev.js";
import {
  append,
  hookErrors,
  latestSession,
  listSessions,
  read,
  sessionCwd,
  sessionFile,
  summarize,
  type Entry,
} from "./ledger.js";

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
      console.log(
        `${new Date(s.mtime).toISOString()}  ${s.file}  ${sessionCwd(read(s.file)) ?? "(project not recorded)"}`,
      );
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
    console.log(
      [
        "canny: a supervision layer for AI coding agents",
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
      ].join("\n"),
    );
}

/** Stdout must hold exactly one JSON object; anything else confuses the agent. Errors go to a file. */
async function hook(): Promise<void> {
  let out: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(0, "utf8") || "{}");
    const ctx = normalize(raw, opts.agent as Agent | undefined);
    const file = sessionFile(ctx.agent, ctx.session);
    const judge = makeJudge({ log: (e) => append(file, { ts: Date.now(), type: "jev", ...e }) });
    out = serialize(ctx, await handle(ctx, { config: loadConfig(ctx.cwd), judge, file }), raw);
  } catch (e) {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    appendFileSync(errorLog(), `${new Date().toISOString()} ${String(e)}\n`, { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(out));
}

function init(): void {
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
  const command = self();
  if (command !== "canny")
    console.log(
      `Hooks call node with the path of this checkout, ${fileURLToPath(import.meta.url)}. Keep it there.`,
    );
  const root = opts.global ? homedir() : process.cwd();
  if (want.claude) write(settingsFile(root, "claude"), hookConfig("claude", command));
  if (want.codex) {
    write(settingsFile(root, "codex"), hookConfig("codex", command));
    console.log("Codex asks you to trust new hooks once: run /hooks inside Codex.");
  }
}

/** Where each agent keeps its hooks, so `init` and `remove` cannot disagree about the path. */
// A declaration, not a const: the command switch at the top of the file runs before any const below it exists.
function settingsFile(root: string, agent: Agent): string {
  return agent === "claude"
    ? join(root, ".claude", "settings.json")
    : join(root, ".codex", "hooks.json");
}

/** A settings file that cannot be merged into is left alone, and the command fails. */
function write(file: string, ours: Hooks): void {
  try {
    console.log(merge(file, ours));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

/** How to run this CLI from a shell: the bare name when it is on PATH, else node with this file. */
// A declaration, not a const: the command switch at the top of the file runs before any const below it exists.
function self(): string {
  return onPath("canny") ? "canny" : `node "${fileURLToPath(import.meta.url)}"`;
}

/** Whether a command of this name resolves on the current PATH. */
function onPath(name: string): boolean {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  return (process.env.PATH ?? "").split(delimiter).some((dir) =>
    names.some((n) => {
      try {
        accessSync(join(dir, n), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function remove(): void {
  const root = opts.global ? homedir() : process.cwd();
  for (const agent of ["claude", "codex"] as const) {
    const file = settingsFile(root, agent);
    if (existsSync(file)) write(file, {});
  }
}

/** A project config can only turn checks off once the user has seen it and said so. */
function trustConfig(): void {
  const found = findConfig(process.cwd());
  if (!found) {
    console.log(`no .canny.json at or above ${process.cwd()}`);
    return;
  }
  trust(found.file);
  const fields = weakened(found.config);
  console.log(
    fields.length
      ? `trusted ${found.file}: ${fields.join(", ")} now take effect`
      : `trusted ${found.file}`,
  );
}

/** The named session file, or else the latest session of the project the user is standing in. */
function pick(): { file: string; entries: Entry[] } | null {
  if (target) return { file: target, entries: read(target) };
  const found = latestSession(process.cwd());
  if (!found)
    console.log(
      `no sessions recorded for ${process.cwd()} under ${home()}; \`${self()} sessions\` lists every project's`,
    );
  return found;
}

function status(): void {
  // Before the session lookup: a fresh project has no sessions yet but can already have a config.
  const config = findConfig(process.cwd());
  if (config && !config.trusted) {
    const ignored = weakened(config.config);
    if (ignored.length)
      console.log(
        `config    ${config.file} is untrusted, so ${ignored.join(", ")} ${ignored.length > 1 ? "are" : "is"} ignored; \`${self()} trust\` accepts it`,
      );
  }
  // Also before the lookup: a hook that crashes on every event records no session at all.
  const errors = hookErrors();
  if (errors)
    console.log(
      `errors    ${errors.count} hook ${errors.count === 1 ? "crash" : "crashes"} in ${errorLog()}, and a crashed hook checks nothing. Last: ${errors.last}`,
    );
  const picked = pick();
  if (!picked) return;
  const { file, entries } = picked;
  const s = summarize(entries);
  const stops = entries.filter((e) => e.type === "verdict").filter((e) => e.phase === "stop");
  const jev = entries.filter((e) => e.type === "jev");
  console.log(`session   ${basename(file)}`);
  console.log(`project   ${sessionCwd(entries) ?? "(not recorded)"}`);
  console.log(`events    ${entries.filter((e) => e.type === "event").length}`);
  console.log(
    `edited    ${s.codeFiles.length ? s.codeFiles.join(", ") : "nothing that needs a check"}`,
  );
  console.log(
    `verified  ${s.verified ? `yes: \`${s.verified.command}\` passed after the last edit` : "no passing check since the last edit"}`,
  );
  if (s.lastCommand)
    console.log(
      `last cmd  \`${s.lastCommand.command}\` exit ${s.lastCommand.exitCode ?? "?"}: ${s.lastCommand.summary}`,
    );
  const repeats = Object.values(s.repeats).filter((r) => r.n > 1);
  if (repeats.length)
    console.log(`repeats   ${repeats.map((r) => `\`${r.command}\` x${r.n}`).join("; ")}`);
  console.log(`stops     ${stops.map((e) => e.decision).join(", ") || "none yet"}`);
  console.log(
    `jev       ${jev.length} calls, ${jev.filter((e) => e.cached).length} cached, ${jev.filter((e) => e.error).length} failed`,
  );
}

/** Re-run the gate over the recorded facts with the recorded Jev answers. Any mismatch means the gate is not deterministic. */
function replay(): void {
  const picked = pick();
  if (!picked) return;
  const { entries } = picked;
  // The config that applied is the one of the project the session ran in, wherever replay is run from.
  const config = loadConfig(sessionCwd(entries) ?? process.cwd());
  let mismatches = 0;
  entries.forEach((e, i) => {
    if (e.type !== "event" || e.fact.kind !== "stop") return;
    const rest = entries.slice(i + 1);
    const verdictAt = rest.findIndex((x) => x.type === "verdict");
    const verdict = rest.find((x) => x.type === "verdict");
    const jev = rest.slice(0, Math.max(verdictAt, 0)).find((x) => x.type === "jev");
    const decision = decideStop(
      summarize(entries.slice(0, i + 1)),
      e.fact.stopHookActive,
      jev?.answers?.[CLAIMS_DONE_ID],
      config,
    );
    const recorded = verdict?.decision ?? "(none)";
    const ok = decision.kind === recorded;
    if (!ok) mismatches++;
    console.log(
      `#${i} stop  recorded=${recorded}  replayed=${decision.kind}  ${ok ? "ok" : "MISMATCH"}`,
    );
  });
  console.log(mismatches ? `${mismatches} mismatch(es)` : "all Stop verdicts reproduced");
  process.exitCode = mismatches ? 1 : 0;
}
