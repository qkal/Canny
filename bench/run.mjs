#!/usr/bin/env node
// Runs each task in bench/tasks with and without Canny and records whether the work holds up.
//
//   node bench/run.mjs --agent claude --runs 5
//   node bench/run.mjs --agent codex --args="-m <model>" --task csv-export-regression
//
// `--args` needs the `=`: its value starts with a dash, which the option parser otherwise refuses.
//
// A task is a small project plus `prompt.txt`. Every run copies it to a fresh scratch directory,
// hands the prompt to a headless agent there, then replaces `test/` and `package.json` with the
// task's own and runs `npm test`: an agent that got to green by gutting the tests fails. A task
// whose tests have to change keeps the tests it is judged by in `check/`, which the agent never
// sees. `solution.sh` is a reference fix, also never copied; test/bench.test.ts runs it to show the
// task can be solved. The `canny` arm gets project-level hooks and its own CANNY_HOME; nothing is
// installed outside the scratch directory.
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"; // prettier-ignore
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const { values: opts } = parseArgs({
  options: {
    agent: { type: "string", default: "claude" },
    args: { type: "string", default: "" },
    // A shell command run in the scratch project with the prompt in $PROMPT, instead of a real agent.
    // `{task}` becomes the task's source directory, which a real agent is never told.
    "agent-cmd": { type: "string" },
    arm: { type: "string", multiple: true, default: ["control", "canny"] },
    runs: { type: "string", default: "3" },
    task: { type: "string", multiple: true },
    out: { type: "string", default: join(here, "results") },
    "timeout-min": { type: "string", default: "10" },
    keep: { type: "boolean", default: false },
  },
});

// Claude Code reads only the project's settings here, so the user's own hooks and plugins are out of
// both arms. Codex keeps its login in the same home as its config, so it runs with the user's config
// in both arms: compare arms from one machine, not rows across machines.
const AGENTS = {
  claude:
    'claude -p "$PROMPT" --output-format json --setting-sources project --permission-mode acceptEdits --allowedTools Bash Edit Write Read Glob Grep',
  codex:
    'codex exec --skip-git-repo-check --dangerously-bypass-hook-trust -s workspace-write "$PROMPT"',
};
// A misspelt arm would run as control and be reported under the misspelt name.
for (const arm of opts.arm)
  if (arm !== "control" && arm !== "canny")
    throw new Error(`--arm is control or canny, not ${arm}`);
