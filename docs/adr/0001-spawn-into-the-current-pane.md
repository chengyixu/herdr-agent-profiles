# 0001. Start an agent in the current pane: a new terminal in a login shell, then close the idle shell

Status: accepted. Measured on Herdr 0.1.15, herdr-core 0.1.20, macOS arm64.

## The need

Start a saved agent in the pane the person is looking at, in the current folder or the agent's own,
with its `AGENTS.md` / `CLAUDE.md` attached the harness's own way.

## What Herdr gives a mod

| Command | Where it puts the agent | How the program starts | Measured |
|---|---|---|---|
| `tab.new {argv, folder}` | a new **tab** | in the person's login shell; a shell stays open afterwards | `claude` resolves through nvm; the shell stays |
| `pane.split {argv}` | a split pane | **directly**, with the core's bare PATH; no folder argument | `claude`: `No such file or directory` |
| `terminal.open {argv, folder, place}` | a split pane or tab | **directly**, bare PATH | same; folder works; a new pane takes focus |

Every shipped mod places agents with `tab.new` or `space.new`. None can put a shell-launched agent in a pane.
There is also no command that replaces the program of an existing pane.

## Options

1. **`tab.new`.** Right launcher, wrong place: a new tab, not the current pane.
2. **Raw `terminal.open {argv: ["claude", ...]}`.** Right place, but the agent is not found, and if it is
   found it runs with a stripped environment (nvm, shell profile variables). The pane closes when it exits.
3. **Type the command into the pane's shell** (`hc send`). Needs per-shell quoting, shows a long command
   (Codex's instructions are inline text; 24 KB in the test), depends on the shell being at a prompt, and
   leaves no way to know it worked.
4. **`terminal.open` with the login shell as the program, the agent as its arguments, then close the old pane.**

## Decision: option 4

```
argv = [$SHELL, "-l", "-i", "-c", '"$@"; exec "$0" -l -i', $SHELL, ...harnessCommand, ...instructionFlag]
```

- The script text is constant and the command is `"$@"`, so **nothing is quoted**. A 24,174-byte argument with
  quotes, `$VARS`, backticks, CRLF, DEL, CJK and emoji arrived byte-exact through zsh, both bashes, sh, dash and ksh
  (`scripts/verify-harnesses.mjs` runs this on every verify).
- `-l -i` loads the person's PATH and environment, as Herdr's menu launcher does. `exec "$0" -l -i` leaves a shell
  open after the agent exits, so an error stays on screen.
- The harness command is `knownAgents().run`: Herdr's program table stays the one home for how an agent starts,
  including the person's `programs.json` overrides and `codex --no-daemon`.
- **Order is the invariant.** The new terminal is created first; the old pane is closed only if that succeeded.
  The new pane appears right after the focused one, and closing the focused pane leaves the new one in its exact slot
  (checked on screen and by the pane list). Unit tests fail if the order is swapped or a failed open is swallowed.
- **Only an idle shell with no sub-agents is replaced.** `program.shell`, no status, and no live child terminals.
  Anything else gets the agent beside it. Replacing a running program, or a shell that owns background workers,
  would destroy work.
- **Zoom.** Closing the zoomed pane un-maximizes the tab, so the new pane is zoomed again. Found by a live probe of `panes()`
  and re-checked there once after the fix; a unit test covers it from now on. Splitting beside a zoomed pane un-maximizes, as splits do everywhere in Herdr.

## Instructions per harness

Each harness takes a persistent document its own way. Each mechanism was proven, not assumed:

- Claude Code: `--append-system-prompt-file <path>`: a live model answered from the file. (Superseded by
  [ADR 0002](0002-include-shared-documents.md): Claude keeps only the last repeated file flag, so it now takes
  the documents inline as one `--append-system-prompt=<texts>`.)
- Pi: `--append-system-prompt <path>`: the file text is in the system prompt pi assembles (pi blanks its own argv,
  so the live run is read from the launch argv the core records).
- Codex: `-c developer_instructions=<TOML string>`: `codex debug prompt-input` shows it verbatim as a `developer`
  message, and not at all without the flag. Codex has no additive file option. `model_instructions_file` was
  rejected because it **replaces** Codex's built-in prompt, which the native `AGENTS.md` never does. The text is a JSON
  string, which is valid TOML except DEL; `tomlString` escapes that one character.

A harness without a verified mechanism **refuses** a profile that has a document. Starting it without the
instructions would look like it worked.

## Consequences

- Local spaces only: the document and the folder live on this machine.
- Supported login shells are the ones verified: zsh, bash, sh, dash, ksh. fish uses different syntax and is refused with
  a message until someone verifies a wrapper for it.
- Replacing a shell ends that shell: its history and variables go with it. Hence "idle only".
- The effects go through `herdr-app do`, not `run()`: the mod needs the answer ("created" or "why not") before it
  closes anything, and `run()` returns nothing.
- If Herdr gains a launcher for split panes, or a way to replace a pane's program, steps 4 and 5 shrink to one
  command and the wrapper can go.
