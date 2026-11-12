import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTERS,
  expandHome,
  parseProfile,
  pickDoc,
  placement,
  planLaunch,
  problem,
  resolveIncludes,
  shellArgv,
  startProfile,
  tomlString,
} from "../agent-profiles/mods/agent-profiles/core.js";

const SHELL = "/bin/zsh";
const WRAP = '"$@"; exec "$0" -l -i';
const wrapped = (cmd) => [SHELL, "-l", "-i", "-c", WRAP, SHELL, ...cmd];
const DOC = { path: "/h/agent-profiles/nexora/AGENTS.md", text: "# Role\nBe terse.\n", label: "AGENTS.md" };
const BASE = { path: "/h/agent-profiles/general/AGENTS.md", text: "# Doctrine\n", label: "general" };
const HOME = "/Users/me";
const AGENTS = {
  claude: { key: "claude", run: ["claude"], installed: true },
  pi: { key: "pi", run: ["pi"], installed: true },
  codex: { key: "codex", run: ["codex", "--no-daemon"], installed: true },
  gemini: { key: "gemini", run: ["gemini"], installed: true },
  amp: { key: "amp", run: ["amp"], installed: false },
};
const profile = (o = {}) => ({ name: "nexora", harness: "claude", cwd: null, include: [], docs: [DOC], ...o });
const plan = (o = {}) =>
  planLaunch({
    profile: profile(),
    mode: "here",
    agent: AGENTS.claude,
    shell: SHELL,
    here: "/work/repo",
    home: HOME,
    ...o,
  });

// ---- parseProfile ------------------------------------------------------------

test("parseProfile accepts a harness and an optional cwd", () => {
  assert.deepEqual(parseProfile("nexora", '{"harness":"claude"}'), {
    profile: { name: "nexora", harness: "claude", cwd: null, include: [] },
  });
  assert.deepEqual(parseProfile("ops_2", '{"harness":"pi","cwd":"~/nexora"}'), {
    profile: { name: "ops_2", harness: "pi", cwd: "~/nexora", include: [] },
  });
  assert.deepEqual(parseProfile("klik", '{"harness":"pi","include":["general","base-2"]}').profile.include, ["general", "base-2"]);
  assert.deepEqual(parseProfile("a", '{"harness":"codex","cwd":"/srv/app"}').profile.cwd, "/srv/app");
});

test("parseProfile rejects bad names", () => {
  for (const name of ["Nexora", "1abc", "a b", "x".repeat(33), "", "-a", "a.b"]) {
    assert.match(parseProfile(name, '{"harness":"pi"}').error, /name/, JSON.stringify(name));
  }
});

test("parseProfile rejects bad content with a reason that names the problem", () => {
  assert.match(parseProfile("a", "{nope").error, /profile\.json/);
  for (const text of ["[]", '"x"', "null", "3"]) {
    assert.match(parseProfile("a", text).error, /object/, text);
  }
  assert.match(parseProfile("a", "{}").error, /harness/);
  assert.match(parseProfile("a", '{"harness":"  "}').error, /harness/);
  assert.match(parseProfile("a", '{"harness":7}').error, /harness/);
  assert.match(parseProfile("a", '{"harness":"pi","cwd":5}').error, /cwd/);
  assert.match(parseProfile("a", '{"harness":"pi","cwd":"src"}').error, /cwd/);
  assert.match(parseProfile("a", '{"harness":"pi","cwd":"~bob/x"}').error, /cwd/);
});

test("parseProfile rejects a bad include list", () => {
  for (const [include, why] of [
    ['"general"', /list of profile names/],
    ["[7]", /list of profile names/],
    ['["General"]', /not a profile name/],
    ['["a"]', /cannot include itself/],
    ['["general","general"]', /more than once/],
  ]) {
    assert.match(parseProfile("a", `{"harness":"pi","include":${include}}`).error, why, include);
  }
});

