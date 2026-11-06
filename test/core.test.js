import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentKey, agentEnv, carriedFlags, isOneShot, validId, command, shQuote, shJoin, readRecord, labelArgs, clearArgs,
  stateOf, shouldResume, resumeScript, ago,
} from "../mods/revive/lib/core.js";

const ID = "9e458eb4-72c3-41c2-88bf-2f7f79f3716f";
const labels = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`revive.${k}`, String(v)]));

test("agents are known by their report or their command line", () => {
  assert.equal(agentKey("claude-code"), "claude");
  assert.equal(agentKey("codex"), "codex");
  assert.equal(agentKey(null, ["claude", "--model", "opus"]), "claude");
  assert.equal(agentKey(null, ["/opt/homebrew/bin/claude"]), "claude");
  assert.equal(agentKey(null, ["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex"]), "codex");
  assert.equal(agentKey(null, ["/bin/zsh", "-l"]), null);
  assert.equal(agentKey("pi"), "pi");
  assert.equal(agentKey(null, ["pi", "--model", "sonnet"]), "pi");
  assert.equal(agentKey(null, ["/nix/store/x/bin/pi"]), "pi");
  for (const argv of [["ssh", "pi"], ["vim", "pi"], ["less", "/tmp/pi"]]) assert.equal(agentKey(null, argv), null, argv.join(" "));
  assert.equal(agentKey("vim", ["vim"]), null);
});

test("only the launch flags worth keeping are carried, values included", () => {
  assert.deepEqual(
    carriedFlags("claude", ["claude", "--permission-mode", "plan", "--model", "haiku", "--resume", "x", "fix the bug"]),
    ["--permission-mode", "plan", "--model", "haiku"],
  );
  assert.deepEqual(carriedFlags("claude", ["claude", "--model=opus", "-p", "hi"]), ["--model=opus"]);
  assert.deepEqual(carriedFlags("codex", ["node", "/x/codex", "--no-daemon", "-m", "gpt-5", "-s", "workspace-write", "task"]), ["--no-daemon", "-m", "gpt-5", "-s", "workspace-write"]);
  // A value flag without its value is dropped, not carried bare.
  assert.deepEqual(carriedFlags("claude", ["claude", "--model"]), []);
  assert.deepEqual(carriedFlags("nope", ["x", "--model", "y"]), []);
  assert.deepEqual(
    carriedFlags("pi", ["pi", "--provider", "anthropic", "--model", "sonnet", "--thinking", "high", "-t", "read,bash", "-e", "/x/ext.ts", "--session", "x", "fix it"]),
    ["--provider", "anthropic", "--model", "sonnet", "--thinking", "high", "-t", "read,bash"],
  );
});

test("permission and sandbox modes come back as they ran", () => {
  const same = {
    claude: [["--dangerously-skip-permissions"], ["--allow-dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"], ["--permission-mode=bypassPermissions"]],
    codex: [["--dangerously-bypass-approvals-and-sandbox"], ["--yolo"], ["--full-auto"], ["--approve-for-me"], ["-a", "never"], ["--ask-for-approval", "never"],
      ["-s", "danger-full-access"], ["--sandbox=danger-full-access"]],
    pi: [["-a"], ["--approve"]],
    omp: [["--auto-approve"], ["--approval-mode", "yolo"], ["--approval-mode=yolo"], ["--plan-yolo"]],
    droid: [["--auto", "high"]],
    cursor: [["-f"], ["--force"], ["--yolo"], ["--sandbox", "disabled"]],
  };
  for (const [key, cases] of Object.entries(same)) {
    for (const flags of cases) assert.deepEqual(carriedFlags(key, ["x", ...flags]), flags, `${key} ${flags.join(" ")}`);
  }
  // Read back from a label, too.
  assert.deepEqual(readRecord(labels({ agent: "codex", session: ID, flags: '["--dangerously-bypass-approvals-and-sandbox","-s","danger-full-access"]' })).flags,
    ["--dangerously-bypass-approvals-and-sandbox", "-s", "danger-full-access"]);
});

