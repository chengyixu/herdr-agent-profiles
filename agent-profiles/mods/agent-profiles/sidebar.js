// The sidebar block: the profiles under the Agents list, as a layout block with props
// { "view": "sidebar" }. Unlike the popup it lives as long as its layout, so it reads its target
// pane at click time and reloads when the profile folder changes. It never takes the keyboard.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { focused, knownAgents, layout, notify, theme, watchFolder } from "herdr";
import { rowsFor, startProfile } from "./core.js";
import { currentTarget, loadProfiles, makeHost, profilesDir, tilde } from "./host.js";

// The profile folder may not exist yet, and a watch on it then fails: look again this often.
const RETRY_MS = 10000;
// Narrower than this, Herdr's sidebar mods draw a compact rail of icons.
const RAIL_PX = 160;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const onRail = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < RAIL_PX;

export class Sidebar {
  constructor(cx) {
    this.host = makeHost();
    this.profiles = null; // null while loading
    this.agents = null; // null until knownAgents answers
    this.starting = null;
    this.lastPane = null;
    cx.spawn(async (cx) => {
      await this.reload();
      cx.notify();
      for (;;) {
        try {
          await watchFolder(profilesDir());
        } catch {
          await new Promise((resolve) => cx.timer.after(RETRY_MS, resolve));
        }
        await this.reload();
        cx.notify();
      }
    });
  }

  async reload() {
    this.profiles = await loadProfiles();
    try {
      this.agents = await knownAgents();
    } catch {
      // keep the last answer; a start asks Herdr again anyway
    }
  }

  // The pane focused now; if the click itself took focus off the panes, the last one seen.
  start(p, mode, cx) {
    if (this.starting) return;
    this.starting = p.name;
    cx.notify();
    const target = currentTarget(focused()?.pane ?? this.lastPane);
    cx.spawn(async (cx) => {
      try {
        await startProfile(this.host, { profile: p, mode, target });
      } catch (e) {
        notify({ title: `Could not start ${p.name}`, body: e.message ?? String(e), level: "error" });
      }
      this.starting = null;
      cx.notify();
    });
  }

  icon(t, agent, dim) {
    if (!agent?.icon) return div().w(16).flex_none();
    return agent.tint ? svg(agent.icon).size(16).flex_none().text_color(dim ? t.dim : t.foreground) : image(agent.icon).size(16).flex_none();
  }

  row(t, { p, agent, why }, rail) {
    const docs = p.docs?.length ? p.docs.map((d) => d.label).join(" + ") : "no instructions";
    const tip = why ? `${p.name}: ${why}` : `${p.name} · ${agent?.name ?? p.harness} · ${docs}`;
    const base = h_flex()
      .id(`ap-side-${p.name}`)
      .flex_none()
      .items_center()
      .tooltip(tip)
      .when(!why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.start(p, "here", cx)));
    if (rail) return base.h(26).justify_center().child(this.icon(t, agent, why));
    return base
      .h(30)
      .px(8)
      .gap(9)
      .rounded(8)
      .child(this.icon(t, agent, why))
      .child(div().flex_1().min_w(0).truncate().text_color(why ? t.dim : t.foreground).child(p.name))
      .when(this.starting === p.name, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("starting…")))
      .when(!why && Boolean(p.cwd) && this.starting !== p.name, (el) =>
        el.child(
          div()
            .id(`ap-side-own-${p.name}`)
            .flex_none()
            .p(2)
            .rounded(4)
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(`Start in ${p.cwd}`)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.start(p, "own", cx);
            })
            .child(svg("mods/agent-profiles/folder.svg").size(13)),
        ),
      );
  }

  render() {
    const t = theme();
    const f = focused();
    if (f?.pane) this.lastPane = f.pane;
    const rail = onRail();
    const rows = rowsFor(this.profiles ?? [], this.agents);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!rail, (el) =>
        el.child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().child(div().text_size(11.5).font_medium().text_color(t.dim).child("Profiles"))),
      )
      .when(!rail && this.profiles?.length === 0, (el) =>
        el.child(div().px(16).text_size(12).text_color(t.dim).child(`No profiles yet. Add a folder per agent in ${tilde(profilesDir())}/.`)),
      )
      .child(v_flex().id("ap-side-list").flex_1().min_h(0).px(rail ? 0 : 8).overflow_y_scrollbar().children(rows.map((r) => this.row(t, r, rail))));
  }
}
