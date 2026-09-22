# Changelog

All notable changes to Canny are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A `SessionStart` hook tells the agent what the done-gate asks for before it starts, and names the project's test command when `package.json`, a `justfile`, a `Makefile`, `Cargo.toml`, or `go.mod` gives one. Before, the agent learned the rule from its first blocked Stop and paid an extra turn for it. Run `canny init` again to add the hook to an existing project.
- A Bash check piped into `tail` (`npm test 2>&1 | tail -20`) is rewritten to run behind `set -o pipefail`, so the check's own exit status is the command's: it counts as a check when it passes and reports its failure when it fails. This was the block nearly every benchmarked session paid. On Claude Code the rewritten command still goes through the user's permission rules; on Codex, which takes a rewrite only with an "allow", approval stays a separate step.
- `bench/run.mjs` records the turns, cost, and model time of each Claude Code run, and how often Canny rewrote a command. With the two changes above, a 25-pair Opus 5 run had no blocked Stops, where every earlier Canny run had one, and the Canny arm finished 1.6 ± 3.4 seconds faster than the arm without it, down from 4.5 seconds slower.
- The Jev rule check can be turned off with `"allow": ["rules"]`, and it skips the paths listed in `ignore`, so a project can keep some or all of its code from being sent to TypeSafe without unsetting the key. Both fields wait for `canny trust`, like the other fields that loosen the guard.

- `bench/run.mjs` measures Canny instead of asserting it: each task in `bench/tasks` goes to a headless Claude Code or Codex in a scratch directory, once with project-level Canny hooks and once without, and the run passes only when the task's original tests pass afterwards. Rows land in `bench/results/`, which git ignores.

### Changed

- CI runs as parallel jobs: static gates once, the tests on Node 22, 24, and 26 on Linux plus Node 24 on macOS, a smoke test of the README install on both systems, and a CodeQL workflow. A newer push to a pull request cancels the older run.
- `pnpm type-check` covers `test/` as well as `src/`. `pnpm check` runs every gate in one command, and `pnpm test:coverage` fails when coverage of `src/` drops under the thresholds in `vitest.config.ts`.
- `pnpm install` sets up a git pre-commit hook that runs `pnpm check`, so a stale `dist/` is caught before the commit instead of in CI. CI has a `ci-ok` job that passes only when the `static`, `test`, and `smoke` jobs did: the one check to require on `main` for those. CodeQL is a separate workflow, so its `analyze` check is required separately or not at all.
- `test/fixtures/` holds the hook payloads of a real Claude Code session and a real Codex session, scrubbed of paths and ids, with a snapshot of how Canny reads them. `test/fixtures/scrub.mjs` turns a new capture into a fixture when an agent release changes what it sends.
- The verify gate is tested as a product: every check in every form that hides its exit status, and in every wrapper that does not. The secret check is tested the same way, every shape through every route into a file, for both agents.
- New tests: a sweep of malformed hook payloads that must all come out as a decision, a guard against regexes that stall on hostile text, a whole session through the real `canny hook` process with `replay` catching an edited ledger, hostile session ids, half-written ledger lines, config trust by path, and hook matchers for every tool Canny reads.
- Canny calls itself a supervision layer instead of a warden, in the README, `canny` help, and the npm description. The npm package is still `canny-warden`.

### Fixed

- A negated check (`! npm test`) and a check named only in a comment (`true # npm test`) no longer count as a passing check: the first exits 0 when the tests fail, and the second runs none.
- An `ignore` pattern matches a path however a shell command spells it: `./generated/x.ts` and `src/../generated/x.ts` both match `^generated/`, for the done-gate and for what the rule check leaves out. Relative paths used to be matched as written.
- A shell command that rewrites a test file goes through the test-removal check: a heredoc or `echo` redirect that leaves fewer test cases, an append that adds `.only` or `.skip`, and a `sed -i` or `perl -pi` script whose `s` command or delete pattern takes test cases out or puts skip markers in. The script is read, not run, so a delete by line number is not seen. Text a shell command writes is also checked against the project rules after it runs, like any other edit.
- A shell command that starts with a `cd` to where it already is (`cd "$PWD"; …`, `cd <project> && …`) can write a key into a git-ignored `.env` again. Any `cd` used to cancel the env-file exemption, and agents open many commands that way, so the write Canny's own message recommends was denied. A `cd` that opens the command and provably goes nowhere (`.`, `$PWD`, or the project's own absolute path) no longer counts as leaving; every other `cd` still leaves no env file exempt. Found by the first `bench/` runs.
- A `;` inside quotes no longer splits a shell statement, so `echo "const k = '<key>';" > src/k.ts` is denied. Before, the secret check lost the redirect as soon as the written code ended in a semicolon.

## [0.2.0] - 2026-09-21

### Added

- `canny trust` accepts the nearest `.canny.json` as it stands, recording a hash of its contents under `~/.canny/trusted.json`.
- `canny remove` takes Canny's hook entries out of a project or the home directory and leaves everything else in the files alone.
- `canny init` writes hook config only for the agents it finds installed, unless told otherwise with `--claude` or `--codex`.

### Changed

- The ledger records the directory the agent worked in. `canny status` and `canny replay` pick the latest session of the project you run them in, not the latest session of any project, and `replay` loads the config of the session's project wherever it is run from. `canny sessions` lists each session's project. Ledgers written before this have no project and are only reachable by file name.
- `canny status` prints how many times the hook crashed and the last error, before anything else. The hook fails open, so a crash used to be visible only in `~/.canny/errors.log`.
- Messages that name a command print `node "<checkout>/dist/cli.js" …` when there is no `canny` on PATH, which is the case after the documented install.