test("flags that load code, configuration, instructions or folders are never carried", () => {
  const never = {
    claude: [["--settings", "/s.json"], ["--settings={\"hooks\":{}}"], ["--mcp-config", "/m.json"], ["--plugin-dir", "/p"], ["--add-dir", "/"], ["--add-dir=/"],
      ["--append-system-prompt", "x"], ["--system-prompt", "x"]],
    codex: [["-c", "x=y"], ["--config", "x=y"], ["--dangerously-bypass-hook-trust"], ["--profile", "../x"]],
    pi: [["-e", "/x.ts"], ["--extension", "/x.ts"], ["--skill", "/s"], ["--system-prompt", "x"], ["--append-system-prompt", "x"], ["--session-dir", "/s"]],
    omp: [["-e", "/x.ts"], ["--extension", "/x.ts"], ["--hook", "/h.ts"], ["--config", "/c.yml"], ["--add-dir", "/"], ["--allow-home"], ["--session-dir", "/s"],
      ["--system-prompt", "x"], ["--system-prompt-template", "x"], ["--append-system-prompt", "x"], ["--api-key", "k"], ["--profile", "../../x"]],
    droid: [["--settings", "/s.json"], ["--append-system-prompt", "x"], ["--append-system-prompt-file", "/p"]],
    cursor: [["--approve-mcps"], ["--plugin-dir", "/p"], ["--api-key", "k"]],
  };
  for (const [key, cases] of Object.entries(never)) {
    for (const flags of cases) assert.deepEqual(carriedFlags(key, ["x", ...flags]), [], `${key} ${flags.join(" ")}`);
  }
});

test("a value that looks like a flag is not taken as a value", () => {
  // `--model --settings /s.json` must not carry --settings as the model's value.
  assert.deepEqual(carriedFlags("claude", ["claude", "--model", "--settings", "/s.json", "--agent", "rev"]), ["--agent", "rev"]);
  assert.deepEqual(carriedFlags("omp", ["omp", "--model", "-e", "/x.ts"]), []);
});

test("a first prompt named like an object's own property is not a flag", () => {
  for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.deepEqual(carriedFlags("claude", ["claude", word]), [], word);
    assert.deepEqual(carriedFlags("claude", ["claude", `--${word}=x`]), [], word);
  }
});

test("a new shell with an old shell's pid is still a new shell", () => {
  const rec = readRecord(labels({ agent: "claude", session: ID, shell: 812, since: "Sat Oct 31 18:49:55 2026" }));
  assert.equal(shouldResume(rec, { pid: 812, since: "Sun Nov 1 09:02:11 2026", shellPid: 812 }).go, true, "pid reused after a reboot");
  assert.equal(shouldResume(rec, { pid: 812, since: "Sat Oct 31 18:49:55 2026", shellPid: 812 }).go, false);
  assert.equal(shouldResume(rec, { pid: 812, since: null, shellPid: 812 }).go, false, "no start time: pids decide");
  assert.equal(stateOf(rec, { live: false, pid: 812, since: "Sun Nov 1 09:02:11 2026" }), "lost");
  assert.equal(stateOf(rec, { live: false, pid: 812, since: "Sat Oct 31 18:49:55 2026" }), "interrupted");
});

test("session ids are checked, not quoted", () => {
  assert.ok(validId(ID));
  assert.ok(!validId(""));
  assert.ok(!validId("abc; rm -rf ~"));
  assert.ok(!validId("$(id)"));
  assert.ok(!validId("-rf"));
  assert.ok(!validId(42));
});

