#!/usr/bin/env node
// Revive's engine. The mod can't run for a terminal while the app is closed or
// the machine is rebooting, so the work happens where the session lives:
//
//   revive.mjs hook               Claude Code / Codex SessionStart and SessionEnd:
//                                 remember the session on its terminal, or forget it
//   revive.mjs check --shell PID  from the shell's rc file: print the commands that
//                                 resume a session lost to a restart, or nothing
//   revive.mjs failed             the resume printed by `check` gave up at once
//   revive.mjs list [--focus T]   every remembered session, as JSON, for the dialog
//   revive.mjs resume T           resume T's session in T's shell
//   revive.mjs auto T on|off      allow or stop automatic resume for T
//   revive.mjs install [--zsh] [--bash] [--no-shell] [--no-codex]
//   revive.mjs uninstall
//   revive.mjs doctor             what is installed, as JSON
//
// Hooks never fail an agent: every error is swallowed and the exit code is 0.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, mkdirSync, renameSync, realpathSync, rmSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENTS, agentKey, agentEnv, carriedFlags, hookOwner, isOneShot, readRecord, labelArgs, clearArgs, resumedArgs, stateOf, shouldResume,
  resumeScript, resumeLine, shQuote, validId,
} from "./lib/core.js";

const run = promisify(execFile);
export const ENGINE = fileURLToPath(import.meta.url);
const HC = process.env.REVIVE_HC || "hc";

// ── herdr-core ──────────────────────────────────────────────────────────────

async function hc(args) {
  const { stdout } = await run(HC, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
  return stdout;
}

const getTerminal = async (t) => JSON.parse(await hc(["get", t, "--json"]));
const label = (t, args) => (args.length ? hc(["label", t, ...args]) : null);

async function listTerminals() {
  const { terminals = [] } = JSON.parse(await hc(["ls", "--json"]));
  const all = await Promise.all(terminals.map((x) => getTerminal(x.address).catch(() => null)));
  return all.filter((t) => t && t.state === "live");
}

/**
 * The agent in the terminal's foreground, or null. By its command line, or,
 * for an agent behind a wrapper with another name (`node …/cli.mjs`), by its
 * own report, which only counts while something other than the terminal's
 * shell is in the foreground: a report outlives the agent that sent it.
 */
function liveAgent(t) {
  const fg = t.foreground;
  if (!fg?.argv) return null;
  return agentKey(null, fg.argv) ?? (fg.pid && fg.pid !== t.pid ? agentKey(t.status?.app) : null);
}

// ── hooks ───────────────────────────────────────────────────────────────────

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

/**
 * Every process: pid → { ppid, since, argv }. `since` is its start time as ps
 * prints it (`lstart`, always five words), which tells a new process from an
 * old one that had the same pid before a reboot. argv is split on spaces,
 * which is enough to recognize an agent by its first two words.
 */
export function parseProcesses(text) {
  const table = new Map();
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length < 7) continue;
    const pid = Number(words[0]);
    if (!pid) continue;
    table.set(pid, { ppid: Number(words[1]), since: words.slice(2, 7).join(" "), argv: words.slice(7) });
  }
  return table;
}

