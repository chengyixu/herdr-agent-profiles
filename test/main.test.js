// main.js under Node: Herdr's three modules are stubbed (test/stub-loader.mjs); the real
// filesystem, core.js and main.js run. This covers the glue the unit tests cannot see:
// loading profiles from disk, what each row says, and what a click or Enter really does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./stub-loader.mjs", import.meta.url);
const { find, textOf } = await import("./stubs/gpui-kit.mjs");
const { default: AgentProfiles } = await import("../agent-profiles/mods/agent-profiles/main.js");

const AGENTS = [
  { key: "claude", name: "Claude Code", run: ["claude"], installed: true, icon: "icons/claude.svg", tint: false },
  { key: "pi", name: "Pi", run: ["pi"], installed: true, icon: "icons/pi.svg", tint: true },
  { key: "gemini", name: "Gemini", run: ["gemini"], installed: true, icon: "icons/gemini.svg", tint: true },
  { key: "amp", name: "Amp", run: ["amp"], installed: false, icon: "icons/amp.svg", tint: false },
];

let root;
const profile = (name, files) => {
  mkdirSync(join(root, "agent-profiles", name), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, "agent-profiles", name, file), text);
};

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ap-main-")));
  profile("reviewer", { "profile.json": '{"harness":"claude"}', "CLAUDE.md": "# Reviewer\nBe terse.\n" });
  profile("ops", { "profile.json": '{"harness":"pi","cwd":"~"}', "AGENTS.md": "# Ops\n" });
  profile("typo", { "profile.json": '{"harness":"claude","native_cwd":"/tmp"}' });
  profile("ghost", { "profile.json": '{"harness":"gemini"}', "AGENTS.md": "# Ghost\n" });
  profile("amp", { "profile.json": '{"harness":"amp"}' });
  profile("empty", {});
  profile("stack", { "profile.json": '{"harness":"claude","include":["reviewer"]}', "CLAUDE.md": "# Stack\n" });
  profile("wobbly", { "profile.json": '{"harness":"pi","include":["nowhere"]}' });
  profile(".hidden", { "profile.json": '{"harness":"pi"}' });
  writeFileSync(join(root, "agent-profiles", "README.txt"), "not a profile");
});
after(() => rmSync(root, { recursive: true, force: true }));

// A fake Herdr app. `commands` records every `herdr-app do` the mod issues.
function app({ failOn = null, panes, spacesList } = {}) {
  const env = {
    commands: [],
    notified: [],
    closed: [],
    appHome: () => root,
    home: () => "/Users/me",
    theme: () => new Proxy({}, { get: () => "#000000" }),
    focused: () => ({ space: "s1", pane: "pA", terminal: "t1", cwd: "/work" }),
    spaces: () => spacesList ?? [{ id: "s1", machine: null }],
    panes: () => panes ?? [{ pane: "pA", terminal: "t1", cwd: "/work", status: null, zoomed: false, program: { shell: true } }],
    terminals: () => [],
    knownAgents: async () => AGENTS,
    props: () => ({ overlay: "ov1" }),
    closeOverlay: (id) => env.closed.push(id),
    notify: (n) => env.notified.push(n),
    exec: async (cmd, args) => {
      if (cmd === "sh") return { code: 0, stdout: "/bin/zsh", stderr: "" };
      assert.equal(cmd, "herdr-app");
      const [, name, json] = args;
      env.commands.push([name, JSON.parse(json)]);
      if (name === failOn) return { code: 1, stdout: JSON.stringify({ error: `cannot do ${name}` }), stderr: "" };
      return { code: 0, stdout: JSON.stringify(name === "terminal.open" ? { pane: "pNEW", terminal: "t9" } : { ok: true }), stderr: "" };
    },
  };
  globalThis.__herdr = env;
  return env;
}