test("resume and fork commands per agent", () => {
  assert.deepEqual(command({ agent: "claude", session: ID, flags: ["--model", "opus"] }, "resume"), ["claude", "--model", "opus", "--resume", ID]);
  assert.deepEqual(command({ agent: "claude", session: ID, flags: [] }, "fork"), ["claude", "--resume", ID, "--fork-session"]);
  assert.deepEqual(command({ agent: "codex", session: ID, flags: ["--no-daemon"] }, "resume"), ["codex", "resume", "--no-daemon", ID]);
  assert.deepEqual(command({ agent: "codex", session: ID, flags: [] }, "fork"), ["codex", "fork", ID]);
  assert.deepEqual(command({ agent: "pi", session: ID, flags: ["--model", "sonnet"] }, "resume"), ["pi", "--model", "sonnet", "--session", ID]);
  assert.deepEqual(command({ agent: "pi", session: ID, flags: [] }, "fork"), ["pi", "--fork", ID]);
  // A config folder is never set from a record: the resuming shell's own counts.
  assert.deepEqual(command({ agent: "pi", session: ID, env: { PI_CODING_AGENT_DIR: "/p" } }), ["pi", "--session", ID]);
  assert.equal(command({ agent: "claude", session: "x y" }), null);
  assert.equal(command({ agent: "vim", session: ID }), null);
  assert.equal(command(null), null);
});

test("shell quoting survives the shell", () => {
  const words = ["plain", "with space", "it's", "$HOME", "`id`", "a\"b", "", "--model=opus"];
  const out = execFileSync("sh", ["-c", `printf '%s\\n' ${shJoin(words)}`], { encoding: "utf8" });
  assert.deepEqual(out.split("\n").slice(0, -1), words);
  assert.equal(shQuote("simple/path-1.2"), "simple/path-1.2");
});

test("labels read back as a record", () => {
  // `ended` from older versions is read past.
  const rec = readRecord(labels({ agent: "claude", session: ID, cwd: "/w", flags: '["--model","opus"]', shell: 41, at: 5, ended: "other" }));
  assert.deepEqual(rec, { agent: "claude", session: ID, cwd: "/w", flags: ["--model", "opus"], env: {}, needs: [], transcript: null, shell: 41, since: null, at: 5, resumed: null, failed: null, auto: true });
  assert.equal(readRecord({}), null);
  assert.equal(readRecord(undefined), null);
  assert.deepEqual(readRecord(labels({ session: ID, flags: "{broken" })).flags, []);
  // Flags read back pass the carry list again: a label is not proof Revive wrote it.
  assert.deepEqual(readRecord(labels({ agent: "claude", session: ID, flags: '["--dangerously-skip-permissions","--settings","/s.json","--model","opus","--mcp-config","/m.json"]' })).flags, ["--dangerously-skip-permissions", "--model", "opus"]);
  assert.deepEqual(readRecord(labels({ agent: "omp", session: ID, flags: '["-e","/x.ts","--model","opus","--hook","/h.ts"]' })).flags, ["--model", "opus"]);
  assert.deepEqual(readRecord(labels({ session: ID, flags: '["--model","opus"]' })).flags, [], "no agent, no carry list");
  assert.deepEqual(readRecord(labels({ agent: "claude", session: ID, flags: '{"0":"--settings"}' })).flags, []);
  assert.equal(readRecord(labels({ session: ID, auto: "off" })).auto, false);
});

test("label arguments set, and empty values remove", () => {
  assert.deepEqual(labelArgs({ session: ID, ended: null, shell: 3 }), [`revive.session=${ID}`, "revive.ended=", "revive.shell=3"]);
  const cleared = clearArgs();
  assert.ok(cleared.includes("revive.session="));
  assert.ok(!cleared.some((a) => a.startsWith("revive.auto")), "the person's auto choice outlives a session");
});

test("where a session stands", () => {
  const rec = readRecord(labels({ agent: "claude", session: ID, shell: 100 }));
  assert.equal(stateOf(rec, { live: true, pid: 100 }), "running");
  assert.equal(stateOf(rec, { live: false, pid: 200 }), "lost");
  assert.equal(stateOf(rec, { live: false, pid: 100 }), "interrupted");
  assert.equal(stateOf({ ...rec, failed: 9 }, { live: false, pid: 200 }), "failed");
  assert.equal(stateOf(null, { live: false, pid: 1 }), null);
});

