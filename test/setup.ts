import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// Every test gets its own `~/.canny`, so a suite can never read or write the developer's real
// sessions, trust store, or Jev cache. Registered for every file, including ones added later.
beforeEach(() => {
  process.env.CANNY_HOME = mkdtempSync(join(tmpdir(), "canny-home-"));
});
