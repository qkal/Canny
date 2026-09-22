import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const INIT = "git run by a test stays in the test's own directory";

it(INIT, () => {
  const dir = mkdtempSync(join(tmpdir(), "canny-git-init-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  expect(existsSync(join(dir, ".git"))).toBe(true);
});

// A git hook runs `pnpm check` with GIT_DIR set, absolute from a linked worktree. The test above,
// run in that environment without `test/setup.ts` clearing it, re-initializes the real repository
// and marks it bare. A whole Vitest process, so the regression is caught even though CI sets no GIT_DIR.
it("a suite started with a linked worktree's GIT_DIR leaves that repository alone", () => {
  const root = mkdtempSync(join(tmpdir(), "canny-git-env-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "main");
  git("-C", "main", "commit", "-q", "--allow-empty", "-m", "init");
  git("-C", "main", "worktree", "add", "-q", "../wt");
  const gitDir = git("-C", "wt", "rev-parse", "--absolute-git-dir");
  execFileSync(
    process.execPath,
    [join("node_modules", "vitest", "vitest.mjs"), "run", "test/git-env.test.ts", "-t", INIT],
    {
      env: { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, "index") },
      stdio: "pipe",
    },
  );
  expect(git("-C", "main", "config", "core.bare")).toBe("false");
}, 60_000);