test("a shell resumes only its own terminal's lost session", () => {
  const rec = readRecord(labels({ agent: "claude", session: ID, shell: 100 }));
  assert.equal(shouldResume(rec, { pid: 200, shellPid: 200 }).go, true);
  assert.equal(shouldResume(rec, { pid: 100, shellPid: 100 }).go, false, "same shell: the agent quit, nothing was lost");
  assert.equal(shouldResume(rec, { pid: 200, shellPid: 333 }).go, false, "a shell started inside the terminal");
  assert.equal(shouldResume(rec, { pid: 200, shellPid: 200, env: { REVIVE_AUTO: "0" } }).go, false);
  assert.equal(shouldResume({ ...rec, auto: false }, { pid: 200, shellPid: 200 }).go, false);
  assert.equal(shouldResume({ ...rec, session: "bad id" }, { pid: 200, shellPid: 200 }).go, false);
  assert.equal(shouldResume({ ...rec, agent: "vim" }, { pid: 200, shellPid: 200 }).go, false);
  assert.equal(shouldResume(rec, { pid: null, shellPid: 200 }).go, false);
  assert.equal(shouldResume(null, { pid: 1, shellPid: 1 }).go, false);
});

test("a resume that failed is not tried again at the next restart", () => {
  const rec = readRecord(labels({ agent: "claude", session: ID, shell: 100, failed: 9 }));
  const verdict = shouldResume(rec, { pid: 200, shellPid: 200 });
  assert.equal(verdict.go, false);
  assert.equal(verdict.why, "the last resume failed");
});

test("a run that answers and quits is told from a session", () => {
  assert.equal(isOneShot("claude", ["claude", "-p", "summarize"]), true);
  assert.equal(isOneShot("claude", ["/usr/local/bin/claude", "--model", "opus", "--print", "hi"]), true);
  assert.equal(isOneShot("claude", ["node", "/x/bin/claude", "-p", "hi"]), true);
  assert.equal(isOneShot("claude", ["claude", "--model", "opus"]), false);
  assert.equal(isOneShot("claude", ["claude", "--permission-mode", "plan"]), false, "a flag that only contains p");
  assert.equal(isOneShot("codex", ["codex", "exec", "fix it"]), true);
  assert.equal(isOneShot("codex", ["codex", "e", "fix it"]), true);
  assert.equal(isOneShot("codex", ["codex", "-p", "work"]), false, "codex's -p is --profile");
  assert.equal(isOneShot("codex", ["codex", "resume", ID]), false);
  assert.equal(isOneShot("pi", ["pi", "-p", "hi"]), true);
  assert.equal(isOneShot("pi", ["pi", "--mode", "json", "hi"]), true);
  assert.equal(isOneShot("pi", ["pi", "--mode=rpc"]), true);
  assert.equal(isOneShot("pi", ["pi", "--no-session"]), true, "nothing saved, nothing to bring back");
  assert.equal(isOneShot("pi", ["pi", "--mode", "text", "--model", "sonnet"]), false);
  assert.equal(isOneShot("vim", ["vim", "-p"]), false);
});