test("parseProfile refuses unknown fields instead of silently ignoring a typo", () => {
  const r = parseProfile("a", '{"harness":"pi","native_cwd":"/x"}');
  assert.match(r.error, /unknown field/);
  assert.match(r.error, /native_cwd/);
});

// ---- resolveIncludes ----------------------------------------------------------

// What main.js loads from disk: a parsed profile with its own document, or { name, error }.
const loaded = (name, o = {}) => ({ name, harness: "pi", cwd: null, include: [], doc: null, ...o });
const broken = (name, error) => ({ name, error });
const own = (name, text = `# ${name}\n`) => ({ path: `/h/agent-profiles/${name}/AGENTS.md`, text });

test("resolveIncludes puts included documents first, labelled with the profile they come from", () => {
  const [general, klik] = resolveIncludes([
    loaded("general", { doc: own("general") }),
    loaded("klik", { include: ["general"], doc: own("klik") }),
  ]);
  assert.deepEqual(general.docs, [{ ...own("general"), label: "AGENTS.md" }]);
  assert.deepEqual(klik.docs, [{ ...own("general"), label: "general" }, { ...own("klik"), label: "AGENTS.md" }]);
});

test("resolveIncludes: a profile may have no document of its own when it includes one", () => {
  const [, panor] = resolveIncludes([loaded("general", { doc: own("general") }), loaded("panor", { include: ["general"] })]);
  assert.deepEqual(panor.docs.map((d) => d.label), ["general"]);
  assert.equal(panor.error, undefined);
});

test("resolveIncludes: a blank document counts as none", () => {
  const [p] = resolveIncludes([loaded("p", { doc: own("p", " \n\t") })]);
  assert.deepEqual(p.docs, []);
});

test("resolveIncludes refuses an include that cannot be honoured, and says why", () => {
  const out = resolveIncludes([
    broken("broken", "profile.json is not valid JSON"),
    loaded("empty"),
    loaded("layered", { include: ["empty"], doc: own("layered") }),
    loaded("a", { include: ["nowhere"] }),
    loaded("b", { include: ["broken"] }),
    loaded("c", { include: ["empty"] }),
    loaded("d", { include: ["layered"] }),
  ]);
  const why = Object.fromEntries(out.map((p) => [p.name, p.error]));
  assert.equal(why.broken, "profile.json is not valid JSON", "a broken profile keeps its own error");
  assert.match(why.a, /includes "nowhere", which is not a profile/);
  assert.match(why.b, /includes "broken", which cannot be used: profile\.json is not valid JSON/);
  assert.match(why.c, /includes "empty", which has no instructions/);
  assert.match(why.d, /includes "layered", which includes others/);
  for (const p of out.filter((p) => p.error)) assert.equal(p.docs, undefined, `${p.name} must not be startable`);
});

// ---- expandHome / pickDoc ----------------------------------------------------

test("expandHome", () => {
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("~/code", HOME), "/Users/me/code");
  assert.equal(expandHome("~/code", "/Users/me/"), "/Users/me/code");
  assert.equal(expandHome("/srv/app", HOME), "/srv/app");
});

test("pickDoc prefers the harness's native file name and falls back to the other", () => {
  const both = ["profile.json", "AGENTS.md", "CLAUDE.md"];
  assert.equal(pickDoc("claude", both), "CLAUDE.md");
  assert.equal(pickDoc("pi", both), "AGENTS.md");
  assert.equal(pickDoc("codex", both), "AGENTS.md");
  assert.equal(pickDoc("claude", ["AGENTS.md"]), "AGENTS.md");
  assert.equal(pickDoc("pi", ["CLAUDE.md"]), "CLAUDE.md");
  assert.equal(pickDoc("pi", ["profile.json", "agents.md", "notes.md"]), null);
  assert.equal(pickDoc("pi", []), null);
});

// ---- tomlString --------------------------------------------------------------

