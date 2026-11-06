// The hooks against a fake `hc` and a fake agent process tree. The fake agent
// is a shell script named `claude`, so `ps` lists it as `/bin/sh …/claude`
// and Revive recognizes it as an agent the way it recognizes the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseProcesses, hasTranscript } from "../mods/revive/revive.mjs";
import { hookOwner, needsHint } from "../mods/revive/lib/core.js";

const ENGINE = resolve("mods/revive/revive.mjs");
const ID = "0c8b28eb-1111-4222-8333-444455556666";

/** A fake `hc`: `get` answers from state.json, `label` appends to labels.log. */
function setup({ labels = {}, app = null, argv = ["claude", "--model", "opus", "fix it"], bin = "claude" } = {}) {
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
    const path = join(dir, name, bin);
    mkdirSync(join(dir, name));
    writeFileSync(path, `#!/bin/sh\n[ -z "$FAKE_FG" ] && export FAKE_FG=$$\nif [ -n "$NESTED" ]; then NESTED= sh -c "\\"$NESTED\\"; true"; else node ${JSON.stringify(ENGINE)} hook; fi\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const outer = agent("outer");
  const inner = agent("inner");
  const run = (payload, { nested = false, env = {} } = {}) => execFileSync(outer, [], {
    input: JSON.stringify(payload),
    env: { ...base, HC_TERMINAL_ID: "t1", REVIVE_HC: hc, NESTED: nested ? inner : "", FAKE_FG: "", ...env },
  });
  const calls = () => (existsSync(join(dir, "labels.log")) ? readFileSync(join(dir, "labels.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const set = (calls) => Object.fromEntries(calls.flat().map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  return { run, calls, set };
}

const start = { hook_event_name: "SessionStart", session_id: ID, cwd: "/w", source: "startup" };
const end = (reason) => ({ hook_event_name: "SessionEnd", session_id: ID, reason });
// The test runner's own CLAUDE_CONFIG_DIR / CODEX_HOME must not leak into records.
const base = { ...process.env };
delete base.CLAUDE_CONFIG_DIR;
delete base.CODEX_HOME;
delete base.PI_CODING_AGENT_DIR;
delete base.PI_CODING_AGENT_SESSION_DIR;

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

test("a `claude -p` typed in the terminal records nothing", () => {
  const { run, calls } = setup({ argv: ["claude", "-p", "summarize this"] });
  run(start);
  run(end("other"));
  assert.deepEqual(calls(), []);
});

test("a `claude -p` typed in the terminal leaves the remembered session alone", () => {
  const { run, calls } = setup({ labels: remembered, argv: ["claude", "-p", "summarize this"] });
  run({ ...start, session_id: "11111111-2222-4333-8444-555566667777" });
  assert.deepEqual(calls(), []);
});

test("a session's own config folder is remembered by name", () => {
  const { run, calls, set } = setup();
  run(start, { env: { CLAUDE_CONFIG_DIR: "/h/.claude-work", CODEX_HOME: "/c" } });
  // Its name only: a label must not choose the folder a resume loads settings from.
  assert.equal(set(calls())["revive.needs"], '["CLAUDE_CONFIG_DIR"]');
  assert.equal(set(calls())["revive.env"], "");
});

test("a session without a config folder clears an older one's", () => {
  const { run, calls, set } = setup({ labels: { ...remembered, "revive.env": '{"CLAUDE_CONFIG_DIR":"/old"}' } });
  run(start);
  assert.equal(set(calls())["revive.env"], "");
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

test("a transcript is looked for in the engine's own config folder, never a record's", () => {
  const work = mkdtempSync(join(tmpdir(), "revive-config-"));
  mkdirSync(join(work, "projects", "-w"), { recursive: true });
  writeFileSync(join(work, "projects", "-w", `${ID}.jsonl`), "{}\n");
  const rec = { agent: "claude", session: ID, cwd: "/w", env: { CLAUDE_CONFIG_DIR: work } };
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "revive-empty-"));
    assert.equal(hasTranscript(rec), false);
    process.env.CLAUDE_CONFIG_DIR = work;
    assert.equal(hasTranscript({ ...rec, env: {} }), true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("pi's flags and session file come from its extension, since ps shows only `pi`", () => {
  const { run, calls, set } = setup({ argv: ["pi"], bin: "pi", app: "pi" });
  const file = "/h/.pi/agent/sessions/--w--/2026-11-02T10-00-00-000Z_" + ID + ".jsonl";
  run({ ...start, transcript_path: file, argv: ["pi", "--model", "sonnet", "--thinking", "high", "fix it"] }, { env: { PI_CODING_AGENT_DIR: "/h/.pi-work" } });
  const got = set(calls());
  assert.equal(got["revive.agent"], "pi");
  assert.equal(got["revive.flags"], '["--model","sonnet","--thinking","high"]');
  assert.equal(got["revive.transcript"], file);
  assert.equal(got["revive.needs"], '["PI_CODING_AGENT_DIR"]');
});

test("a pi session is resumable once its file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-pi-"));
  const rec = { agent: "pi", session: ID, cwd: "/w", transcript: join(dir, `x_${ID}.jsonl`) };
  assert.equal(hasTranscript(rec), false);
  writeFileSync(rec.transcript, "{}\n");
  assert.equal(hasTranscript(rec), true);
  assert.equal(hasTranscript({ ...rec, transcript: null }), true, "no file named: unknown, let pi try");
});

/** A fake `hc` with one live terminal running claude, for `revive.mjs list`. */
function listSetup(labels) {
  const dir = mkdtempSync(join(tmpdir(), "revive-list-"));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/usr/bin/env node
const [cmd, t] = process.argv.slice(2);
if (cmd === "ls") console.log(JSON.stringify({ terminals: [{ address: "t1" }, { address: "t2" }] }));
else if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: 4242, cwd: "/w",
  labels: ${JSON.stringify(labels)},
  foreground: { pid: 4243, argv: ["claude"], cwd: "/w" } }));
`);
  chmodSync(hc, 0o755);
  const config = join(dir, "config");
  const list = (env = {}) => JSON.parse(execFileSync("node", [ENGINE, "list", "--focus", "t1"], {
    env: { ...base, REVIVE_HC: hc, CLAUDE_CONFIG_DIR: config, ...env },
  })).entries;
  const transcript = (folder = config) => {
    mkdirSync(join(folder, "projects", "-w"), { recursive: true });
    writeFileSync(join(folder, "projects", "-w", `${ID}.jsonl`), "{}\n");
  };
  return { config, list, transcript };
}

