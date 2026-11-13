# 0004. Profile options in a right-click menu that writes profile.json

Status: accepted. Herdr 0.1.15.

## The need

A click starts a profile. Changing one (its harness, folder or attached instructions) meant editing files by hand,
and the person did not know where.

## Decision

Right-click (also Option-click and Control-click) on a sidebar row opens a menu. A plain click still starts.

- **The menu edits the files, nothing else.** Profiles stay plain files (`profile.json` and a document); the
  menu is a way to change them, so an editor, an agent and the menu all change the same thing.
- **Only valid writes.** `editProfile` in `core.js` builds the new text and checks it with `parseProfile`, the
  same rule the loader uses. A file that does not load is never overwritten; the menu offers to open it instead.
  `writeTextFile` writes only if the file still has the text just read, so an edit made meanwhile is not lost.
- **Rows are data.** `menuItems` turns the profile into rows; the menu draws them, and the sidebar sizes the popup
  from the same rows before opening it. The rows do not change in number when a setting changes (start rows are
  dimmed rather than removed), so the popup keeps its size while the person works in it.
- **Short harness list.** Only harnesses that can take instructions (now `HARNESSES`, ADR 0005) are offered, plus the current
  one. Every installed agent made the menu taller than the window on a machine with 15 of them.
- **Attachments follow `include`'s rules.** `includeChoices` offers only profiles with a document of their own and
  no includes, and offers nothing to a profile others include, saying who does.
- **Instructions open in the person's editor.** Herdr's Files viewer is read-only; `open -t` (`xdg-open` off
  macOS) uses the editor they already have. A missing document is created empty first, named for the harness.

## Consequences

- The mod now writes, but only under `agent-profiles/`, and only when the person picks a row.
- `profile.json` files the menu writes are formatted one way (two-space JSON).
