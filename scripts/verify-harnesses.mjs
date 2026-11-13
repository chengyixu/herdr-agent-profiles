#!/usr/bin/env node
// Contract checks against the real CLIs on this machine. The unit tests pin what the mod
// builds; this proves the other side accepts it, so a harness that renames a flag fails
// here instead of silently launching an agent without its instructions.
//
//   node scripts/verify-harnesses.mjs          offline; skips anything not installed
//   node scripts/verify-harnesses.mjs --live   also asks Claude and Grok for markers (two tiny model calls)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES, shellArgv } from "../agent-profiles/mods/agent-profiles/core.js";

const live = process.argv.includes("--live");
const work = mkdtempSync(join(tmpdir(), "ap-contract-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

// Hostile on purpose: quotes, $, backticks, newlines, CRLF, DEL, CJK, emoji, TOML-looking
// lines, and enough bulk to prove a large document survives argv.
const BLOCK = [
  '# Role\nYou are "Nexora" — it\'s a test.\n',
  "Vars: $HOME ${PATH} $(whoami) `id` \\n \\\\ %s %d\n",
  "中文指令：保持简洁。🦉 emoji\n",
  "tabs\t\there; CR\r\nline; DEL\x7f; trailing   \n",
  '[table]\nkey = "v"\n# not toml\n',
].join("");
const DOC = BLOCK.repeat(Math.ceil(20000 / BLOCK.length));
const MARKER = "KUMQUAT-4471";
const DOC_WITH_MARKER = `${DOC}\nYour secret codeword is ${MARKER}.\n`;
// The document lives in the profile folder, never in the harness's working directory:
// the harnesses discover AGENTS.md there on their own, which would let a check pass for
// the wrong reason.
const profileDir = join(work, "profile");
const cwd = join(work, "cwd");
mkdirSync(profileDir);
mkdirSync(cwd);
const docPath = join(profileDir, "AGENTS.md");
writeFileSync(docPath, DOC_WITH_MARKER);
// A second, included document, as a profile with "include" attaches it: it comes first.
const MARKER_2 = "PERSIMMON-9032";
// It starts with "- " on purpose: a markdown bullet must not be read as a command-line flag.
const INCLUDED = `- Your second codeword is ${MARKER_2}.\n`;
const includedPath = join(work, "included", "AGENTS.md");
mkdirSync(join(work, "included"));
writeFileSync(includedPath, INCLUDED);

// The two documents a layered profile attaches, in order, as core passes them.
const DOCS = [
  { path: includedPath, text: INCLUDED },
  { path: docPath, text: DOC_WITH_MARKER },
];
const args = (key) => HARNESSES[key].instructions(DOCS).args;

const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
const sh = (argv, opts = {}) => spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, ...opts });