test("the focused session can be forked only once it has a transcript", () => {
  const { config, list, transcript } = listSetup({ ...remembered, "revive.cwd": "/w" });
  // The agent's own sessions/<pid>.json proves the engine looks in its folder.
  mkdirSync(join(config, "sessions"), { recursive: true });
  writeFileSync(join(config, "sessions", "4243.json"), JSON.stringify({ sessionId: ID }));
  assert.equal(list()[0].forkable, false);
  transcript();
  assert.equal(list()[0].forkable, true);
  // Only the focused terminal is checked.
  assert.equal(list()[1].forkable, undefined);
});

test("a fork isn't blocked when the session's config folder isn't known", () => {
  // A record without env, and no sessions/<pid>.json here: the agent may keep
  // its sessions in a folder this process doesn't know about.
  const { list } = listSetup({ ...remembered, "revive.cwd": "/w" });
  assert.equal(list()[0].forkable, null);
});

test("a config folder from a label is never believed", () => {
  const own = mkdtempSync(join(tmpdir(), "revive-own-"));
  const { list, transcript } = listSetup({ ...remembered, "revive.cwd": "/w", "revive.env": JSON.stringify({ CLAUDE_CONFIG_DIR: own }) });
  transcript(own);
  const entry = list()[0];
  assert.equal(entry.rec.env, undefined);
  assert.deepEqual(entry.rec.needs, ["CLAUDE_CONFIG_DIR"]);
  assert.notEqual(entry.forkable, true, "the label's folder holding the session proves nothing");
});

