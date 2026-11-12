// The options menu: a popup opened by right-clicking (or Option-clicking) a profile in the
// sidebar, with props { view: "menu", profile, pane }. It starts the profile and changes its
// settings. Every change rewrites profile.json through core's editProfile, so it can only write
// a profile that loads; the sidebar sees the change through its folder watch.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import { closeOverlay, exec, home, knownAgents, notify, pickFolder, props, theme, window, writeTextFile } from "herdr";
import { ADAPTERS, editProfile, homeRelative, includeChoices, newDocName, parseProfile, pickDoc, rowsFor, startProfile } from "./core.js";
import { currentTarget, loadProfiles, makeHost, profilesDir } from "./host.js";

const H = { header: 50, row: 28, section: 24, note: 28, divider: 11, padding: 10 };

// Everything the menu shows, read fresh: the resolved profiles, Herdr's agents, and this
// profile's own profile.json (parsed even when an include makes the profile unusable).
export async function menuState(name) {
  const dir = `${profilesDir()}/${name}`;
  const profiles = await loadProfiles();
  let agents = [];
  try {
    agents = await knownAgents();
  } catch {
    // no harness list: the harness rows show only the current one
  }
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    // the folder went away: the menu says so
  }
  let raw;
  try {
    raw = parseProfile(name, await fs.readFile(`${dir}/profile.json`, "utf8"));
  } catch {
    raw = { error: "profile.json is missing" };
  }
  return { name, dir, profiles, agents, files, raw };
}

// The menu as data, so its height is known before it opens: the sidebar sizes the popup with it.
export function menuItems(state) {
  const { name, profiles, agents, files, raw } = state;
  const row = rowsFor(profiles, agents).find((r) => r.p.name === name);
  const why = row ? row.why : "this profile is gone";
  const settings = raw.profile ?? null;
  const docs = row?.p.docs?.length ? row.p.docs.map((d) => d.label).join(" + ") : "no instructions";
  const out = [{ kind: "header", label: name, hint: why ?? `${row.agent?.name ?? row.p.harness} · ${docs}`, bad: Boolean(why) }];
  const cwd = settings?.cwd ?? null;
  out.push({ kind: "row", id: "ap-m-here", label: "Start here", enabled: !why, act: { type: "start", mode: "here" } });
  out.push({ kind: "row", id: "ap-m-own", label: cwd ? `Start in ${cwd}` : "Start in its folder", enabled: !why && Boolean(cwd), act: { type: "start", mode: "own" } });

  if (settings) {
    out.push({ kind: "divider" }, { kind: "section", label: "Harness" });
    // Only harnesses that can take instructions: a profile is for instructions, and the list stays
    // short however many agents are installed. profile.json can still name any other.
    const offered = agents.filter((a) => a.installed && ADAPTERS[a.key]);
    if (!offered.some((a) => a.key === settings.harness)) {
      const known = agents.find((a) => a.key === settings.harness);
      offered.push({ key: settings.harness, name: known?.installed ? known.name : `${settings.harness} (not installed)` });
    }
    for (const a of offered) {
      out.push({ kind: "row", id: `ap-m-harness-${a.key}`, label: a.name, check: a.key === settings.harness, enabled: true, act: { type: "change", change: { harness: a.key } } });
    }

    out.push({ kind: "divider" }, { kind: "section", label: "Folder" });
    out.push({ kind: "row", id: "ap-m-folder", label: cwd ?? "Choose a folder…", hint: cwd ? "change…" : "", check: Boolean(cwd), enabled: true, act: { type: "folder" } });
    out.push({ kind: "row", id: "ap-m-nofolder", label: "None: start where you are", check: !cwd, enabled: true, act: { type: "change", change: { cwd: null } } });

    out.push({ kind: "divider" }, { kind: "section", label: "Also attach the instructions of" });
    const { choices, usedBy } = includeChoices(profiles, name);
    const listed = [...choices, ...settings.include.filter((n) => !choices.includes(n))];
    if (usedBy.length) out.push({ kind: "note", label: `Attached by ${usedBy.join(", ")}: it cannot attach others` });
    else if (!listed.length) out.push({ kind: "note", label: "No other profile has instructions to attach" });
    for (const n of listed) {
      const on = settings.include.includes(n);
      const include = on ? settings.include.filter((x) => x !== n) : [...settings.include, n];
      out.push({ kind: "row", id: `ap-m-include-${n}`, label: n, check: on, enabled: true, act: { type: "change", change: { include } } });
    }
  }

  out.push({ kind: "divider" });
  if (settings) {
    const file = pickDoc(settings.harness, files);
    out.push({ kind: "row", id: "ap-m-doc", label: "Edit instructions", hint: file ?? `new ${newDocName(settings.harness)}`, enabled: true, act: { type: "doc", file: file ?? newDocName(settings.harness), create: !file } });
  }
  out.push({ kind: "row", id: "ap-m-json", label: "Edit profile.json", enabled: true, act: { type: "json", create: !files.includes("profile.json") } });
  out.push({ kind: "row", id: "ap-m-reveal", label: window()?.platform === "macos" ? "Show in Finder" : "Show the folder", enabled: true, act: { type: "reveal" } });
  return out;
}

