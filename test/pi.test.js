// pi's extension against a fake pi and a fake engine that logs what it is sent.
// It is TypeScript, as pi loads it: Node runs it here when it can strip types.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ID = "01a19bbb-ced1-7004-b681-6ccd26c5c927";
let copies = 0;

/** The extension in a mod folder of its own, loaded into a fake pi. */
async function load(t, env = { HC_TERMINAL_ID: "t1" }) {
  const mod = mkdtempSync(join(tmpdir(), "revive-pi-"));
  mkdirSync(join(mod, "pi"));
  writeFileSync(join(mod, "package.json"), '{ "type": "module" }\n');
  // The fake engine: one line per hook.
  writeFileSync(join(mod, "revive.mjs"), `import fs from "node:fs";
let text = ""; for await (const c of process.stdin) text += c;
fs.appendFileSync(${JSON.stringify(join(mod, "log"))}, JSON.stringify([process.argv[2], JSON.parse(text)]) + "\\n");
`);
  // A new file name each time: a module is loaded once per URL.
  const file = join(mod, "pi", `revive-${copies++}.ts`);
  copyFileSync("mods/revive/pi/revive.ts", file);
  const handlers = {};
  const saved = process.env.HC_TERMINAL_ID;
  process.env.HC_TERMINAL_ID = env.HC_TERMINAL_ID ?? "";
  try {
    const ext = (await import(pathToFileURL(file))).default;
    ext({ on: (name, fn) => { handlers[name] = fn; } });
  } catch (err) {
    t.skip(`this Node can't load TypeScript: ${err.message}`);
    return null;
  } finally {
    if (saved === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = saved;
  }
  const log = () => (existsSync(join(mod, "log")) ? readFileSync(join(mod, "log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { handlers, log };
}

const ctx = (mode = "tui", file = `/h/.pi/agent/sessions/--w--/x_${ID}.jsonl`) => ({
  mode,
  cwd: "/w",
  sessionManager: { getSessionId: () => ID, getSessionFile: () => file },
});

test("pi's session start and /quit reach the engine as Claude-shaped hooks", async (t) => {
  const pi = await load(t);
  if (!pi) return;
  pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx());
  await pi.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx());
  const [[cmd, start], [, end]] = pi.log();
  assert.equal(cmd, "hook");
  assert.equal(start.hook_event_name, "SessionStart");
  assert.equal(start.session_id, ID);
  assert.equal(start.transcript_path, `/h/.pi/agent/sessions/--w--/x_${ID}.jsonl`);
  assert.equal(start.argv[0], "pi");
  const { source, ...rest } = start;
  assert.equal(source, "startup");
  assert.deepEqual(end, { ...rest, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
});

test("pi ended by a signal keeps its session", async (t) => {
  const pi = await load(t);
  if (!pi) return;
  pi.handlers.session_start({ reason: "startup" }, ctx());
  // pi's own SIGTERM handler runs first and reports "quit"; Revive's listener runs after it.
  const done = pi.handlers.session_shutdown({ reason: "quit" }, ctx());
  process.emit("SIGTERM", "SIGTERM");
  await done;
  assert.deepEqual(pi.log().map(([, p]) => p.hook_event_name), ["SessionStart"]);
});

test("a session replaced inside pi leaves the record to the next one", async (t) => {
  const pi = await load(t);
  if (!pi) return;
  for (const reason of ["new", "resume", "fork", "reload"]) await pi.handlers.session_shutdown({ reason }, ctx());
  assert.deepEqual(pi.log(), []);
});

test("pi outside a herdr terminal, in print or json mode, or without a session file sends nothing", async (t) => {
  const outside = await load(t, { HC_TERMINAL_ID: "" });
  if (!outside) return;
  assert.deepEqual(outside.handlers, {});
  const pi = await load(t);
  pi.handlers.session_start({ reason: "startup" }, ctx("json"));
  pi.handlers.session_start({ reason: "startup" }, ctx("print"));
  pi.handlers.session_start({ reason: "startup" }, ctx("tui", null));
  await pi.handlers.session_shutdown({ reason: "quit" }, ctx("tui", null));
  assert.deepEqual(pi.log(), []);
});
