import { findSecrets, testDamage, type TestDamage } from "./checks.js";
import { off, type Config } from "./config.js";
import type { Ctx, FileChange } from "./events.js";
import { NO, YES, noul, type Judge } from "./jev.js";
import { append, read, rel, summarize, toFact, type Fact, type Summary } from "./ledger.js";
import { loadRules } from "./rules.js";

export type Decision =
  { kind: "allow" } | { kind: "deny" | "ask" | "block" | "note" | "warn"; message: string };

export interface Deps {
  config: Config;
  judge: Judge;
  /** Path of this session's ledger file. */
  file: string;
}

/** Identical failures: the agent is told at the second one and stopped after the third. */
const REPEAT_NOTE_AT = 2;
const REPEAT_DENY_AFTER = 3;

export const CLAIMS_DONE = noul("Does `message` claim that the requested work is complete?", {
  true: "Says the task, fix, feature, or change is done, implemented, complete, finished, ready, or working, or gives a final summary of finished work",
  false:
    "Asks the user a question, reports being blocked or unable to proceed, describes partial progress, or proposes next steps without saying the work is finished",
});

export async function handle(ctx: Ctx, deps: Deps): Promise<Decision> {
  switch (ctx.phase) {
    case "pre":
      return pre(ctx, deps);
    case "post":
      return post(ctx, deps);
    case "stop":
      return stop(ctx, deps);
    default:
      return { kind: "allow" };
  }
}

/** Pattern checks that can block, before the tool runs. Nothing is recorded here: the edit has not happened yet. */
function pre(ctx: Ctx, deps: Deps): Decision {
  const { event } = ctx;
  if (event.kind === "edit") {
    for (const c of event.changes) {
      const hits = off(deps.config, "secrets") ? [] : findSecrets(c.added);
      if (hits.length)
        return record(ctx, deps, {
          kind: "deny",
          message: `Canny: ${rel(ctx.cwd, c.path)} would contain what looks like a ${hits.join(" and a ")}. Read the value from the environment or an uncommitted config file instead of writing it into the file.`,
        });
      const damage = off(deps.config, "test-removal") ? null : testDamage(c, ctx.cwd);
      if (damage) return record(ctx, deps, { kind: "ask", message: describe(ctx, c, damage) });
    }
  }
  if (event.kind === "command" && !off(deps.config, "repeat-failure")) {
    const s = summarize(read(deps.file));
    const hit = Object.values(s.repeats).find(
      (r) => r.command === event.command && r.n >= REPEAT_DENY_AFTER,
    );
    if (hit)
      return record(ctx, deps, {
        kind: "deny",
        message: `Canny: this exact command has failed ${hit.n} times with the same output. Running it again will not change the result. Change the code or the approach first.`,
      });
  }
  return { kind: "allow" };
}

/** Record what happened, then hand judgment calls to Jev. Nothing here can block. */
async function post(ctx: Ctx, deps: Deps): Promise<Decision> {
  const { event } = ctx;
  const fact = toFact(event, ctx.cwd, deps.config);
  if (fact) append(deps.file, entry(ctx, fact));
  if (fact?.kind === "command") {
    if (fact.exitCode !== null && fact.exitCode !== 0 && !off(deps.config, "repeat-failure")) {
      const n = summarize(read(deps.file)).repeats[fact.fingerprint]?.n ?? 0;
      if (n >= REPEAT_NOTE_AT)
        return record(ctx, deps, {
          kind: "note",
          message: `Canny: \`${short(fact.command)}\` has now failed ${n} times with the same output. Repeating it will not help; change the approach.`,
        });
    }
    return { kind: "allow" };
  }
  if (event.kind === "edit") return ruleCheck(ctx, deps, event.changes);
  return { kind: "allow" };
}

/** One Noul per project rule over each change, all changes in parallel. A confident yes becomes a note. */
async function ruleCheck(ctx: Ctx, deps: Deps, changes: FileChange[]): Promise<Decision> {
  const rules = loadRules(ctx.cwd, deps.config);
  if (!rules) return { kind: "allow" };
  const questions = Object.fromEntries(
    rules.rules.map((_, i) => [
      `rule_${i}`,
      noul(`Does the code change in \`change\` break the project rule in \`rules[${i}]\`?`, {
        true: `The text in \`change.added\` or \`change.removed\` clearly does what \`rules[${i}]\` forbids, or leaves out what it requires`,
        false: "The change follows the rule, or the rule does not apply to this change",
      }),
    ]),
  );
  const notes = await Promise.all(
    changes
      .filter((c) => c.added || c.removed)
      .map(async (c) => {
        const file = rel(ctx.cwd, c.path);
        const state = {
          rules: rules.rules,
          change: { file, added: clip(c.added), removed: clip(c.removed) },
        };
        const answers = await deps.judge(state, questions);
        const broken = rules.rules.filter((_, i) => (answers?.[`rule_${i}`] ?? 0) >= YES);
        if (!broken.length) return "";
        const one = broken.length === 1;
        return `Canny: the edit to ${file} may break ${one ? "a project rule" : "project rules"} from ${rules.source}:\n${broken.map((r) => `- ${r}`).join("\n")}\nReview the change against ${one ? "that rule" : "those rules"} before continuing.`;
      }),
  );
  const message = notes.filter(Boolean).join("\n\n");
  return message ? record(ctx, deps, { kind: "note", message }) : { kind: "allow" };
}

