#!/usr/bin/env node
// Contract checks against the real CLIs on this machine. The unit tests pin what the mod
// builds; this proves the other side accepts it, so a harness that renames a flag fails
// here instead of silently launching an agent without its instructions.
//
//   node scripts/verify-harnesses.mjs          offline; skips anything not installed
//   node scripts/verify-harnesses.mjs --live   also asks Claude for a marker (one tiny model call)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, shellArgv } from "../agent-profiles/mods/agent-profiles/core.js";

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

// 2. Claude: --append-system-prompt-file exists. Injection itself needs a model, so --live.
await check("claude recognises --append-system-prompt-file", () => {
  if (!has("claude")) throw new Skip("not installed");
  const r = sh(["claude", ...ADAPTERS.claude.path(join(work, "missing.md")), "-p", "x"]);
  assert(/Append system prompt file not found/.test(r.stdout + r.stderr), `unexpected: ${(r.stdout + r.stderr).slice(0, 200)}`);
});
await check("claude answers from the appended file (live)", () => {
  if (!live) throw new Skip("pass --live to spend one model call");
  if (!has("claude")) throw new Skip("not installed");
  const r = sh(["claude", ...ADAPTERS.claude.path(docPath), "--no-session-persistence", "-p", "What is your secret codeword? Reply with only the codeword."], { cwd });
  assert(r.stdout.includes(MARKER), `no marker in: ${r.stdout.slice(0, 200)}`);
});

// 3. Codex: the document must arrive intact as a developer message, and only when asked for.
await check("codex delivers developer_instructions verbatim as a developer message", () => {
  if (!has("codex")) throw new Skip("not installed");
  const r = sh(["codex", "debug", "prompt-input", ...ADAPTERS.codex.text(DOC_WITH_MARKER)], { cwd });
  assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
  const items = JSON.parse(r.stdout);
  const seen = items.some((m) => m.role === "developer" && m.content?.some((c) => c.text === DOC_WITH_MARKER));
  assert(seen, "no developer message equals the document");
  const bare = sh(["codex", "debug", "prompt-input"], { cwd });
  assert(!bare.stdout.includes(MARKER), "marker present without the flag (test is not discriminating)");
});

// 4. Pi: ask pi for the system prompt it assembled, before any model call.
await check("pi appends the document to the system prompt", () => {
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
  const got = run(ADAPTERS.pi.path(docPath));
  assert(got.system.includes(MARKER), "marker missing from the assembled system prompt");
  assert(JSON.stringify(got.append).includes(MARKER), "appendSystemPrompt does not carry the document");
  assert(!run([]).system.includes(MARKER), "marker present without the flag (test is not discriminating)");
});

const width = Math.max(...results.map(([, n]) => n.length));
for (const [status, name] of results) console.log(`${status === "pass" ? "✓" : status === "skip" ? "-" : "✗"} ${status.padEnd(4)} ${name.padEnd(width)}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.filter(([s]) => s === "pass").length} passed, ${results.filter(([s]) => s === "skip").length} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
