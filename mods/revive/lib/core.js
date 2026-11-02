// What Revive knows about agents, sessions and terminals, as plain functions.
// Shared by the dialog (main.js) and the engine (revive.mjs), so nothing here
// may touch herdr, node or the file system.
//
// A session is remembered as labels on the herdr-core terminal it runs in.
// Labels live in the core, next to the terminal, so they survive the app
// closing, the core restarting and the machine rebooting, and they go away
// with the terminal.

export const PREFIX = "revive.";
// `ended` is no longer written; it stays here so clearing removes it from older records.
export const KEYS = ["agent", "session", "cwd", "flags", "env", "transcript", "shell", "since", "at", "ended", "resumed", "failed", "auto"];

/**
 * The agents Revive can bring back. `carry` lists the launch flags a resume or
 * fork keeps, so a session that ran with `--dangerously-skip-permissions` or
 * another model comes back the way it was: 0 for a switch, 1 for a flag that
 * takes a value, 2 for one that takes every value up to the next flag. Anything
 * else on the original command line (a first prompt, `--resume` itself) is
 * left behind.
 *
 * `env` lists the variables that say where the agent keeps its sessions: a
 * session started under `CLAUDE_CONFIG_DIR=~/.claude-work` is found, and
 * resumed, only under that same folder, so the hook records them with it.
 * `oneShot` tells a run that answers and quits (`claude -p`, `codex exec`)
 * from an interactive session, given the words after the program's name:
 * such a run has hooks too, and must not replace the session on record.
 * `argv0Only` recognizes the agent by the first word of a command line only:
 * a short name like `pi` is often an argument (`ssh pi`, `vim pi`).
 */
export const AGENTS = {
  claude: {
    name: "Claude Code",
    bin: "claude",
    apps: ["claude-code", "claude"],
    resume: (id, flags) => ["claude", ...flags, "--resume", id],
    fork: (id, flags) => ["claude", ...flags, "--resume", id, "--fork-session"],
    env: ["CLAUDE_CONFIG_DIR"],
    oneShot: (args) => args.some((w) => w === "-p" || w === "--print"),
    carry: {
      "--dangerously-skip-permissions": 0,
      "--allow-dangerously-skip-permissions": 0,
      "--permission-mode": 1,
      "--model": 1,
      "--add-dir": 2,
      "--settings": 1,
      "--agent": 1,
    },
  },
  codex: {
    name: "Codex",
    bin: "codex",
    apps: ["codex"],
    resume: (id, flags) => ["codex", "resume", ...flags, id],
    fork: (id, flags) => ["codex", "fork", ...flags, id],
    env: ["CODEX_HOME"],
    oneShot: (args) => args[0] === "exec" || args[0] === "e",
    carry: {
      "--no-daemon": 0,
      "--dangerously-bypass-approvals-and-sandbox": 0,
      "--yolo": 0,
      "--full-auto": 0,
      "--search": 0,
      "-m": 1,
      "--model": 1,
      "-s": 1,
      "--sandbox": 1,
      "-a": 1,
      "--ask-for-approval": 1,
      "-p": 1,
      "--profile": 1,
    },
  },
  pi: {
    name: "pi",
    bin: "pi",
    apps: ["pi"],
    // pi sets its process title to `pi`, so the first word is always its own.
    argv0Only: true,
    resume: (id, flags) => ["pi", ...flags, "--session", id],
    fork: (id, flags) => ["pi", ...flags, "--fork", id],
    env: ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"],
    oneShot: (args) => args.some((w, i) => w === "-p" || w === "--print" || w === "--no-session"
      || /^--mode=(json|rpc)$/.test(w) || (w === "--mode" && /^(json|rpc)$/.test(args[i + 1] ?? ""))),
    carry: {
      "--provider": 1,
      "--model": 1,
      "--models": 1,
      "--thinking": 1,
      "-t": 1,
      "--tools": 1,
      "-xt": 1,
      "--exclude-tools": 1,
      "-nt": 0,
      "--no-tools": 0,
      "-nbt": 0,
      "--no-builtin-tools": 0,
      "-e": 1,
      "--extension": 1,
      "-ne": 0,
      "--no-extensions": 0,
      "--no-mcp": 0,
      "--skill": 1,
      "-ns": 0,
      "--no-skills": 0,
      "-nc": 0,
      "--no-context-files": 0,
      "--system-prompt": 1,
      "--append-system-prompt": 1,
      "--session-dir": 1,
      "-a": 0,
      "--approve": 0,
      "-na": 0,
      "--no-approve": 0,
      "--offline": 0,
    },
  },
};

const base = (path) => String(path ?? "").split("/").pop();
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** The agent behind an OSC 7501 report (`claude-code`) or a command line, or null. */
export function agentKey(app, argv = []) {
  for (const [key, agent] of Object.entries(AGENTS)) {
    if (app && agent.apps.includes(app)) return key;
  }
  // `claude …`, or a script run by its interpreter: `node …/bin/codex …`.
  for (const [i, word] of argv.slice(0, 2).entries()) {
    for (const [key, agent] of Object.entries(AGENTS)) {
      if (base(word) === agent.bin && !(i > 0 && agent.argv0Only)) return key;
    }
  }
  return null;
}