test("an agent running with nothing on record is listed with its folder", () => {
  const { list } = listSetup({});
  const entry = list()[0];
  assert.equal(entry.rec, null);
  assert.equal(entry.live, "claude");
  assert.equal(entry.folder, "/w");
});

/** A fake `hc` with one idle shell whose labels remember a session, for `revive.mjs resume`. */
function resumeSetup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-resume-"));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "revive-work-")));
  const hc = join(dir, "hc");
  const labels = { "revive.agent": "codex", "revive.session": ID, "revive.cwd": work, "revive.shell": "1", ...extra };
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("fs");
const [cmd, t, ...rest] = process.argv.slice(2);
if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: 4242, cwd: "/w",
  labels: ${JSON.stringify(labels)},
  foreground: { pid: 4242, argv: ["zsh"], cwd: "/w" } }));
else if (cmd === "send") fs.writeFileSync(${JSON.stringify(join(dir, "sent.json"))}, JSON.stringify({ text: rest[0], from: process.env.HC_TERMINAL_ID ?? null }));
else if (cmd === "label") fs.appendFileSync(${JSON.stringify(join(dir, "labels.txt"))}, rest.join(" ") + "\\n");
`);
  chmodSync(hc, 0o755);
  const resume = () => {
    try { execFileSync("node", [ENGINE, "resume", "t1"], { env: { ...base, REVIVE_HC: hc, HC_TERMINAL_ID: "t9" }, stdio: "pipe" }); return null; }
    catch (err) { return String(err.stderr); }
  };
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  return { work, resume, sent: () => JSON.parse(read("sent.json") ?? "null"), labelled: () => read("labels.txt") ?? "" };
}

test("Resume types the command as is, even when run from inside a herdr terminal", () => {
  // From a terminal, `hc send` would deliver the text as a note (<hc from="t9">…</hc>).
  const { work, resume, sent } = resumeSetup();
  assert.equal(resume(), null);
  assert.equal(sent().text, `cd -- ${work} && codex resume ${ID}`);
  assert.equal(sent().from, null);
});

test("Resume by hand refuses a folder that failed the check, and names it", () => {
  const { resume, sent } = resumeSetup({ "revive.cwd": "/nonexistent/revive-w" });
  assert.match(resume(), /Won't resume: its folder \/nonexistent\/revive-w is missing/);
  assert.equal(sent(), null, "nothing typed: the agent would start elsewhere, with its flags");
});

test("Resume by hand refuses a session with needs, keeps it and shows the command", () => {
  for (const extra of [{ "revive.needs": '["CODEX_HOME"]' }, { "revive.agent": "pi", "revive.needs": '["--session-dir"]' }]) {
    const { resume, sent, labelled } = resumeSetup(extra);
    const err = resume();
    assert.match(err, /Won't resume here: it ran with (CODEX_HOME|--session-dir)/);
    assert.match(err, new RegExp(`Set CODEX_HOME, then run: cd -- \\S+ && codex resume ${ID}|Fill in --session-dir, then run: cd -- \\S+ && pi --session-dir <folder> --session ${ID}`), "a command to copy");
    assert.equal(sent(), null);
    assert.doesNotMatch(labelled(), /revive\.session=(\s|$)/, "the record is not forgotten");
  }
});

test("the hand-resume hint puts an uncarried flag after the agent's name, with a placeholder", () => {
  const rec = { agent: "pi", session: ID, cwd: "/w x", flags: ["--model", "m"], needs: ["PI_CODING_AGENT_DIR", "--session-dir"] };
  assert.equal(needsHint(rec), `Set PI_CODING_AGENT_DIR and fill in --session-dir, then run: cd -- '/w x' && pi --session-dir <folder> --model m --session ${ID}`);
  assert.equal(needsHint({ agent: "claude", session: ID, cwd: null, flags: [], needs: ["CLAUDE_CONFIG_DIR"] }), `Set CLAUDE_CONFIG_DIR, then run: claude --resume ${ID}`);
});

// ── Factory Droid and Cursor ────────────────────────────────────────────────

const droid = { bin: "droid", argv: ["droid", "--auto", "high", "fix it"] };
const cursor = { bin: "cursor-agent", argv: ["cursor-agent", "--force", "--model", "gpt-5", "fix it"] };
const cursorStart = { hook_event_name: "sessionStart", conversation_id: ID, session_id: ID, generation_id: ID, workspace_roots: ["/w/app"], cursor_version: "2026.10.1", transcript_path: null };
const cursorEnd = (reason) => ({ hook_event_name: "sessionEnd", conversation_id: ID, session_id: ID, reason, cursor_version: "2026.10.1" });

test("droid's SessionStart is remembered, with its flags", () => {
  const { run, calls, set } = setup(droid);
  run({ ...start, transcript_path: "/Users/me/.factory/projects/-w/s.jsonl" });
  const got = set(calls());
  assert.equal(got["revive.agent"], "droid");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--auto","high"]');
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

test("omp's SessionStart is remembered with the command line its extension sends", () => {
  // omp renames its process `omp`: the foreground shows no flags.
  const { run, calls, set } = setup({ bin: "omp", argv: ["omp"], app: "omp" });
  const transcript = `/home/me/.omp/agent/sessions/-w/2026-01-01T00-00-00-000Z_${ID}.jsonl`;
  run({ ...start, transcript_path: transcript, argv: ["omp", "--model", "opus", "-e", "/x.ts", "fix it"] });
  const got = set(calls());
  assert.equal(got["revive.agent"], "omp");
  assert.equal(got["revive.session"], ID);
  assert.equal(got["revive.flags"], '["--model","opus"]');
  assert.equal(got["revive.transcript"], transcript);
});

test("check resumes into the folder's real path, and only hints at a session it can't resume by itself", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "revive-check-")));
  const work = join(dir, "work");
  mkdirSync(work);
  symlinkSync(work, join(dir, "link"));
  const config = join(dir, "config");
  mkdirSync(join(config, "projects", work.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true });
  writeFileSync(join(config, "projects", work.replace(/[^A-Za-z0-9]/g, "-"), `${ID}.jsonl`), "{}\n");
  const check = (labels, env = { CLAUDE_CONFIG_DIR: config }) => {
    writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
    rmSync(join(dir, "label.log"), { force: true });
    writeFileSync(join(dir, "hc"), `#!/usr/bin/env node
