# 0005. More harnesses, and a per-profile bypass switch

Status: accepted. Checked on Claude Code 2.1.323, Codex 0.167.2, Pi 1.5.2, Grok 1.0.70, OpenCode 1.19.5,
Antigravity 1.3.3, Copilot 1.0.105, Crush 0.98.2, Cursor 2026.01.23, Gemini 0.66.0, Hermes 0.20.5, Kimi 2.2.0,
Qoder 1.1.68.

## The need

Start profiles on more harnesses, and per profile, start the agent with all approvals skipped. Every harness
names that switch differently.

## Decision

- **One table, `HARNESSES` in `core.js`**, keyed by Herdr's program key, holding each harness's `instructions`
  (how documents reach it) and `bypass` (its own skip-all-approvals flags). It replaces the instruction-only
  `ADAPTERS`. Nothing harness-specific lives anywhere else.
- **Every flag comes from the CLI's own `--help`** and `scripts/verify-harnesses.mjs` checks each one there on
  every verify, with a whole-word match (a planted near miss, `--allow-al`, fails). Instructions are checked by
  what the harness actually loads: Codex's model-visible prompt, Pi's assembled prompt, OpenCode's resolved config,
  and live model answers for Claude and Grok.
- **The strongest flag, not the friendliest name.** Kimi's `--yolo` still asks before risky actions, so its
  entry is `--auto`. Codex uses `--dangerously-bypass-approvals-and-sandbox`, not `--full-auto`. Cursor needs
  `--force --sandbox disabled`. Pi never asks before tool calls; `--approve` answers its only prompt, project trust.
- **Refuse, never fake.** A profile with bypass on, on a harness without a bypass flag, cannot start. Amp has only
  a settings-file switch that `--settings-file` would replace whole, so it is not in the table. Kiro's chat binary
  was missing here, so it is not either.
- **OpenCode through its config override.** `OPENCODE_CONFIG_CONTENT` adds `instructions` after the project's own
  list (checked), passed with `env` inside the login shell, so the wrapper and argv rules stay as they are.
- **Bypass is a boolean in `profile.json`**, left out when false, so a profile file only says what is unusual.
  The flags go right after the harness command, before the instruction flags.
- **Menu:** the harness list moved to its own page (13 rows would not fit beside the rest), and a Bypass row shows
  the harness's flags. The popup opens at the height of the taller page.

## Consequences

- Five harnesses take instructions (Claude, Codex, Pi, Grok, OpenCode); thirteen have bypass.
- A harness that renames its flag fails `verify-source` instead of starting an agent that silently asks, or worse,
  silently does not get its instructions.
- Qoder's and OpenCode's instructions paths were not live-checked (Qoder was logged out; OpenCode's model timed out);
  Qoder therefore takes no instructions yet, and OpenCode's are checked through its resolved config.
