import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// A git hook runs `pnpm check` with GIT_DIR set, absolute from a linked worktree: a test's `git init`
// in a temp directory would then re-initialize the real repository and mark it bare.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

// Every test gets its own `~/.canny`, so a suite can never read or write the developer's real
// sessions, trust store, or Jev cache. Registered for every file, including ones added later.
beforeEach(() => {
  process.env.CANNY_HOME = mkdtempSync(join(tmpdir(), "canny-home-"));
});