async function processes(pids = null) {
  const args = pids ? ["-o", "pid=,ppid=,lstart=,args=", "-p", pids.join(",")] : ["-A", "-o", "pid=,ppid=,lstart=,args="];
  try {
    const { stdout } = await run("ps", args, { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return parseProcesses(stdout);
  } catch (err) {
    // ps exits 1 when none of the asked pids exist.
    return parseProcesses(err?.stdout ?? "");
  }
}

/** When a terminal's program started, or null. */
async function startOf(pid) {
  if (!pid) return null;
  return (await processes([pid])).get(pid)?.since ?? null;
}

function agentFromPayload(payload) {
  const path = String(payload.transcript_path ?? "");
  if (path.includes("/.codex/")) return "codex";
  if (path.includes("/.claude/") || path.includes("/projects/")) return "claude";
  return null;
}

async function hook() {
  const payload = await readStdin();
  const t = process.env.HC_TERMINAL_ID;
  const event = payload.hook_event_name;
  if (!t || !validId(payload.session_id)) return;
  const terminal = await getTerminal(t);
  // The hook must belong to the agent in the terminal's foreground, not to a
  // `claude -p` that agent ran as a tool (it inherits HC_TERMINAL_ID too).
  const target = terminal.foreground?.pid ?? terminal.pid;
  if (!target) return;
  const table = await processes();
  const owner = hookOwner(table, process.ppid, target);
  if (!owner.owned) return;
  const rec = readRecord(terminal.labels);

  if (event === "SessionStart") {
    // The command line: the foreground's (exact words), else the agent
    // process the hook came from, when a wrapper with another name runs it.
    const fgArgv = terminal.foreground?.argv ?? terminal.argv ?? [];
    const argv = agentKey(null, fgArgv) ? fgArgv : table.get(owner.agent)?.argv ?? fgArgv;
    // The command line first: the terminal's last OSC report may still be a
    // previous agent's, sent before this one reported anything.
    const key = agentKey(null, argv) ?? agentFromPayload(payload) ?? agentKey(terminal.status?.app);
    if (!key) return;
    // `claude -p "…"` or `codex exec` typed in the terminal: it answers and
    // quits, and its SessionEnd ("other") would leave its session on record in
    // place of the interactive one. Neither is worth bringing back.
    if (isOneShot(key, argv)) return;
    const same = rec?.session === payload.session_id;
    // The hook runs in the agent's environment: where it keeps its sessions.
    const env = agentEnv(key, process.env);
    await label(t, labelArgs({
      agent: key,
      session: payload.session_id,
      cwd: payload.cwd || terminal.foreground?.cwd || terminal.cwd || "",
      flags: JSON.stringify(carriedFlags(key, argv)),
      env: Object.keys(env).length ? JSON.stringify(env) : null,
      shell: terminal.pid ?? "",
      since: table.get(terminal.pid)?.since ?? null,
      at: same ? rec.at ?? Date.now() : Date.now(),
      ended: null,
      failed: null,
      // The same session starting again (a resume, a compaction) keeps its
      // "resumed" mark; a new one starts without.
      resumed: same ? rec.resumed : null,
    }));
    return;
  }

  if (event === "SessionEnd") {
    if (!rec || rec.session !== payload.session_id) return;
    // `/clear` (and `/resume` from inside) ends one session to start another
    // in the same process; that one's SessionStart records it, and clearing
    // here could race it and erase the new record.
    if (payload.reason === "clear" || payload.reason === "resume") return;
    // A signal (a crash, a kill, a shutdown) reports "other": the record stays,
    // worth bringing back. `/exit`, Ctrl+C, `/logout`: the person ended it.
    if (payload.reason !== "other") await label(t, clearArgs());
  }
}

// ── the shell ───────────────────────────────────────────────────────────────

const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/**
 * Claude Code writes a session's transcript only once it has a message, so a
 * session opened and left empty can't be resumed: `--resume` says "No
 * conversation found". Its folder is named after the cwd; other folders are
 * searched when the agent moved. Codex is not checked. The folder is the
 * session's own `CLAUDE_CONFIG_DIR` when it was recorded with one, not this
 * shell's. Records from before Revive kept it fall back to this shell's.
 */
export function hasTranscript(rec) {
  if (rec.agent !== "claude") return true;
  const projects = join(rec.env?.CLAUDE_CONFIG_DIR ? rec.env.CLAUDE_CONFIG_DIR : claudeDir(), "projects");
  const file = `${rec.session}.jsonl`;
  if (rec.cwd && existsSync(join(projects, rec.cwd.replace(/[^A-Za-z0-9]/g, "-"), file))) return true;
  try { return readdirSync(projects).some((dir) => existsSync(join(projects, dir, file))); }
  catch { return false; }
}

async function check(args) {
  const t = process.env.HC_TERMINAL_ID;
  if (!t) return;
  const shellPid = Number(args[args.indexOf("--shell") + 1]);
  const terminal = await getTerminal(t);
  const rec = readRecord(terminal.labels);
  const debug = (why) => { if (process.env.REVIVE_DEBUG) process.stderr.write(`revive: ${why}\n`); };
  // A shell started inside the terminal is the common case and needs no ps.
  const pid = terminal.pid ?? null;
  const since = pid !== null && shellPid === pid ? await startOf(pid) : null;
  const verdict = shouldResume(rec, { pid, since, shellPid, env: process.env });
  debug(verdict.why);
  if (!verdict.go) return;
  if (!hasTranscript(rec)) { debug("the session has no transcript; forgot it"); await label(t, clearArgs()); return; }
  // Mark it first: a second shell started from this one must not resume it again.
  await label(t, resumedArgs({ pid, since }));
  process.stdout.write(resumeScript(rec, ENGINE) + "\n");
}

async function failed() {
  const t = process.env.HC_TERMINAL_ID;
  if (t) await label(t, labelArgs({ failed: Date.now() }));
}

// ── the dialog ──────────────────────────────────────────────────────────────

/** Claude Code keeps `sessions/<pid>.json` for each interactive process. */
function claudeSessionFor(pid) {
  const dir = join(claudeDir(), "sessions");
  try {
    const id = JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8")).sessionId;
    return validId(id) ? id : null;
  } catch { return null; }
}

/**
 * Whether a running session can be forked: a fork resumes it, so it needs a
 * transcript. Only a sure "no" says false. A record without the agent's
 * config folder (one from before Revive kept it) is checked against this
 * process's folder only when the agent's own `sessions/<pid>.json` is there,
 * which proves it is the same folder; otherwise the answer is unknown (null)
 * and the fork is let through.
 */
function forkable(rec, fgPid) {
  if (rec.agent !== "claude") return true;
  const known = rec.env?.CLAUDE_CONFIG_DIR || (fgPid && claudeSessionFor(fgPid) !== null);
  if (!known) return null;
  return hasTranscript(rec);
}

function describe(t, since, focus) {
  const rec = readRecord(t.labels);
  const live = liveAgent(t);
  const entry = {
    address: t.address,
    where: t.labels?.where ?? null,
    title: t.title ?? "",
    pid: t.pid ?? null,
    live,
    rec,
    state: rec ? stateOf(rec, { live: live === rec.agent, pid: t.pid ?? null, since }) : null,
  };
  // A live agent nobody recorded yet (started before Revive was installed).
  if (!rec && live === "claude" && t.foreground?.pid) {
    const session = claudeSessionFor(t.foreground.pid);
    if (session) {
      entry.rec = { agent: "claude", session, cwd: t.foreground.cwd ?? t.cwd ?? null, flags: carriedFlags("claude", t.foreground.argv), shell: t.pid, auto: true };
      entry.state = "running";
      entry.unrecorded = true;
    }
  }
  // An agent running with nothing on record: the dialog still names it, and its folder.
  if (!entry.rec && live) entry.folder = t.foreground?.cwd ?? t.cwd ?? null;
  // Only the focused terminal's card offers Fork, so only it is checked.
  if (entry.rec && entry.state === "running" && t.address === focus) entry.forkable = forkable(entry.rec, t.foreground?.pid);
  return entry;
}

async function list(args) {
  const focus = args.includes("--focus") ? args[args.indexOf("--focus") + 1] : null;
  const terminals = await listTerminals();
  const pids = terminals.map((t) => t.pid).filter(Boolean);
  const procs = pids.length ? await processes(pids) : new Map();
  const entries = terminals.map((t) => describe(t, procs.get(t.pid)?.since ?? null, focus)).filter((e) => e.rec || e.address === focus);
  // The setup only changes on install; the dialog asks for it when it opens and after.
  const out = { entries };
  if (args.includes("--setup")) out.setup = doctorReport();
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function resume(args) {
  const t = args[0];
  const terminal = await getTerminal(t);
  const rec = readRecord(terminal.labels);
  if (!rec) throw new Error(`${t} has no remembered session.`);
  if (liveAgent(terminal) === rec.agent) throw new Error(`${AGENTS[rec.agent].name} is already running in ${t}.`);
  const fg = terminal.foreground;
  if (fg?.pid && terminal.pid && fg.pid !== terminal.pid) {
    throw new Error(`${t} is busy with ${fg.argv?.[0] ?? "another program"}. Quit it first.`);
  }
  const line = resumeLine(rec);
  if (!line) throw new Error(`Can't build a resume command for ${t}.`);
  if (!hasTranscript(rec)) {
    await label(t, clearArgs());
    throw new Error("That session never got a message, so there is nothing to resume. Forgot it.");
  }
  await label(t, resumedArgs({ pid: terminal.pid, since: await startOf(terminal.pid) }));
  await hc(["send", t, line]);
}

async function auto(args) {
  const [t, value] = args;
  await label(t, labelArgs({ auto: value === "off" ? "off" : null }));
}

// ── install ─────────────────────────────────────────────────────────────────

const HOOK_COMMAND = `node ${shQuote(ENGINE)} hook`;
const claudeSettings = () => join(claudeDir(), "settings.json");
const codexDir = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const codexHooks = () => join(codexDir(), "hooks.json");

/**
 * Herdr starts terminals as login shells (`zsh -l`, `bash -l`). zsh reads
 * .zshrc either way; a login bash reads the first of .bash_profile,
 * .bash_login and .profile, and not .bashrc. Creating .bash_profile where
 * only .profile exists would stop bash from reading .profile, so the block
 * goes into whichever bash reads.
 */
const BASH_LOGIN = [".bash_profile", ".bash_login", ".profile"];
const bashLogin = () => {
  const found = BASH_LOGIN.map((f) => join(homedir(), f)).find((p) => existsSync(p));
  return found ?? join(homedir(), ".bash_profile");
};
/**
 * zsh reads .zshrc from $ZDOTDIR, which people often set in ~/.zshenv. The
 * dialog's Install runs from the app, whose environment never read that
 * file, so zsh itself is asked: `zsh -c` reads .zshenv and nothing else.
 */
let zdotdir;
function zshDir() {
  if (zdotdir !== undefined) return zdotdir;
  zdotdir = process.env.ZDOTDIR || null;
  if (!zdotdir) {
    try {
      const out = execFileSync("zsh", ["-c", 'print -r -- "${ZDOTDIR:-$HOME}"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out.startsWith("/")) zdotdir = out;
    } catch { /* no zsh: its rc file is moot */ }
  }
  zdotdir ||= homedir();
  return zdotdir;
}
const RC = { zsh: () => join(zshDir(), ".zshrc"), bash: bashLogin };
// Every file a block may be in, for uninstall (.bashrc: from earlier versions).
const ALL_RC = () => [RC.zsh(), ...BASH_LOGIN.map((f) => join(homedir(), f)), join(homedir(), ".bashrc")];
const BEGIN = "# >>> herdr-revive >>>";
const END = "# <<< herdr-revive <<<";
const EVENTS = ["SessionStart", "SessionEnd"];

const isOurs = (h) => typeof h?.command === "string" && h.command.includes("revive.mjs") && /\bhook\b/.test(h.command);

export function shellBlock(engine = ENGINE) {
  const q = shQuote(engine);
  return [
    BEGIN,
    "# Resume the coding agent a herdr terminal lost to a restart or reboot.",
    "# REVIVE_DEBUG=1 says why it did or didn't.",
    `if [ -n "$HC_TERMINAL_ID" ] && [ -f ${q} ] && command -v node >/dev/null 2>&1; then`,
    `  __revive_j="$("\${REVIVE_HC:-hc}" get "$HC_TERMINAL_ID" --json 2>/dev/null)"`,
    // Two cheap tests before starting node: a session is remembered here, and
    // this is the terminal's own shell (its pid), not one started inside it.
    `  case "$__revive_j" in *'"revive.session"'*) __revive_has=1 ;; *) __revive_has= ;; esac`,
    `  case "$__revive_j" in *'"pid":'"$$"','*|*'"pid": '"$$"','*) __revive_own=1 ;; *) __revive_own= ;; esac`,
    `  if [ -z "$__revive_has" ]; then`,
    `    if [ -n "$REVIVE_DEBUG" ]; then echo "revive: nothing remembered on $HC_TERMINAL_ID" >&2; fi`,
    `  elif [ -z "$__revive_own" ]; then`,
    `    if [ -n "$REVIVE_DEBUG" ]; then echo "revive: not the terminal's own shell" >&2; fi`,
    `  else`,
    `    if [ -n "$REVIVE_DEBUG" ]; then __revive="$(node ${q} check --shell $$)"`,
    `    else __revive="$(node ${q} check --shell $$ 2>/dev/null)"; fi`,
    // The agent is interactive: start it at the first prompt, once the rc
    // files are done and the terminal is the shell's again (an instant
    // prompt, for one, holds on to it while they run).
    `    if [ -z "$__revive" ]; then unset __revive`,
    `    elif [ -n "$ZSH_VERSION" ]; then`,
    `      __revive_run() { add-zsh-hook -d precmd __revive_run; eval "$__revive"; unset __revive; unfunction __revive_run; }`,
    `      autoload -Uz add-zsh-hook && add-zsh-hook precmd __revive_run`,
    `    elif [ -n "$BASH_VERSION" ]; then`,
    `      __revive_run() { PROMPT_COMMAND="\${PROMPT_COMMAND#__revive_run;}"; eval "$__revive"; unset __revive; unset -f __revive_run; }`,
    `      PROMPT_COMMAND="__revive_run;\${PROMPT_COMMAND}"`,
    `    else eval "$__revive"; unset __revive; fi`,
    `  fi`,
    `  unset __revive_j __revive_has __revive_own`,
    `fi`,
    END,
  ].join("\n");
}

/**
 * Adds (or, with remove, takes out) Revive's SessionStart/SessionEnd hooks.
 * An event that already has exactly Revive's hook is left as it is, wherever
 * it sits: other tools write this file too, and moving Revive's group back to
 * the end each time would rewrite it for nothing. `timeouts` sets an event's
 * timeout (Codex clamps SessionEnd to 3 seconds and warns about more).
 */
export function withHooks(settings, { remove = false, matcher = false, timeouts = {} } = {}) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  for (const event of EVENTS) {
    const timeout = timeouts[event] ?? 10;
    const ours = (out.hooks[event] ?? []).flatMap((g) => (g.hooks ?? []).filter(isOurs));
    if (!remove && ours.length === 1 && ours[0].command === HOOK_COMMAND && ours[0].timeout === timeout) continue;
    const groups = (out.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!remove) groups.push({ ...(matcher ? { matcher: "" } : {}), hooks: [{ type: "command", command: HOOK_COMMAND, timeout }] });
    if (groups.length) out.hooks[event] = groups;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export const hasHooks = (settings) => EVENTS.every((e) => (settings?.hooks?.[e] ?? []).some((g) => (g.hooks ?? []).some(isOurs)));

export function withShellBlock(text, { remove = false } = {}) {
  if (remove && !text.includes(BEGIN)) return text;
  const pattern = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, "g");
  const stripped = text.replace(pattern, "\n").replace(/\n{3,}$/, "\n\n");
  if (remove) return stripped;
  return `${stripped.replace(/\n*$/, "")}\n\n${shellBlock()}\n`;
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`${path} is not valid JSON; fix it first, Revive won't overwrite it.`); }
}

/**
 * Writes a file atomically. The first time Revive changes it, the person's
 * original is copied to `<file>.revive-backup`; later changes keep that copy.
 * A symlinked file (a dotfiles repository) is written where the link points,
 * so the link stays; the file keeps its permissions.
 */
function save(path, text) {
  let target = path;
  try { target = realpathSync(path); } catch { /* not there yet */ }
  mkdirSync(dirname(target), { recursive: true });
  let mode = null;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === text) return false;
    mode = statSync(target).mode & 0o7777;
    const backup = `${path}.revive-backup`;
    if (!existsSync(backup)) copyFileSync(target, backup);
  }
  const tmp = `${target}.revive-${process.pid}.tmp`;
  // Created with the file's own permissions, not the umask's: a 0600 settings
  // file (API keys under `env`) must not sit world-readable until the chmod.
  // The chmod stays for bits the umask takes away (0664 under umask 077).
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, mode !== null ? { mode } : undefined);
  if (mode !== null) chmodSync(tmp, mode);
  renameSync(tmp, target);
  return true;
}

