// The wiring of Herdr's APIs into core.js's `host`, shared by the popup and the sidebar block.
// Every function here makes host calls, so they run inside a view, never at module scope.
import * as fs from "fs/promises";
import { appHome, exec, focused, home, knownAgents, panes, spaces, terminals } from "herdr";
import { parseProfile, pickDoc, resolveIncludes } from "./core.js";

export const profilesDir = () => `${appHome()}/agent-profiles`;
export const tilde = (path) => (path && path.startsWith(home()) ? `~${path.slice(home().length)}` : (path ?? ""));

// One entry per folder: a profile with the documents it attaches, or { name, error } to show why not.
export async function loadProfiles() {
  let entries;
  try {
    entries = await fs.readdir(profilesDir(), { withFileTypes: true });
  } catch {
    return []; // no folder yet: the empty state explains how to make one
  }
  const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  return resolveIncludes(await Promise.all(names.map(loadProfile)));
}

async function loadProfile(name) {
  const dir = `${profilesDir()}/${name}`;
  try {
    const files = await fs.readdir(dir);
    if (!files.includes("profile.json")) return { name, error: "profile.json is missing" };
    const parsed = parseProfile(name, await fs.readFile(`${dir}/profile.json`, "utf8"));
    if (parsed.error) return { name, error: parsed.error };
    const file = pickDoc(parsed.profile.harness, files);
    const doc = file ? { path: `${dir}/${file}`, text: await fs.readFile(`${dir}/${file}`, "utf8") } : null;
    return { ...parsed.profile, doc };
  } catch (e) {
    return { name, error: `could not read the profile: ${e.message ?? e}` };
  }
}

// `herdr-app do` is the app's own command line: unlike run(), it answers with what it made
// or why it could not, and core needs that answer before it closes anything.
async function dispatch(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // not JSON: reported below with stderr
  }
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error ?? (r.stderr.trim() || `herdr-app exited ${r.code}`));
  return out;
}

// Built per view, in init: Herdr shares module scope between copies, so no host call may run there.
export const makeHost = () => ({
  home: home(),
  agent: async (harness) => (await knownAgents()).find((a) => a.key === harness) ?? null,
  shell: async () => {
    const shell = (await exec("sh", ["-c", 'printf %s "$SHELL"'])).stdout.trim();
    if (!shell) throw new Error("could not read your login shell ($SHELL is empty)");
    return shell;
  },
  hasChildren: (terminal) => terminals().some((t) => t.parent === terminal && t.state === "live"),
  dispatch,
});

// Where a start lands: a pane (default: the focused one) and the machine of its space.
export function currentTarget(paneId = focused()?.pane) {
  const space = spaces().find((s) => s.id === focused()?.space);
  const pane = paneId ? (panes().find((p) => p.pane === paneId) ?? null) : null;
  return { machine: space?.machine ?? null, pane };
}