/** Where the agent's own words start: after its program's name, else after the first word. */
const argsStart = (key, argv) => {
  const start = argv.findIndex((word) => base(word) === AGENTS[key].bin);
  return start < 0 ? 1 : start + 1;
};

/** Whether a command line runs the agent once, without a session to bring back. */
export function isOneShot(key, argv = []) {
  const agent = AGENTS[key];
  return Boolean(agent?.oneShot?.(argv.slice(argsStart(key, argv)).map(String)));
}

/** The agent's `env` variables that are set in `env`, as an object (empty when none). */
export function agentEnv(key, env = {}) {
  const names = AGENTS[key]?.env ?? [];
  return Object.fromEntries(names.filter((n) => typeof env[n] === "string" && env[n] !== "").map((n) => [n, env[n]]));
}

/** The launch flags worth keeping, in their original order. */
export function carriedFlags(key, argv = []) {
  const carry = AGENTS[key]?.carry;
  if (!carry) return [];
  const out = [];
  for (let i = argsStart(key, argv); i < argv.length; i++) {
    const word = argv[i];
    const eq = word.indexOf("=");
    if (word.startsWith("--") && eq > 0 && own(carry, word.slice(0, eq)) && carry[word.slice(0, eq)] >= 1) { out.push(word); continue; }
    // Own keys only: a first prompt like `constructor` is not a flag.
    if (!own(carry, word)) continue;
    out.push(word);
    if (carry[word] === 1 && i + 1 < argv.length) out.push(argv[++i]);
    if (carry[word] === 2) while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) out.push(argv[++i]);
  }
  return out;
}

/**
 * Whether a hook belongs to the agent in the terminal's foreground (`target`).
 * `table` maps pid → { ppid, argv }; the walk goes up from the hook's parent
 * and must reach `target`. On the way, the agent processes must sit next to
 * each other: an agent and the wrapper that started it (`node …/bin/codex`
 * running the native `codex`, a launcher script whose own name is something
 * else) are one agent. An agent, then a shell, then another agent is a tool
 * call: a `claude -p` the foreground agent ran, whose hooks are not its own.
 * The first agent found above the hook is returned with the verdict.
 */
export function hookOwner(table, start, target) {
  let first = null, ended = false;
  for (let pid = start, hops = 0; pid > 1 && hops < 64; hops++) {
    const proc = table.get(pid);
    if (!proc) return { owned: false, agent: first };
    const isAgent = Boolean(agentKey(null, proc.argv));
    if (isAgent && ended) return { owned: false, agent: first };
    if (isAgent && first === null) first = pid;
    if (!isAgent && first !== null) ended = true;
    if (pid === target) return { owned: true, agent: first };
    pid = proc.ppid;
  }
  return { owned: false, agent: first };
}

/** Session ids are UUIDs for every agent; anything else is refused rather than quoted. */
export const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);

export const shortId = (id) => (id ? String(id).slice(0, 8) : "");

/**
 * The command line that resumes or forks a session. A session recorded with
 * its agent's variables (`CLAUDE_CONFIG_DIR`) gets them back through `env`.
 */
export function command(rec, kind = "resume") {
  const agent = AGENTS[rec?.agent];
  if (!agent || !validId(rec.session)) return null;
  const argv = agent[kind](rec.session, rec.flags ?? []);
  const vars = Object.entries(agentEnv(rec.agent, rec.env ?? {}));
  return vars.length ? ["env", ...vars.map(([k, v]) => `${k}=${v}`), ...argv] : argv;
}

/** One word for a POSIX shell, quoted only when it needs to be. */
export function shQuote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const shJoin = (argv) => argv.map(shQuote).join(" ");