const fs = require("fs"); const [cmd, t, ...rest] = process.argv.slice(2);
if (cmd === "get") console.log(JSON.stringify({ address: t, state: "live", pid: 4242, labels: JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "labels.json"))}, "utf8")) }));
else if (cmd === "label") fs.appendFileSync(${JSON.stringify(join(dir, "label.log"))}, rest.join(" ") + "\\n");
`);
    chmodSync(join(dir, "hc"), 0o755);
    const out = execFileSync("node", [ENGINE, "check", "--shell", "4242"], { encoding: "utf8", env: { ...base, REVIVE_HC: join(dir, "hc"), HC_TERMINAL_ID: "t1", ...env } });
    return { out, labelled: existsSync(join(dir, "label.log")) ? readFileSync(join(dir, "label.log"), "utf8") : "" };
  };
  const rec = { "revive.agent": "claude", "revive.session": ID, "revive.shell": "1", "revive.cwd": join(dir, "link") };
  const ok = check(rec);
  assert.match(ok.out, new RegExp(`cd -- ${work.replace(/[/.]/g, "\\$&")} && claude --resume ${ID}`));
  // The shell sets the variable itself: its own folder, so the need is met.
  assert.match(check({ ...rec, "revive.needs": '["CLAUDE_CONFIG_DIR"]' }).out, /claude --resume/);
  const hinted = check({ ...rec, "revive.needs": '["CLAUDE_CONFIG_DIR"]' }, {});
  assert.doesNotMatch(hinted.out, /--resume/);
  assert.match(hinted.out, /not resuming Claude Code session .*CLAUDE_CONFIG_DIR/);
  assert.match(hinted.labelled, /revive\.failed=\d+/, "said once: the next shell stays quiet");
  const gone = check({ ...rec, "revive.cwd": join(dir, "gone") });
  assert.match(gone.out, /folder is missing or not yours/);
});
