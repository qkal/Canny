import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSecrets, fingerprint, isIgnored, isVerify, testDamage } from "../src/checks.js";

describe("findSecrets", () => {
  it.each([
    ["AKIAIOSFODNN7EXAMPLE", "AWS access key"],
    ["token ghp_" + "a1".repeat(20), "GitHub token"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private key"],
    ["key = sk-ant-api03-" + "x9".repeat(20), "OpenAI or Anthropic key"],
    ['const apiKey = "a1b2c3d4e5f6g7h8i9j0";', "hardcoded credential"],
  ])("flags %s", (text, label) => expect(findSecrets(text)).toContain(label));

  it.each([
    'apiKey = "your-api-key-here"',
    "password = process.env.PASSWORD",
    "const token = getToken();",
    "sk-test",
  ])("ignores %s", (text) => expect(findSecrets(text)).toEqual([]));
});

describe("isVerify", () => {
  it.each([
    ["pnpm test", true],
    ["node --test 2>&1 | tail -20", false],
    ["set -o pipefail; node --test 2>&1 | tail -20", true],
    ["set -euo pipefail\npnpm test | tail -5", true],
    ["echo pipefail; pnpm test 2>&1 | tail -20", false],
    ["pnpm test | tail -20 # set -o pipefail", false],
    ["set -o pipefail; set +o pipefail; pnpm test | tail", false],
    ["pnpm test & echo done", false],
    ["pnpm test > out.log 2>&1", true],
    ["pnpm test || true", false],
    ["pnpm test; echo done", false],
    ["pnpm test 2>&1 | tail -5 && pnpm lint", true],
    ["echo tsc", false],
    ["tsc --version", false],
    ["git diff -- vitest.config.ts", false],
    ["cd web && uv run pytest -q", true],
    ["pnpm type-check", true],
    ["cargo build --release", true],
    ["ruff check .", true],
    ["ruff format .", false],
    ['git commit -m "add pytest suite"', false],
    ["ls -la", false],
  ])("%s -> %s", (cmd, yes) => expect(isVerify(cmd, {})).toBe(yes));

  it("uses config.verify instead of the defaults when given", () => {
    expect(isVerify("pnpm test", { verify: ["^just check$"] })).toBe(false);
    expect(isVerify("just check", { verify: ["^just check$"] })).toBe(true);
  });
});

describe("isIgnored", () => {
  it.each([
    ["README.md", true],
    ["docs/guide.txt", true],
    ["pnpm-lock.yaml", false],
    ["src/a.ts", false],
  ])("%s -> %s", (p, v) => expect(isIgnored(p, {})).toBe(v));
  it("adds config.ignore patterns", () =>
    expect(isIgnored("gen/x.ts", { ignore: ["^gen/"] })).toBe(true));
});

describe("testDamage", () => {
  it("is null for non-test files", () => {
    expect(
      testDamage({ path: "src/a.ts", added: "", removed: "it('x', () => {})" }, "/"),
    ).toBeNull();
  });
  it("counts removed cases in an Edit", () => {
    const d = testDamage(
      { path: "test/a.test.ts", added: "", removed: "it('a', () => {});\nit('b', () => {});" },
      "/",
    );
    expect(d).toEqual({ removed: 2, skipped: 0, deleted: false });
  });
  it("counts skip and focus markers added", () => {
    expect(
      testDamage(
        {
          path: "tests/test_x.py",
          added: "@pytest.mark.skip\ndef test_a(): pass",
          removed: "def test_a(): pass",
        },
        "/",
      ),
    ).toEqual({ removed: 0, skipped: 1, deleted: false });
    expect(
      testDamage({ path: "a.spec.ts", added: "it.only('a')", removed: "it('a')" }, "/"),
    ).toEqual({ removed: 0, skipped: 1, deleted: false });
  });
  it("is null when a case is only renamed", () => {
    expect(
      testDamage({ path: "test/a.test.ts", added: "it('b', f)", removed: "it('a', f)" }, "/"),
    ).toBeNull();
  });
  it("reads the file from disk for a whole-file Write", () => {
    const dir = mkdtempSync(join(tmpdir(), "canny-"));
    writeFileSync(
      join(dir, "a_test.go"),
      "func TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n",
    );
    expect(
      testDamage(
        {
          path: join(dir, "a_test.go"),
          added: "func TestA(t *testing.T) {}\n",
          removed: "",
          wholeFile: true,
        },
        dir,
      ),
    ).toEqual({ removed: 1, skipped: 0, deleted: false });
    expect(
      testDamage(
        {
          path: join(dir, "new_test.go"),
          added: "func TestA(t *testing.T) {}\n",
          removed: "",
          wholeFile: true,
        },
        dir,
      ),
    ).toBeNull();
  });
  it("flags a deleted test file", () => {
    expect(
      testDamage({ path: "test/a.test.ts", added: "", removed: "", deleted: true }, "/"),
    ).toEqual({ removed: 0, skipped: 0, deleted: true });
  });
});

describe("fingerprint", () => {
  it("ignores durations, timestamps, and colors but not the failure itself", () => {
    const a = fingerprint(
      "pnpm test",
      "\x1b[31mFAIL\x1b[0m a.test.ts\n1 failed in 1.2s at 2026-09-18T00:00:01Z",
    );
    const b = fingerprint("pnpm test", "FAIL a.test.ts\n1 failed in 3.4s at 2026-09-18T00:05:07Z");
    const c = fingerprint("pnpm test", "FAIL a.test.ts\n2 failed in 3.4s at 2026-09-18T00:05:07Z");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("stays fast on one huge line of digits", () => {
    const started = performance.now();
    fingerprint("pnpm test", "ok\n" + "9".repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
