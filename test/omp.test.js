// omp's extension against a fake omp and a fake engine that logs what it is sent.
// It is TypeScript, as omp loads it: Node runs it here when it can strip types.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentKey, carriedFlags, command, hookPayload, isOneShot, readRecord, canFork } from "../mods/revive/lib/core.js";

const ID = "0190f3a2-7c41-7b5e-9d2a-3e6f1c8b4a17";
const FILE = `/h/.omp/agent/sessions/-w/2026-01-01T00-00-00-000Z_${ID}.jsonl`;
let copies = 0;

/** The extension in a mod folder of its own, loaded into a fake omp. */
async function load(t, env = { HC_TERMINAL_ID: "t1" }) {
  const mod = mkdtempSync(join(tmpdir(), "revive-omp-"));
  mkdirSync(join(mod, "omp"));
  writeFileSync(join(mod, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(mod, "revive.mjs"), `import fs from "node:fs";
let text = ""; for await (const c of process.stdin) text += c;
fs.appendFileSync(${JSON.stringify(join(mod, "log"))}, JSON.stringify([process.argv.slice(2), JSON.parse(text)]) + "\\n");
`);
  const file = join(mod, "omp", `revive-${copies++}.ts`);
  copyFileSync("mods/revive/omp/revive.ts", file);
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

const ctx = (mode = "tui", file = FILE, id = ID) => ({
  mode,
  cwd: "/w",
  sessionManager: { getSessionId: () => id, getSessionFile: () => file },
});

test("omp is known by its command line and its report, and only as the first word", () => {
  assert.equal(agentKey("omp"), "omp");
  assert.equal(agentKey(null, ["omp"]), "omp");
  assert.equal(agentKey(null, ["/home/me/.local/bin/omp", "--model", "opus"]), "omp");
  assert.equal(agentKey(null, ["vim", "omp"]), null);
  assert.equal(agentKey(null, ["pi"]), "pi", "pi stays pi");
});

test("omp resumes with --resume and forks with --fork, keeping its flags", () => {
  assert.deepEqual(command({ agent: "omp", session: ID, flags: ["--model", "opus"] }), ["omp", "--model", "opus", "--resume", ID]);
  assert.deepEqual(command({ agent: "omp", session: ID, flags: [] }, "fork"), ["omp", "--fork", ID]);
  assert.deepEqual(command({ agent: "omp", session: ID, env: { PI_CODING_AGENT_DIR: "/p" } }), ["env", "PI_CODING_AGENT_DIR=/p", "omp", "--resume", ID]);
  assert.equal(canFork("omp"), true);
  assert.deepEqual(
    carriedFlags("omp", ["omp", "--model=opus", "--thinking", "high", "--profile", "work", "--approval-mode", "write", "--resume", "x", "-e", "/x.ts", "fix it"]),
    ["--model=opus", "--thinking", "high", "--profile", "work", "--approval-mode", "write"],
  );
});

test("omp runs that answer and quit are not sessions to bring back", () => {
  for (const argv of [["omp", "-p", "hi"], ["omp", "--print"], ["omp", "--mode", "rpc"], ["omp", "--mode=json"], ["omp", "--no-session"], ["omp", "--export", "/s.jsonl"]]) {
    assert.equal(isOneShot("omp", argv), true, argv.join(" "));
  }
  assert.equal(isOneShot("omp", ["omp", "--model", "opus"]), false);
});

test("omp's payload is recognized by its transcript path", () => {
  const p = hookPayload({ hook_event_name: "SessionStart", session_id: ID, transcript_path: FILE, argv: ["omp", "--model", "m"] });
  assert.equal(p.agent, "omp");
  assert.deepEqual(p.argv, ["omp", "--model", "m"]);
  assert.equal(readRecord({ "revive.agent": "omp", "revive.session": ID, "revive.flags": '["--model","m","--hook","/h.ts"]' }).flags.join(" "), "--model m");
});

test("omp's session start and /exit reach the engine as Claude-shaped hooks", async (t) => {
  const omp = await load(t);
  if (!omp) return;
  omp.handlers.session_start({ type: "session_start" }, ctx());
  await omp.handlers.session_shutdown({ type: "session_shutdown" }, ctx());
  const [[args, start], [, end]] = omp.log();
  assert.deepEqual(args, ["hook", "--agent", "omp"]);
  assert.equal(start.hook_event_name, "SessionStart");
  assert.equal(start.session_id, ID);
  assert.equal(start.transcript_path, FILE);
  assert.equal(start.argv[0], "omp");
  const { source, ...rest } = start;
  assert.equal(source, "startup");
  assert.deepEqual(end, { ...rest, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
});

test("omp ended by a signal keeps its session", async (t) => {
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    const omp = await load(t);
    if (!omp) return;
    omp.handlers.session_start({}, ctx());
    // omp's own handler starts the teardown; Revive's listener runs right after it.
    const done = omp.handlers.session_shutdown({}, ctx());
    process.emit(signal, signal);
    await done;
    assert.deepEqual(omp.log().map(([, p]) => p.hook_event_name), ["SessionStart"], signal);
  }
});

test("a session switched inside omp is recorded like a start", async (t) => {
  const omp = await load(t);
  if (!omp) return;
  const other = "0190f3a2-0000-7b5e-9d2a-3e6f1c8b4a18";
  omp.handlers.session_start({}, ctx());
  omp.handlers.session_switch({ reason: "new", previousSessionFile: FILE }, ctx("tui", FILE.replace(ID, other), other));
  await omp.handlers.session_shutdown({}, ctx("tui", FILE.replace(ID, other), other));
  const events = omp.log().map(([, p]) => [p.hook_event_name, p.session_id, p.source ?? p.reason]);
  assert.deepEqual(events, [["SessionStart", ID, "startup"], ["SessionStart", other, "new"], ["SessionEnd", other, "prompt_input_exit"]]);
});

test("omp outside a herdr terminal, in print or rpc mode, or without a session file sends nothing", async (t) => {
  const outside = await load(t, { HC_TERMINAL_ID: "" });
  if (!outside) return;
  assert.deepEqual(outside.handlers, {});
  const omp = await load(t);
  omp.handlers.session_start({}, ctx("rpc"));
  omp.handlers.session_start({}, ctx("print"));
  omp.handlers.session_start({}, ctx("tui", null));
  omp.handlers.session_switch({ reason: "new" }, ctx("json"));
  await omp.handlers.session_shutdown({}, ctx("tui", null));
  assert.deepEqual(omp.log(), []);
});