test("tomlString emits a TOML basic string with no raw control characters", () => {
  const nasty = 'quote " back \\ nl\n cr\r\n tab\t del\x7f bell\x07 中文🦉 $HOME `id` \u2028 [t]\nk = "v"';
  const out = tomlString(nasty);
  assert.ok(out.startsWith('"') && out.endsWith('"'));
  assert.equal(/[\x00-\x1f\x7f]/.test(out), false, "raw control character leaked");
  // Every escape used is also valid JSON, so JSON.parse is an independent decoder.
  assert.equal(JSON.parse(out), nasty);
});

// ---- shellArgv ---------------------------------------------------------------

test("shellArgv wraps the command in a login interactive shell that stays open", () => {
  assert.deepEqual(shellArgv("/bin/zsh", ["claude", "-x"]), wrapped(["claude", "-x"]));
  for (const shell of ["/opt/homebrew/bin/bash", "/bin/sh", "/bin/dash", "/bin/ksh"]) {
    assert.deepEqual(shellArgv(shell, ["pi"]), [shell, "-l", "-i", "-c", WRAP, shell, "pi"]);
  }
});

test("shellArgv refuses shells it has not been verified with", () => {
  for (const shell of ["/usr/bin/fish", "/usr/bin/pwsh", "", undefined]) {
    assert.throws(() => shellArgv(shell, ["pi"]), /supported/i, String(shell));
  }
});

// ---- placement ---------------------------------------------------------------

test("placement replaces only an idle shell with nothing under it", () => {
  const idle = { terminal: "t1", status: null, program: { shell: true } };
  assert.equal(placement({ pane: idle, hasChildren: false }), "replace");
  assert.equal(placement({ pane: { ...idle, program: { shell: false } }, hasChildren: false }), "beside");
  assert.equal(placement({ pane: { ...idle, status: "working" }, hasChildren: false }), "beside");
  assert.equal(placement({ pane: { ...idle, terminal: null }, hasChildren: false }), "beside");
  assert.equal(placement({ pane: idle, hasChildren: true }), "beside");
});

// ---- planLaunch --------------------------------------------------------------

test("planLaunch: Claude takes the text inline, attached with = so a leading dash cannot read as a flag", () => {
  assert.deepEqual(plan(), {
    argv: wrapped(["claude", `--append-system-prompt=${DOC.text}`]),
    folder: "/work/repo",
  });
});

test("planLaunch: Pi takes the document as an append-system-prompt path", () => {
  const r = plan({ profile: profile({ harness: "pi" }), agent: AGENTS.pi });
  assert.deepEqual(r.argv, wrapped(["pi", "--append-system-prompt", DOC.path]));
});

test("planLaunch: Codex takes the text as additive developer_instructions", () => {
  const r = plan({ profile: profile({ harness: "codex" }), agent: AGENTS.codex });
  assert.deepEqual(r.argv, wrapped(["codex", "--no-daemon", "-c", 'developer_instructions="# Role\\nBe terse.\\n"']));
});

test("planLaunch attaches every document, included ones first", () => {
  const two = [BASE, DOC];
  assert.deepEqual(
    plan({ profile: profile({ docs: two }) }).argv.slice(6),
    // One value: Claude Code keeps only the last of a repeated --append-system-prompt(-file).
    ["claude", `--append-system-prompt=${BASE.text}\n\n${DOC.text}`],
  );
  assert.deepEqual(
    plan({ profile: profile({ harness: "pi", docs: two }), agent: AGENTS.pi }).argv.slice(6),
    ["pi", "--append-system-prompt", BASE.path, "--append-system-prompt", DOC.path],
  );
  // Codex takes one developer_instructions value: the texts in order, a blank line between.
  const codex = plan({ profile: profile({ harness: "codex", docs: two }), agent: AGENTS.codex }).argv.slice(6);
  assert.deepEqual(codex.slice(0, 3), ["codex", "--no-daemon", "-c"]);
  assert.equal(JSON.parse(codex[3].slice("developer_instructions=".length)), "# Doctrine\n\n\n# Role\nBe terse.\n");
});

