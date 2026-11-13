// Agent profiles: the logic, with no imports from Herdr. It runs inside the app's
// mod runtime and under Node, so the destructive path (replace a pane) is unit tested.
//
// A profile is a folder in ~/.config/herdr-app/agent-profiles/<name>/:
//   profile.json   { "harness": "claude", "cwd": "~/code/app", "include": ["general"] }
//                  (cwd and include are optional)
//   AGENTS.md      the persistent instructions (CLAUDE.md works too)
// `include` attaches other profiles' documents first, so a shared document has one home.

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// The terminal label that names the profile a terminal was started from. A pane header reads it
// to show "klik-agent" instead of the harness name.
export const PROFILE_LABEL = "agent-profile";
const FIELDS = ["harness", "cwd", "include", "bypass"];
const POSIX_SHELLS = ["zsh", "bash", "sh", "dash", "ksh"];

// Everything harness-specific, keyed by Herdr's program key (knownAgents().key). This table is the
// one home for these flags; scripts/verify-harnesses.mjs checks them against the real CLIs.
//
// instructions(docs) -> { env?, args }: how the profile's documents ({ path, text }, in order) reach
//   the harness. Claude Code keeps only the LAST of a repeated --append-system-prompt(-file), and
//   Codex has no additive file option, so those get one inline value; "=" keeps a document that
//   starts with "-" from reading as a flag. OpenCode adds config `instructions` through its
//   OPENCODE_CONFIG_CONTENT override, which it merges after the project's own list.
// bypass: the flags that run the harness without asking for permission. Each is the harness's own
//   "skip all approvals" switch, read from its --help. Pi never asks before tool calls; its only
//   prompt is trusting a folder's project files, which --approve answers.
// A harness missing from the table, or without one of the two, refuses a profile that asks for it.
const joined = (docs) => docs.map((d) => d.text).join("\n\n");
export const HARNESSES = {
  claude: {
    instructions: (docs) => ({ args: [`--append-system-prompt=${joined(docs)}`] }),
    bypass: ["--dangerously-skip-permissions"],
  },
  codex: {
    instructions: (docs) => ({ args: ["-c", `developer_instructions=${tomlString(joined(docs))}`] }),
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  pi: {
    instructions: (docs) => ({ args: docs.flatMap((d) => ["--append-system-prompt", d.path]) }),
    bypass: ["--approve"],
  },
  grok: {
    instructions: (docs) => ({ args: [`--rules=${joined(docs)}`] }),
    bypass: ["--always-approve"],
  },
  opencode: {
    instructions: (docs) => ({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: docs.map((d) => d.path) }) }, args: [] }),
    bypass: ["--auto"],
  },
  antigravity: { bypass: ["--dangerously-skip-permissions"] },
  copilot: { bypass: ["--allow-all"] },
  crush: { bypass: ["--yolo"] },
  cursor: { bypass: ["--force", "--sandbox", "disabled"] },
  gemini: { bypass: ["--yolo"] },
  hermes: { bypass: ["--yolo"] },
  // Kimi's --yolo still asks before risky actions; --auto never asks.
  kimi: { bypass: ["--auto"] },
  qoder: { bypass: ["--dangerously-skip-permissions"] },
};

const namesWith = (key) => Object.keys(HARNESSES).filter((k) => HARNESSES[k][key]).sort().join(", ");

export function parseProfile(name, jsonText) {
  if (!NAME_RE.test(name)) {
    return { error: `name "${name}" must be 1-32 characters: a-z, 0-9, - or _, starting with a letter` };
  }
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { error: "profile.json is not valid JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "profile.json must be an object" };
  }
  const unknown = Object.keys(raw).filter((k) => !FIELDS.includes(k));
  if (unknown.length) return { error: `unknown field ${unknown.map((k) => `"${k}"`).join(", ")}` };
  if (typeof raw.harness !== "string" || !raw.harness.trim()) {
    return { error: '"harness" is missing (for example "claude", "codex" or "pi")' };
  }
  let cwd = null;
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || !(raw.cwd === "~" || raw.cwd.startsWith("~/") || raw.cwd.startsWith("/"))) {
      return { error: '"cwd" must be an absolute path or start with ~/' };
    }
    cwd = raw.cwd;
  }
  const include = raw.include ?? [];
  if (!Array.isArray(include) || include.some((n) => typeof n !== "string")) {
    return { error: '"include" must be a list of profile names, for example ["general"]' };
  }
  const bad = include.find((n) => !NAME_RE.test(n));
  if (bad !== undefined) return { error: `"include": "${bad}" is not a profile name` };
  if (include.includes(name)) return { error: `"include": a profile cannot include itself` };
  if (new Set(include).size !== include.length) return { error: '"include" names a profile more than once' };
  if (raw.bypass !== undefined && typeof raw.bypass !== "boolean") return { error: '"bypass" must be true or false' };
  return { profile: { name, harness: raw.harness.trim(), cwd, include, bypass: raw.bypass ?? false } };
}

