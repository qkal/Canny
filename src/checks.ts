import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import type { FileChange } from "./events.js";

const VERIFY = [
  /\b(pytest|vitest|jest|mocha|ava|cypress|playwright test|go test|cargo test|swift test|xcodebuild test|gradlew? test|mvn test|dotnet test|rspec|phpunit|mix test|bun test|deno test|node --test|node --run test|npm test|pnpm test|yarn test|make test|just test|python -m pytest|python -m unittest|npm run test|pnpm run test|yarn run test|tox|nox)\b/,
  /\b(tsc|cargo build|go build|go vet|swift build|xcodebuild|gradlew? (build|assemble)|mvn (package|compile|verify)|dotnet build|npm run build|pnpm build|pnpm run build|yarn build|make build|just build|bun run build|vite build|next build|esbuild|webpack)\b/,
  /\b(eslint|oxlint|biome (check|lint)|prettier --check|ruff (check|format --check)|flake8|pylint|mypy|pyright|pyrefly|ty check|pnpm type-check|npm run lint|pnpm lint|pnpm run lint|yarn lint|golangci-lint|cargo clippy|swiftlint|swift-format lint|pre-commit run|just lint|just check|rubocop|shellcheck)\b/,
];

// Config patterns are tested once per path and once per command segment, so each is compiled once.
const compiled = new Map<string, RegExp | null>();
const safeRegex = (p: string): RegExp | null => {
  let re = compiled.get(p);
  if (re === undefined) {
    try {
      re = new RegExp(p);
    } catch {
      re = null;
    }
    compiled.set(p, re);
  }
  return re;
};

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Commands that print or inspect: `echo tsc` and `git diff -- vitest.config.ts` prove nothing. */
// ponytail: denylist of first words, move to parsing the command position if agents find other ways around it
// Leading whitespace is matched here rather than assumed away: as one regex with a shared `^`, the
// anchor bound only the first alternative, so an untrimmed `   echo tsc` read as a passing check.
const PRINTS_OR_INSPECTS =
  /^\s*(?:echo|printf|cat|grep|rg|ls|which|type|command|man|head|tail|git)\b/;

/** `--version` and `--help` anywhere in the statement: the command ran, but it checked nothing. */
const ASKS_ONLY = /\s--(?:version|help)\b/;

/** `! npm test` exits 0 when the tests fail. */
const NEGATED = /^\s*!/;

const notACheck = (part: string): boolean =>
  PRINTS_OR_INSPECTS.test(part) || ASKS_ONLY.test(part) || NEGATED.test(part);

/** The shell text that runs: quoted strings and `#` comments are dropped, so neither a commit message nor `true # npm test` names a check. */
const executed = (command: string): string =>
  command.replace(/"[^"]*"|'[^']*'/g, "").replace(/(^|\s)#[^\n]*/g, "$1");

/**
 * Whether a shell command is a test, build, lint, or type check whose exit status reaches the
 * agent. Quoted strings are dropped so a commit message cannot match. A check piped into another
 * command without `set -o pipefail`, backgrounded, followed by `||`, or followed by `;` and something else reports the
 * other command's status, so it does not count.
 */
export function isVerify(command: string, config: Config): boolean {
  const bare = executed(command);
  // Only a `set -o pipefail` statement turns the option on; the word in an echo or a comment does not.
  const pipefail =
    /(?:^|[;&\n])\s*set\s+-\w*o\s+pipefail\b/.test(bare) && !/\bset\s+\+o\s+pipefail\b/.test(bare);
  const last =
    bare
      .split(/[;\n]/)
      .map((s) => s.trim())
      .findLast(Boolean) ?? "";
  return last.split("&&").some((raw) => {
    const part = raw.trim();
    if (part.includes("||") || (!pipefail && part.includes("|"))) return false;
    // A lone `&` backgrounds the check; `2>&1` and `&>` are redirections.
    if (/(?<!>)&(?!>)/.test(part)) return false;
    if (notACheck(part)) return false;
    return config.verify
      ? config.verify.some((p) => safeRegex(p)?.test(part))
      : VERIFY.some((re) => re.test(part));
  });
}

/**
 * `<check> | tail -20` behind `set -o pipefail`, so the check's own exit status is the command's.
 * Null when the command already counts, or when pipefail would not make it count. Only `tail`
 * qualifies: it reads to the end, while `head` or `grep -q` quit early and kill the check with
 * SIGPIPE. `&&` rather than `;`, so a shell without pipefail runs nothing instead of a masked check.
 */
export function withPipefail(command: string, config: Config): string | null {
  if (isVerify(command, config)) return null;
  const next = `set -o pipefail && ${command}`;
  if (!isVerify(next, config)) return null;
  return /(?<!\|)\|(?!\|)(?!\s*tail\b)/.test(executed(command)) ? null : next;
}

/** The command that runs this project's tests, named to the agent up front. A hint, never a check. */
export function projectCheck(cwd: string): string | null {
  const text = (name: string): string => {
    try {
      return readFileSync(join(cwd, name), "utf8");
    } catch {
      return "";
    }
  };
  let pkg: { scripts?: { test?: unknown }; packageManager?: unknown } = {};
  try {
    pkg = JSON.parse(text("package.json") || "{}") as typeof pkg;
  } catch {
    // Not JSON: no scripts to name.
  }
  const test = pkg?.scripts?.test;
  if (typeof test === "string" && !test.includes("no test specified")) {
    const lock = ["pnpm-lock.yaml", "yarn.lock"].find((f) => existsSync(join(cwd, f)));
    const runner =
      typeof pkg.packageManager === "string"
        ? pkg.packageManager.split("@")[0]
        : (lock?.split(/[-.]/)[0] ?? "npm");
    // `bun test` runs Bun's own test runner, not the script.
    if (runner !== "bun") return `${runner} test`;
  }
  const just = ["justfile", "Justfile", ".justfile"].map(text).join("\n");
  // Only a recipe that runs with no arguments: no parameters, or one `*args` that may be empty.
  // `test-unit:` is another recipe, and `test target:` fails without its argument.
  const recipe = /^(test|check)(?:\s+\*\w+)?\s*:(?!=)/m.exec(just)?.[1];
  if (recipe) return `just ${recipe}`;
  if (/^test\s*:/m.test(text("Makefile"))) return "make test";
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(cwd, "go.mod"))) return "go test ./...";
  return null;
}

