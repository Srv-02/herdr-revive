// Factory Droid and Cursor CLI: recognized, their flags carried, their
// sessions resumed (and forked where the agent can), their hook payloads read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentKey, carriedFlags, command, canFork, hookPayload, endAction } from "../mods/revive/lib/core.js";

const ID = "5f1d6a52-8c39-4a0e-9b0d-2a7c1e9f0b11";

test("droid is known by its command line and its report", () => {
  assert.equal(agentKey(null, ["droid"]), "droid");
  assert.equal(agentKey(null, ["/Users/me/.local/bin/droid", "--auto", "high"]), "droid");
  assert.equal(agentKey(null, ["node", "/opt/factory/bin/droid"]), "droid");
  assert.equal(agentKey("droid"), "droid");
});

test("cursor-agent is known by its command line and its report", () => {
  assert.equal(agentKey(null, ["cursor-agent", "--force"]), "cursor");
  assert.equal(agentKey(null, ["/Users/me/.local/bin/cursor-agent"]), "cursor");
  // The installer's launcher execs its bundled node on the versioned index.js.
  assert.equal(agentKey(null, ["/Users/me/.local/share/cursor-agent/versions/2026.10.1-abc/node", "--use-system-ca", "/Users/me/.local/share/cursor-agent/versions/2026.10.1-abc/index.js"]), "cursor");
  assert.equal(agentKey("cursor-agent"), "cursor");
  assert.equal(agentKey("cursor"), "cursor");
});

test("`agent` is Cursor only when its path or its report says so", () => {
  assert.equal(agentKey(null, ["/Users/me/.local/share/cursor-agent/versions/1/agent"]), "cursor");
  assert.equal(agentKey(null, ["/opt/cursor/bin/agent", "--yolo"]), "cursor");
  assert.equal(agentKey("cursor", ["agent"]), "cursor", "a bare `agent` that reports itself as Cursor");
  assert.equal(agentKey(null, ["agent"]), null, "a bare `agent` could be anything");
  assert.equal(agentKey(null, ["/usr/local/bin/agent", "--model", "x"]), null);
  assert.equal(agentKey(null, ["ssh-agent", "-s"]), null);
  assert.equal(agentKey(null, ["/usr/bin/gpg-agent", "--daemon"]), null);
  assert.equal(agentKey(null, ["node", "/home/me/my-agent/index.js"]), null);
  assert.equal(agentKey(null, ["/bin/zsh", "-l"]), null);
});

test("droid carries only its interactive flags; exec-only flags read as a prompt", () => {
  // Interactive droid 1.1.0 takes --auto, --settings, --append-system-prompt(-file),
  // --use-spec and --disable-builtin-skills. --skip-permissions-unsafe, -m and the
  // reasoning/tool flags are `droid exec` only: interactive droid reads them as the prompt.
  assert.deepEqual(
    carriedFlags("droid", ["droid", "--auto", "high", "--use-spec", "--resume", "old", "fix the bug"]),
    ["--auto", "high", "--use-spec"],
  );
  assert.deepEqual(carriedFlags("droid", ["droid", "--skip-permissions-unsafe", "-m", "gpt-5", "--reasoning-effort", "high"]), []);
  assert.deepEqual(carriedFlags("droid", ["droid", "--settings", "/s.json", "--cwd", "/elsewhere", "-w", "tree", "--fork", "y"]), ["--settings", "/s.json"]);
  assert.deepEqual(carriedFlags("droid", ["droid", "--append-system-prompt-file", "/p.md", "--disable-builtin-skills"]), ["--append-system-prompt-file", "/p.md", "--disable-builtin-skills"]);
  assert.deepEqual(carriedFlags("droid", ["droid", "constructor"]), []);
});

