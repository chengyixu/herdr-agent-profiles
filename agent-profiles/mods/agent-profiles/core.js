// Agent profiles: the logic, with no imports from Herdr. It runs inside the app's
// mod runtime and under Node, so the destructive path (replace a pane) is unit tested.
//
// A profile is a folder in ~/.config/herdr-app/agent-profiles/<name>/:
//   profile.json   { "harness": "claude", "cwd": "~/code/app" }   (cwd is optional)
//   AGENTS.md      the persistent instructions (CLAUDE.md works too)

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELDS = ["harness", "cwd"];
const POSIX_SHELLS = ["zsh", "bash", "sh", "dash", "ksh"];

// How each harness takes a persistent instruction document. This table is the one
// home for the flag names; scripts/verify-harnesses.mjs proves it against the real CLIs.
//   path: the harness reads the file itself.
//   text: the document is passed inline (Codex has no additive file flag).
export const ADAPTERS = {
  claude: { path: (file) => ["--append-system-prompt-file", file] },
  pi: { path: (file) => ["--append-system-prompt", file] },
  codex: { text: (text) => ["-c", `developer_instructions=${tomlString(text)}`] },
};

const adapterNames = () => Object.keys(ADAPTERS).sort().join(", ");

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
  return { profile: { name, harness: raw.harness.trim(), cwd } };
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

// A blank document is no document: there is nothing to attach.
const usableDoc = (profile) => (profile.doc && profile.doc.text.trim() ? profile.doc : null);

// Why this profile cannot start (null when it can). The list greys a row out with this
// text, and planLaunch refuses with it, so the two can never disagree.
export function problem(profile, agent) {
  if (profile.error) return profile.error;
  if (!agent) return `unknown harness "${profile.harness}"`;
  if (!agent.installed) return `${profile.harness} is not installed`;
  if (usableDoc(profile) && !ADAPTERS[profile.harness]) {
    return `${profile.harness} cannot take instructions yet (supported: ${adapterNames()})`;
  }
  return null;
}

export function planLaunch({ profile, mode, agent, shell, here, home }) {
  const blocked = problem(profile, agent);
  if (blocked) return { error: blocked };
  if (mode === "own" && !profile.cwd) return { error: `${profile.name} has no "cwd" in profile.json` };

  const doc = usableDoc(profile);
  const adapter = ADAPTERS[profile.harness];
  const attach = doc ? (adapter.path ? adapter.path(doc.path) : adapter.text(doc.text)) : [];

  let argv;
  try {
    argv = shellArgv(shell, [...agent.run, ...attach]);
  } catch (e) {
    return { error: e.message };
  }
  return { argv, folder: mode === "own" ? expandHome(profile.cwd, home) : (here ?? null) };
}

// host: { agent(harness), shell(), home, hasChildren(terminal), dispatch(command, args) }
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
  return { where, pane: created.pane, terminal: created.terminal };
}
