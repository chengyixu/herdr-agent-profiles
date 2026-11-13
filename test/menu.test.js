// The options menu under Node: Herdr's modules are stubbed (test/stub-loader.mjs); the real
// filesystem, core.js, host.js and menu.js run. writeTextFile is a real compare-and-swap write.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./stub-loader.mjs", import.meta.url);
const { find, textOf } = await import("./stubs/gpui-kit.mjs");
const { default: AgentProfiles } = await import("../agent-profiles/mods/agent-profiles/main.js");
const { menuHeight } = await import("../agent-profiles/mods/agent-profiles/menu.js");

const AGENTS = [
  { key: "claude", name: "Claude Code", run: ["claude"], installed: true, icon: "icons/claude.svg", tint: false },
  { key: "codex", name: "Codex", run: ["codex", "--no-daemon"], installed: true, icon: "icons/codex.svg", tint: false },
  { key: "pi", name: "Pi", run: ["pi"], installed: true, icon: "icons/pi.svg", tint: true },
  { key: "amp", name: "Amp", run: ["amp"], installed: false, icon: "icons/amp.svg", tint: false },
  { key: "gemini", name: "Gemini", run: ["gemini"], installed: true, icon: "icons/gemini.svg", tint: true },
];

let root;
const dir = (name) => join(root, "agent-profiles", name);
const profile = (name, files) => {
  mkdirSync(dir(name), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir(name), file), text);
};
const json = (name) => JSON.parse(readFileSync(join(dir(name), "profile.json"), "utf8"));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ap-menu-")));
  profile("general", { "profile.json": '{"harness":"pi"}', "AGENTS.md": "# Shared\n" });
  profile("base", { "profile.json": '{"harness":"pi"}', "AGENTS.md": "# Base\n" });
  profile("klik", { "profile.json": '{ "harness": "pi", "cwd": "~/Klik", "include": ["general"] }\n', "AGENTS.md": "# Klik\n" });
  profile("panor", { "profile.json": '{"harness":"claude","include":["general"]}' });
  profile("broken", { "profile.json": "{nope" });
  profile("geminiish", { "profile.json": '{"harness":"gemini"}' });
  profile("dangling", { "profile.json": '{"harness":"pi","include":["nowhere"]}', "AGENTS.md": "# D\n" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const tick = () => new Promise((r) => setTimeout(r, 40));

function app({ name = "klik", platform = "macos", picked = null, writeFails = false } = {}) {
  const env = {
    commands: [],
    execs: [],
    notified: [],
    closed: [],
    writes: 0,
    picked,
    appHome: () => root,
    home: () => "/Users/me",
    theme: () => new Proxy({}, { get: () => "#000000" }),
    window: () => ({ platform }),
    focused: () => ({ space: "s1", pane: "pOTHER", terminal: "t-other" }),
    spaces: () => [{ id: "s1", machine: null }],
    panes: () => [
      { pane: "pA", terminal: "t-a", cwd: "/work/a", status: null, zoomed: false, program: { shell: true } },
      { pane: "pOTHER", terminal: "t-other", cwd: "/work/other", status: null, zoomed: false, program: { shell: true } },
    ],
    terminals: () => [],
    knownAgents: async () => AGENTS,
    props: () => ({ view: "menu", profile: name, pane: "pA", overlay: "ov-menu" }),
    closeOverlay: (id) => env.closed.push(id),
    notify: (n) => env.notified.push(n),
    openOverlay: () => "ov",
    pickFolder: async () => env.picked,
    // A real compare-and-swap write, as Herdr's: null creates a new file, else the file must still match.
    writeTextFile: async (path, text, expected) => {
      if (writeFails) throw new Error("the file changed since it was read");
      const now = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (now !== expected) throw new Error("the file changed since it was read");
      writeFileSync(path, text);
      env.writes++;
      return null;
    },
    labelled: [],
    hc: async (args) => (env.labelled.push(args), { code: 0, stdout: "", stderr: "" }),
    exec: async (cmd, args) => {
      if (cmd === "sh") return { code: 0, stdout: "/bin/zsh", stderr: "" };
      if (cmd === "herdr-app") {
        const [, n, j] = args;
        env.commands.push([n, JSON.parse(j)]);
        return { code: 0, stdout: JSON.stringify(n === "terminal.open" ? { pane: "pNEW", terminal: "t9" } : { ok: true }), stderr: "" };
      }
      env.execs.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  globalThis.__herdr = env;
  return env;
}

async function menu(env = app()) {
  const cx = { spawn: (fn) => void fn(cx), timer: { after() {}, every() {} }, focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {} };
  const mod = new AgentProfiles();
  mod.init({}, cx);
  await tick();
  const click = async (id) => {
    const el = find(mod.render(cx), id);
    assert.ok(el, `no element ${id}`);
    assert.ok(el.$on.on_click, `${id} is not clickable`);
    el.$on.on_click({}, cx);
    await tick();
  };
  return { env, cx, mod, tree: () => mod.render(cx), click };
}
const checked = (tree, id) => /✓/.test(textOf(find(tree, id)));

test("the menu shows the profile's settings: harness, folder, attached profiles and its files", async () => {
  const { tree } = await menu();
  const t = tree();
  const text = textOf(t);
  assert.match(text, /klik/);
  assert.match(text, /Pi · general \+ AGENTS\.md/);
  for (const id of ["ap-m-here", "ap-m-own", "ap-m-harness-claude", "ap-m-harness-codex", "ap-m-harness-pi", "ap-m-folder", "ap-m-nofolder", "ap-m-include-general", "ap-m-include-base", "ap-m-doc", "ap-m-json", "ap-m-reveal"]) {
    assert.ok(find(t, id), id);
  }
  assert.equal(find(t, "ap-m-harness-amp"), null, "an agent that is not installed is not offered");
  assert.equal(find(t, "ap-m-harness-gemini"), null, "nor one that cannot take instructions: it keeps the menu short");
  assert.ok(checked(t, "ap-m-harness-pi") && !checked(t, "ap-m-harness-claude"));
  assert.match(textOf(find(t, "ap-m-folder")), /~\/Klik/);
  assert.ok(checked(t, "ap-m-include-general") && !checked(t, "ap-m-include-base"));
  assert.equal(find(t, "ap-m-include-panor"), null, "a profile without a document cannot be attached");
  assert.equal(find(t, "ap-m-include-klik"), null, "not itself");
});

test("choosing a harness rewrites profile.json, keeps the rest, and the menu shows the new choice", async () => {
  const { env, tree, click } = await menu();
  await click("ap-m-harness-claude");
  assert.deepEqual(json("klik"), { harness: "claude", cwd: "~/Klik", include: ["general"] });
  assert.ok(checked(tree(), "ap-m-harness-claude"));
  assert.deepEqual(env.closed, [], "the menu stays open for more changes");
  assert.deepEqual(env.notified, []);
});

test("a profile on another harness still shows it, checked, and can move to a supported one", async () => {
  const { tree, click } = await menu(app({ name: "geminiish" }));
  assert.ok(checked(tree(), "ap-m-harness-gemini"));
  await click("ap-m-harness-pi");
  assert.equal(json("geminiish").harness, "pi");
  assert.equal(find(tree(), "ap-m-harness-gemini"), null);
});

test("choosing a folder stores it under ~; cancelling the picker writes nothing", async () => {
  const env = app({ picked: "/Users/me/code/klik" });
  const { tree, click } = await menu(env);
  await click("ap-m-folder");
  assert.equal(json("klik").cwd, "~/code/klik");
  assert.match(textOf(find(tree(), "ap-m-own")), /~\/code\/klik/);
  env.picked = null;
  const writes = env.writes;
  await click("ap-m-folder");
  assert.equal(env.writes, writes);
  assert.deepEqual(env.notified, [], "cancelling is not an error");
});

test("'no folder' clears it, and starting in its own folder is then unavailable", async () => {
  const { tree, click } = await menu();
  await click("ap-m-nofolder");
  assert.equal("cwd" in json("klik"), false);
  assert.ok(checked(tree(), "ap-m-nofolder"));
  assert.equal(find(tree(), "ap-m-own").$on.on_click, undefined);
});

test("ticking and unticking attached profiles changes include, in the order ticked", async () => {
  const { tree, click } = await menu();
  await click("ap-m-include-base");
  assert.deepEqual(json("klik").include, ["general", "base"]);
  await click("ap-m-include-general");
  assert.deepEqual(json("klik").include, ["base"]);
  assert.ok(checked(tree(), "ap-m-include-base") && !checked(tree(), "ap-m-include-general"));
});

test("a profile others attach cannot attach any itself, and the menu says who uses it", async () => {
  const { tree } = await menu(app({ name: "general" }));
  const t = tree();
  assert.match(textOf(t), /Attached by klik, panor/);
  assert.equal(find(t, "ap-m-include-base"), null);
});

test("Edit instructions opens the profile's own document in the text editor", async () => {
  const { env, click } = await menu();
  await click("ap-m-doc");
  assert.deepEqual(env.execs, [["open", "-t", join(dir("klik"), "AGENTS.md")]]);
});

test("a profile without its own document gets an empty one named for its harness, then opened", async () => {
  const { env, tree, click } = await menu(app({ name: "panor" }));
  assert.match(textOf(find(tree(), "ap-m-doc")), /new CLAUDE\.md/);
  await click("ap-m-doc");
  assert.equal(readFileSync(join(dir("panor"), "CLAUDE.md"), "utf8"), "");
  assert.deepEqual(env.execs, [["open", "-t", join(dir("panor"), "CLAUDE.md")]]);
  // A blank file is "no instructions", but it is a file: opening again must not try to create it.
  await click("ap-m-doc");
  assert.equal(env.notified.length, 0, JSON.stringify(env.notified));
  assert.equal(env.execs.length, 2);
});

test("Edit profile.json and Show in Finder open the profile's files", async () => {
  const { env, click } = await menu();
  await click("ap-m-json");
  await click("ap-m-reveal");
  assert.deepEqual(env.execs, [
    ["open", "-t", join(dir("klik"), "profile.json")],
    ["open", "-R", join(dir("klik"), "profile.json")],
  ]);
});

test("on Linux the files open with xdg-open", async () => {
  const { env, click } = await menu(app({ platform: "linux" }));
  await click("ap-m-json");
  await click("ap-m-reveal");
  assert.deepEqual(env.execs, [
    ["xdg-open", join(dir("klik"), "profile.json")],
    ["xdg-open", dir("klik")],
  ]);
});

test("a broken profile.json offers only to open it; nothing can overwrite it", async () => {
  const { tree } = await menu(app({ name: "broken" }));
  const t = tree();
  assert.match(textOf(t), /profile\.json is not valid JSON/);
  for (const id of ["ap-m-harness-pi", "ap-m-folder", "ap-m-include-general"]) assert.equal(find(t, id), null, id);
  assert.equal(find(t, "ap-m-here").$on.on_click, undefined);
  assert.ok(find(t, "ap-m-json").$on.on_click);
  assert.equal(readFileSync(join(dir("broken"), "profile.json"), "utf8"), "{nope");
});

test("a dangling include can be unticked from the menu, which makes the profile startable", async () => {
  const { tree, click } = await menu(app({ name: "dangling" }));
  assert.match(textOf(tree()), /includes "nowhere"/);
  assert.equal(find(tree(), "ap-m-here").$on.on_click, undefined);
  assert.ok(checked(tree(), "ap-m-include-nowhere"));
  await click("ap-m-include-nowhere");
  assert.equal("include" in json("dangling"), false);
  assert.ok(find(tree(), "ap-m-here").$on.on_click, "startable now");
});

test("a failed write says why in a toast and leaves the file as it was", async () => {
  const { env, click } = await menu(app({ writeFails: true }));
  const before = readFileSync(join(dir("klik"), "profile.json"), "utf8");
  await click("ap-m-harness-claude");
  assert.equal(env.notified.length, 1);
  assert.equal(env.notified[0].level, "error");
  assert.match(env.notified[0].body, /changed since it was read/);
  assert.equal(readFileSync(join(dir("klik"), "profile.json"), "utf8"), before);
});

test("Start here starts in the pane that was focused when the menu opened, then closes the menu", async () => {
  const { env, click } = await menu();
  await click("ap-m-here");
  assert.deepEqual(env.commands[0], ["pane.focus", { pane: "pA" }]);
  assert.equal(env.commands.find(([n]) => n === "terminal.open")[1].folder, "/work/a");
  assert.deepEqual(env.closed, ["ov-menu"]);
});

test("Start in its folder uses the profile's folder", async () => {
  const { env, click } = await menu();
  await click("ap-m-own");
  assert.equal(env.commands.find(([n]) => n === "terminal.open")[1].folder, "/Users/me/Klik");
});

test("the menu's height is the height its rows need, and stays the same as settings change", async () => {
  const { mod, click } = await menu();
  const h = mod.part.height();
  assert.equal(h, menuHeight(mod.part.items()));
  assert.ok(h > 300 && h < 900, String(h));
  await click("ap-m-nofolder");
  await click("ap-m-include-base");
  await click("ap-m-harness-claude");
  assert.equal(mod.part.height(), h);
});