const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function shells(args) {
  const picked = ["zsh", "bash"].filter((s) => args.includes(`--${s}`));
  if (picked.length) return picked;
  const login = (process.env.SHELL ?? "").split("/").pop();
  return [RC[login] ? login : "zsh"];
}

/** Codex clamps a SessionEnd hook's timeout to 3 seconds and warns at every start about more. */
const CODEX_HOOKS = { matcher: true, timeouts: { SessionEnd: 3 } };

/**
 * Writes Revive's hooks into a JSON settings file. A file whose hooks are
 * already right is not written, even when another tool formatted it
 * differently (sorted its keys, say): only a real change rewrites it.
 */
function saveHooks(path, options) {
  const before = readJson(path);
  const after = withHooks(before, options);
  if (existsSync(path) && JSON.stringify(after) === JSON.stringify(before)) return false;
  return save(path, JSON.stringify(after, null, 2) + "\n");
}

function install(args, remove = false) {
  const changed = [];
  const claude = claudeSettings();
  if (!remove || existsSync(claude)) {
    if (saveHooks(claude, { remove })) changed.push(claude);
  }
  if (!args.includes("--no-codex") && existsSync(codexDir())) {
    const codex = codexHooks();
    if (!remove || existsSync(codex)) {
      if (saveHooks(codex, { remove, ...CODEX_HOOKS })) changed.push(codex);
    }
  }
  if (!args.includes("--no-shell")) {
    for (const rc of remove ? ALL_RC() : shells(args).map((s) => RC[s]())) {
      if (remove && !existsSync(rc)) continue;
      if (save(rc, withShellBlock(readText(rc), { remove }))) changed.push(rc);
    }
  }
  process.stdout.write(changed.length ? `${remove ? "Removed from" : "Updated"}:\n${changed.map((p) => `  ${p}`).join("\n")}\n` : "Nothing to change.\n");
  if (!remove && changed.includes(codexHooks())) process.stdout.write("Codex asks to trust new hooks the next time it starts.\n");
}

export function doctorReport() {
  const safe = (fn) => { try { return fn(); } catch { return false; } };
  return {
    engine: ENGINE,
    claude: safe(() => hasHooks(readJson(claudeSettings()))),
    codex: existsSync(codexDir()) ? safe(() => hasHooks(readJson(codexHooks()))) : null,
    shell: Object.fromEntries(Object.entries(RC).map(([s, rc]) => [s, readText(rc()).includes(BEGIN)])),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

const COMMANDS = {
  hook: { run: hook, quiet: true },
  check: { run: check, quiet: true },
  failed: { run: failed, quiet: true },
  list: { run: list },
  resume: { run: resume },
  auto: { run: auto },
  install: { run: (a) => install(a) },
  uninstall: { run: (a) => install(a, true) },
  doctor: { run: async () => process.stdout.write(JSON.stringify(doctorReport(), null, 2) + "\n") },
};

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`usage: revive.mjs ${Object.keys(COMMANDS).join("|")}\n`);
    process.exit(2);
  }
  try {
    await cmd.run(args);
  } catch (err) {
    if (cmd.quiet) return;
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

// Run as a program, not when the tests import it (a linked mod folder resolves through the link).
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(ENGINE) === real(process.argv[1])) await main();
