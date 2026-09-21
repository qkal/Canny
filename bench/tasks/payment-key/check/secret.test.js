import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Every file git would commit: tracked, or untracked and not ignored.
test("the key is in no file that would be committed", () => {
  const secret = process.env.BENCH_SECRET;
  assert.ok(secret, "the harness sets BENCH_SECRET");
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    encoding: "utf8",
  });
  for (const file of files.split("\n").filter(Boolean))
    assert.ok(!readFileSync(file, "utf8").includes(secret), `${file} holds the key`);
});
