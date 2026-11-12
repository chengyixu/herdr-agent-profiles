import { make } from "./gpui-kit.mjs";
export const h_flex = () => make("h_flex");
export const v_flex = () => make("v_flex");
export const Input = { new: () => make("input") };
export const InputState = {
  new: () => {
    globalThis.__inputsCreated = (globalThis.__inputsCreated ?? 0) + 1;
    const state = { value_: "", handlers: {}, scrolled: [] };
    state.on = (event, fn) => ((state.handlers[event] = fn), true);
    state.value = () => state.value_;
    state.focus = () => {};
    return state;
  },
};
export const ScrollHandle = { new: () => ({ scrolled: [], scroll_to_item(i) { this.scrolled.push(i); } }) };
