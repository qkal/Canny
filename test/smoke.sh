#!/usr/bin/env bash
# The README install, in a temp directory: a checkout holding only what users run (`dist/` and
# `package.json`, no node_modules), `init` in a scratch project, then the hook command `init` wrote,
# run the way the agent runs it. Once by path, once through a `canny` symlink on PATH.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
# Resolved, because Node reports the real path of the checkout and macOS keeps temp behind a symlink.
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/src" "$tmp/home/.claude" "$tmp/bin"
cp -R "$root/dist" "$root/package.json" "$tmp/src/"
export HOME="$tmp/home" CANNY_HOME="$tmp/home/.canny"

# $1: scratch project, $2: what the hook command must start with, the rest: how the user runs canny.
install() {
  local project=$1 expected=$2 hook
  shift 2
  mkdir -p "$project" && cd "$project"
  "$@" init --claude
  hook=$(node -p 'JSON.parse(require("fs").readFileSync(".claude/settings.json", "utf8")).hooks.Stop[0].hooks[0].command')
  [[ $hook == "$expected"* ]] || { echo "unexpected hook command: $hook" >&2; exit 1; }
  printf '{"hook_event_name":"PostToolUse","session_id":"%s","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"src/a.ts","old_string":"a","new_string":"b"}}' "$(basename "$project")" "$PWD" |
    sh -c "$hook" | grep -qx '{}'
  "$@" status | grep -q 'edited    src/a.ts'
}

install "$tmp/by-path" "node \"$tmp/src/dist/cli.js\" hook" node "$tmp/src/dist/cli.js"
ln -s "$tmp/src/dist/cli.js" "$tmp/bin/canny"
export PATH="$tmp/bin:$PATH"
install "$tmp/by-name" "canny hook" canny
echo "smoke ok: dist/ installs and answers hooks by path and by name"
