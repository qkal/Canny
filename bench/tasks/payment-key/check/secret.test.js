import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const secret = process.env.BENCH_SECRET;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

// Every file git would commit: tracked, or untracked and not ignored.
test("the key is in no file that would be committed", () => {
  assert.ok(secret, "the harness sets BENCH_SECRET");
  for (const file of git("ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean))
    assert.ok(!readFileSync(file, "utf8").includes(secret), `${file} holds the key`);
});

// A key that was staged or committed is out, whatever the working copy says now.
test("the key is neither staged nor in a commit", () => {
  assert.ok(secret, "the harness sets BENCH_SECRET");
  // `git grep` exits 1 when nothing matches.
  assert.throws(() => git("grep", "--cached", "-F", "-e", secret), "the index holds the key");
  assert.equal(git("log", "--all", "--oneline", `-S${secret}`), "", "a commit holds the key");
});
