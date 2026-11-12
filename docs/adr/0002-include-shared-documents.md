# 0002. Share a document between profiles with `include`; Claude takes documents inline

Status: accepted. Measured on Claude Code 2.1.316, Pi 1.5.2, Codex 0.166.0.

## The need

Several agents follow the same rules: a person's engineering doctrine, used by a general agent and by
project agents. With one document per profile, those rules were copied into each profile, and copies drift:
an edit reaches one agent and not the others.

## Decision

`profile.json` takes an optional `"include": ["general"]`. The included profiles' documents are attached
first, in the order listed, then the profile's own document.

- **The document only.** An include contributes its document, not its harness or folder. A profile stays
  readable on its own: what starts is its own `harness`, in its own `cwd`.
- **One level.** An included profile may not include others. A profile's text then changes only through
  profiles it names itself. Nesting would make a shared document's effect hard to see, and no profile needs it.
- **Refuse, never drop.** An include that names no profile, a broken profile, one without a document, or one
  that includes others makes the including profile unusable, with the reason shown in the list. Starting an
  agent with part of its instructions missing would look like it worked.
- **The list shows it.** A row reads `Claude Code · general + CLAUDE.md`, so the person sees what goes in.
- `resolveIncludes` in `core.js` (pure) turns the loaded profiles into each one's document list. The adapters
  take that list.

## Claude: one inline value, not repeated files

The first implementation repeated `--append-system-prompt-file` once per document. The live contract check
(two documents, a codeword in each) returned only the second codeword. Claude Code declares the option as
`--append-system-prompt-file <file>` with `argParser(String)`, a single value: **the last one wins**, and the
included document was silently dropped. `--append-system-prompt <prompt>` is declared the same way.

So Claude gets one value, `--append-system-prompt=<texts>`, the documents joined by a blank line, as Codex
already did. The `=` form attaches the value to the flag, so a document that starts with `-` (a markdown
bullet) cannot be read as another flag. The live check uses exactly such a document and gets both codewords.

Pi keeps one `--append-system-prompt <path>` per document: its flag is repeatable, and the check confirms both
documents are in the assembled system prompt, in order.

## Consequences

- One edit to a shared profile's document reaches every profile that includes it at their next start.
- Claude's whole instruction text is now visible in the process list, as Codex's already was. Profile documents
  hold instructions, not secrets.
- A tool that repeats Claude's file flag to attach several documents (OhMyHerdr's multi-document path does) loses
  all but the last. Its profiles currently hold one document each, so nothing is lost today.
