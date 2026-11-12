// Agent profiles. Pick a profile and its harness starts in the current pane, with the
// profile's AGENTS.md / CLAUDE.md attached. The logic lives in core.js (and is unit
// tested); host.js wires Herdr's APIs into it. This mod draws in two places: the popup
// (opened with a key), a sidebar block (a layout block with props { "view": "sidebar" }) and
// the sidebar's options menu (props { "view": "menu", profile, pane }).
// Which one is a prop of each copy, so it is chosen per instance, never at module scope.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Popup } from "./popup.js";
import { Sidebar } from "./sidebar.js";
import { Menu } from "./menu.js";

export default class AgentProfiles extends View {
  init(_props, cx) {
    const view = props()?.view;
    this.part = view === "sidebar" ? new Sidebar(cx) : view === "menu" ? new Menu(cx) : new Popup(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
