// Test-only module hooks: the three modules Herdr provides to a mod are replaced by stubs.
// Everything else (node:fs, core.js, main.js) is the real thing.
const STUBBED = ["herdr", "gpui-kit", "gpui-base"];
export async function resolve(specifier, context, next) {
  if (STUBBED.includes(specifier)) return { url: new URL(`./stubs/${specifier}.mjs`, import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