test("a session keeps its agent's config folder, and only that", () => {
  assert.deepEqual(agentEnv("claude", { CLAUDE_CONFIG_DIR: "/h/.claude-work", CODEX_HOME: "/c", PATH: "/bin" }), { CLAUDE_CONFIG_DIR: "/h/.claude-work" });
  assert.deepEqual(agentEnv("codex", { CODEX_HOME: "/c" }), { CODEX_HOME: "/c" });
  assert.deepEqual(agentEnv("claude", { CLAUDE_CONFIG_DIR: "" }), {});
  // Older records held values: neither they nor a variable the agent doesn't declare are used.
  const rec = readRecord(labels({ agent: "claude", session: ID, env: JSON.stringify({ CLAUDE_CONFIG_DIR: "/h/my work", LD_PRELOAD: "/evil.so" }) }));
  assert.deepEqual(rec.env, {});
  assert.deepEqual(rec.needs, ["CLAUDE_CONFIG_DIR"]);
  assert.deepEqual(command(rec), ["claude", "--resume", ID]);
  assert.deepEqual(command(rec, "fork"), ["claude", "--resume", ID, "--fork-session"]);
  assert.doesNotMatch(resumeScript({ ...rec, cwd: "/w" }, "/e"), /CLAUDE_CONFIG_DIR/);
  assert.deepEqual(readRecord(labels({ agent: "claude", session: ID, env: "{broken" })).needs, []);
  assert.deepEqual(readRecord(labels({ agent: "claude", session: ID, needs: '["CLAUDE_CONFIG_DIR","LD_PRELOAD","--settings"]' })).needs, ["CLAUDE_CONFIG_DIR"]);
  assert.deepEqual(command(readRecord(labels({ agent: "claude", session: ID }))), ["claude", "--resume", ID], "no variables, no env");
});

test("the resume script runs the agent in its folder and reports a quick failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-"));
  const work = join(dir, "it's here");
  execFileSync("mkdir", ["-p", work]);
  // A fake agent that records where and how it ran, then fails like a missing session.
  writeFileSync(join(dir, "claude"), `#!/bin/sh\npwd -P > "${dir}/where"\nprintf '%s\\n' "$@" > "${dir}/argv"\nexit 1\n`);
  writeFileSync(join(dir, "node"), `#!/bin/sh\necho "$2" > "${dir}/node"\n`);
  chmodSync(join(dir, "claude"), 0o755);
  chmodSync(join(dir, "node"), 0o755);
  const rec = { agent: "claude", session: ID, cwd: work, flags: ["--model", "opus"] };
  const script = resumeScript(rec, "/x/revive.mjs");
  // No terminal to hand over: everything runs on the shell's own output.
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIVE_TTY: join(dir, "missing", "tty") };
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8", env });
  assert.match(out, /Revive: resuming Claude Code session 9e458eb4/);
  assert.equal(readFileSync(join(dir, "where"), "utf8").trim(), execFileSync("sh", ["-c", `cd "${work}" && pwd -P`], { encoding: "utf8" }).trim());
  assert.deepEqual(readFileSync(join(dir, "argv"), "utf8").trim().split("\n"), ["--model", "opus", "--resume", ID]);
  assert.equal(readFileSync(join(dir, "node"), "utf8").trim(), "failed");
  assert.equal(resumeScript({ agent: "claude", session: "x;y" }, "/x"), "");
});

test("the agent is handed the terminal, even when the shell's output is held", () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-"));
  // The agent reports whether its stdout is the terminal device it was given.
  writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "agent ran"\nexit 0\n`);
  chmodSync(join(dir, "claude"), 0o755);
  const tty = join(dir, "tty");
  writeFileSync(tty, "");
  const script = resumeScript({ agent: "claude", session: ID, cwd: null, flags: [] }, "/x/revive.mjs");
  const out = execFileSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIVE_TTY: tty } });
  assert.equal(out, "", "nothing on the held output");
  const seen = readFileSync(tty, "utf8");
  assert.match(seen, /Revive: resuming/);
  assert.match(seen, /agent ran/);
});

test("ago", () => {
  assert.equal(ago(null), "");
  assert.equal(ago(1000, 1000 + 30_000), "just now");
  assert.equal(ago(0 + 1, 1 + 5 * 60_000), "5m ago");
  assert.equal(ago(1, 1 + 3 * 3600_000), "3h ago");
  assert.equal(ago(1, 1 + 2 * 86400_000), "2d ago");
});