- `verify`, `ignore`, `rules`, and `allow` in a `.canny.json` are ignored until the file is trusted, since it sits in the repository the agent is editing: a cloned repo can ship one and a blocked agent can write one. `rules` is on the list because it replaces the `CLAUDE.md` extraction, so one junk rule in an untrusted file would silence every rule the project wrote. `strict` is still read from any config. Existing projects need one `canny trust` for those four fields to work again.
- `canny status` prints the untrusted-config line before it looks for a session, so a fresh project with no recorded sessions still sees it, and names only the fields the file actually sets.
- A `.canny.json` holding valid JSON that is not an object — `null`, an array, a number — is read as no config at all instead of throwing in `canny status` and `canny trust`.
- Canny is installed from this repository, not from npm. The compiled `dist/` is committed, so a clone and `node ~/.canny/src/dist/cli.js init` is the whole install. The README carries prompts that let the agent do it.
- Without a `canny` on PATH, `init` writes `node <checkout>/dist/cli.js` into the hook config instead of the absolute path of the Node binary, so a Node upgrade no longer breaks the hooks.

### Fixed

- `canny init` and `canny remove` recognise their own hook entries by the `statusMessage: "Canny"` marker every version has written together with the `hook --agent …` arguments, or by the bare `canny hook --agent …` command, not by the word "canny" anywhere in the command. Another tool's hook that lives under a directory named `canny` is no longer deleted.
- A hook group that holds another tool's hook next to Canny's keeps the other hook; the whole group used to be dropped.
- A settings file that holds valid JSON but not an object, or a `hooks` value that is not an object, is refused and left untouched, and the command exits 1. `null` used to crash and `[]` was silently overwritten.
- Settings are written to a temporary file and renamed into place, so a crash mid-write cannot leave half a file. A symlinked `settings.json` stays a symlink and the file keeps its mode. `canny remove` leaves no empty `"hooks": {}` behind.
- `canny status` finds the session when the agent and the shell reach the project through different paths, such as `/tmp` and `/private/tmp` on macOS.

- The secret check reads shell commands that write a file, so `echo "key = 'sk-…'" > src/config.ts` is denied like the same `Write` would be. Only text the command itself puts into the file is read: heredoc bodies and `echo` or `printf` statements. A key that is only used, such as a `curl` header whose response is saved, is left alone.
- `rm`, `git rm`, and `mv` of a test file or test directory get the same ask (deny on Codex) as deleting it through an edit. Moving a test to another test path is not removal.
- `cp`, `mv`, `rm`, `git rm`, `git checkout -- file`, and `git restore` count as code changes in the ledger, so the done-gate sees them. Changes under `node_modules`, `.venv`, `__pycache__`, `coverage`, `.cache`, and temp files outside the project do not.
- Writing a key into a `.env` file that git ignores is allowed; that is where the deny message sends the agent. A `.env` that is not ignored, and `.env.example`-style templates, are still denied.

- A check whose exit status never reaches the agent no longer counts as passing: `pnpm test 2>&1 | tail -20` without `pipefail`, `pnpm test || true`, and `pnpm test; echo done` all report another command's status. Commands that only print or inspect (`echo tsc`, `tsc --version`, `git diff -- vitest.config.ts`) do not count either. The block message says so.
- `>` inside a quoted string or a heredoc body is no longer read as a file write, so `git commit -m "a > b"` does not make a session with no edits fail the done-gate. `.log` files do not count as code.
- One very long line of digits in command output stalled the hook past its timeout (41 s for 200 KB), which lost the ledger entry. The failure fingerprint now reads at most the last 8000 characters.
- The ledger, the Jev cache, `errors.log`, and their directories are created owner-only (`0600`, `0700`), since recorded command lines can hold credentials. Files from earlier versions keep their old mode: `chmod -R go= ~/.canny` fixes them.
- Escape sequences and control characters are stripped from commands, output summaries, and paths before they enter the ledger, so command output cannot redraw what `canny status` prints.

## [0.1.0] - 2026-09-18

First release.

### Added

- Evidence ledger: an append-only log per session of edited files, shell commands, and exit codes, under `~/.canny/sessions/`.
- Done-gate on Stop: the agent cannot finish after a code edit until a test, build, lint, or type-check command has passed since the last edit. One block, then a warning to the user, unless `strict` is set.
- Pattern checks on PreToolUse: secret shapes in content about to be written (deny), test cases removed or skipped and test files deleted (ask on Claude Code, deny on Codex), and the same command failing with the same output (note on the second, deny on the fourth).
- Jev as a classifier: "does this message claim the work is done?" on Stop and "does this edit break project rule X?" on PostToolUse, with rules read from `CLAUDE.md`, `AGENTS.md`, or `.canny.json`. Answers are cached by content hash and only acted on above 0.9 or below 0.1. Jev never blocks.
- `canny replay` re-derives every Stop verdict from the recorded facts and Jev answers.
- Claude Code and Codex CLI support from one codebase: shell writes by redirection are counted as edits, Claude Code's `PostToolUseFailure` carries the exit code, and Codex's exit code is read from the session transcript.
- `canny init` writes hook config for a project or, with `--global`, for the home directory.

[Unreleased]: https://github.com/qkal/canny/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/qkal/canny/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/qkal/canny/releases/tag/v0.1.0