test("cursor carries force, model, sandbox and mode, and never a key or a header", () => {
  assert.deepEqual(
    carriedFlags("cursor", ["cursor-agent", "-f", "--model", "gpt-5", "--sandbox", "disabled", "--resume", "old", "write tests"]),
    ["-f", "--model", "gpt-5", "--sandbox", "disabled"],
  );
  // cursor-agent 2026.10.22 has --model but no -m.
  assert.deepEqual(carriedFlags("cursor", ["agent", "--yolo", "--force", "--model", "sonnet-4", "--approve-mcps", "--plan"]), ["--yolo", "--force", "--model", "sonnet-4", "--approve-mcps", "--plan"]);
  assert.deepEqual(carriedFlags("cursor", ["cursor-agent", "--api-key", "sk-secret", "-H", "Authorization: x", "--print", "-p", "hi", "--mode=ask"]), ["--mode=ask"]);
  assert.deepEqual(
    carriedFlags("cursor", ["/x/cursor-agent/versions/1/node", "--use-system-ca", "/x/cursor-agent/versions/1/index.js", "--force", "do it"]),
    ["--force"],
  );
});

test("resume commands are built exactly", () => {
  assert.deepEqual(command({ agent: "droid", session: ID, flags: ["--auto", "high"] }, "resume"), ["droid", "--auto", "high", "--resume", ID]);
  assert.deepEqual(command({ agent: "cursor", session: ID, flags: ["--force", "--model", "gpt-5"] }, "resume"), ["cursor-agent", "--force", "--model", "gpt-5", "--resume", ID]);
  assert.equal(command({ agent: "cursor", session: "bad id" }, "resume"), null);
});

test("droid forks with --fork; Cursor has no fork", () => {
  assert.deepEqual(command({ agent: "droid", session: ID, flags: ["--auto", "high"] }, "fork"), ["droid", "--auto", "high", "--fork", ID]);
  assert.equal(command({ agent: "cursor", session: ID, flags: [] }, "fork"), null);
  assert.equal(canFork("claude"), true);
  assert.equal(canFork("codex"), true);
  assert.equal(canFork("droid"), true);
  assert.equal(canFork("cursor"), false);
  assert.equal(canFork("vim"), false);
});

test("hook payloads read the same for every agent", () => {
  // Claude Code, Codex and Droid: Claude's format.
  assert.deepEqual(
    hookPayload({ hook_event_name: "SessionStart", session_id: ID, cwd: "/w", transcript_path: "/Users/me/.factory/projects/-w/x.jsonl", source: "startup" }),
    { event: "SessionStart", session: ID, cwd: "/w", reason: null, agent: "droid" },
  );
  assert.equal(hookPayload({ hook_event_name: "SessionStart", session_id: ID, transcript_path: "/Users/me/.claude/projects/-w/x.jsonl" }).agent, "claude");
  assert.equal(hookPayload({ hook_event_name: "SessionStart", session_id: ID, transcript_path: "/Users/me/.codex/sessions/x.jsonl" }).agent, "codex");
  // Cursor: camelCase events, the chat as conversation_id, the folder as workspace_roots.
  assert.deepEqual(
    hookPayload({ hook_event_name: "sessionStart", conversation_id: ID, generation_id: ID, workspace_roots: ["/w"], cursor_version: "2026.10.1", transcript_path: null }),
    { event: "SessionStart", session: ID, cwd: "/w", reason: null, agent: "cursor" },
  );
  assert.deepEqual(
    hookPayload({ hook_event_name: "sessionEnd", session_id: ID, conversation_id: ID, reason: "completed", cursor_version: "x" }),
    { event: "SessionEnd", session: ID, cwd: null, reason: "completed", agent: "cursor" },
  );
  assert.equal(hookPayload({}).session, null);
  assert.equal(hookPayload(null).event, null);
});

test("how each agent's SessionEnd reasons are taken", () => {
  for (const key of ["claude", "codex", "droid"]) {
    assert.equal(endAction(key, "prompt_input_exit"), "forget", key);
    assert.equal(endAction(key, "logout"), "forget", key);
    assert.equal(endAction(key, "other"), "keep", key);
    assert.equal(endAction(key, "clear"), "ignore", key);
    assert.equal(endAction(key, "resume"), "ignore", key);
  }
  assert.equal(endAction("cursor", "completed"), "forget");
  assert.equal(endAction("cursor", "user_close"), "forget");
  assert.equal(endAction("cursor", "aborted"), "keep");
  assert.equal(endAction("cursor", "error"), "keep");
  assert.equal(endAction("cursor", "window_close"), "keep");
  assert.equal(endAction("cursor", undefined), "keep");
});
