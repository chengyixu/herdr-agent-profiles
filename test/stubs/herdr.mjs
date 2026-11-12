// The `herdr` module, delegating to whatever a test installs on globalThis.__herdr.
const h = (name) => (...args) => globalThis.__herdr[name](...args);
export const appHome = h("appHome");
export const closeOverlay = h("closeOverlay");
export const exec = h("exec");
export const focused = h("focused");
export const home = h("home");
export const knownAgents = h("knownAgents");
export const notify = h("notify");
export const panes = h("panes");
export const props = h("props");
export const spaces = h("spaces");
export const terminals = h("terminals");
export const theme = h("theme");
