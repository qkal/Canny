# Changelog

All notable changes to Canny are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `canny trust` accepts the nearest `.canny.json` as it stands, recording a hash of its contents under `~/.canny/trusted.json`.
- `canny remove` takes Canny's hook entries out of a project or the home directory and leaves everything else in the files alone.
- `canny init` writes hook config only for the agents it finds installed, unless told otherwise with `--claude` or `--codex`.

### Changed

- `verify`, `ignore`, `rules`, and `allow` in a `.canny.json` are ignored until the file is trusted, since it sits in the repository the agent is editing: a cloned repo can ship one and a blocked agent can write one. `rules` is on the list because it replaces the `CLAUDE.md` extraction, so one junk rule in an untrusted file would silence every rule the project wrote. `strict` is still read from any config. Existing projects need one `canny trust` for those four fields to work again.
- `canny status` prints the untrusted-config line before it looks for a session, so a fresh project with no recorded sessions still sees it, and names only the fields the file actually sets.
- A `.canny.json` holding valid JSON that is not an object — `null`, an array, a number — is read as no config at all instead of throwing in `canny status` and `canny trust`.
- Canny is installed from this repository, not from npm. The compiled `dist/` is committed, so a clone and `node ~/.canny/src/dist/cli.js init` is the whole install. The README carries prompts that let the agent do it.
- Without a `canny` on PATH, `init` writes `node <checkout>/dist/cli.js` into the hook config instead of the absolute path of the Node binary, so a Node upgrade no longer breaks the hooks.

### Fixed

- The secret check reads shell commands that write a file, so `echo "key = 'sk-…'" > src/config.ts` is denied like the same `Write` would be. A command that only uses a key, with no file written, is left alone.
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

[Unreleased]: https://github.com/qkal/canny/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qkal/canny/releases/tag/v0.1.0
