import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, symlinkSync, lstatSync, statSync, realpathSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withHooks, hasHooks, withShellBlock, shellBlock } from "../mods/revive/revive.mjs";

const ENGINE = resolve("mods/revive/revive.mjs");
const theirs = { type: "command", command: "~/bin/notify.sh" };
// The test runner's own pi folder must not be installed into.
delete process.env.PI_CODING_AGENT_DIR;

test("hooks are added beside the person's own, once", () => {
  const before = { model: "opus", hooks: { SessionStart: [{ hooks: [theirs] }], Stop: [{ hooks: [theirs] }] } };
  const once = withHooks(before);
  const twice = withHooks(once);
  assert.deepEqual(twice, once, "installing again changes nothing");
  assert.ok(hasHooks(once));
  assert.equal(once.model, "opus");
  assert.deepEqual(once.hooks.Stop, before.hooks.Stop);
  assert.deepEqual(once.hooks.SessionStart[0], { hooks: [theirs] });
  assert.equal(once.hooks.SessionStart.length, 2);
  assert.equal(once.hooks.SessionEnd.length, 1);
  assert.deepEqual(before.hooks.SessionStart, [{ hooks: [theirs] }], "the input is not changed");
});

test("removing takes out only Revive's hooks", () => {
  const before = { hooks: { SessionStart: [{ hooks: [theirs] }] } };
  assert.deepEqual(withHooks(withHooks(before), { remove: true }), before);
  assert.deepEqual(withHooks(withHooks({}), { remove: true }), {});
  assert.ok(!hasHooks({}));
});

test("Codex groups carry an empty matcher", () => {
  const codex = withHooks({}, { matcher: true });
  assert.equal(codex.hooks.SessionStart[0].matcher, "");
});

test("hooks already in place stay where another tool put them", () => {
  // Another tool appended its group after Revive's: installing again must not
  // move Revive's back to the end.
  const installed = withHooks({});
  installed.hooks.SessionStart.push({ hooks: [theirs] });
  assert.deepEqual(withHooks(installed), installed);
});

test("an outdated Revive hook is replaced", () => {
  const old = withHooks({});
  old.hooks.SessionEnd[0].hooks[0].timeout = 30;
  assert.equal(withHooks(old).hooks.SessionEnd[0].hooks[0].timeout, 10);
  assert.equal(withHooks(old).hooks.SessionEnd.length, 1);
});

