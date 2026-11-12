// Agent profiles. Pick a profile and its harness starts in the current pane, with the
// profile's AGENTS.md / CLAUDE.md attached. The logic lives in core.js (and is unit
// tested); this file is the dialog and the wiring of Herdr's APIs into core's `host`.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import * as fs from "fs/promises";
import { appHome, closeOverlay, exec, focused, home, knownAgents, notify, panes, props, spaces, terminals, theme } from "herdr";
import { parseProfile, pickDoc, placement, problem, startProfile } from "./core.js";

// The popup is as tall as its content, so the list needs a height of its own: a list that
// only flexes into "the rest" collapses to nothing (seen on screen).
const ROW_HEIGHT = 36;
const VISIBLE_ROWS = 8;

const profilesDir = () => `${appHome()}/agent-profiles`;
const tilde = (path) => (path && path.startsWith(home()) ? `~${path.slice(home().length)}` : (path ?? ""));

// One entry per folder: a profile with its document read, or { name, error } to show why not.
async function loadProfiles() {
  let entries;
  try {
    entries = await fs.readdir(profilesDir(), { withFileTypes: true });
  } catch {
    return []; // no folder yet: the empty state explains how to make one
  }
  const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  return Promise.all(names.map(loadProfile));
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
const makeHost = () => ({
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

// Where a start would land: the focused pane of the focused space, read once when the dialog opens.
function currentTarget() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space);
  const pane = f?.pane ? (panes().find((p) => p.pane === f.pane) ?? null) : null;
  return { machine: space?.machine ?? null, pane };
}

export default class AgentProfiles extends View {
  init(_props, cx) {
    this.host = makeHost();
    this.target = currentTarget();
    this.profiles = null; // null while loading
    this.agents = null; // null until knownAgents answers
    this.filter = "";
    this.at = 0;
    this.starting = null;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Start an agent profile…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    // Enter starts it where you are; Shift+Enter (or Cmd/Ctrl+Enter) in the profile's own folder.
    this.input.on("submit", (e, cx) => this.choose(this.pickable()[this.at], e.shift || e.secondary ? "own" : "here", cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      this.profiles = await loadProfiles();
      cx.notify();
      try {
        this.agents = await knownAgents();
      } catch {
        this.agents = [];
      }
      cx.notify();
    });
  }

  agentFor(profile) {
    return this.agents?.find((a) => a.key === profile.harness) ?? null;
  }

  rows() {
    const f = this.filter.trim().toLowerCase();
    return (this.profiles ?? [])
      .filter((p) => !f || p.name.includes(f) || (p.harness ?? "").includes(f))
      .map((p) => ({ p, agent: this.agentFor(p), why: this.agents ? problem(p, this.agentFor(p)) : (p.error ?? null) }));
  }

  pickable() {
    return this.rows().filter((r) => !r.why);
  }

  // The overlay has to stay open until core is done: closing it cancels this view's tasks,
  // and the replace sequence must not stop halfway.
  choose(row, mode, cx) {
    if (!row || this.starting) return;
    this.starting = row.p.name;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await startProfile(this.host, { profile: row.p, mode, target: this.target });
      } catch (e) {
        notify({ title: `Could not start ${row.p.name}`, body: e.message ?? String(e), level: "error" });
      }
      closeOverlay(props().overlay);
    });
  }

  // What a start would do here, said before it is chosen.
  where(t) {
    const { machine, pane } = this.target;
    if (machine) return { text: `This space is on ${machine}. Remote spaces are not supported yet.`, color: t.blocked };
    if (!pane) return { text: "Focus a pane first.", color: t.blocked };
    const action = placement({ pane, hasChildren: this.host.hasChildren(pane.terminal) }) === "replace" ? "Takes over this idle shell" : "Opens beside this pane";
    return { text: `${action} · ${tilde(pane.cwd)}`, color: t.dim };
  }

  rowView(t, r, on) {
    const { p, agent, why } = r;
    const icon = agent?.icon
      ? agent.tint
        ? svg(agent.icon).size(15).flex_none().text_color(why ? t.dim : t.foreground)
        : image(agent.icon).size(15).flex_none()
      : div().w(15).flex_none();
    const doc = p.doc ? p.doc.path.split("/").pop() : "no instructions";
    return h_flex()
      .id(`ap-${p.name}`)
      .h(ROW_HEIGHT)
      .px(10)
      .gap(10)
      .rounded(7)
      .items_center()
      .flex_none()
      .when(on, (el) => el.bg(t.hover))
      .when(!why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(r, "here", cx)))
      .child(icon)
      .child(div().flex_none().font_semibold().text_color(why ? t.dim : t.foreground).child(p.name))
      .child(div().flex_1().truncate().text_size(11.5).text_color(why ? t.blocked : t.dim).child(why ?? `${agent?.name ?? p.harness} · ${doc}`))
      .when(!why && p.cwd, (el) =>
        el.child(
          h_flex()
            .id(`ap-own-${p.name}`)
            .flex_none()
            .h(24)
            .px(8)
            .rounded(6)
            .items_center()
            .border_1()
            .border_color(t.border)
            .text_size(11)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.selected).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.choose(r, "own", cx);
            })
            .child(`in ${p.cwd}`),
        ),
      );
  }

  empty(t, text, extra) {
    return v_flex().gap(6).px(10).py(8).text_size(12).text_color(t.dim).child(text).when(Boolean(extra), (el) => el.child(extra));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => !r.why);
    this.at = Math.min(this.at, Math.max(0, pickable.length - 1));
    const selected = pickable[this.at];
    const where = this.where(t);

    let body;
    if (this.profiles === null) body = this.empty(t, "Loading…");
    else if (this.profiles.length === 0) {
      body = this.empty(
        t,
        `No profiles yet. Make a folder named after the agent in ${tilde(profilesDir())}/ with two files:`,
        v_flex().gap(3).child(div().text_color(t.muted).child('profile.json   {"harness": "claude", "cwd": "~/code/app"}')).child(div().text_color(t.muted).child("AGENTS.md      its instructions (CLAUDE.md works too)")),
      );
    } else if (rows.length === 0) body = this.empty(t, "No profile matches.");
    else body = v_flex().id("ap-list").flex_none().h(Math.min(rows.length, VISIBLE_ROWS) * ROW_HEIGHT).overflow_y_scrollbar().track_scroll(this.scroll).children(rows.map((r) => this.rowView(t, r, r === selected)));

    return v_flex()
      .id("agent-profiles")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        if (!pickable.length) return;
        if (e.key === "down") this.at = (this.at + 1) % pickable.length;
        else if (e.key === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
        else return;
        this.scroll.scroll_to_item(rows.indexOf(pickable[this.at]));
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Agent profiles"))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(
        h_flex().h(36).flex_none().px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(div().flex_none().text_size(11.5).text_color(this.starting ? t.accent : where.color).child(this.starting ? `Starting ${this.starting}…` : where.text))
      .child(body)
      .when((this.profiles ?? []).length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("↵ start here · ⇧↵ start in the profile folder · ↑↓ choose")));
  }
}