export const menuHeight = (items) => H.padding + items.reduce((sum, item) => sum + H[item.kind], 0);

export class Menu {
  constructor(cx) {
    const p = props();
    this.name = p.profile;
    this.host = makeHost();
    this.target = currentTarget(p.pane);
    this.state = null;
    this.busy = false;
    cx.spawn(async (cx) => {
      this.state = await menuState(this.name);
      cx.notify();
    });
  }

  items() {
    return this.state ? menuItems(this.state) : [];
  }

  height() {
    return menuHeight(this.items());
  }

  // One action at a time; a failure is said in a toast. The menu stays open for further changes.
  run(act, cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this[act.type](act);
      } catch (e) {
        notify({ title: `${this.name}: could not do that`, body: e.message ?? String(e), level: "error" });
      }
      this.busy = false;
      if (act.type === "start") return closeOverlay(props().overlay);
      this.state = await menuState(this.name);
      cx.notify();
    });
  }

  async start({ mode }) {
    const profile = this.state.profiles.find((p) => p.name === this.name);
    await startProfile(this.host, { profile, mode, target: this.target });
  }

  async change({ change }) {
    const path = `${this.state.dir}/profile.json`;
    const before = await fs.readFile(path, "utf8");
    const next = editProfile(this.name, before, change);
    if (next.error) throw new Error(next.error);
    await writeTextFile(path, next.text, before);
  }

  async folder() {
    const picked = await pickFolder({ prompt: "Use this folder" });
    if (picked) await this.change({ change: { cwd: homeRelative(picked, home()) } });
  }

  async doc({ file, create }) {
    const path = `${this.state.dir}/${file}`;
    if (create) await writeTextFile(path, "", null);
    await this.open(path);
  }

  async json({ create }) {
    const path = `${this.state.dir}/profile.json`;
    if (create) {
      const first = this.state.agents.find((a) => a.installed)?.key ?? "claude";
      await writeTextFile(path, `${JSON.stringify({ harness: first }, null, 2)}\n`, null);
    }
    await this.open(path);
  }

  async reveal() {
    const mac = window()?.platform === "macos";
    await this.exec(mac ? ["open", "-R", `${this.state.dir}/profile.json`] : ["xdg-open", this.state.dir]);
  }

  async open(path) {
    await this.exec(window()?.platform === "macos" ? ["open", "-t", path] : ["xdg-open", path]);
  }

  async exec([cmd, ...args]) {
    const r = await exec(cmd, args);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${cmd} exited ${r.code}`);
  }

  item(t, item, i) {
    if (item.kind === "divider") return div().h(1).mx(4).my(5).flex_none().bg(t.border);
    if (item.kind === "section") return div().h(H.section).px(9).pt(7).flex_none().text_size(11).text_color(t.dim).child(item.label);
    if (item.kind === "note") return div().h(H.note).px(9).flex_none().flex().items_center().truncate().text_size(11.5).text_color(t.dim).child(item.label);
    if (item.kind === "header") {
      return v_flex()
        .id(`ap-m-header-${i}`)
        .h(H.header)
        .px(9)
        .pt(6)
        .gap(2)
        .flex_none()
        .child(div().truncate().font_semibold().text_color(t.foreground).child(item.label))
        .child(div().truncate().text_size(11.5).text_color(item.bad ? t.blocked : t.dim).child(item.hint));
    }
    const enabled = item.enabled && !this.busy;
    return h_flex()
      .id(item.id)
      .h(H.row)
      .px(9)
      .gap(8)
      .rounded(6)
      .flex_none()
      .items_center()
      .text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)).on_click((_e, cx) => this.run(item.act, cx)))
      .child(div().w(14).flex_none().text_color(t.accent).child(item.check ? "✓" : ""))
      .child(div().flex_1().min_w(0).truncate().child(item.label))
      .when(Boolean(item.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(item.hint)));
  }

  render() {
    const t = theme();
    return v_flex()
      .id("ap-menu")
      .w_full()
      .h(this.height())
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .children(this.items().map((item, i) => this.item(t, item, i)));
  }
}