test("Codex's SessionEnd hook gets the 3 second timeout Codex allows", () => {
  const codex = withHooks({}, { matcher: true, timeouts: { SessionEnd: 3 } });
  assert.equal(codex.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(codex.hooks.SessionStart[0].hooks[0].timeout, 10);
});

test("the shell block is added once and removed whole", () => {
  const rc = "export PATH=$HOME/bin:$PATH\nalias ll='ls -l'\n";
  const once = withShellBlock(rc);
  assert.equal(withShellBlock(once), once);
  assert.ok(once.startsWith(rc));
  assert.equal(withShellBlock(once, { remove: true }).trim(), rc.trim());
  assert.equal(withShellBlock("", { remove: true }).trim(), "");
});

for (const sh of ["sh", "bash", "zsh"]) {
  test(`the shell block is valid ${sh}`, (t) => {
    try { execFileSync("sh", ["-c", `command -v ${sh}`]); } catch { t.skip(`${sh} not installed`); return; }
    execFileSync(sh, ["-n", "-c", shellBlock("/a path/with 'quotes'/revive.mjs")]);
  });
}

test("outside herdr the block does nothing", () => {
  const out = execFileSync("sh", ["-c", `${shellBlock(ENGINE)}\necho ok`], { encoding: "utf8", env: { ...process.env, HC_TERMINAL_ID: "" } });
  assert.equal(out, "ok\n");
});

test("install and uninstall touch only what they own, with backups", () => {
  const home = mkdtempSync(join(tmpdir(), "revive-home-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [theirs] }] } }));
  writeFileSync(join(home, ".zshrc"), "alias g=git\n");
  const env = { ...process.env, HOME: home, SHELL: "/bin/zsh", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", ZDOTDIR: "" };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; delete env.ZDOTDIR;
  const run = (...args) => execFileSync("node", [ENGINE, ...args], { encoding: "utf8", env });

  run("install");
  const doctor = JSON.parse(run("doctor"));
  assert.equal(doctor.claude, true);
  assert.equal(doctor.codex, true);
  assert.equal(doctor.shell.zsh, true);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).theme, "dark");
  assert.ok(existsSync(`${settings}.revive-backup`));
  assert.match(run("install"), /Nothing to change/);
  assert.equal(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.SessionEnd[0].hooks[0].timeout, 3);

  // Another tool rewrites the files with sorted keys: the hooks are still
  // there, so install leaves them alone and says so.
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  for (const file of [settings, join(home, ".codex", "hooks.json")]) {
    writeFileSync(file, JSON.stringify(sorted(JSON.parse(readFileSync(file, "utf8")))));
  }
  const reformatted = readFileSync(settings, "utf8");
  assert.match(run("install"), /Nothing to change/);
  assert.equal(readFileSync(settings, "utf8"), reformatted);

  run("uninstall");
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { theme: "dark", hooks: { Stop: [{ hooks: [theirs] }] } });
  assert.equal(readFileSync(join(home, ".zshrc"), "utf8").trim(), "alias g=git");
  const after = JSON.parse(run("doctor"));
  assert.equal(after.claude, false);
  assert.equal(after.shell.zsh, false);
  // The backup is still the person's original, not the installed version.
  assert.deepEqual(JSON.parse(readFileSync(`${settings}.revive-backup`, "utf8")), { theme: "dark", hooks: { Stop: [{ hooks: [theirs] }] } });
  assert.equal(readFileSync(join(home, ".zshrc.revive-backup"), "utf8"), "alias g=git\n");
});

const bareHome = () => {
  const home = mkdtempSync(join(tmpdir(), "revive-home-"));
  const env = { ...process.env, HOME: home, SHELL: "/bin/bash" };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; delete env.ZDOTDIR;
  return { home, run: (...args) => execFileSync("node", [ENGINE, ...args], { encoding: "utf8", env }) };
};

test("uninstall creates nothing that wasn't there", () => {
  const { home, run } = bareHome();
  assert.match(run("uninstall"), /Nothing to change/);
  assert.ok(!existsSync(join(home, ".claude")));
  assert.ok(!existsSync(join(home, ".bash_profile")));
});

test("without Claude Code, install leaves ~/.claude alone and doctor doesn't ask for its hooks", () => {
  const { home, run } = bareHome();
  run("install", "--no-shell");
  assert.ok(!existsSync(join(home, ".claude")));
  assert.equal(JSON.parse(run("doctor")).claude, null);
});

test("bash gets the block in the file a login shell reads", () => {
  const only = bareHome();
  writeFileSync(join(only.home, ".profile"), "export A=1\n");
  only.run("install", "--bash", "--no-codex");
  assert.ok(readFileSync(join(only.home, ".profile"), "utf8").includes("herdr-revive"));
  assert.ok(!existsSync(join(only.home, ".bash_profile")), "a new .bash_profile would hide .profile");
  assert.equal(JSON.parse(only.run("doctor")).shell.bash, true);

  const none = bareHome();
  none.run("install", "--bash", "--no-codex");
  assert.ok(readFileSync(join(none.home, ".bash_profile"), "utf8").includes("herdr-revive"));
  assert.ok(!existsSync(join(none.home, ".bashrc")));
  none.run("uninstall");
  assert.ok(!readFileSync(join(none.home, ".bash_profile"), "utf8").includes("herdr-revive"));
});

test("REVIVE_DEBUG=1 says why a shell didn't resume", () => {
  const bin = mkdtempSync(join(tmpdir(), "revive-bin-"));
  writeFileSync(join(bin, "hc"), "#!/bin/sh\necho '{\"labels\":{}}'\n");
  chmodSync(join(bin, "hc"), 0o755);
  const env = { ...process.env, HC_TERMINAL_ID: "t1", PATH: `${bin}:${process.env.PATH}` };
  const quiet = execFileSync("sh", ["-c", shellBlock(ENGINE)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(quiet, "");
  const r = execFileSync("sh", ["-c", `{\n${shellBlock(ENGINE)}\n} 2>&1`], { env: { ...env, REVIVE_DEBUG: "1" }, encoding: "utf8" });
  assert.match(r, /revive: nothing remembered on t1/);
});

/**
 * A fake hc that answers `get` with a remembered session and the given pid
 * (`SELF`: the pid the asking shell exports as $SELF), and a fake node that records that
 * the engine was started.
 */
function fakeTools(pid) {
  const bin = mkdtempSync(join(tmpdir(), "revive-bin-"));
  const answer = (p) => `{"labels":{"revive.session":"x"},"name":null,"parent":null,"pid":${p},"reason":null}`;
  writeFileSync(join(bin, "fakehc"), pid === "SELF"
    ? `#!/bin/sh\necho '${answer("'\"$SELF\"'")}'\n`
    : `#!/bin/sh\necho '${answer(pid)}'\n`);
  writeFileSync(join(bin, "node"), `#!/bin/sh\necho started >> "${bin}/node.log"\n`);
  chmodSync(join(bin, "fakehc"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  const env = { ...process.env, HC_TERMINAL_ID: "t1", REVIVE_HC: join(bin, "fakehc"), PATH: `${bin}:${process.env.PATH}` };
  return { env, started: () => existsSync(join(bin, "node.log")) };
}

test("the shell block honors REVIVE_HC and starts node only in the terminal's own shell", () => {
  // `hc` is not on PATH here: only REVIVE_HC can answer.
  const own = fakeTools("SELF");
  // The test's shell tells the fake hc its pid, which is what the real one reports.
  execFileSync("sh", ["-c", `SELF=$$; export SELF\n${shellBlock(ENGINE)}`], { env: own.env });
  assert.ok(own.started(), "the terminal's own shell asks the engine");

  const nested = fakeTools(1);
  const out = execFileSync("sh", ["-c", `{\n${shellBlock(ENGINE)}\n} 2>&1`], { env: { ...nested.env, REVIVE_DEBUG: "1" }, encoding: "utf8" });
  assert.ok(!nested.started(), "a shell inside the terminal doesn't start node");
  assert.match(out, /not the terminal's own shell/);
});

test("install writes through a symlinked file and keeps its permissions", () => {
  const home = mkdtempSync(join(tmpdir(), "revive-home-"));
  const repo = join(home, "dotfiles");
  mkdirSync(repo);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(repo, "zshrc"), "alias g=git\n", { mode: 0o600 });
  chmodSync(join(repo, "zshrc"), 0o600);
  symlinkSync(join(repo, "zshrc"), join(home, ".zshrc"));
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  chmodSync(join(home, ".claude", "settings.json"), 0o600);
  const env = { ...process.env, HOME: home, SHELL: "/bin/zsh", ZDOTDIR: home };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  execFileSync("node", [ENGINE, "install", "--no-codex"], { env });

  assert.ok(lstatSync(join(home, ".zshrc")).isSymbolicLink(), "the link is still a link");
  assert.ok(readFileSync(join(repo, "zshrc"), "utf8").includes("herdr-revive"), "the block is in the linked file");
  assert.equal(statSync(join(repo, "zshrc")).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".claude", "settings.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, ".zshrc.revive-backup"), "utf8"), "alias g=git\n");
});

test("zsh's rc file is found through ZDOTDIR set in .zshenv", (t) => {
  try { execFileSync("sh", ["-c", "command -v zsh"]); } catch { t.skip("zsh not installed"); return; }
  const home = mkdtempSync(join(tmpdir(), "revive-home-"));
  mkdirSync(join(home, ".config", "zsh"), { recursive: true });
  writeFileSync(join(home, ".zshenv"), 'export ZDOTDIR="$HOME/.config/zsh"\n');
  const env = { ...process.env, HOME: home, SHELL: "/bin/zsh" };
  delete env.ZDOTDIR; delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  execFileSync("node", [ENGINE, "install", "--no-codex"], { env });
  assert.ok(readFileSync(join(home, ".config", "zsh", ".zshrc"), "utf8").includes("herdr-revive"));
  assert.ok(!existsSync(join(home, ".zshrc")));
  assert.equal(JSON.parse(execFileSync("node", [ENGINE, "doctor"], { env, encoding: "utf8" })).shell.zsh, true);
});

test("a settings file that isn't JSON is left alone", () => {
  const home = mkdtempSync(join(tmpdir(), "revive-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  const env = { ...process.env, HOME: home, SHELL: "/bin/zsh" };
  delete env.CLAUDE_CONFIG_DIR; delete env.ZDOTDIR;
  assert.throws(() => execFileSync("node", [ENGINE, "install", "--no-shell"], { env, stdio: "pipe" }), /not valid JSON/);
  assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), "{ not json");
});

test("hooks without a herdr terminal do nothing and never fail", () => {
  const env = { ...process.env, HC_TERMINAL_ID: "" };
  const out = execFileSync("node", [ENGINE, "hook"], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "x" }), env, encoding: "utf8" });
  assert.equal(out, "");
  execFileSync("node", [ENGINE, "hook"], { input: "garbage", env: { ...env, HC_TERMINAL_ID: "t999", REVIVE_HC: "/nonexistent/hc" } });
});

test("pi's extension is linked where pi loads it, and only that link is taken out", () => {
  const { home, run } = bareHome();
  const link = join(home, ".pi", "agent", "extensions", "herdr-revive.ts");
  assert.equal(JSON.parse(run("doctor")).pi, null, "no pi, nothing to say");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  assert.match(run("install", "--no-shell", "--no-codex"), /herdr-revive\.ts[\s\S]*next time it starts/);
  assert.equal(realpathSync(link), realpathSync("mods/revive/pi/revive.ts"));
  assert.equal(JSON.parse(run("doctor")).pi, true);
  assert.match(run("install", "--no-shell", "--no-codex"), /Nothing to change/);
  run("uninstall", "--no-shell");
  assert.ok(!existsSync(link));
  assert.equal(JSON.parse(run("doctor")).pi, false);
});

test("a pi extension placed by something else is left alone", () => {
  const { home, run } = bareHome();
  const dir = join(home, ".pi", "agent", "extensions");
  mkdirSync(dir, { recursive: true });
  // A package manager's read-only copy (a Nix store path), linked in.
  const store = join(home, "store-revive.ts");
  copyFileSync("mods/revive/pi/revive.ts", store);
  chmodSync(store, 0o444);
  symlinkSync(store, join(dir, "herdr-revive.ts"));
  assert.doesNotMatch(run("install", "--no-shell", "--no-codex"), /herdr-revive\.ts/);
  assert.equal(JSON.parse(run("doctor")).pi, true);
  run("uninstall", "--no-shell");
  assert.ok(lstatSync(join(dir, "herdr-revive.ts")).isSymbolicLink(), "uninstall keeps a link it didn't make");
  // Another file by that name is not Revive's to replace.
  const other = bareHome();
  mkdirSync(join(other.home, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(join(other.home, ".pi", "agent", "extensions", "herdr-revive.ts"), "export default () => {};\n");
  assert.throws(() => other.run("install", "--no-shell", "--no-codex"), /not Revive's pi extension/);
});