const num = (v) => (v === undefined || v === "" || v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A terminal's labels as a record, or null when it carries no session. */
export function readRecord(labels) {
  const get = (k) => labels?.[PREFIX + k];
  const session = get("session");
  if (!session) return null;
  let flags = [];
  try {
    const parsed = JSON.parse(get("flags") || "[]");
    if (Array.isArray(parsed)) flags = parsed.map(String);
  } catch { /* a hand-edited label: carry nothing */ }
  let env = {};
  try {
    const parsed = JSON.parse(get("env") || "{}");
    // Only the variables the agent declares: a label must not set LD_PRELOAD.
    if (parsed && typeof parsed === "object") env = agentEnv(get("agent"), parsed);
  } catch { /* a hand-edited label: no variables */ }
  return {
    agent: get("agent") || null,
    session,
    cwd: get("cwd") || null,
    flags,
    env,
    transcript: get("transcript") || null,
    shell: num(get("shell")),
    since: get("since") || null,
    at: num(get("at")),
    resumed: num(get("resumed")),
    failed: num(get("failed")),
    auto: get("auto") !== "off",
  };
}

/** `k=v` arguments for `hc label`. A null or "" value removes that label. */
export function labelArgs(fields) {
  return Object.entries(fields).map(([k, v]) => `${PREFIX}${k}=${v === null || v === undefined ? "" : v}`);
}

/**
 * The labels a resume writes, by hand or after a restart: the terminal's
 * program now, and when. Written before the agent starts, so a second shell
 * can't resume the same session again.
 */
export const resumedArgs = ({ pid, since, now = Date.now() }) =>
  labelArgs({ shell: pid, since, resumed: now, failed: null, ended: null });

/** Every Revive label, removed. `auto` stays: it is the person's choice for that terminal. */
export const clearArgs = () => labelArgs(Object.fromEntries(KEYS.filter((k) => k !== "auto").map((k) => [k, null])));

/**
 * Where a remembered session stands, given its terminal now:
 * - running      the agent is in the terminal's foreground
 * - lost         the terminal's program was replaced (a restart or reboot)
 *                and the session did not come back
 * - interrupted  the agent died under a shell that survived (a signal, a crash)
 * - failed       a resume was tried and the agent gave up at once
 * A session the person ended themselves is never remembered, so it has no state.
 */
export function stateOf(rec, terminal) {
  if (!rec) return null;
  if (terminal.live) return "running";
  if (rec.failed) return "failed";
  if (rec.shell !== null && terminal.pid !== null && !sameShell(rec, terminal)) return "lost";
  return "interrupted";
}

/**
 * Whether the terminal still runs the program the session was recorded under.
 * Pids start over after a reboot, so a new shell can get the old one's pid;
 * its start time tells them apart. A record without one compares pids only.
 */
export function sameShell(rec, { pid, since = null }) {
  if (rec.shell !== pid) return false;
  return !rec.since || !since || rec.since === since;
}

/**
 * Whether a shell that just started should resume its terminal's session.
 * Only the terminal's own shell (not one started inside it), only after the
 * program it held was replaced, and only when nobody turned it off.
 */
export function shouldResume(rec, { pid, since = null, shellPid, env = {} }) {
  if (!rec) return { go: false, why: "nothing remembered" };
  if (!AGENTS[rec.agent]) return { go: false, why: `unknown agent ${rec.agent}` };
  if (!validId(rec.session)) return { go: false, why: "malformed session id" };
  if (pid === null || shellPid !== pid) return { go: false, why: "not the terminal's own shell" };
  if (env.REVIVE_AUTO === "0") return { go: false, why: "REVIVE_AUTO=0" };
  if (!rec.auto) return { go: false, why: "turned off for this terminal" };
  // It was tried after the last restart and the agent gave up at once (its
  // folder is gone, the session can't be found): trying at every restart would
  // fail the same way. The dialog still offers it by hand.
  if (rec.failed) return { go: false, why: "the last resume failed" };
  if (sameShell(rec, { pid, since })) return { go: false, why: "same shell as before" };
  return { go: true, why: "the terminal's program was replaced" };
}

/** `cd -- <folder> && <agent> … --resume <id>`, one line, or "". */
export function resumeLine(rec) {
  const argv = command(rec, "resume");
  if (!argv) return "";
  return `${rec.cwd ? `cd -- ${shQuote(rec.cwd)} && ` : ""}${shJoin(argv)}`;
}

/**
 * What the recovered shell runs: say what is happening, go back to the
 * session's folder, start the agent, and mark the terminal failed when the
 * agent quits within a few seconds with an error (a session it can't find).
 */
export function resumeScript(rec, engine) {
  const line = resumeLine(rec);
  if (!line) return "";
  const name = AGENTS[rec.agent].name;
  const note = `↻ Revive: resuming ${name} session ${shortId(rec.session)}. REVIVE_AUTO=0 skips this.`;
  const body = [
    `  printf '\\033[2m%s\\033[0m\\n' ${shQuote(note)}`,
    `  __revive_t=$SECONDS`,
    `  ${line}`,
    `  if [ $? -ne 0 ] && [ $((SECONDS - __revive_t)) -lt 15 ]; then node ${shQuote(engine)} failed; fi`,
    `  unset __revive_t`,
  ];
  // The agent gets the terminal itself: while a shell starts, its input and
  // output may be held by something else (an instant prompt), and an agent
  // that doesn't see a terminal runs non-interactively and quits. It is the
  // terminal's own device (/dev/ttys004), found from the shell's process: an
  // agent on /dev/tty crashes on macOS, where kqueue can't watch that alias.
  // REVIVE_TTY: another device, for tests.
  return [
    `__revive_tty="\${REVIVE_TTY:-/dev/$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')}"`,
    `case "$__revive_tty" in /dev/|/dev/\\?*|/dev/-*) __revive_tty= ;; esac`,
    `if [ -n "$__revive_tty" ] && { : >"$__revive_tty"; } 2>/dev/null; then {`,
    ...body,
    `} <"$__revive_tty" >"$__revive_tty" 2>&1; else {`,
    ...body,
    `}; fi`,
    `unset __revive_tty`,
  ].join("\n");
}

/** "3m ago", for a timestamp in ms. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