const IGNORE =
  /(^|\/)docs?\/|(^|\/)(node_modules|\.venv|__pycache__|coverage|\.cache|\.git)(\/|$)|\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|ico|webp|lock|log)$/i;

/** One directory is the other, or sits inside it. `relative` gets the filesystem root and Windows drives right, which string prefixes do not. */
export const inside = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};

/** Scratch space outside the project. A project that itself lives under a temp directory is not scratch. */
export const isScratch = (path: string, cwd: string): boolean => {
  const abs = resolve(cwd, path);
  return /^(\/private)?\/(tmp|var\/tmp|var\/folders)\//.test(abs) && !inside(cwd, abs);
};

/** Files whose edits never need a passing check: docs, images, lockfiles, logs, installed packages, and anything in `config.ignore`. */
export function isIgnored(path: string, config: Config): boolean {
  return IGNORE.test(path) || userIgnored(path, config);
}

/** Paths the user listed in `config.ignore`: besides needing no check, their edits are never sent to Jev. */
export const userIgnored = (path: string, config: Config): boolean =>
  (config.ignore ?? []).some((p) => safeRegex(p)?.test(path));

const SECRETS: [string, RegExp][] = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["OpenAI or Anthropic key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["Stripe key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  [
    "hardcoded credential",
    /(?:api[_-]?key|secret|token|passw(?:or)?d)\s*[:=]\s*["'`](?=[^"'`\s]*\d)(?=[^"'`\s]*[A-Za-z])[^"'`\s]{16,}["'`]/i,
  ],
];

const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/;

/** A `.env` file git ignores is where keys belong. Templates are committed, so they never qualify. */
export function isPrivateEnv(path: string, cwd: string): boolean {
  if (!ENV_FILE.test(path) || ENV_TEMPLATE.test(path)) return false;
  // A write through a symlink lands in its target, which may be a tracked file.
  if (lstatSync(resolve(cwd, path), { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd, stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** Labels of secret shapes found in text about to be written. */
export function findSecrets(text: string): string[] {
  return SECRETS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

const TEST_PATH =
  /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs|rb|exs?)$|(^|\/)test_[^/]*\.py$|Tests?\.(swift|kt|java|cs)$|_spec\.rb$/;
const CASE =
  /\b[xf]?(?:it|test|describe)(?:\.\w+)?\s*\(|\bdef test_\w+|\bfunc Test\w+|#\[test\]|@Test\b|\bfunc test\w+\s*\(|\b(?:it|test)\s+"[^"]*"\s+do\b/g;
const SKIP =
  /\.(?:skip|todo|only)\s*\(|\b[xf](?:it|test|describe)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bpytest\.(?:skip|xfail)\(|@unittest\.skip|\bt\.Skip(?:f|Now)?\(|#\[ignore\]|@Ignore\b|@Disabled\b|XCTSkip|\bpending\s*\(/g;

/** Built with a constructor so the escape byte never appears literally in a regex. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/** Text safe to store and print: command output can carry escape sequences that redraw the terminal. */
export const plain = (text: string): string => text.replace(ANSI, "").replace(/\p{Cc}+/gu, " ");

/** A bare directory name such as `tests` counts, so `rm -rf tests` is seen. */
export const isTestFile = (path: string): boolean =>
  TEST_PATH.test(path) || TEST_PATH.test(path + "/");

export interface TestDamage {
  removed: number;
  skipped: number;
  deleted: boolean;
}

const count = (re: RegExp, text: string): number => (text.match(re) ?? []).length;

/** Test cases removed, skip or focus markers added, or the whole test file deleted. Null when nothing is damaged. */
export function testDamage(change: FileChange, cwd: string): TestDamage | null {
  if (!isTestFile(change.path)) return null;
  if (change.deleted) return { removed: 0, skipped: 0, deleted: true };
  let removed = change.removed;
  if (change.wholeFile) {
    const file = resolve(cwd, change.path);
    removed = existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  const damage = {
    removed: Math.max(0, count(CASE, removed) - count(CASE, change.added)),
    skipped: Math.max(0, count(SKIP, change.added) - count(SKIP, removed)),
    deleted: false,
  };
  return damage.removed || damage.skipped ? damage : null;
}

/** One output line can be megabytes long; the normalising regexes only ever see this much. */
const TAIL_CHARS = 8000;

/** Stable id for a failure: the command plus its output tail with timings and colors stripped. */
export function fingerprint(command: string, output: string): string {
  // Clipped before the split: one build log can be megabytes, and the last 30 lines of the last
  // TAIL_CHARS characters are the same text as the last TAIL_CHARS characters of the last 30 lines.
  const tail = output
    .slice(-TAIL_CHARS)
    .split("\n")
    .slice(-30)
    .join("\n")
    .replace(ANSI, "")
    .replace(/(?<!\d)\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?)\b/g, "T")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "TS")
    .replace(/[ \t]+/g, " ")
    .trim();
  return sha(command + "\n" + tail).slice(0, 16);
}
