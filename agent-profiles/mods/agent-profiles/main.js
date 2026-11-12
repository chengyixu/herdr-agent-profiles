// Agent profiles. Pick a profile and its harness starts in the current pane, with the
// profile's AGENTS.md / CLAUDE.md attached. The logic lives in core.js (and is unit
// tested); host.js wires Herdr's APIs into it. This mod draws in two places: the popup
// (opened with a key) and a sidebar block (a layout block with props { "view": "sidebar" }).
// Which one is a prop of each copy, so it is chosen per instance, never at module scope.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Popup } from "./popup.js";
import { Sidebar } from "./sidebar.js";

export default class AgentProfiles extends View {
  init(_props, cx) {
    this.part = props()?.view === "sidebar" ? new Sidebar(cx) : new Popup(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
