# Contributing

## Setup

Node 22 or newer and pnpm.

```bash
pnpm install
pnpm build
```

`dist/` is committed: it is what the install prompt in the README clones and runs, so there is no build step for users. Rebuild it before every commit that touches `src/`. CI fails when the committed `dist/` does not match the source.

## Before opening a pull request

Run the same gates CI runs:

```bash
pnpm check
```

That is `pnpm format:check`, `pnpm type-check` (source and tests), `pnpm lint`, `pnpm test:coverage`, `pnpm build`, and `git diff --exit-code -- dist`, stopping at the first that fails. `pnpm test:coverage` fails when coverage of `src/` drops under the thresholds in `vitest.config.ts`, so new code arrives with its tests.

```bash
pnpm test:smoke
```

This one replays the README install in a temp directory: a checkout with only `dist/` and `package.json`, `init` in a scratch project, then the hook command `init` wrote, run as the agent runs it. It sets `HOME` and `CANNY_HOME` to temp directories first, so your own agent config is never touched.

`pnpm install` points git at `.githooks/`, so `pnpm check` also runs before every commit. It takes about two seconds. When it fails on the `dist/` diff, the build it just ran has already fixed `dist/`: `git add dist` and commit again.

CI runs the static gates once, the tests on Node 22, 24, and 26 on Linux and on macOS, the smoke test on both, and CodeQL. The jobs are in `.github/workflows/`. `ci-ok` passes only when every other CI job did, so it is the one check to require on `main`.

Add a test when you fix a bug (the one that fails before the fix) or change what the gate decides. Four cases that differ only by input are one parametrized test. `src/cli.ts` runs its command switch on import, so `test/cli.test.ts` compiles it to a scratch directory and runs each command as a process, with `HOME` and `CANNY_HOME` pointed at temp directories. Logic that can live outside `cli.ts` (`src/install.ts`, `src/ledger.ts`) is tested by import.

## Trying a change against a real agent

Build, then point a scratch project at the local build. Without a `canny` on your PATH, `init` writes `node <path to this checkout>/dist/cli.js` into the hook config, which is what you want here:

```bash
mkdir /tmp/scratch && cd /tmp/scratch && node ~/canny/dist/cli.js init --claude
```

Use `CANNY_HOME=/tmp/scratch/home` when starting the agent so the session ledger lands somewhere you can throw away, then read it with `canny status` and `canny replay`. Codex needs `--dangerously-bypass-hook-trust` for a non-interactive run, or trust the hooks once with `/hooks`.

To see the exact hook payload an agent sends, add a second handler next to Canny's in the generated config with the command `cat >> /tmp/scratch/raw.jsonl; echo`.

## Recorded sessions

`test/fixtures/` holds every hook payload of one real Claude Code session and one real Codex session, and `test/fixtures.test.ts` checks that Canny still reads them as it did. The payloads in the other tests are written by hand, so these are the only ones that show what the agents really send. They were last recorded with Claude Code 2.1.277 and codex-cli 0.154.0. Record them again when an agent release touches its hooks:

1. In a scratch project, write a hook config whose only handler is `cat >> /tmp/raw.jsonl; echo >> /tmp/raw.jsonl`, for `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop` in `.claude/settings.json`, or for the first two and `Stop` in `.codex/hooks.json`.
2. Run the agent there, headless, with a prompt that makes it write `src/math.js`, edit it, run `node -e "process.exit(3)"` without retrying, run `echo generated > gen.txt && node -e "console.log(42)"`, and answer `Done.`:

   ```bash
   claude -p "<prompt>" --allowedTools "Write,Edit,Bash"
   ```

   ```bash
   codex exec --skip-git-repo-check --dangerously-bypass-hook-trust -s workspace-write "<prompt>"
   ```

3. Scrub the capture into a fixture, then update the snapshot and read its diff, which is exactly what changed in what the agent sends:

   ```bash
   node test/fixtures/scrub.mjs claude-code /tmp/raw.jsonl /tmp/scratch
   ```

   ```bash
   pnpm exec vitest run test/fixtures.test.ts -u
   ```

The scrub keeps only the scratch project's events and replaces paths, ids, the user name, and the model. Codex also fires hooks for its own housekeeping under `~/.codex`, which is why that filter exists: search the fixture for your home directory before committing it.

## Commits and pull requests

- Conventional Commits, lowercase, imperative: `feat: count tee targets as edits`, `fix: read codex exit codes from the transcript`.
- One issue per pull request.
- The rule that shapes every change: facts go to code, judgments go to Jev, and only facts can block. A new check that blocks must be derivable from the ledger or the tool input alone.
