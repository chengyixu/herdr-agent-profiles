# Context

The why, the environment, and what was and was not verified. How it works is in the [README](README.md); why
it is built this way is in [docs/adr/0001](docs/adr/0001-spawn-into-the-current-pane.md).

## Environment this was built and checked on

| | |
|---|---|
| Herdr app / core | 0.1.15 / `hc` 0.1.20 |
| Harnesses | Claude Code 2.1.316, Codex 0.166.0, Pi 1.5.2 |
| OS, Node | macOS arm64 (Darwin 27.3), Node 24.11 (for `node:test`; the mod itself needs no Node) |
| Other platforms | Not checked. The wrapper is POSIX-shell only, so Windows is out. Linux is expected to work and is unverified. |

## Where things live (one home each)

| Fact | Home |
|---|---|
| How to start an agent | Herdr's program table (`knownAgents().run`, `programs.json`) |
| A profile | `~/.config/herdr-app/agent-profiles/<name>/` (`$HERDR_APP_HOME` respected through `appHome()`) |
| Which flag attaches a document to which harness | `ADAPTERS` in `core.js`, proven by `scripts/verify-harnesses.mjs` |
| Which documents a profile attaches, in order | `resolveIncludes()` in `core.js` (`include` in `profile.json`) |
| Rules shared by several profiles | one profile's document, included by the others |
| Whether a profile can start, and why not | `problem()` in `core.js`: the list greys a row out with it, the launcher refuses with it |
| Replace or beside | `placement()` in `core.js`, used by both the dialog's hint and the start |

The mod owns no state: no files written, nothing in `shared`. Profiles are read when the dialog opens and again
only because the document text is read at that moment.

## Verify

```sh
bash scripts/verify-source.sh        # offline: tests, guards, contract checks, `herdr-app check`
bash scripts/verify-source.sh --live # plus one tiny Claude call that proves the appended file is read
node scripts/e2e-live.mjs            # needs a running Herdr; makes and removes a throwaway space
```

What each layer is for:

- `test/core.test.js`: the rules and the destructive ordering, with an injected host.
- `test/main.test.js`: the UI glue under Node. Herdr's three modules are stubbed; the real filesystem, `core.js`
  and `main.js` run.
- `scripts/verify-harnesses.mjs`: the other side of each boundary: the wrapper through six shells, and each
  harness's flag against the real CLI, each with a "not present without the flag" control.
- `scripts/project-guards.sh`: layering, Herdr's mod rules, generated files, privacy, bundle shape.
- `scripts/e2e-live.mjs`: replace, beside and a failed start in a running Herdr, with real harnesses.

## Bugs found while building, and what now catches each

| What went wrong | Caught by now |
|---|---|
| A split pane's program is exec'd with a bare PATH: `claude` not found | the login-shell wrapper; `verify-harnesses` (every shell) and `e2e-live` (claude resolves) |
| A contract check passed for the wrong reason: the document sat in the harness's cwd, so Codex read it natively | the document lives in a profile folder, never the cwd; every check has a no-flag control |
| Replacing a **zoomed** pane silently un-maximized the tab | unit test; found by a live probe of `panes()` |
| `main.js` called `home()` at module scope, which Herdr forbids (module scope is shared between copies) | glue test (it failed to import); `project-guards` rule |
| `herdr-app check` writes `gpui-kit.d.ts` and `jsconfig.json` next to the mod: they were about to be committed | `.gitignore`; a guard; `verify-source` checks a throwaway copy |
| Pi blanks its own argv, so a live "flag present" check failed on a working launch | `e2e-live` reads the argv the core recorded; pi's behaviour is a `verify-harnesses` check |
| A pi prompt-size observable was flaky | dropped, not tuned |
| A first "RED" was only a CLI usage error (`node --test test/`) | the script uses an explicit glob; the RED was redone against the missing module |
| A harness without an adapter would start without its instructions and look fine | `problem()` refuses it; tested in the list and in the launcher |
| A sidebar test passed for the wrong reason: it redrew after moving focus, so a block that remembered only the last pane it drew also passed | the test clicks a row drawn before the focus moved; mutation-checked |
| The options menu listed every installed agent: on this Mac 15, so the menu ran off the window (seen on screen) | it offers only the harnesses that can take instructions, plus the current one; tested |
| A mutation check found two weak tests: a cancelled folder picker and a click on a broken row could have shown an error toast unnoticed | both tests now also require no toast |
| Claude Code keeps only the **last** of a repeated `--append-system-prompt-file`: an included document was silently dropped (ADR 0002) | the live contract check asks for a codeword from each of two documents; Claude now takes one inline value |

Every unit and glue test was also mutation-checked: the dangerous mutations (close before create, ignore sub-agent
children, swallow a failed open, drop DEL escaping, skip the adapter check, ignore Shift+Enter, remove the
double-start guard, close the dialog before the work ends, and others) each turn a test red.

## Not done, on purpose

- **`.sectormap.json` / OwlSpace Map.** The engine is not in this environment, so a profile could not be validated
  against it, and an unvalidated one would claim more than was checked. Add it where the engine runs.
- **Remote spaces, fish, Windows.** See the ADR's consequences.
- **A profile editor.** Profiles are files; Herdr is a file interface. An agent or an editor creates them.
- **A bug-catalog file.** The table above is the catalog for a repo this size.

## The preview image

`agent-profiles/preview.png` must be a real screenshot of the dialog, with nothing private in it. Make it with
`herdr-app shot` while the window is visible (a covered or occluded window returns a stale frame), crop it to the
dialog, and use the demo profiles from `examples/profiles/`.
