// The sidebar block under Node: Herdr's modules are stubbed (test/stub-loader.mjs); the real
// filesystem, core.js, host.js and sidebar.js run. The block lives as long as its layout, so
// unlike the popup it reads its target at click time and reloads when the profiles change.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./stub-loader.mjs", import.meta.url);
const { find, textOf, walk } = await import("./stubs/gpui-kit.mjs");
const { default: AgentProfiles } = await import("../agent-profiles/mods/agent-profiles/main.js");

const AGENTS = [
  { key: "claude", name: "Claude Code", run: ["claude"], installed: true, icon: "icons/claude.svg", tint: false },
  { key: "pi", name: "Pi", run: ["pi"], installed: true, icon: "icons/pi.svg", tint: true },
];
const SHELL = (pane, cwd) => ({ pane, terminal: `t-${pane}`, cwd, status: null, zoomed: false, program: { shell: true } });

let root;
const profile = (name, files) => {
  mkdirSync(join(root, "agent-profiles", name), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, "agent-profiles", name, file), text);
};
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ap-side-")));
  profile("general", { "profile.json": '{"harness":"pi"}', "AGENTS.md": "# Shared\n" });
  profile("klik-agent", { "profile.json": '{"harness":"claude","cwd":"~/Klik","include":["general"]}', "CLAUDE.md": "# Klik\n" });
  profile("broken", { "profile.json": '{"harness":"pi","include":["nowhere"]}' });
});
after(() => rmSync(root, { recursive: true, force: true }));

const tick = () => new Promise((r) => setTimeout(r, 40));

// A fake Herdr with a mutable focus, a controllable folder watcher and a sidebar width.
function app({ failOn = null, width = 268, focus = "pA" } = {}) {
  const env = {
    commands: [],
    notified: [],
    closed: [],
    timers: [],
    focusCalls: 0,
    focus,
    watches: [],
    appHome: () => root,
    home: () => "/Users/me",
    theme: () => new Proxy({}, { get: () => "#000000" }),
    layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: width } }] }),
    focused: () => ({ space: "s1", pane: env.focus, terminal: env.focus ? `t-${env.focus}` : null }),
    spaces: () => [{ id: "s1", machine: null }],
    panes: () => [SHELL("pA", "/work/a"), SHELL("pB", "/work/b")],
    terminals: () => [],
    knownAgents: async () => AGENTS,
    props: () => ({ view: "sidebar" }),
    window: () => ({ platform: "macos" }),
    overlays: [],
    openOverlay: (spec) => (env.overlays.push(spec), "ov"),
    closeOverlay: (id) => env.closed.push(id),
    notify: (n) => env.notified.push(n),
    // Each call waits until the test fires it: resolve() = something changed, reject() = no folder.
    watchFolder: () => new Promise((resolve, reject) => env.watches.push({ resolve, reject })),
    labelled: [],
    hc: async (args) => (env.labelled.push(args), { code: 0, stdout: "", stderr: "" }),
    exec: async (cmd, args) => {
      if (cmd === "sh") return { code: 0, stdout: "/bin/zsh", stderr: "" };
      const [, name, json] = args;
      env.commands.push([name, JSON.parse(json)]);
      if (name === failOn) return { code: 1, stdout: JSON.stringify({ error: `cannot do ${name}` }), stderr: "" };
      return { code: 0, stdout: JSON.stringify(name === "terminal.open" ? { pane: "pNEW", terminal: "t9" } : { ok: true }), stderr: "" };
    },
  };
  globalThis.__herdr = env;
  return env;
}

async function sidebar(env = app()) {
  globalThis.__inputsCreated = 0;
  const cx = {
    spawn: (fn) => {
      fn(cx);
    },
    timer: { after: (ms, fn) => env.timers.push({ ms, fn }), every() {} },
    focus_handle: () => ({ focus: () => env.focusCalls++ }),
    notify() {},
    stopped: 0,
    stop_propagation() {
      cx.stopped++;
    },
  };
  const mod = new AgentProfiles();
  mod.init({}, cx);
  await tick();
  return { env, cx, mod, tree: () => mod.render(cx) };
}
const names = (env) => env.commands.map(([n]) => n);

