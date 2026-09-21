import { isAbsolute, resolve } from "node:path";
import { findSecrets, isPrivateEnv, isTestFile, plain, testDamage, } from "./checks.js";
import { off } from "./config.js";
import { fileOps, shellEdits, shellWrites } from "./events.js";
import { NO, YES, noul } from "./jev.js";
import { append, read, rel, summarize, toFact } from "./ledger.js";
import { loadRules } from "./rules.js";
/** Identical failures: the agent is told at the second one and stopped after the third. */
const REPEAT_NOTE_AT = 2;
const REPEAT_DENY_AFTER = 3;
/** The question id `canny replay` reads back out of the ledger. */
export const CLAIMS_DONE_ID = "claims_done";
const CLAIMS_DONE = noul("Does `message` claim that the requested work is complete?", {
    true: "Says the task, fix, feature, or change is done, implemented, complete, finished, ready, or working, or gives a final summary of finished work",
    false: "Asks the user a question, reports being blocked or unable to proceed, describes partial progress, or proposes next steps without saying the work is finished",
});
export async function handle(ctx, deps) {
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
function pre(ctx, deps) {
    const { event, cwd } = ctx;
    if (event.kind === "edit") {
        for (const c of event.changes) {
            if (!off(deps.config, "secrets")) {
                const hits = findSecrets(c.added);
                if (hits.length && !isPrivateEnv(c.path, cwd))
                    return record(ctx, deps, { kind: "deny", message: secretMessage(ctx, [c.path], hits) });
            }
            if (!off(deps.config, "test-removal")) {
                const damage = testDamage(c, cwd);
                if (damage)
                    return record(ctx, deps, { kind: "ask", message: describe(ctx, c, damage) });
            }
        }
        return { kind: "allow" };
    }
    if (event.kind !== "command")
        return { kind: "allow" };
    // The shell reaches the same files with no Write or Edit event, so the same two checks read the command.
    if (!off(deps.config, "secrets")) {
        // After a `cd`, a relative target is no longer relative to `ctx.cwd`, so no env file is exempt.
        const moved = leavesCwd(event.command, cwd);
        for (const w of shellWrites(event.command)) {
            const hits = findSecrets(w.text);
            const targets = hits.length ? w.targets.filter((p) => moved || !isPrivateEnv(p, cwd)) : [];
            if (targets.length)
                return record(ctx, deps, { kind: "deny", message: secretMessage(ctx, targets, hits) });
        }
    }
    if (!off(deps.config, "test-removal")) {
        const ops = fileOps(event.command);
        const gone = [
            ...ops.removed,
            ...ops.moved.filter(([, to]) => !isTestFile(to)).map(([from]) => from),
        ].filter(isTestFile);
        if (gone.length)
            return record(ctx, deps, {
                kind: "ask",
                message: `Canny: this command removes ${list(gone.map((p) => rel(cwd, p)))} from the tests. ${TESTS_STAY}`,
            });
        for (const c of shellEdits(event.command)) {
            const damage = testDamage(c, cwd);
            if (damage)
                return record(ctx, deps, { kind: "ask", message: describe(ctx, c, damage, "command") });
        }
    }
    if (!off(deps.config, "repeat-failure")) {
        const command = plain(event.command);
        const hit = Object.values(summarize(read(deps.file)).repeats).find((r) => r.command === command && r.n >= REPEAT_DENY_AFTER);
        if (hit)
            return record(ctx, deps, {
                kind: "deny",
                message: `Canny: this exact command has failed ${hit.n} times with the same output. Running it again will not change the result. Change the code or the approach first.`,
            });
    }
    return { kind: "allow" };
}
/**
 * Whether a command may be somewhere else by the time it writes. Agents open commands with
 * `cd "$PWD";` or a `cd` to the project itself, which goes nowhere, so that alone is not leaving.
 * Every other `cd` is: where it ends up depends on CDPATH, OLDPWD, and quoting this does not model.
 */
function leavesCwd(command, cwd) {
    const moves = command.match(/(?:^|[;&|(\n])\s*(?:cd|pushd|popd)\b/g) ?? [];
    if (!moves.length)
        return false;
    // The one `cd` has to open the command, with `&&`, `;`, or a newline after it: after `&`, `|`,
    // or `||` the rest runs where it started anyway, but then the text is too odd to vouch for.
    const opening = /^\s*cd\s+(["']?)([^;&|\n)"']*)\1\s*(?:&&|;|\n|$)/.exec(command);
    if (moves.length > 1 || !opening)
        return true;
    const quote = opening[1];
    const target = opening[2].trim();
    if (target === "." || target === "./")
        return false;
    // Single quotes make `$PWD` a directory of that name.
    if (/^\$(?:PWD|\{PWD\})$/.test(target))
        return quote === "'";
    return !(isAbsolute(target) && !/[$`*?~\\]/.test(target) && resolve(target) === resolve(cwd));
}
/** Record what happened, then hand judgment calls to Jev. Nothing here can block. */
async function post(ctx, deps) {
    const { event } = ctx;
    const fact = toFact(event, ctx.cwd, deps.config);
    if (fact)
        append(deps.file, entry(ctx, fact));
    if (fact?.kind === "command") {
        if (fact.exitCode !== null && fact.exitCode !== 0 && !off(deps.config, "repeat-failure")) {
            const n = summarize(read(deps.file)).repeats[fact.fingerprint]?.n ?? 0;
            if (n >= REPEAT_NOTE_AT)
                return record(ctx, deps, {
                    kind: "note",
                    message: `Canny: \`${short(fact.command)}\` has now failed ${n} times with the same output. Repeating it will not help; change the approach.`,
                });
        }
        // Text the shell wrote is held to the project rules like any other edit.
        return event.kind === "command"
            ? ruleCheck(ctx, deps, shellEdits(event.command))
            : { kind: "allow" };
    }
    if (event.kind === "edit")
        return ruleCheck(ctx, deps, event.changes);
    return { kind: "allow" };
}
/** One Noul per project rule over each change, all changes in parallel. A confident yes becomes a note. */
async function ruleCheck(ctx, deps, changes) {
    const rules = changes.length ? loadRules(ctx.cwd, deps.config) : null;
    if (!rules)
        return { kind: "allow" };
    const questions = Object.fromEntries(rules.rules.map((_, i) => [
        `rule_${i}`,
        noul(`Does the code change in \`change\` break the project rule in \`rules[${i}]\`?`, {
            true: `The text in \`change.added\` or \`change.removed\` clearly does what \`rules[${i}]\` forbids, or leaves out what it requires`,
            false: "The change follows the rule, or the rule does not apply to this change",
        }),
    ]));
    const notes = await Promise.all(changes
        .filter((c) => c.added || c.removed)
        .map(async (c) => {
        const file = rel(ctx.cwd, c.path);
        const state = {
            rules: rules.rules,
            change: { file, added: clip(c.added), removed: clip(c.removed) },
        };
        const answers = await deps.judge(state, questions);
        const broken = rules.rules.filter((_, i) => (answers?.[`rule_${i}`] ?? 0) >= YES);
        if (!broken.length)
            return "";
        const one = broken.length === 1;
        return `Canny: the edit to ${file} may break ${one ? "a project rule" : "project rules"} from ${rules.source}:\n${broken.map((r) => `- ${r}`).join("\n")}\nReview the change against ${one ? "that rule" : "those rules"} before continuing.`;
    }));
    const message = notes.filter(Boolean).join("\n\n");
    return message ? record(ctx, deps, { kind: "note", message }) : { kind: "allow" };
}
async function stop(ctx, deps) {
    if (ctx.event.kind !== "stop")
        return { kind: "allow" };
    append(deps.file, entry(ctx, toFact(ctx.event, ctx.cwd, deps.config)));
    const s = summarize(read(deps.file));
    let claimsDone;
    if (s.codeFiles.length && !s.verified && ctx.event.message) {
        const answers = await deps.judge({ message: ctx.event.message }, { [CLAIMS_DONE_ID]: CLAIMS_DONE });
        claimsDone = answers?.[CLAIMS_DONE_ID];
    }
    return record(ctx, deps, decideStop(s, ctx.event.stopHookActive, claimsDone, deps.config));
}
/**
 * The gate, as a pure function so a session can be replayed. Only the ledger can block; Jev can only
 * relax the block when it is sure the message is not a "done" claim.
 */
export function decideStop(s, stopHookActive, claimsDone, config) {
    if (!s.codeFiles.length || s.verified)
        return { kind: "allow" };
    if (stopHookActive && s.factsSinceBlock === 0 && !config.strict)
        return {
            kind: "warn",
            message: `Canny: the agent finished without a passing check after editing ${list(s.codeFiles)}. Verify by hand.`,
        };
    if (claimsDone !== undefined && claimsDone <= NO)
        return { kind: "allow" };
    return { kind: "block", message: blockReason(s, config) };
}
function blockReason(s, config) {
    const last = s.lastCommand
        ? ` The last command was \`${short(s.lastCommand.command)}\`${s.lastCommand.exitCode === null ? "" : ` (exit ${s.lastCommand.exitCode})`}.`
        : "";
    const counts = config.verify?.length
        ? ` Commands that count: ${config.verify.map((v) => `\`${v}\``).join(", ")}.`
        : " A test, build, lint, or type-check command counts, run so its own exit status is the result: a pipe into `tail`, `|| true`, or a trailing `; echo` hides it.";
    const tail = config.strict
        ? ""
        : " If no check applies to this change, say so explicitly and stop again.";
    return `Canny: ${list(s.codeFiles)} changed, but no check has passed since the last edit.${last} Run the project's checks and fix what fails before finishing.${counts}${tail}`;
}
function describe(ctx, c, d, by = "edit") {
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
    return `Canny: this ${by} ${what}. ${TESTS_STAY}`;
}
const TESTS_STAY = "Tests are only removed or skipped when the user asked for it. Fix the code the test covers instead.";
function secretMessage(ctx, paths, hits) {
    const files = list(paths.map((p) => rel(ctx.cwd, p)));
    const advice = paths.some((p) => /(^|\/)\.env/.test(p))
        ? "An env file is only the place for it once git ignores the file, and a committed template never is."
        : "Read the value from the environment or a git-ignored env file instead of writing it into the file.";
    return `Canny: ${files} would contain what looks like a ${hits.join(" and a ")}. ${advice}`;
}
/** Hook JSON for the agent that sent the event. Codex has no "ask", so it gets a deny with the same reason. */
export function serialize(ctx, d) {
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
const entry = (ctx, fact) => ({
    ts: Date.now(),
    type: "event",
    cwd: plain(ctx.cwd),
    phase: ctx.phase,
    hookEvent: ctx.hookEvent,
    tool: ctx.tool,
    fact,
});
function record(ctx, deps, d) {
    append(deps.file, {
        ts: Date.now(),
        type: "verdict",
        cwd: plain(ctx.cwd),
        phase: ctx.phase,
        decision: d.kind,
        ...(d.kind !== "allow" && { message: d.message }),
    });
    return d;
}
const short = (cmd) => (cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd).replace(/\s+/g, " ");
const clip = (s) => (s.length > 4000 ? s.slice(0, 4000) + "\n[clipped]" : s);
function list(files) {
    const shown = files.slice(0, 3).join(", ");
    const more = files.length - 3;
    return more > 0 ? `${shown} and ${more} more ${more === 1 ? "file" : "files"}` : shown;
}