test("planLaunch: the harness command is Herdr's own `run`, so programs.json overrides apply", () => {
  const custom = { ...AGENTS.claude, run: ["claude", "--model", "opus"] };
  assert.deepEqual(plan({ agent: custom }).argv.slice(6, 9), ["claude", "--model", "opus"]);
});

test("planLaunch: 'here' uses the pane folder, 'own' uses the profile folder", () => {
  assert.equal(plan({ mode: "here", here: "/work/repo" }).folder, "/work/repo");
  assert.equal(plan({ mode: "own", profile: profile({ cwd: "~/nexora" }) }).folder, "/Users/me/nexora");
  assert.equal(plan({ mode: "own", profile: profile({ cwd: "/srv/app" }) }).folder, "/srv/app");
  assert.equal(plan({ mode: "here", here: null }).folder, null);
});

test("planLaunch: the document is attached in both folder modes", () => {
  const own = plan({ mode: "own", profile: profile({ cwd: "~/nexora" }) });
  const here = plan({ mode: "here" });
  assert.deepEqual(own.argv, here.argv);
});

test("planLaunch: no document launches the bare harness", () => {
  assert.deepEqual(plan({ profile: profile({ docs: [] }) }).argv, wrapped(["claude"]));
});

test("planLaunch: a harness without a verified adapter fails loudly instead of dropping the document", () => {
  const r = plan({ profile: profile({ harness: "gemini" }), agent: AGENTS.gemini });
  assert.match(r.error, /gemini/);
  assert.match(r.error, /claude, codex, pi/);
  // ...but it can still be launched when there is nothing to attach.
  const bare = plan({ profile: profile({ harness: "gemini", docs: [] }), agent: AGENTS.gemini });
  assert.deepEqual(bare.argv, wrapped(["gemini"]));
});

test("planLaunch reports unusable input as an error", () => {
  assert.match(plan({ mode: "own" }).error, /cwd/);
  assert.match(plan({ agent: null }).error, /unknown harness/);
  assert.match(plan({ agent: AGENTS.amp, profile: profile({ harness: "amp", docs: [] }) }).error, /not installed/);
  assert.match(plan({ shell: "/usr/bin/fish" }).error, /supported/i);
});

test("problem is the one rule the list and the launcher share", () => {
  assert.equal(problem(profile(), AGENTS.claude), null);
  assert.equal(problem(profile({ docs: [], harness: "gemini" }), AGENTS.gemini), null);
  assert.equal(problem(profile({ error: "harness is missing" }), null), "harness is missing");
  assert.match(problem(profile(), null), /unknown harness/);
  assert.match(problem(profile({ harness: "amp" }), AGENTS.amp), /not installed/);
  assert.match(problem(profile({ harness: "gemini" }), AGENTS.gemini), /cannot take instructions/);
});

test("the adapter table is exactly the verified set", () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), ["claude", "codex", "pi"]);
});

// ---- startProfile (the destructive path) --------------------------------------

const IDLE = { pane: "pOLD", terminal: "t1", cwd: "/work/repo", status: null, program: { shell: true } };
const BUSY = { ...IDLE, status: "working", program: { shell: false } };

function fakeHost(over = {}) {
  const calls = [];
  return {
    calls,
    agent: async (h) => AGENTS[h] ?? null,
    shell: async () => SHELL,
    home: HOME,
    hasChildren: () => false,
    dispatch: async (name, args) => {
      calls.push([name, args]);
      return name === "terminal.open" ? { pane: "pNEW", terminal: "t9" } : { ok: true };
    },
    ...over,
  };
}
const names = (host) => host.calls.map(([n]) => n);

test("startProfile replaces an idle shell: create first, close second", async () => {
  const host = fakeHost();
  const r = await startProfile(host, { profile: profile(), mode: "here", target: { machine: null, pane: IDLE } });
  assert.deepEqual(names(host), ["pane.focus", "terminal.open", "pane.close"]);
  assert.deepEqual(host.calls[0][1], { pane: "pOLD" });
  assert.deepEqual(host.calls[1][1], {
    argv: wrapped(["claude", `--append-system-prompt=${DOC.text}`]),
    folder: "/work/repo",
    place: "right",
  });
  assert.deepEqual(host.calls[2][1], { pane: "pOLD" });
  assert.deepEqual(r, { where: "replace", pane: "pNEW", terminal: "t9" });
});