test("the sidebar shows a Profiles header and one row per profile", async () => {
  const { tree } = await sidebar();
  const text = textOf(tree());
  assert.match(text, /Profiles/);
  for (const n of ["general", "klik-agent", "broken"]) assert.ok(find(tree(), `ap-side-${n}`), n);
  assert.ok(find(tree(), "ap-side-general").$on.on_click, "a startable row is clickable");
  assert.match(find(tree(), "ap-side-broken").$tip, /includes "nowhere", which is not a profile/);
  assert.match(find(tree(), "ap-side-klik-agent").$tip, /Claude Code · general \+ CLAUDE\.md/);
});

test("a plain click on a row that cannot start starts nothing", async () => {
  const { env, cx, tree } = await sidebar();
  find(tree(), "ap-side-broken").$on.on_click?.({ modifiers: {} }, cx);
  await tick();
  assert.deepEqual(env.commands, []);
  assert.deepEqual(env.notified, [], "no error toast either: the row already says why");
  assert.deepEqual(env.overlays, []);
});

test("right-click opens the options menu for that profile, at the pointer, and starts nothing", async () => {
  const { env, cx, tree } = await sidebar();
  for (const name of ["klik-agent", "broken"]) {
    find(tree(), `ap-side-${name}`).$on["on_mouse_down:right"]({}, cx);
    await tick();
    const spec = env.overlays.at(-1);
    assert.equal(spec.mod, "agent-profiles");
    assert.equal(spec.kind, "popup");
    assert.deepEqual(spec.props, { view: "menu", profile: name, pane: "pA" });
    assert.ok(spec.height > 100, "sized for its rows");
  }
  assert.deepEqual(env.commands, []);
});

test("Option-click (or Control-click) opens the menu instead of starting", async () => {
  const { env, cx, tree } = await sidebar();
  for (const modifiers of [{ alt: true }, { control: true }]) {
    find(tree(), "ap-side-general").$on.on_click({ modifiers }, cx);
    await tick();
  }
  assert.equal(env.overlays.length, 2);
  assert.deepEqual(env.commands, []);
});

test("the tooltip says a right-click shows the options", async () => {
  const { tree } = await sidebar();
  assert.match(find(tree(), "ap-side-general").$tip, /right-click for options/i);
});

test("the sidebar never takes the keyboard from the terminal", async () => {
  const { env } = await sidebar();
  assert.equal(globalThis.__inputsCreated, 0, "no text field");
  assert.equal(env.focusCalls, 0, "no focus() on any handle");
});

test("a click starts the profile in the pane focused at the moment of the click", async () => {
  const { env, cx, tree } = await sidebar();
  const drawn = tree(); // drawn while pA is focused
  env.focus = "pB"; // focus moves on, and the click comes before any redraw
  find(drawn, "ap-side-general").$on.on_click({}, cx);
  await tick();
  assert.deepEqual(names(env), ["pane.focus", "terminal.open", "pane.close"]);
  assert.deepEqual(env.commands[0][1], { pane: "pB" });
  assert.equal(env.commands[1][1].folder, "/work/b");
  assert.deepEqual(env.closed, [], "the sidebar is not an overlay: nothing to close");
});

test("if the click itself took focus away from the panes, the last pane seen is used", async () => {
  const { env, cx, tree } = await sidebar();
  const t = tree(); // drawn while pA is focused
  env.focus = null;
  find(t, "ap-side-general").$on.on_click({}, cx);
  await tick();
  assert.deepEqual(env.commands[0][1], { pane: "pA" });
});

