#!/usr/bin/env node
// End to end against the RUNNING Herdr app and the real harnesses on this machine.
// It drives core.js's startProfile with a host that talks to `herdr-app do` and `hc`
// (the same commands main.js issues), then reads back what actually happened:
//   - the pane layout (the agent takes the idle shell's slot; a busy pane is left alone),
//   - the argv the core recorded for the terminal (what Herdr really launched), and
//   - that the agent is the foreground process, in the requested folder.
// Whether each harness HONOURS its flag is scripts/verify-harnesses.mjs's job; some (pi)
// blank their own argv, so the launch argv is the reliable thing to read here.
//
// It makes a throwaway space called "ap-e2e" and removes it afterwards (also on failure).
// Opt-in: it is not part of scripts/verify-source.sh because it touches the live window.
//
//   node scripts/e2e-live.mjs [claude pi codex]

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startProfile } from "../agent-profiles/mods/agent-profiles/core.js";

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60000 });
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};
const herdr = (command, args = {}) => {
  const r = run("herdr-app", ["do", command, JSON.stringify(args)]);
  const out = json(r);
  if (r.status !== 0 || !out || out.error) throw new Error(out?.error ?? (r.stderr.trim() || `herdr-app exited ${r.status}`));
  return out;
};
const ls = () => json(run("herdr-app", ["ls"]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => run("sh", ["-c", `command -v ${bin}`]).status === 0;
const info = (t) => json(run("hc", ["get", t, "--json"]));

// What `knownAgents()` returns on a stock install (programs.json can override `run`).
const KNOWN = {
  claude: { key: "claude", run: ["claude"], installed: true },
  pi: { key: "pi", run: ["pi"], installed: true },
  codex: { key: "codex", run: ["codex", "--no-daemon"], installed: true },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(KNOWN);

const work = realpathSync(mkdtempSync(join(tmpdir(), "ap-e2e-")));
const profileDir = join(work, "profile");
const cwd = join(work, "cwd");
mkdirSync(profileDir);
mkdirSync(cwd);
const TEXT = '# E2E\nYou are "E2E" — it\'s a test. $HOME `id`\n中文 🦉\n';

const host = {
  home: homedir(),
  agent: async (h) => KNOWN[h] ?? null,
  shell: async () => process.env.SHELL,
  hasChildren: (terminal) => (json(run("hc", ["ls", "--json"]))?.terminals ?? []).some((t) => t.parent === terminal && t.state === "live"),
  dispatch: async (command, args) => herdr(command, args),
};

const originalSpace = json(run("herdr-app", ["status"])).space;
let space = null;
const failures = [];
const ok = (cond, label) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
};
const kill = (terminal) => {
  try {
    herdr("terminal.kill", { terminal });
  } catch {
    // already gone
  }
};
async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(400);
  }
  return null;
}
const terminalsOf = (tabId) => ls().spaces.flatMap((s) => s.tabs).find((t) => t.id === tabId)?.terminals ?? [];

async function freshShellPane(name) {
  const made = herdr("tab.new", { name, space, folder: cwd });
  const found = await waitFor(() => terminalsOf(made.tab).find((t) => t.terminal === made.terminal));
  return { tab: made.tab, pane: { pane: found.pane, terminal: made.terminal, cwd, status: null, program: { shell: true } } };
}

// The attach arguments each harness must have been launched with (literal on purpose:
// this must not be derived from the table under test).
function attached(harness, argv, doc) {
  const i = (flag) => argv.indexOf(flag);
  if (harness === "claude") return i("--append-system-prompt-file") >= 0 && argv[i("--append-system-prompt-file") + 1] === doc.path;
  if (harness === "pi") return i("--append-system-prompt") >= 0 && argv[i("--append-system-prompt") + 1] === doc.path;
  const arg = argv.find((a) => a.startsWith("developer_instructions="));
  return argv[i("-c")] === "-c" && arg !== undefined && JSON.parse(arg.slice("developer_instructions=".length)) === doc.text;
}

try {
  space = herdr("space.new", { name: "ap-e2e", folder: cwd }).space;

  for (const harness of wanted) {
    if (!has(harness)) {
      console.log(`- ${harness}: not installed, skipped`);
      continue;
    }
    const doc = { path: join(profileDir, harness === "claude" ? "CLAUDE.md" : "AGENTS.md"), text: TEXT };
    writeFileSync(doc.path, TEXT);
    const profile = { name: `e2e-${harness}`, harness, cwd, doc };

    // 1. an idle shell is replaced in place by the agent
    const { tab, pane } = await freshShellPane(`replace-${harness}`);
    const started = await startProfile(host, { profile, mode: "here", target: { machine: null, pane } });
    const now = terminalsOf(tab).map((t) => t.terminal);
    ok(started.where === "replace", `${harness}: an idle shell is replaced`);
    ok(now.length === 1 && now[0] === started.terminal, `${harness}: the tab has one pane, and it is the new terminal`);

    // 2. Herdr launched the agent with the instructions, in the folder asked for
    const launched = info(started.terminal);
    ok(Boolean(launched) && attached(harness, launched.argv, doc), `${harness}: launched with the instruction document attached`);
    const fg = await waitFor(() => {
      const f = info(started.terminal)?.foreground;
      return f && f.name !== "zsh" && f.name !== "bash" ? f : null;
    });
    ok(Boolean(fg), `${harness}: the agent is the foreground process (it started and stayed up)`);
    ok(fg?.cwd === cwd, `${harness}: it runs in the requested folder`);

    // 3. the folder mode does not change what is attached
    if (harness === "pi") {
      const second = await freshShellPane("own-folder");
      const own = await startProfile(host, { profile: { ...profile, cwd: work }, mode: "own", target: { machine: null, pane: second.pane } });
      ok(attached(harness, info(own.terminal).argv, doc), "pi: the document is attached in the profile's own folder too");
      ok(info(own.terminal).cwd === work, "pi: ...and it started there");
      kill(own.terminal);
    }

    // 4. a pane that is busy is never closed: the agent opens beside it
    if (harness === "claude") {
      const busy = { pane: terminalsOf(tab)[0].pane, terminal: started.terminal, cwd, status: "working", program: { shell: false } };
      const beside = await startProfile(host, { profile, mode: "here", target: { machine: null, pane: busy } });
      ok(beside.where === "beside", "claude: a busy pane is left alone");
      ok(terminalsOf(tab).length === 2, "claude: the tab now has both the old agent and the new one");
      kill(beside.terminal);
    }
    kill(started.terminal);
    await sleep(300);
  }

  // 5. a start that cannot be created leaves the old pane alone
  const { tab, pane } = await freshShellPane("failure");
  const bad = { name: "e2e-bad", harness: "pi", cwd: "/definitely/not/a/folder", doc: null };
  let error = null;
  try {
    await startProfile(host, { profile: bad, mode: "own", target: { machine: null, pane } });
  } catch (e) {
    error = e;
  }
  ok(Boolean(error), "a folder that does not exist is refused");
  ok(terminalsOf(tab).some((t) => t.terminal === pane.terminal), "the old shell survives a failed start");
} catch (e) {
  failures.push(`unexpected: ${e.stack ?? e}`);
  console.error(e);
} finally {
  if (space) {
    try {
      herdr("space.close", { id: space, confirmed: true });
    } catch (e) {
      console.error(`could not close the throwaway space ${space}: ${e.message}`);
    }
  }
  try {
    herdr("space.select", { id: originalSpace });
  } catch {
    // the original space is gone: nothing to restore
  }
  rmSync(work, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall live checks passed");
process.exit(failures.length ? 1 : 0);