// A blank document is no document: there is nothing to attach.
const usable = (doc) => Boolean(doc && doc.text.trim());

// Loaded profiles ({ ..., include, doc } or { name, error }) -> each with `docs`, the documents
// to attach in order: included profiles' first (labelled with the profile's name), then its own
// (labelled with its file name). One level: an included profile may not include others, so a
// profile's text never changes because of a profile it does not name.
export function resolveIncludes(profiles) {
  const byName = new Map(profiles.map((p) => [p.name, p]));
  return profiles.map((p) => {
    if (p.error) return p;
    const docs = [];
    for (const name of p.include) {
      const target = byName.get(name);
      const why = !target
        ? "which is not a profile"
        : target.error
          ? `which cannot be used: ${target.error}`
          : target.include.length
            ? "which includes others (only one level is allowed)"
            : !usable(target.doc)
              ? "which has no instructions"
              : null;
      if (why) return { name: p.name, error: `includes "${name}", ${why}` };
      docs.push({ ...target.doc, label: name });
    }
    if (usable(p.doc)) docs.push({ ...p.doc, label: p.doc.path.split("/").pop() });
    const { doc: _own, ...rest } = p;
    return { ...rest, docs };
  });
}

// ---- Editing a profile (the options menu) -------------------------------------------

const CHANGES = ["harness", "cwd", "include", "bypass"];

// The new profile.json text after a change ({ harness?, cwd? (null clears), include? }), or
// { error }. A file that does not load is never overwritten, and a change that would leave it
// unloadable is refused, so the menu can only ever write a valid profile.
export function editProfile(name, jsonText, change) {
  const unknown = Object.keys(change).filter((k) => !CHANGES.includes(k));
  if (unknown.length) return { error: `unknown change ${unknown.join(", ")}` };
  const current = parseProfile(name, jsonText);
  if (current.error) return { error: current.error };
  const next = { ...current.profile, ...change };
  const out = { harness: typeof next.harness === "string" ? next.harness.trim() : next.harness };
  if (next.cwd != null) out.cwd = next.cwd;
  if (next.include?.length) out.include = next.include;
  if (next.bypass) out.bypass = next.bypass;
  const text = `${JSON.stringify(out, null, 2)}\n`;
  const check = parseProfile(name, text);
  return check.error ? { error: check.error } : { text };
}