test("startProfile keeps a maximized pane maximized when the agent takes its place", async () => {
  const host = fakeHost();
  await startProfile(host, { profile: profile(), mode: "here", target: { machine: null, pane: { ...IDLE, zoomed: true } } });
  assert.deepEqual(names(host), ["pane.focus", "terminal.open", "pane.close", "pane.zoom"]);
  assert.deepEqual(host.calls[3][1], { pane: "pNEW" });

  // Beside is a split, which un-maximizes the way a split does anywhere in Herdr: nothing to restore.
  const beside = fakeHost();
  await startProfile(beside, { profile: profile(), mode: "here", target: { machine: null, pane: { ...BUSY, zoomed: true } } });
  assert.deepEqual(names(beside), ["pane.focus", "terminal.open"]);
});

test("startProfile never closes a pane that is busy, or that has children", async () => {
  for (const [pane, over] of [
    [BUSY, {}],
    [IDLE, { hasChildren: () => true }],
  ]) {
    const host = fakeHost(over);
    const r = await startProfile(host, { profile: profile(), mode: "here", target: { machine: null, pane } });
    assert.deepEqual(names(host), ["pane.focus", "terminal.open"]);
    assert.equal(r.where, "beside");
  }
});

test("startProfile never closes the old pane when the new terminal could not be created", async () => {
  const host = fakeHost({
    dispatch: async (name, args) => {
      host.calls.push([name, args]);
      if (name === "terminal.open") throw new Error("cannot start: no such folder");
      return { ok: true };
    },
  });
  await assert.rejects(
    startProfile(host, { profile: profile(), mode: "here", target: { machine: null, pane: IDLE } }),
    /no such folder/,
  );
  assert.deepEqual(names(host), ["pane.focus", "terminal.open"]);
});

test("startProfile says the agent is running when only the old shell could not be closed", async () => {
  const host = fakeHost({
    dispatch: async (name, args) => {
      host.calls.push([name, args]);
      if (name === "pane.close") throw new Error("no such pane");
      return name === "terminal.open" ? { pane: "pNEW", terminal: "t9" } : { ok: true };
    },
  });
  await assert.rejects(
    startProfile(host, { profile: profile(), mode: "here", target: { machine: null, pane: IDLE } }),
    /agent started.*no such pane/is,
  );
});

test("startProfile omits the folder when the pane's folder is unknown", async () => {
  const host = fakeHost();
  await startProfile(host, {
    profile: profile(),
    mode: "here",
    target: { machine: null, pane: { ...BUSY, cwd: null } },
  });
  assert.equal("folder" in host.calls[1][1], false);
});

test("startProfile refuses before touching anything", async () => {
  const refuse = async (req, pattern, over) => {
    const host = fakeHost(over);
    await assert.rejects(startProfile(host, req), pattern);
    assert.equal(host.calls.length, 0, "dispatched despite refusing");
  };
  await refuse({ profile: profile(), mode: "here", target: { machine: "owlspace", pane: IDLE } }, /remote/i);
  await refuse({ profile: profile(), mode: "here", target: { machine: null, pane: null } }, /pane/i);
  await refuse(
    { profile: profile({ error: "harness is missing" }), mode: "here", target: { machine: null, pane: IDLE } },
    /harness is missing/,
  );
  await refuse(
    { profile: profile({ harness: "amp", docs: [] }), mode: "here", target: { machine: null, pane: IDLE } },
    /not installed/,
  );
  await refuse(
    { profile: profile({ harness: "nope", docs: [] }), mode: "here", target: { machine: null, pane: IDLE } },
    /unknown harness/,
  );
  await refuse({ profile: profile(), mode: "own", target: { machine: null, pane: IDLE } }, /cwd/);
});
