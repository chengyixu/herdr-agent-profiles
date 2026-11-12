#!/usr/bin/env bash
# Copies the mod into your Herdr app home and checks that it loads. It does not touch keys.json:
# merge agent-profiles/keys.json into yours by hand.
#
#   bash scripts/install.sh            first install
#   bash scripts/install.sh --update   replace a copy this script installed before
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DEST="$APP_HOME/mods/agent-profiles"

if [ -e "$DEST" ] && [ "${1:-}" != "--update" ]; then
  echo "$DEST already exists. Run with --update to replace it, or pick another name." >&2
  exit 1
fi
mkdir -p "$APP_HOME/mods"
rm -rf "$DEST"
cp -R "$ROOT/agent-profiles/mods/agent-profiles" "$DEST"
echo "installed: $DEST"
if command -v herdr-app >/dev/null 2>&1; then herdr-app check "$DEST"; else echo "herdr-app not found: not checked"; fi
echo
echo "Next: merge this into $APP_HOME/keys.json (do not replace the file):"
cat "$ROOT/agent-profiles/keys.json"