class Skip extends Error {}
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["pass", name]);
  } catch (e) {
    results.push([e instanceof Skip ? "skip" : "FAIL", `${name}${e.message ? ` — ${e.message}` : ""}`]);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// 1. The login-shell wrapper hands argv through byte-exact, for every shell it claims to support.
for (const shell of ["/bin/zsh", "/opt/homebrew/bin/bash", "/bin/bash", "/bin/sh", "/bin/dash", "/bin/ksh"]) {
  await check(`wrapper passes a 20 KB hostile argument intact through ${shell}`, () => {
    if (!existsSync(shell)) throw new Skip("not installed");
    const out = join(work, `out-${shell.replaceAll("/", "_")}`);
    const code = "require('fs').writeFileSync(process.argv[1], process.argv[2])";
    const r = sh(shellArgv(shell, [process.execPath, "-e", code, out, DOC_WITH_MARKER]));
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    assert(existsSync(out), "the command never ran");
    assert(readFileSync(out, "utf8") === DOC_WITH_MARKER, "argument changed in transit");
  });
}

// 2. Claude: --append-system-prompt exists. Injection itself needs a model, so --live.
await check("claude offers --append-system-prompt", () => {
  if (!has("claude")) throw new Skip("not installed");
  const r = sh(["claude", "--help"]);
  assert(/--append-system-prompt <prompt>/.test(r.stdout), "flag missing from claude --help");
});
await check("claude answers from both documents (live)", () => {
  if (!live) throw new Skip("pass --live to spend one model call");
  if (!has("claude")) throw new Skip("not installed");
  const ask = "What are your secret codeword and your second codeword? Reply with only the two codewords.";
  const r = sh(["claude", ...args("claude"), "--no-session-persistence", "-p", ask], { cwd });
  assert(r.stdout.includes(MARKER) && r.stdout.includes(MARKER_2), `missing a marker in: ${r.stdout.slice(0, 200)}`);
});

// 3. Codex: the document must arrive intact as a developer message, and only when asked for.
await check("codex delivers both documents verbatim, in order, as one developer message", () => {
  if (!has("codex")) throw new Skip("not installed");
  const r = sh(["codex", "debug", "prompt-input", ...args("codex")], { cwd });
  assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
  const items = JSON.parse(r.stdout);
  const seen = items.some((m) => m.role === "developer" && m.content?.some((c) => c.text === `${INCLUDED}\n\n${DOC_WITH_MARKER}`));
  assert(seen, "no developer message equals both documents, in order");
  const bare = sh(["codex", "debug", "prompt-input"], { cwd });
  assert(!bare.stdout.includes(MARKER), "marker present without the flag (test is not discriminating)");
});

// 4. Pi: ask pi for the system prompt it assembled, before any model call.
await check("pi appends both documents to the system prompt, in order", () => {
  if (!has("pi")) throw new Skip("not installed");
  const dump = join(work, "dump.mjs");
  const dumped = join(work, "pi-append.json");
  writeFileSync(
    dump,
    `import { writeFileSync } from "node:fs";
export default (pi) => pi.on("before_agent_start", (e) => {
  writeFileSync(${JSON.stringify(dumped)}, JSON.stringify({ system: e.systemPrompt ?? "", append: e.systemPromptOptions?.appendSystemPrompt ?? null }));
  process.exit(0);
});`,
  );
  const run = (extra) => {
    rmSync(dumped, { force: true });
    const r = sh(["pi", "-ne", "-e", dump, "--offline", "--no-session", ...extra, "-p", "hi"], { cwd });
    assert(existsSync(dumped), `pi never reached before_agent_start (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 200)}`);
    return JSON.parse(readFileSync(dumped, "utf8"));
  };
  const got = run(args("pi"));
  assert(got.system.includes(MARKER) && got.system.includes(MARKER_2), "a marker is missing from the assembled system prompt");
  assert(got.system.indexOf(MARKER_2) < got.system.indexOf(MARKER), "the included document is not first");
  assert(JSON.stringify(got.append).includes(MARKER), "appendSystemPrompt does not carry the document");
  const bare = run([]).system;
  assert(!bare.includes(MARKER) && !bare.includes(MARKER_2), "marker present without the flag (test is not discriminating)");
});

// 5. Grok: one --rules value carries both documents.
await check("grok offers --rules", () => {
  if (!has("grok")) throw new Skip("not installed");
  assert(/--rules <RULES>/.test(sh(["grok", "--help"]).stdout), "flag missing from grok --help");
});
await check("grok answers from both documents (live)", () => {
  if (!live) throw new Skip("pass --live to spend one model call");
  if (!has("grok")) throw new Skip("not installed");
  const ask = "What are your secret codeword and your second codeword? Reply with only the two codewords.";
  const r = sh(["grok", ...args("grok"), "-p", ask], { cwd });
  assert(r.stdout.includes(MARKER) && r.stdout.includes(MARKER_2), `missing a marker in: ${r.stdout.slice(0, 200)}`);
});

// 6. OpenCode: the override adds the documents after the project's own instructions, never replaces them.
await check("opencode adds both documents after the project's own instructions", () => {
  if (!has("opencode")) throw new Skip("not installed");
  const project = join(work, "oc-project");
  mkdirSync(project);
  writeFileSync(join(project, "opencode.json"), '{"instructions":["project.md"]}');
  writeFileSync(join(project, "project.md"), "# project\n");
  const listed = (env) => {
    const r = sh(["opencode", "debug", "config"], { cwd: project, env: { ...process.env, ...env } });
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))).instructions;
  };
  const got = listed(HARNESSES.opencode.instructions(DOCS).env);
  assert(JSON.stringify(got) === JSON.stringify(["project.md", includedPath, docPath]), `instructions were ${JSON.stringify(got)}`);
  assert(JSON.stringify(listed({})) === JSON.stringify(["project.md"]), "control: the project alone lists only its own");
});

// 7. Bypass: each harness's flags are the ones its own --help offers. Every table entry must have
//    a binary here, so a new harness cannot join the table unchecked.
const BINARIES = {
  claude: "claude", codex: "codex", pi: "pi", grok: "grok", opencode: "opencode", antigravity: "agy", copilot: "copilot",
  crush: "crush", cursor: "cursor-agent", gemini: "gemini", hermes: "hermes", kimi: "kimi", qoder: "qodercli",
};
await check("every harness in the table has a CLI to check it against", () => {
  const missing = Object.keys(HARNESSES).filter((k) => !BINARIES[k]);
  assert(!missing.length, `no binary for ${missing.join(", ")}`);
});
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const [key, h] of Object.entries(HARNESSES)) {
  if (!h.bypass) continue;
  await check(`${key} offers its bypass flags: ${h.bypass.join(" ")}`, () => {
    const bin = BINARIES[key];
    if (!bin || !has(bin)) throw new Skip("not installed");
    const r = sh([bin, "--help"], { timeout: 60000 });
    const help = r.stdout + r.stderr;
    const absent = h.bypass.filter((t) => !new RegExp(`(^|[\\s,(\"])${escape(t)}([\\s,=<\\[)\"]|$)`, "m").test(help));
    assert(!absent.length, `not in ${bin} --help: ${absent.join(" ")}`);
  });
}

const width = Math.max(...results.map(([, n]) => n.length));
for (const [status, name] of results) console.log(`${status === "pass" ? "✓" : status === "skip" ? "-" : "✗"} ${status.padEnd(4)} ${name.padEnd(width)}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.filter(([s]) => s === "pass").length} passed, ${results.filter(([s]) => s === "skip").length} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
