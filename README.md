# Canny

A warden for AI coding agents. Canny plugs into Claude Code and Codex CLI through their hook systems and checks the agent's work while the session runs.

Coding agents fail quietly: they say "done" when no test ran, ignore rules in `CLAUDE.md` or `AGENTS.md`, retry the same failing command, and write secrets into files. Canny turns those into facts the agent cannot talk its way past.

The rule: **facts go to code, judgments go to Jev, and only facts can block.**

## What it does

| Check | When | Source | Outcome |
| --- | --- | --- | --- |
| Done-gate: no code edit may be finished without a passing check since the last edit | Stop | evidence ledger | block |
| Secret shapes (AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, Google keys, private keys, hardcoded credentials) in content about to be written | PreToolUse | pattern | deny |
| Test cases removed, `.skip`/`.only`/`xfail` markers added, or a test file deleted | PreToolUse | pattern | ask (Claude Code), deny (Codex) |
| The same command failing with the same output | PostToolUse, PreToolUse | ledger | note on the 2nd, deny on the 4th |
| "Does this message claim the work is done?" | Stop | Jev | can only relax the done-gate |
| "Does this edit break project rule X?" | PostToolUse | Jev | note to the agent |

The evidence ledger is an append-only log per session under `~/.canny/sessions/`. It records which files changed, which test, build, or lint commands ran after the last edit, and their exit codes. It works offline with no API key.

Files written from the shell count too. Agents often write with `cat > file <<'EOF'`, `tee`, or `sed -i` when told to prefer the shell, and no Write or Edit hook fires for that. Canny reads redirection and in-place edit targets out of every Bash command, and uses Claude Code's `bashEditDiff` list when it is present.

## Install

```bash
pnpm add -g canny-warden
```

Node 22 or newer. Install globally so `canny` is on your PATH.

Then, inside a project:

```bash
canny init
```

This writes hook entries into `.claude/settings.json` for Claude Code and `.codex/hooks.json` for Codex, keeping whatever is already there. Without flags it picks the agents it finds installed (a `~/.claude` or `~/.codex` directory), and both when it finds neither. The entries call `canny hook`, so they keep working across upgrades of Canny and Node. If `canny` is not on your PATH at init time, absolute paths to the current Node binary and install are written instead, and init says so. Use `--global` to install into `~/.claude` and `~/.codex` instead, and `--claude` or `--codex` to choose explicitly. Codex asks you to trust new hooks once: run `/hooks` inside Codex.

Set `TYPESAFE_API_KEY` to enable Jev. Without it, Canny runs the deterministic checks alone.

## How the done-gate decides

At every Stop, Canny reads the ledger:

1. No code files edited this session: allow. Docs, images, and lockfiles do not count.
2. A test, build, lint, or type-check command exited 0 after the last edit: allow.
3. Otherwise, if Jev is available and is at least 90 percent sure the message is *not* a "done" claim (the agent is asking a question or reporting being blocked): allow.
4. Otherwise: block, with a reason that names the files, the last command and its exit code, and what counts as a check.

The agent gets one block. If it stops again with no new edit or command, Canny lets it through and warns you. Set `"strict": true` to keep blocking until a check passes (Claude Code caps this at 8 in a row).

## Jev

Jev is TypeSafe's decision model. Canny asks it typed yes/no questions and gets a probability back in about 250 ms. Jev never blocks: a "done" claim is blocked because the ledger has no passing check, not because a probability crossed a line.

To keep verdicts stable across Jev's run-to-run drift of about 0.05:

- Every answer is cached by content hash under `~/.canny/jev/`, so the same edit or message always gets the same answer.
- Canny acts only above 0.9 (a rule is broken) or below 0.1 (not a done claim). Everything in between falls back to the deterministic default.
- Every request is logged to the session ledger. `canny replay` re-derives every Stop verdict from the recorded facts and answers and reports any mismatch.

The judge is one function (`makeJudge` in `src/jev.ts`) that posts to `CANNY_JEV_URL`. Point it at anything that speaks the same request shape to swap in a local model.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | unset | Enables Jev |
| `CANNY_JEV_URL` | `https://api.typesafe.ai/v1/systemone` | Endpoint |
| `CANNY_JEV_MODEL` | `jev-latest` | Model |
| `CANNY_JEV_TIMEOUT_MS` | `3000` | Per-request timeout; a timeout is treated as no answer |
| `CANNY_HOME` | `~/.canny` | Sessions, cache, error log |

## What Canny stores and sends

- The session ledger under `~/.canny/sessions/` keeps the command line of every shell command the agent ran, its exit code, the last line of its output, and the paths of edited files. It never keeps file contents, but a secret passed on a command line ends up in the ledger.
- With `TYPESAFE_API_KEY` set, each edit's added and removed text (clipped to 4,000 characters), the extracted project rules, and the agent's final message are sent to TypeSafe's API. Every request and its answer are cached under `~/.canny/jev/`, so that content also sits on disk.
- Without a key, nothing leaves the machine.
- Hook errors go to `~/.canny/errors.log`.

Set `CANNY_HOME` to move all of it.

## Configuration

Optional `.canny.json` in the project (or any parent up to your home directory):

```json
{
  "verify": ["^just check", "uv run pytest"],
  "ignore": ["^generated/"],
  "rules": ["Never hardcode model IDs.", "Use pnpm, not npm."],
  "allow": ["test-removal"],
  "strict": false
}
```

- `verify`: regexes for commands that count as a check. Replaces the built-in list (pytest, vitest, jest, go test, cargo test, tsc, eslint, ruff, pre-commit, and about forty more).
- `ignore`: regexes for edited paths that never need a check. Adds to docs, images, and lockfiles.
- `rules`: rules for the Jev rule check. Replaces the automatic extraction of instruction-like bullets from `CLAUDE.md`, `AGENTS.md`, and `.claude/CLAUDE.md` (capped at 24, strongest first).
- `allow`: checks to turn off: `secrets`, `test-removal`, `repeat-failure`.
- `strict`: keep blocking Stop until a check passes.

## Commands

```bash
canny status            # what the ledger knows about the latest session
canny sessions          # list recorded sessions
canny replay            # re-derive every Stop verdict; exit 1 on any mismatch
```

## Agent differences

Both agents share the hook wire format, and Canny sends the same JSON to both. What differs:

- Claude Code fires `PostToolUse` only when a command succeeds and `PostToolUseFailure` when it fails. Codex fires `PostToolUse` for both. Canny subscribes to both events on Claude Code.
- Codex hook payloads carry no exit status for shell commands, only their output. Canny reads the exit code from the session transcript Codex passes as `transcript_path` (the `item_completed` record for the call). If that lookup fails, the exit code is unknown and the command does not count as a passing check.
- Codex has no `ask` permission decision, so a test-removal check denies there with the same reason.
- Codex file edits arrive as `apply_patch`; Canny parses the patch to find files, removed tests, and secrets.
- Codex requires you to trust hooks once via `/hooks`.

## Development

```bash
pnpm install
pnpm test
pnpm type-check
pnpm lint
pnpm build
```

Run a hook by hand:

```bash
echo '{"hook_event_name":"Stop","session_id":"demo","cwd":"'"$PWD"'","last_assistant_message":"Done."}' | node dist/cli.js hook --agent claude
```