async function stop(ctx: Ctx, deps: Deps): Promise<Decision> {
  if (ctx.event.kind !== "stop") return { kind: "allow" };
  append(deps.file, entry(ctx, toFact(ctx.event, ctx.cwd, deps.config)!));
  const s = summarize(read(deps.file));
  let claimsDone: number | undefined;
  if (s.codeFiles.length && !s.verified && ctx.event.message) {
    const answers = await deps.judge({ message: ctx.event.message }, { claims_done: CLAIMS_DONE });
    claimsDone = answers?.claims_done;
  }
  return record(ctx, deps, decideStop(s, ctx.event.stopHookActive, claimsDone, deps.config));
}

/**
 * The gate, as a pure function so a session can be replayed. Only the ledger can block; Jev can only
 * relax the block when it is sure the message is not a "done" claim.
 */
export function decideStop(
  s: Summary,
  stopHookActive: boolean,
  claimsDone: number | undefined,
  config: Config,
): Decision {
  if (!s.codeFiles.length || s.verified) return { kind: "allow" };
  if (stopHookActive && s.factsSinceBlock === 0 && !config.strict)
    return {
      kind: "warn",
      message: `Canny: the agent finished without a passing check after editing ${list(s.codeFiles)}. Verify by hand.`,
    };
  if (claimsDone !== undefined && claimsDone <= NO) return { kind: "allow" };
  return { kind: "block", message: blockReason(s, config) };
}

function blockReason(s: Summary, config: Config): string {
  const last = s.lastCommand
    ? ` The last command was \`${short(s.lastCommand.command)}\`${s.lastCommand.exitCode === null ? "" : ` (exit ${s.lastCommand.exitCode})`}.`
    : "";
  const counts = config.verify?.length
    ? ` Commands that count: ${config.verify.map((v) => `\`${v}\``).join(", ")}.`
    : " A test, build, lint, or type-check command counts.";
  const tail = config.strict
    ? ""
    : " If no check applies to this change, say so explicitly and stop again.";
  return `Canny: ${list(s.codeFiles)} changed, but no check has passed since the last edit.${last} Run the project's checks and fix what fails before finishing.${counts}${tail}`;
}

function describe(ctx: Ctx, c: FileChange, d: TestDamage): string {
  const file = rel(ctx.cwd, c.path);
  const what = d.deleted
    ? `deletes the test file ${file}`
    : [
        d.removed
          ? `removes ${d.removed} test ${d.removed === 1 ? "case" : "cases"} from ${file}`
          : "",
        d.skipped
          ? `adds ${d.skipped} skip or focus ${d.skipped === 1 ? "marker" : "markers"} in ${file}`
          : "",
      ]
        .filter(Boolean)
        .join(" and ");
  return `Canny: this edit ${what}. Tests are only removed or skipped when the user asked for it. Fix the code the test covers instead.`;
}

/** Hook JSON for the agent that sent the event. Codex has no "ask", so it gets a deny with the same reason. */
export function serialize(ctx: Ctx, d: Decision): Record<string, unknown> {
  switch (d.kind) {
    case "deny":
    case "ask":
      return {
        systemMessage: d.message,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: d.kind === "ask" && ctx.agent === "claude" ? "ask" : "deny",
          permissionDecisionReason: d.message,
        },
      };
    case "block":
      return { decision: "block", reason: d.message, systemMessage: d.message };
    case "note":
      return { hookSpecificOutput: { hookEventName: ctx.hookEvent, additionalContext: d.message } };
    case "warn":
      return { systemMessage: d.message };
    default:
      return {};
  }
}

const entry = (ctx: Ctx, fact: Fact) => ({
  ts: Date.now(),
  type: "event" as const,
  phase: ctx.phase,
  hookEvent: ctx.hookEvent,
  tool: ctx.tool,
  fact,
});

function record(ctx: Ctx, deps: Deps, d: Decision): Decision {
  append(deps.file, {
    ts: Date.now(),
    type: "verdict",
    phase: ctx.phase,
    decision: d.kind,
    ...(d.kind !== "allow" && { message: d.message }),
  });
  return d;
}

const short = (cmd: string): string =>
  (cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd).replace(/\s+/g, " ");
const clip = (s: string): string => (s.length > 4000 ? s.slice(0, 4000) + "\n[clipped]" : s);

function list(files: string[]): string {
  const shown = files.slice(0, 3).join(", ");
  const more = files.length - 3;
  return more > 0 ? `${shown} and ${more} more ${more === 1 ? "file" : "files"}` : shown;
}
