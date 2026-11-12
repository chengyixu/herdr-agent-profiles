# 0003. Profiles in the sidebar: the same mod as a separate block, in a copy of the layout

Status: accepted. Herdr 0.1.15.

## The need

The person expected the profiles where agents are, under the Agents list at the bottom left, not only behind a key.

## Options

1. **Edit Herdr's `agents` panel.** Not possible to keep: shipped mods are read-only. An edit is moved aside to
   `agents-edited` at the next start and Herdr's version restored. A shipped layout also cannot swap one panel for another.
2. **Copy the `agents` panel and add the profiles inside it.** One panel, but the copy is frozen: it no longer gets
   Herdr's fixes and features for the Agents list.
3. **A separate block under the Agents list**, in a copy of the layout. The Agents list stays Herdr's and keeps updating.

## Decision: 3

- **Same mod, second view.** A block's `props: { "view": "sidebar" }` selects `sidebar.js`; without it, the popup. The
  choice is made per copy in `init`, because module scope is shared between copies. Loading and launching live in
  `host.js` and `core.js`, shared by both views (`rowsFor` decides, for both, what can start and why not).
- **Target at click time.** The popup reads its pane once, when it opens. The block lives as long as the layout, so it
  reads `focused()` when clicked, and falls back to the last pane it saw if the click took focus off the panes.
- **Follows the folder.** `watchFolder` on the profile folder; when that fails (no folder yet) it waits 10 seconds
  with `cx.timer.after` before watching again, never a tight loop.
- **Never takes the keyboard.** No text field, no focus handle: clicking a profile must not leave the terminal unable to type.
- **Looks like the Agents list:** its header, row height, rounding and colors, and the narrow-rail form (icons only).

## Consequences

- The person's layout copy does not get Herdr's future changes to `main`. Re-cloning and adding the block again picks them up.
- The block is not part of the shared bundle (a mod bundle has no `layouts/`); the README and RECIPE give the block to add.