// Opens the dialog the way Herdr does and waits for its loading tasks.
async function open(env = app()) {
  const tasks = [];
  const cx = {
    spawn: (fn) => tasks.push(fn(cx)),
    timer: { after() {} },
    focus_handle: () => ({}),
    notify() {},
    stopped: 0,
    stop_propagation() {
      cx.stopped++;
    },
  };
  const view = new AgentProfiles();
  view.init({}, cx);
  await Promise.all(tasks);
  const settle = async () => {
    await Promise.all(tasks);
  };
  return { env, view, cx, settle, tree: () => view.render() };
}
const names = (env) => env.commands.map(([n]) => n);

test("the list shows every profile folder, and says why a broken one cannot start", async () => {
  const { tree } = await open();
  const text = textOf(tree());
  for (const name of ["reviewer", "ops"]) assert.match(text, new RegExp(`\\b${name}\\b`));
  assert.match(text, /Claude Code · CLAUDE\.md/);
  assert.match(text, /Pi · AGENTS\.md/);
  assert.match(text, /start here/, "key hints are shown when there is something to choose");
  assert.match(text, /typo[\s\S]*unknown field "native_cwd"/);
  assert.match(text, /ghost[\s\S]*gemini cannot take instructions yet/);
  assert.match(text, /amp[\s\S]*amp is not installed/);
  assert.match(text, /empty[\s\S]*profile\.json is missing/);
  assert.match(text, /stack[\s\S]*Claude Code · reviewer \+ CLAUDE\.md/);
  assert.match(text, /wobbly[\s\S]*includes "nowhere", which is not a profile/);
  assert.doesNotMatch(text, /hidden|README/);
  // Alphabetical, and only the profiles that can start are selectable.
  const order = ["amp", "empty", "ghost", "ops", "reviewer", "stack", "typo", "wobbly"].map((n) => text.indexOf(n));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("the dialog says where an agent would land", async () => {
  assert.match(textOf((await open()).tree()), /Takes over this idle shell · \/work/);
  const busy = app({ panes: [{ pane: "pA", terminal: "t1", cwd: "/work", status: "working", zoomed: false, program: { shell: false } }] });
  assert.match(textOf((await open(busy)).tree()), /Opens beside this pane/);
  const remote = app({ spacesList: [{ id: "s1", machine: "owlspace" }] });
  assert.match(textOf((await open(remote)).tree()), /Remote spaces are not supported yet/);
});

test("with no profile folder yet, the dialog explains how to make one", async () => {
  const saved = root;
  root = join(tmpdir(), "ap-main-does-not-exist");
  try {
    const text = textOf((await open()).tree());
    assert.match(text, /No profiles yet/);
    assert.match(text, /agent-profiles\//);
    assert.match(text, /profile\.json/);
    assert.doesNotMatch(text, /start here/, "no key hints when there is nothing to choose");
  } finally {
    root = saved;
  }
});

test("clicking a row starts it where you are: replace the shell, with the document attached", async () => {
  const { env, tree, cx, settle } = await open();
  find(tree(), "ap-reviewer").$on.on_click({}, cx);
  await settle();
  assert.deepEqual(names(env), ["pane.focus", "terminal.open", "pane.close"]);
  const open_ = env.commands[1][1];
  assert.equal(open_.folder, "/work");
  assert.equal(open_.place, "right");
  assert.deepEqual(open_.argv.slice(0, 6), ["/bin/zsh", "-l", "-i", "-c", '"$@"; exec "$0" -l -i', "/bin/zsh"]);
  assert.deepEqual(open_.argv.slice(6), ["claude", "--append-system-prompt=# Reviewer\nBe terse.\n"]);
  assert.deepEqual(env.closed, ["ov1"]);
  assert.deepEqual(env.notified, []);
});

test("a profile that includes another starts with both documents, the included one first", async () => {
  const { env, tree, cx, settle } = await open();
  find(tree(), "ap-stack").$on.on_click({}, cx);
  await settle();
  const open_ = env.commands.find(([n]) => n === "terminal.open")[1];
  assert.deepEqual(open_.argv.slice(6), ["claude", "--append-system-prompt=# Reviewer\nBe terse.\n\n\n# Stack\n"]);
});

test("the folder chip starts it in the profile's own folder, with the same document", async () => {
  const { env, tree, cx, settle } = await open();
  find(tree(), "ap-own-ops").$on.on_click({}, cx);
  await settle();
  assert.equal(cx.stopped, 1, "the chip click must not also trigger the row");
  const open_ = env.commands.find(([n]) => n === "terminal.open")[1];
  assert.equal(open_.folder, "/Users/me");
  assert.deepEqual(open_.argv.slice(6), ["pi", "--append-system-prompt", join(root, "agent-profiles", "ops", "AGENTS.md")]);
  assert.equal(find(tree(), "ap-own-reviewer"), null, "a profile without cwd has no folder chip");
});

test("Enter starts here, Shift+Enter in the profile folder, on the first startable row", async () => {
  const plain = await open();
  plain.view.input.handlers.submit({}, plain.cx);
  await plain.settle();
  assert.equal(plain.env.commands.find(([n]) => n === "terminal.open")[1].folder, "/work");
  assert.match(plain.env.commands.find(([n]) => n === "terminal.open")[1].argv.at(-2), /append-system-prompt/);

  const shifted = await open();
  shifted.view.input.handlers.submit({ shift: true }, shifted.cx);
  await shifted.settle();
  assert.equal(shifted.env.commands.find(([n]) => n === "terminal.open")[1].folder, "/Users/me");
});

test("a profile that cannot start is not startable by click or Enter", async () => {
  const { env, tree, view, cx, settle } = await open();
  for (const id of ["ap-typo", "ap-ghost", "ap-amp", "ap-empty", "ap-wobbly"]) assert.equal(find(tree(), id).$on.on_click, undefined, id);
  view.filter = "typo";
  view.input.handlers.submit({}, cx);
  await settle();
  assert.deepEqual(env.commands, []);
});

test("typing filters the list and resets the selection", async () => {
  const { view, tree, cx } = await open();
  view.input.value_ = "rev";
  view.input.handlers.change({}, cx);
  const text = textOf(tree());
  assert.match(text, /reviewer/);
  assert.doesNotMatch(text, /\bops\b/);
  view.input.value_ = "zzz";
  view.input.handlers.change({}, cx);
  assert.match(textOf(tree()), /No profile matches/);
});

test("a failed start shows an error toast, closes the dialog and never closes the old pane", async () => {
  const { env, tree, cx, settle } = await open(app({ failOn: "terminal.open" }));
  find(tree(), "ap-reviewer").$on.on_click({}, cx);
  await settle();
  assert.deepEqual(names(env), ["pane.focus", "terminal.open"]);
  assert.equal(env.notified.length, 1);
  assert.equal(env.notified[0].level, "error");
  assert.match(env.notified[0].title, /reviewer/);
  assert.match(env.notified[0].body, /cannot do terminal\.open/);
  assert.deepEqual(env.closed, ["ov1"]);
});

test("a second click while one is starting does nothing", async () => {
  const { env, tree, cx, settle } = await open();
  const click = find(tree(), "ap-reviewer").$on.on_click;
  click({}, cx);
  click({}, cx);
  await settle();
  assert.equal(names(env).filter((n) => n === "terminal.open").length, 1);
});

test("arrow keys move the selection and keep it in view; Escape closes", async () => {
  const { env, view, tree, cx } = await open();
  const keys = tree().$on.on_key_down;
  const press = (key) => keys({ key }, { stop_propagation() {}, notify() {} });
  assert.equal(view.at, 0);
  press("down");
  assert.equal(view.at, 1);
  press("down");
  assert.equal(view.at, 2);
  press("down");
  assert.equal(view.at, 0, "wraps around the three startable profiles");
  press("up");
  assert.equal(view.at, 2);
  assert.ok(view.scroll.scrolled.length >= 3, "scrolled the selected row into view each time");
  press("escape");
  assert.deepEqual(env.closed, ["ov1"]);
  void cx;
});