// An absolute folder as profile.json stores it: under the home folder, with ~.
export function homeRelative(path, home) {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const h = home.replace(/\/+$/, "");
  if (p === h) return "~";
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

// The file a new document gets: the harness's own name.
export const newDocName = (harness) => (harness === "claude" ? "CLAUDE.md" : "AGENTS.md");

// Which profiles `name` may include (loaded and resolved profiles): one level deep, so only
// profiles with a document of their own that include nothing. A profile others include may not
// include anything itself (usedBy says who), or those others would break.
export function includeChoices(profiles, name) {
  const usedBy = profiles.filter((p) => !p.error && p.include.includes(name)).map((p) => p.name).sort();
  if (usedBy.length) return { choices: [], usedBy };
  const choices = profiles
    .filter((p) => p.name !== name && !p.error && p.include.length === 0 && p.docs.length > 0)
    .map((p) => p.name)
    .sort();
  return { choices, usedBy };
}

export function expandHome(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  return path;
}

// The harness's own file name wins; the other one is accepted so a profile survives a
// harness switch.
export function pickDoc(harness, files) {
  const order = harness === "claude" ? ["CLAUDE.md", "AGENTS.md"] : ["AGENTS.md", "CLAUDE.md"];
  return order.find((n) => files.includes(n)) ?? null;
}

// A TOML basic string. JSON's escapes are a subset of TOML's; DEL is the one control
// character JSON leaves raw that TOML requires escaped.
export function tomlString(text) {
  return JSON.stringify(text).replace(/\x7f/g, "\\u007f");
}

// Herdr's own launcher runs an agent in the person's login shell and leaves a shell open
// afterwards. `pane.split`/`terminal.open` exec their argv directly with a bare PATH, so
// the same shape is built here. The command travels as argv: nothing is ever quoted.
export function shellArgv(shell, cmd) {
  const kind = String(shell ?? "").split("/").pop();
  if (!POSIX_SHELLS.includes(kind)) {
    throw new Error(`login shell "${shell ?? ""}" is not supported yet (supported: ${POSIX_SHELLS.join(", ")})`);
  }
  return [shell, "-l", "-i", "-c", '"$@"; exec "$0" -l -i', shell, ...cmd];
}

// An idle shell has nothing to lose, so the agent takes its place. Anything else (a
// running program, an agent, a mod, a shell that owns sub-agents) is left alone.
export function placement({ pane, hasChildren }) {
  const idleShell = Boolean(pane.terminal) && pane.status == null && pane.program?.shell === true;
  return idleShell && !hasChildren ? "replace" : "beside";
}

// Why this profile cannot start (null when it can). The list greys a row out with this
// text, and planLaunch refuses with it, so the two can never disagree.
export function problem(profile, agent) {
  if (profile.error) return profile.error;
  if (!agent) return `unknown harness "${profile.harness}"`;
  if (!agent.installed) return `${profile.harness} is not installed`;
  if (profile.docs.length && !HARNESSES[profile.harness]?.instructions) {
    return `${profile.harness} cannot take instructions yet (supported: ${namesWith("instructions")})`;
  }
  if (profile.bypass && !HARNESSES[profile.harness]?.bypass) {
    return `${profile.harness} has no bypass mode yet (supported: ${namesWith("bypass")})`;
  }
  return null;
}

// What a list shows: each profile with its agent and why it cannot start (null: it can). Until
// Herdr has said which agents exist (agents null), only the profile's own problems count.
// The one line every view shows for a profile: harness, documents, and bypass when it is on.
export function summary(p, agent) {
  const docs = p.docs?.length ? p.docs.map((d) => d.label).join(" + ") : "no instructions";
  return [agent?.name ?? p.harness, docs, ...(p.bypass ? ["bypass"] : [])].join(" · ");
}

export function rowsFor(profiles, agents) {
  return profiles.map((p) => {
    const agent = agents?.find((a) => a.key === p.harness) ?? null;
    return { p, agent, why: agents ? problem(p, agent) : (p.error ?? null) };
  });
}

export function planLaunch({ profile, mode, agent, shell, here, home }) {
  const blocked = problem(profile, agent);
  if (blocked) return { error: blocked };
  if (mode === "own" && !profile.cwd) return { error: `${profile.name} has no "cwd" in profile.json` };

  const h = HARNESSES[profile.harness];
  const inst = profile.docs.length ? h.instructions(profile.docs) : { args: [] };
  const env = Object.entries(inst.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const cmd = [...(env.length ? ["env", ...env] : []), ...agent.run, ...(profile.bypass ? h.bypass : []), ...inst.args];

  let argv;
  try {
    argv = shellArgv(shell, cmd);
  } catch (e) {
    return { error: e.message };
  }
  return { argv, folder: mode === "own" ? expandHome(profile.cwd, home) : (here ?? null) };
}

// host: { agent(harness), shell(), home, hasChildren(terminal), dispatch(command, args), label(terminal, key, value) }
// target: { machine, pane }  (pane: { pane, terminal, cwd, status, program })
// Order matters: the new terminal must exist before the old pane is closed, and a
// failure to create it must leave the old pane untouched.
export async function startProfile(host, { profile, mode, target }) {
  if (target.machine) throw new Error(`remote spaces are not supported yet (this one is on ${target.machine})`);
  if (!target.pane) throw new Error("focus a pane first");

  const planned = planLaunch({
    profile,
    mode,
    agent: await host.agent(profile.harness),
    shell: await host.shell(),
    here: target.pane.cwd,
    home: host.home,
  });
  if (planned.error) throw new Error(planned.error);

  const where = placement({ pane: target.pane, hasChildren: host.hasChildren(target.pane.terminal) });
  await host.dispatch("pane.focus", { pane: target.pane.pane });
  const open = { argv: planned.argv, place: "right" };
  if (planned.folder) open.folder = planned.folder;
  const created = await host.dispatch("terminal.open", open);
  if (where === "replace") {
    try {
      await host.dispatch("pane.close", { pane: target.pane.pane });
      // Closing the zoomed pane un-maximizes the tab; the agent now holds its place, so it takes the zoom too.
      if (target.pane.zoomed) await host.dispatch("pane.zoom", { pane: created.pane });
    } catch (e) {
      throw new Error(`agent started, but the old shell pane could not be replaced cleanly: ${e.message}`);
    }
  }
  // Last: the agent is in place either way, so a failure here only costs the name in its header.
  try {
    await host.label(created.terminal, PROFILE_LABEL, profile.name);
  } catch (e) {
    throw new Error(`agent started, but its name could not be set: ${e.message}`);
  }
  return { where, pane: created.pane, terminal: created.terminal };
}