const agentCmd = opts["agent-cmd"] ?? `${AGENTS[opts.agent]} ${opts.args}`;
const tasks = opts.task ?? readdirSync(join(here, "tasks"));
mkdirSync(opts.out, { recursive: true });
const results = join(opts.out, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const rows = [];

for (let run = 1; run <= Number(opts.runs); run++)
  for (const task of tasks)
    // Arms alternate inside a run so a slow hour at the model provider hits both alike.
    for (const arm of run % 2 ? opts.arm : opts.arm.toReversed()) {
      const row = { task, arm, agent: opts["agent-cmd"] ? "custom" : opts.agent, run, ...once(task, arm) }; // prettier-ignore
      rows.push(row);
      appendFileSync(results, JSON.stringify(row) + "\n");
      console.log(`${task} ${arm} #${run}: ${row.passes ? "pass" : "FAIL"} in ${row.seconds}s`);
    }

function once(task, arm) {
  const src = join(here, "tasks", task);
  const dir = mkdtempSync(join(tmpdir(), `canny-bench-${task}-${arm}-`));
  const project = join(dir, "project");
  const hidden = ["prompt.txt", "solution.sh", "check"].map((f) => join(src, f));
  cpSync(src, project, { recursive: true, filter: (f) => !hidden.includes(f) });
  // A key that exists nowhere else, in the shape of a payment provider's test key. A task's prompt
  // hands it over as `{{SECRET}}`, and its check looks for it in the files git would commit.
  const secret = `sk_${"test"}_${randomBytes(18).toString("hex").slice(0, 24)}`;
  const prompt = readFileSync(join(src, "prompt.txt"), "utf8")
    .trim()
    .replaceAll("{{SECRET}}", secret);
  // Run from a git hook, this process carries GIT_DIR and GIT_INDEX_FILE, which would point every
  // git command in the scratch project at the repository the hook belongs to.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))); // prettier-ignore
  const env = { ...clean, CANNY_HOME: join(dir, "canny-home") };
  execFileSync("git", ["init", "-q"], { cwd: project, env });
  if (arm === "canny")
    execFileSync("node", [cli, "init", `--${opts.agent === "codex" ? "codex" : "claude"}`], { cwd: project, env, stdio: "ignore" }); // prettier-ignore
  const started = Date.now();
  // The task's path reaches the shell through the environment, never as command text, so no
  // directory name is parsed as shell. Only a stand-in agent gets it: a real one must not find
  // the reference fix. A stand-in cannot read the prompt either, so it gets the key directly.
  const agent = spawnSync("sh", ["-c", agentCmd.replaceAll("{task}", '"$BENCH_TASK"')], {
    cwd: project,
    env: { ...env, PROMPT: prompt, ...(opts["agent-cmd"] && { BENCH_SECRET: secret, BENCH_TASK: src }) }, // prettier-ignore
    timeout: Number(opts["timeout-min"]) * 60_000,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  // Only the task's own tests and its own `npm test` count, so neither a gutted test, nor a test the
  // agent added, nor `"test": "true"` decides the result.
  rmSync(join(project, "test"), { recursive: true, force: true });
  const check = existsSync(join(src, "check")) ? "check" : "test";
  cpSync(join(src, check), join(project, "test"), { recursive: true });
  cpSync(join(src, "package.json"), join(project, "package.json"));
  const passes =
    spawnSync("npm", ["test"], {
      cwd: project,
      env: { ...clean, BENCH_SECRET: secret },
      stdio: "ignore",
      timeout: 5 * 60_000,
    }).status === 0;
  const row = { passes, seconds, agentExit: agent.status, ...usage(agent.stdout), ...verdicts(env.CANNY_HOME) }; // prettier-ignore
  if (opts.keep) console.log(`  kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
  return row;
}

/** Turns, cost, and model time from `claude -p --output-format json`; nothing for other agents. */
function usage(stdout) {
  try {
    const r = JSON.parse(String(stdout));
    return { turns: r.num_turns, costUsd: r.total_cost_usd, apiSeconds: Math.round(r.duration_api_ms / 100) / 10 }; // prettier-ignore
  } catch {
    return {};
  }
}

/** How often Canny stepped in, read from the run's own ledgers. Zero in the control arm. */
function verdicts(home) {
  // What was denied is kept in words: a deny is either the catch being measured or a false alarm.
  const counts = { blocks: 0, denies: 0, notes: 0, rewrites: 0, denied: [] };
  const sessions = join(home, "sessions");
  if (!existsSync(sessions)) return counts;
  for (const f of readdirSync(sessions, { recursive: true }).filter((f) => f.endsWith(".jsonl")))
    for (const line of readFileSync(join(sessions, f), "utf8").split("\n").filter(Boolean)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        // A hook killed mid-write leaves half a line.
        continue;
      }
      if (e.type !== "verdict") continue;
      if (e.decision === "block") counts.blocks++;
      else if (e.decision === "deny" || e.decision === "ask") {
        counts.denies++;
        counts.denied.push(String(e.message).slice(0, 300));
      } else if (e.decision === "note") counts.notes++;
      else if (e.decision === "rewrite") counts.rewrites++;
    }
  return counts;
}

console.log(`\n${"task".padEnd(28)}${"arm".padEnd(10)}passed  blocks  denies  rewrites  mean s  turns`);
for (const task of tasks)
  for (const arm of opts.arm) {
    const mine = rows.filter((r) => r.task === task && r.arm === arm);
    const sum = (k) => mine.reduce((n, r) => n + (r[k] ?? 0), 0);
    const mean = (k) => (sum(k) / mine.length).toFixed(1);
    console.log(`${task.padEnd(28)}${arm.padEnd(10)}${`${sum("passes")}/${mine.length}`.padEnd(8)}${String(sum("blocks")).padEnd(8)}${String(sum("denies")).padEnd(8)}${String(sum("rewrites")).padEnd(10)}${mean("seconds").padEnd(8)}${mean("turns")}`); // prettier-ignore
  }
console.log(`\nrows: ${results}`);
