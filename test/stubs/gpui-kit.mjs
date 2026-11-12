// A recording stand-in for gpui-kit's element builders: every builder is chainable and a
// no-op, except the few that carry meaning for a test (id, child, children, when, on_*, tooltip).
export const make = (tag, src = null) => {
  const node = { $tag: tag, $kids: [], $on: {}, $id: null, $tip: null, $src: src };
  const proxy = new Proxy(function () {}, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      if (key.startsWith("$")) return node[key];
      if (key === "id") return (v) => ((node.$id = v), proxy);
      if (key === "tooltip") return (v) => ((node.$tip = v), proxy);
      if (key === "child") return (c) => (node.$kids.push(c), proxy);
      if (key === "children") return (cs) => (node.$kids.push(...cs), proxy);
      if (key === "when") return (cond, fn) => (cond ? (fn(proxy) ?? proxy) : proxy);
      if (key === "on_mouse_down") return (button, fn) => ((node.$on[`on_mouse_down:${button}`] = fn), proxy);
      if (key.startsWith("on_")) return (...a) => ((node.$on[key] = a[a.length - 1]), proxy);
      return () => proxy;
    },
  });
  return proxy;
};
export class View {}
export const div = () => make("div");
export const svg = (src) => make("svg", src);
export const image = (src) => make("image", src);

export const walk = (node, fn) => {
  if (node === null || typeof node === "string" || typeof node === "number") return;
  fn(node);
  for (const kid of node.$kids) walk(kid, fn);
};
export const textOf = (node) => {
  const out = [];
  const visit = (n) => {
    if (typeof n === "string" || typeof n === "number") out.push(String(n));
    else if (n) n.$kids.forEach(visit);
  };
  visit(node);
  return out.join(" ");
};
export const find = (node, id) => {
  let hit = null;
  walk(node, (n) => {
    if (n.$id === id) hit = n;
  });
  return hit;
};
