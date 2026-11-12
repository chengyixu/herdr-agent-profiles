#!/usr/bin/env bash
# The one command that says whether this repo is sound. Fail-fast, direct, no CI service.
#
# Prerequisites: node >= 20 (node:test), git, bash. Optional, each skipped with a note when
# absent: herdr-app (checks the mod loads), and the claude / codex / pi CLIs plus the shells
# in scripts/verify-harnesses.mjs (contract checks against the real thing).
#
#   bash scripts/verify-source.sh            everything above, offline
#   bash scripts/verify-source.sh --live     also one tiny Claude model call
#
# The live end-to-end against a running Herdr (scripts/e2e-live.mjs) is separate on
# purpose: it creates and removes a throwaway space in the open window.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

step "unit and glue tests"
node --test test/*.test.js

step "generic guards"
bash scripts/repo-guards.sh

step "project guards"
bash scripts/project-guards.sh

step "contract: shells and harnesses"
node scripts/verify-harnesses.mjs "$@"

step "the mod loads in Herdr"
if command -v herdr-app >/dev/null 2>&1; then
  # `check` writes editor typings next to the mod, so it runs on a throwaway copy.
  copy="$(mktemp -d)"
  trap 'rm -rf "$copy"' EXIT
  cp -R agent-profiles/mods/agent-profiles "$copy/agent-profiles"
  herdr-app check "$copy/agent-profiles"
else
  echo "- herdr-app not found: skipped"
fi

printf '\n\033[32mverify-source passed\033[0m\n'
