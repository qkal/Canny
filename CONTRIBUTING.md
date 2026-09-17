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
pnpm exec prettier --check src test
pnpm type-check
pnpm lint
pnpm test
pnpm build
git diff --exit-code -- dist
```

Add a test when you fix a bug (the one that fails before the fix) or change what the gate decides. Four cases that differ only by input are one parametrized test.

## Trying a change against a real agent

Build, then point a scratch project at the local build. Without a `canny` on your PATH, `init` writes `node <path to this checkout>/dist/cli.js` into the hook config, which is what you want here:

```bash
mkdir /tmp/scratch && cd /tmp/scratch && node ~/canny/dist/cli.js init --claude
```

Use `CANNY_HOME=/tmp/scratch/home` when starting the agent so the session ledger lands somewhere you can throw away, then read it with `canny status` and `canny replay`. Codex needs `--dangerously-bypass-hook-trust` for a non-interactive run, or trust the hooks once with `/hooks`.

To see the exact hook payload an agent sends, add a second handler next to Canny's in the generated config with the command `cat >> /tmp/scratch/raw.jsonl; echo`.

## Commits and pull requests

- Conventional Commits, lowercase, imperative: `feat: count tee targets as edits`, `fix: read codex exit codes from the transcript`.
- One issue per pull request.
- The rule that shapes every change: facts go to code, judgments go to Jev, and only facts can block. A new check that blocks must be derivable from the ledger or the tool input alone.
