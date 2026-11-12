import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import type { FileChange } from "./events.js";

const VERIFY = [
  /\b(pytest|vitest|jest|mocha|ava|cypress|playwright test|go test|cargo test|swift test|xcodebuild test|gradlew? test|mvn test|dotnet test|rspec|phpunit|mix test|bun test|deno test|node --test|node --run test|npm test|pnpm test|yarn test|make test|just test|python -m pytest|python3? -m unittest|npm run test|pnpm run test|yarn run test|tox|nox)\b/,
  /\b(tsc|cargo build|go build|go vet|swift build|xcodebuild|gradlew? (build|assemble)|mvn (package|compile|verify)|dotnet build|npm run build|pnpm build|pnpm run build|yarn build|make build|just build|bun run build|vite build|next build|esbuild|webpack)\b/,
  /\b(eslint|oxlint|biome (check|lint)|prettier --check|ruff (check|format --check)|flake8|pylint|mypy|pyright|pyrefly|ty check|pnpm type-check|npm run lint|pnpm lint|pnpm run lint|yarn lint|golangci-lint|cargo clippy|swiftlint|swift-format lint|pre-commit run|just lint|just check|rubocop|shellcheck)\b/,
  // A test file run directly: `python tests.py`, `node test.js`. The name has to say it is one,
  // since `python manage.py` and `node test/fixtures/scrub.mjs` check nothing. Options may come
  // first (`python -u tests.py`), but none that evaluate, print, or only parse (`-c`, `-m`, `-e`,
  // `-p`, `-v`, `-h`, `--eval`, `--print`, `--check`): with those the file is not what runs.
  /\b(?:python[\d.]*|node|ruby)(?:\s+(?:-(?!\w*[cmepvVh])\w+|--(?!eval|print|check)[\w-]+(?:=\S+)?))*\s+(?:[^\s;|&]*[/\\])?(?:tests?|test_[\w.-]+|[\w.-]+[_.](?:tests?|spec))\.(?:py|rb|[cm]?[jt]sx?)\b/,
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
  // A `#` after an escaped space is part of a word, not a comment: `--grep=\ #foo | tail` pipes.
  command.replace(/"[^"]*"|'[^']*'/g, "").replace(/(^|(?<!\\)\s)#[^\n]*/g, "$1");

/**
 * Whether a shell command is a test, build, lint, or type check whose exit status reaches the
 * agent. Quoted strings are dropped so a commit message cannot match. A check piped into another
 * command without `set -o pipefail`, backgrounded, followed by `||`, or followed by `;` and something else reports the
 * other command's status, so it does not count.
 */
export function isVerify(command: string, config: Config): boolean {
  return checksIn(command, config).length > 0;
}

/** `config.require` as usable patterns. The field is read from an untrusted file, so anything but a string that compiles is dropped: a typo must not crash the hook open. */
export const required = (config: Config): string[] =>
  Array.isArray(config.require)
    ? config.require.filter((p): p is string => typeof p === "string" && safeRegex(p) !== null)
    : [];

/** The `require` patterns this command satisfies. Only a check that counts can satisfy one, so the field never adds to what counts. */
export function requiredBy(command: string, config: Config): string[] {
  const checks = checksIn(command, config);
  return required(config).filter((p) => checks.some((c) => safeRegex(p)!.test(c)));
}

/** The checks in a command whose own exit status is the command's result. */
function checksIn(command: string, config: Config): string[] {
  const bare = executed(command);
  // Only a `set` statement changes the option, the word in an echo or a comment does not, and the last one wins.
  const pipefail =
    [...bare.matchAll(/(?:^|[;&\n])\s*set\s+([+-])\w*o\s+pipefail\b/g)].at(-1)?.[1] === "-";
  const last =
    bare
      .split(/[;\n]/)
      .map((s) => s.trim())
      .findLast(Boolean) ?? "";
  const parts = last.split("&&").map((s) => s.trim());
  // `a && b || true` exits 0 when `a` fails: an `||` rescues every check before it, and the one
  // after it may never run. Only what follows the last `||` part reports its own status.
  const from = parts.findLastIndex((p) => p.includes("||")) + 1;
  return parts.slice(from).flatMap((part) => {
    if (!pipefail && part.includes("|")) return [];
    // A lone `&` backgrounds the check; `2>&1` and `&>` are redirections.
    if (/(?<!>)&(?!>)/.test(part)) return [];
    // Under pipefail the check is the command that feeds the pipe, so `^npm test$` names it.
    const check = part.split("|")[0]!.trim();
    if (notACheck(check)) return [];
    const counts = config.verify
      ? config.verify.some((p) => safeRegex(p)?.test(check))
      : VERIFY.some((re) => re.test(check));
    return counts ? [check] : [];
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

/** Symlinks resolved as far as the path exists: the agent may name a file through one (`/tmp` on macOS) and report its cwd through the other. */
export const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const up = dirname(path);
    return up === path ? path : join(real(up), basename(path));
  }
};

/** The repository a session works in: the nearest directory at or above `cwd` that holds `.git`, or `cwd` when none does. The agent may be working in a subdirectory of it. */
export const projectRoot = (cwd: string): string => {
  // Resolved first: a cwd reached through a symlink has the link's parents, not the repository's.
  const start = real(resolve(cwd));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === dirname(dir)) return start;
  }
};

/**
 * Whether a path is part of the session's project. A file outside it (`~/.zshrc`, a temp file,
 * another checkout) is nothing the project's checks can vouch for, so it never holds the done-gate.
 */
export const inProject = (path: string, cwd: string, root = projectRoot(cwd)): boolean =>
  inside(root, real(resolve(cwd, path)));

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
