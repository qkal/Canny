# Changelog

All notable changes to Canny are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
