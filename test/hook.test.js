// The hooks against a fake `hc` and a fake agent process tree. The fake agent
// is a shell script named `claude`, so `ps` lists it as `/bin/sh …/claude`
// and Revive recognizes it as an agent the way it recognizes the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseProcesses } from "../mods/revive/revive.mjs";
import { hookOwner } from "../mods/revive/lib/core.js";

const ENGINE = resolve("mods/revive/revive.mjs");
const ID = "0c8b28eb-1111-4222-8333-444455556666";

/** A fake `hc`: `get` answers from state.json, `label` appends to labels.log. */
function setup({ labels = {}, app = null, argv = ["claude", "--model", "opus", "fix it"], bin: name0 = "claude" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-hook-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ labels, app, argv }));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs"), dir = ${JSON.stringify(dir)};
const [cmd, t, ...rest] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
if (cmd === "get") {
  console.log(JSON.stringify({ address: t, state: "live", pid: 4242, cwd: "/w", labels: state.labels,
    status: state.app ? { app: state.app, state: "working" } : null,
    foreground: { pid: Number(process.env.FAKE_FG), argv: state.argv, cwd: "/w" } }));
} else if (cmd === "label") {
  fs.appendFileSync(dir + "/labels.log", JSON.stringify(rest) + "\\n");
}
`);
  chmodSync(hc, 0o755);
  // The agent in the foreground: it records its own pid as FAKE_FG, then runs
  // either the hook or, through a shell the way an agent's tool call does,
  // another agent (a \`claude -p\` used as a tool).
  const agent = (name) => {
    const bin = join(dir, name, name0);
    mkdirSync(join(dir, name));
    writeFileSync(bin, `#!/bin/sh\n[ -z "$FAKE_FG" ] && export FAKE_FG=$$\nif [ -n "$NESTED" ]; then NESTED= sh -c "\\"$NESTED\\"; true"; else node ${JSON.stringify(ENGINE)} hook; fi\n`);
    chmodSync(bin, 0o755);
    return bin;
  };
  const outer = agent("outer");
  const inner = agent("inner");
  const run = (payload, { nested = false } = {}) => execFileSync(outer, [], {
    input: JSON.stringify(payload),
    env: { ...process.env, HC_TERMINAL_ID: "t1", REVIVE_HC: hc, NESTED: nested ? inner : "", FAKE_FG: "" },
  });
  const calls = () => (existsSync(join(dir, "labels.log")) ? readFileSync(join(dir, "labels.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const set = (calls) => Object.fromEntries(calls.flat().map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  return { run, calls, set };
}

const start = { hook_event_name: "SessionStart", session_id: ID, cwd: "/w", source: "startup" };
const end = (reason) => ({ hook_event_name: "SessionEnd", session_id: ID, reason });
const remembered = { "revive.agent": "claude", "revive.session": ID, "revive.shell": "4242" };

test("the foreground agent's SessionStart is remembered, with its flags", () => {
  const { run, calls, set } = setup();
  run(start);
  const got = set(calls());
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.agent"], "claude");
  assert.equal(got["revive.flags"], '["--model","opus"]');
  assert.equal(got["revive.shell"], "4242");
});

test("a `claude -p` the agent runs as a tool records nothing", () => {
  const { run, calls } = setup();
  run(start, { nested: true });
  assert.deepEqual(calls(), []);
});

test("the command line wins over a previous agent's report", () => {
  const { run, calls, set } = setup({ app: "codex" });
  run(start);
  assert.equal(set(calls())["revive.agent"], "claude");
});

test("ending a session yourself forgets it", () => {
  const { run, calls, set } = setup({ labels: remembered });
  run(end("prompt_input_exit"));
  assert.equal(set(calls())["revive.session"], "");
});

test("a signal keeps the session as it was", () => {
  const { run, calls } = setup({ labels: remembered });
  run(end("other"));
  assert.deepEqual(calls(), []);
});

test("/clear leaves the record to the new session's SessionStart", () => {
  const { run, calls } = setup({ labels: remembered });
  run(end("clear"));
  assert.deepEqual(calls(), []);
});

test("another session's SessionEnd is ignored", () => {
  const { run, calls } = setup({ labels: { ...remembered, "revive.session": "aaaaaaaa-0000-0000-0000-000000000000" } });
  run(end("prompt_input_exit"));
  assert.deepEqual(calls(), []);
});

test("ps lines parse into pid, parent, start time and words", () => {
  const table = parseProcesses([
    "  812     1 Sat Oct 31 18:49:55 2026     /bin/zsh -l",
    "  900   812 Sat Oct 31 18:50:01 2026     claude --model opus",
    "  950   900 Sat Oct 31 18:51:00 2026     /bin/sh -c node /x/revive.mjs hook",
    "garbage",
  ].join("\n"));
  assert.deepEqual(table.get(812), { ppid: 1, since: "Sat Oct 31 18:49:55 2026", argv: ["/bin/zsh", "-l"] });
  assert.equal(table.get(900).argv[0], "claude");
  assert.equal(table.size, 3);
  assert.deepEqual(hookOwner(table, 950, 900), { owned: true, agent: 900 });
  assert.deepEqual(hookOwner(table, 812, 900), { owned: false, agent: null });
});

test("a tool call's hooks are not the foreground agent's", () => {
  const table = new Map([
    [10, { ppid: 1, argv: ["/bin/zsh", "-l"] }],
    [20, { ppid: 10, argv: ["claude"] }],
    [30, { ppid: 20, argv: ["/bin/zsh", "-c", "claude -p hi"] }],
    [40, { ppid: 30, argv: ["claude", "-p", "hi"] }],
    [50, { ppid: 40, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.deepEqual(hookOwner(table, 50, 20), { owned: false, agent: 40 }, "claude -p under a shell under claude");
  assert.deepEqual(hookOwner(table, 50, 40), { owned: true, agent: 40 });
  assert.deepEqual(hookOwner(table, 30, 20), { owned: true, agent: 20 });
});

test("an agent behind a wrapper is still the foreground's", () => {
  // npm: node …/bin/codex runs the native codex, which runs the hook.
  const npm = new Map([
    [10, { ppid: 1, argv: ["/bin/zsh", "-l"] }],
    [20, { ppid: 10, argv: ["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex", "--yolo"] }],
    [30, { ppid: 20, argv: ["/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex", "--yolo"] }],
    [40, { ppid: 30, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.deepEqual(hookOwner(npm, 40, 20), { owned: true, agent: 30 });
  // A launcher with another name: node …/cli.mjs runs the native codex.
  const hud = new Map([
    [10, { ppid: 1, argv: ["/bin/zsh", "-l"] }],
    [20, { ppid: 10, argv: ["node", "/home/u/.codex/codex-hud/runtime/cli.mjs"] }],
    [30, { ppid: 20, argv: ["/home/u/.codex/packages/standalone/current/bin/codex"] }],
    [40, { ppid: 30, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.deepEqual(hookOwner(hud, 40, 20), { owned: true, agent: 30 });
  // A codex exec the agent ran as a tool, behind a shell: not the agent's.
  const tool = new Map([...hud,
    [50, { ppid: 30, argv: ["/bin/zsh", "-c", "codex exec x"] }],
    [60, { ppid: 50, argv: ["codex", "exec", "x"] }],
    [70, { ppid: 60, argv: ["/bin/sh", "-c", "node revive.mjs hook"] }],
  ]);
  assert.equal(hookOwner(tool, 70, 20).owned, false);
});

test("the same session starting again keeps its resumed mark", () => {
  const { run, calls, set } = setup({ labels: { ...remembered, "revive.resumed": "1700000000000", "revive.at": "5" } });
  run({ ...start, source: "compact" });
  const got = set(calls());
  assert.equal(got["revive.resumed"], "1700000000000");
  assert.equal(got["revive.at"], "5");
});

test("a new session starts without a resumed mark", () => {
  const { run, calls, set } = setup({ labels: { ...remembered, "revive.session": "aaaaaaaa-0000-0000-0000-000000000000", "revive.resumed": "1700000000000" } });
  run({ ...start, source: "clear" });
  const got = set(calls());
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.resumed"], "");
});

// ── Factory Droid and Cursor ────────────────────────────────────────────────

const droid = { bin: "droid", argv: ["droid", "--skip-permissions-unsafe", "-m", "gpt-5", "fix it"] };
const cursor = { bin: "cursor-agent", argv: ["cursor-agent", "--force", "--model", "gpt-5", "fix it"] };
const cursorStart = { hook_event_name: "sessionStart", conversation_id: ID, session_id: ID, generation_id: ID, workspace_roots: ["/w/app"], cursor_version: "2026.10.1", transcript_path: null };
const cursorEnd = (reason) => ({ hook_event_name: "sessionEnd", conversation_id: ID, session_id: ID, reason, cursor_version: "2026.10.1" });

test("droid's SessionStart is remembered, with its flags", () => {
  const { run, calls, set } = setup(droid);
  run({ ...start, transcript_path: "/Users/me/.factory/projects/-w/s.jsonl" });
  const got = set(calls());
  assert.equal(got["revive.agent"], "droid");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--skip-permissions-unsafe","-m","gpt-5"]');
});

test("droid's own /exit forgets it, a signal keeps it", () => {
  const exit = setup({ ...droid, labels: { ...remembered, "revive.agent": "droid" } });
  exit.run(end("prompt_input_exit"));
  assert.equal(exit.set(exit.calls())["revive.session"], "");
  const kill = setup({ ...droid, labels: { ...remembered, "revive.agent": "droid" } });
  kill.run(end("other"));
  assert.deepEqual(kill.calls(), []);
});

test("Cursor's sessionStart is remembered from its conversation id and workspace", () => {
  const { run, calls, set } = setup(cursor);
  run(cursorStart);
  const got = set(calls());
  assert.equal(got["revive.agent"], "cursor");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.cwd"], "/w/app");
  assert.equal(got["revive.flags"], '["--force","--model","gpt-5"]');
});

test("a bare `agent` that reports itself as Cursor is Cursor", () => {
  const { run, calls, set } = setup({ bin: "cursor-agent", argv: ["agent", "--yolo"], app: "cursor" });
  run(cursorStart);
  assert.equal(set(calls())["revive.agent"], "cursor");
});

test("Cursor's completed session is forgotten; an aborted one is kept", () => {
  const done = setup({ ...cursor, labels: { ...remembered, "revive.agent": "cursor" } });
  done.run(cursorEnd("completed"));
  assert.equal(done.set(done.calls())["revive.session"], "");
  const aborted = setup({ ...cursor, labels: { ...remembered, "revive.agent": "cursor" } });
  aborted.run(cursorEnd("aborted"));
  assert.deepEqual(aborted.calls(), []);
});
