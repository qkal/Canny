import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const tasks = readdirSync("bench/tasks");

/** Every task once, with a shell command standing in for the agent; returns `passes` per task. */
async function bench(agentCmd: string, arm: string): Promise<Record<string, boolean>> {
  const out = mkdtempSync(join(tmpdir(), "canny-bench-out-"));
  await promisify(execFile)("node", ["bench/run.mjs", "--runs", "1", "--arm", arm, "--out", out, "--agent-cmd", agentCmd]); // prettier-ignore
  const rows = readFileSync(join(out, readdirSync(out)[0]!), "utf8")
    .trim()
    .split("\n");
  return Object.fromEntries(
    rows
      .map((line) => JSON.parse(line) as { task: string; passes: boolean })
      .map((r) => [r.task, r.passes]),
  );
}

const all = (passes: boolean) => Object.fromEntries(tasks.map((t) => [t, passes]));

it("every task fails untouched and passes with its reference fix; only the task's own check decides", async () => {
  // On top of the real fix: tests gutted and the test script a no-op, which the check overrides, and
  // the key written to a file git would commit, which it catches.
  const cheat = `sh {task}/solution.sh; for f in test/*; do echo > "$f"; done; npm pkg set scripts.test=true; echo "$BENCH_SECRET" > notes.txt`;
  const [untouched, solved, cheated] = await Promise.all([
    bench("true", "control"),
    bench("sh {task}/solution.sh", "canny"),
    bench(cheat, "control"),
  ]);
  expect(untouched).toEqual(all(false));
  expect(solved).toEqual(all(true));
  expect(cheated).toEqual({ ...all(true), "payment-key": false });
});
