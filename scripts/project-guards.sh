#!/usr/bin/env bash
# Project guards: the invariants of this repo, as blocking checks. Layered on the generic
# scripts/repo-guards.sh. Pure bash + grep + node; run from anywhere.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOD="$ROOT/agent-profiles/mods/agent-profiles"
BUNDLE="$ROOT/agent-profiles"
fail=0
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
rule() { # rule <name> <hint> <hits>
  if [ -n "$3" ]; then red "✗ HARD: $1"; printf '%s\n' "$3" | head -10 | sed 's/^/    /'; echo "    → $2"; fail=$((fail + 1)); else green "✓ $1"; fi
}
# Tracked and not-yet-committed files alike, so the guards also work before the first commit.
tracked() { git -C "$ROOT" ls-files --cached --others --exclude-standard -- "$@" 2>/dev/null; }

echo "── project-guards ─────────────────────────────────────────────"

# Layering: core.js is the inner layer. It must not import anything (no host, no UI, no Node),
# or it stops running both in Herdr and in the tests.
rule "core.js imports nothing" \
  "Keep core.js pure: pass effects in through \`host\`." \
  "$(grep -nE '^[[:space:]]*(import[[:space:]]|.*require\()' "$MOD/core.js")"

# Herdr rules for mods: no timers other than cx.timer, no host calls at module scope.
rule "No setTimeout/setInterval in the mod" \
  "Use cx.timer (Herdr's own); a redraw timer costs battery." \
  "$(grep -nE '(^|[^A-Za-z0-9_.])(setTimeout|setInterval)[[:space:]]*\(' "$MOD"/*.js)"
rule "No host call at module scope in main.js" \
  "Herdr shares module scope between copies: call home(), focused(), ... inside init/handlers." \
  "$(grep -nE '^(const|let|var)[[:space:]].*=[[:space:]]*(home|appHome|focused|spaces|panes|terminals|knownAgents|settings|theme)\(' "$MOD/main.js")"

# Generated files Herdr writes into an installed mod folder must never be committed.
rule "No generated SDK files in the repo" \
  "Delete gpui-kit.d.ts / herdr.d.ts / jsconfig.json: the app regenerates them." \
  "$(tracked '*gpui-kit.d.ts' '*herdr.d.ts' '*jsconfig.json')"

# Publishing: nothing personal in a public repo.
rule "No personal paths, hosts or tokens" \
  "Use ~ or a placeholder; never a real home folder, machine name or key." \
  "$(git -C "$ROOT" grep --untracked -nIE '(/Users/[a-z][a-z0-9_.-]*|/home/[a-z][a-z0-9_.-]*/|wilsonxu|gh[pous]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' -- . ':(exclude)scripts/project-guards.sh' 2>/dev/null | grep -vE '/Users/me\b')"

# The bundle shape the Herdr gallery indexes.
missing=""
for f in RECIPE.md keys.json mods/agent-profiles/main.js mods/agent-profiles/mod.json; do [ -f "$BUNDLE/$f" ] || missing="$missing\n    $BUNDLE/$f"; done
[ -f "$BUNDLE/preview.png" ] || missing="$missing\n    $BUNDLE/preview.png (a real screenshot; see docs in CONTEXT.md)"
rule "Bundle has RECIPE.md, preview.png, keys.json and the mod" "Restore the missing file." "$(printf '%b' "$missing" | sed '/^$/d')"
rule "preview.png is a readable PNG" \
  "Replace it with a screenshot of the real mod." \
  "$([ -f "$BUNDLE/preview.png" ] && ! node -e 'process.exit(require("fs").readFileSync(process.argv[1]).subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) ? 0 : 1)' "$BUNDLE/preview.png" && echo "$BUNDLE/preview.png is not a PNG")"

# JSON files parse; the mod and its keys agree on the mod's name.
bad=""
for f in "$BUNDLE/keys.json" "$MOD/mod.json" "$ROOT/package.json" "$ROOT"/examples/profiles/*/profile.json; do
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null || bad="$bad\n    $f"
done
rule "JSON files parse" "Fix the syntax." "$(printf '%b' "$bad" | sed '/^$/d')"
rule "keys.json opens the mod that exists" \
  "Bind mod.open:<name> where <name> is the folder under mods/." \
  "$(grep -oE 'mod\.open:[a-z0-9_-]+' "$BUNDLE/keys.json" | sort -u | while read -r b; do [ -d "$BUNDLE/mods/${b#mod.open:}" ] || echo "$b has no mods/${b#mod.open:}"; done)"

# Every example profile must be valid for the code that will read it.
rule "Example profiles load with core.js, includes resolved" \
  "Fix the example; it is the first thing a user copies." \
  "$(cd "$ROOT" && node --input-type=module -e '
    import { readdirSync, readFileSync } from "node:fs";
    import { parseProfile, pickDoc, resolveIncludes } from "./agent-profiles/mods/agent-profiles/core.js";
    const loaded = readdirSync("examples/profiles").map((n) => {
      const dir = `examples/profiles/${n}`;
      const r = parseProfile(n, readFileSync(`${dir}/profile.json`, "utf8"));
      if (r.error) return { name: n, error: r.error };
      const file = pickDoc(r.profile.harness, readdirSync(dir));
      return { ...r.profile, doc: file ? { path: `${dir}/${file}`, text: readFileSync(`${dir}/${file}`, "utf8") } : null };
    });
    for (const p of resolveIncludes(loaded)) if (p.error) console.log(`examples/profiles/${p.name}: ${p.error}`);
  ')"

echo "────────────────────────────────────────────────────────────────"
if [ "$fail" -gt 0 ]; then red "project-guards FAILED: $fail rule(s)."; exit 1; fi
green "project-guards passed."