test("the folder icon starts the profile in its own folder, and only that", async () => {
  const { env, cx, tree } = await sidebar();
  find(tree(), "ap-side-own-klik-agent").$on.on_click({}, cx);
  await tick();
  assert.equal(cx.stopped, 1, "the row under it must not start a second agent");
  assert.equal(names(env).filter((n) => n === "terminal.open").length, 1);
  assert.equal(env.commands.find(([n]) => n === "terminal.open")[1].folder, "/Users/me/Klik");
  assert.equal(find(tree(), "ap-side-own-general"), null, "no folder icon without a cwd");
});

test("a second click while one is starting does nothing; afterwards it can start again", async () => {
  const { env, cx, tree } = await sidebar();
  const click = find(tree(), "ap-side-general").$on.on_click;
  click({}, cx);
  click({}, cx);
  await tick();
  assert.equal(names(env).filter((n) => n === "terminal.open").length, 1);
  find(tree(), "ap-side-general").$on.on_click({}, cx);
  await tick();
  assert.equal(names(env).filter((n) => n === "terminal.open").length, 2);
});

test("a failed start shows an error toast and never closes the old pane", async () => {
  const { env, cx, tree } = await sidebar(app({ failOn: "terminal.open" }));
  find(tree(), "ap-side-general").$on.on_click({}, cx);
  await tick();
  assert.deepEqual(names(env), ["pane.focus", "terminal.open"]);
  assert.equal(env.notified.length, 1);
  assert.equal(env.notified[0].level, "error");
  assert.match(env.notified[0].title, /general/);
  assert.ok(find(tree(), "ap-side-general").$on.on_click, "usable again after the failure");
});

test("the list follows the profile folder: a new profile appears when the folder changes", async () => {
  const { env, tree } = await sidebar();
  assert.equal(find(tree(), "ap-side-docs"), null);
  profile("docs", { "profile.json": '{"harness":"pi"}', "AGENTS.md": "# Docs\n" });
  env.watches.at(-1).resolve([join(root, "agent-profiles", "docs")]);
  await tick();
  assert.ok(find(tree(), "ap-side-docs"), "reloaded after the change");
  assert.equal(env.watches.length, 2, "and watching again");
  rmSync(join(root, "agent-profiles", "docs"), { recursive: true });
});

test("without a profile folder the watch fails; the block retries on a timer, not in a tight loop", async () => {
  const { env, tree } = await sidebar();
  env.watches.at(-1).reject(new Error("no such folder"));
  await tick();
  assert.equal(env.timers.length, 1);
  assert.ok(env.timers[0].ms >= 5000, "waits seconds before watching again");
  assert.equal(env.watches.length, 1, "no new watch until the timer fires");
  env.timers[0].fn({});
  await tick();
  assert.equal(env.watches.length, 2);
  assert.ok(find(tree(), "ap-side-general"));
});

test("with no profiles, the block says where to put them", async () => {
  const saved = root;
  root = join(tmpdir(), "ap-side-does-not-exist");
  try {
    const text = textOf((await sidebar()).tree());
    assert.match(text, /No profiles yet/);
    assert.match(text, /agent-profiles/);
  } finally {
    root = saved;
  }
});

test("on the narrow rail the rows are icons only, and still start the profile here", async () => {
  const { env, cx, tree } = await sidebar(app({ width: 76 }));
  const t = tree();
  assert.doesNotMatch(textOf(t), /Profiles|general|klik-agent/, "no header and no names on the rail");
  assert.match(find(t, "ap-side-general").$tip, /general/, "the name is in the tooltip");
  let icons = 0;
  walk(find(t, "ap-side-klik-agent"), (n) => (icons += n.$tag === "svg" || n.$tag === "image" ? 1 : 0));
  assert.equal(icons, 1, "one harness icon, no folder icon");
  find(t, "ap-side-general").$on.on_click({}, cx);
  await tick();
  assert.equal(env.commands.find(([n]) => n === "terminal.open")[1].folder, "/work/a");
});
