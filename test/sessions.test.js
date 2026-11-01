// Finding a running agent's session from the files it writes, for a session
// started before Revive's hooks were installed. Fake stores in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDirs, findSession, sessionDir } from "../mods/revive/lib/sessions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const CWD = "/Users/me/code/my.app";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (path, ms) => utimesSync(path, ms / 1000, ms / 1000);

const home = () => mkdtempSync(join(tmpdir(), "revive-sessions-"));

test("store folders follow HOME and the agents' own variables", () => {
  const dirs = agentDirs({ HOME: "/h" });
  assert.equal(dirs.claude, "/h/.claude");
  assert.equal(dirs.factory, "/h/.factory");
  assert.equal(dirs.cursor, "/h/.cursor");
  assert.equal(agentDirs({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }).claude, "/c");
});

test("each agent's per-folder store is named after the folder", () => {
  const dirs = agentDirs({ HOME: "/h" });
  assert.equal(sessionDir("droid", dirs, CWD), "/h/.factory/sessions/-Users-me-code-my-app");
  assert.equal(sessionDir("cursor", dirs, CWD), `/h/.cursor/chats/${createHash("md5").update(CWD).digest("hex")}`);
  assert.equal(sessionDir("codex", dirs, CWD), null);
});

test("Claude Code's session is read from its pid file", () => {
  const h = home();
  mkdirSync(join(h, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(h, ".claude", "sessions", "4242.json"), JSON.stringify({ sessionId: A }));
  const dirs = agentDirs({ HOME: h });
  assert.equal(findSession("claude", { dirs, pid: 4242 }), A);
  assert.equal(findSession("claude", { dirs, pid: 1 }), null);
});

test("droid: the newest session file for the folder written since the agent started", () => {
  const h = home();
  const dirs = agentDirs({ HOME: h });
  const dir = sessionDir("droid", dirs, CWD);
  mkdirSync(dir, { recursive: true });
  for (const [id, ms] of [[A, T0 - 60_000], [B, T0 + 5_000], [C, T0 + 9_000]]) {
    writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
    at(join(dir, `${id}.jsonl`), ms);
  }
  // Not sessions: another kind of file, a bad name.
  writeFileSync(join(dir, `${C}.settings.json`), "{}");
  at(join(dir, `${C}.settings.json`), T0 + 99_000);
  writeFileSync(join(dir, "bad id.jsonl"), "{}");
  at(join(dir, "bad id.jsonl"), T0 + 99_000);
  // Another folder's newer session.
  const other = sessionDir("droid", dirs, "/elsewhere");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, `${A}.jsonl`), "{}");
  at(join(other, `${A}.jsonl`), T0 + 99_000);

  assert.equal(findSession("droid", { dirs, cwd: CWD, startedMs: T0 }), C);
  assert.equal(findSession("droid", { dirs, cwd: CWD, startedMs: T0 + 60_000 }), null, "nothing written since it started");
  assert.equal(findSession("droid", { dirs, cwd: "/nowhere", startedMs: T0 }), null);
  assert.equal(findSession("droid", { dirs, cwd: null, startedMs: T0 }), null);
});

test("cursor: the newest chat folder for the workspace written since the agent started", () => {
  const h = home();
  const dirs = agentDirs({ HOME: h });
  const dir = sessionDir("cursor", dirs, CWD);
  for (const [id, ms] of [[A, T0 - 60_000], [B, T0 + 5_000], [C, T0 + 2_000]]) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "store.db"), "");
    at(join(dir, id, "store.db"), ms);
    at(join(dir, id), Math.min(ms, T0 - 120_000));
  }
  // The chat written last is the one in use, even if its folder is older.
  assert.equal(findSession("cursor", { dirs, cwd: CWD, startedMs: T0 }), B);
  mkdirSync(join(dir, "not-a-chat id"));
  assert.equal(findSession("cursor", { dirs, cwd: CWD, startedMs: T0 }), B);
  assert.equal(findSession("cursor", { dirs, cwd: CWD, startedMs: T0 + 60_000 }), null);
  assert.equal(findSession("cursor", { dirs, cwd: "/nowhere", startedMs: T0 }), null);
});

test("an agent without a finder finds nothing", () => {
  assert.equal(findSession("codex", { dirs: agentDirs({ HOME: home() }), pid: 1, cwd: CWD, startedMs: T0 }), null);
  assert.equal(findSession("vim", { dirs: agentDirs({ HOME: home() }) }), null);
});
