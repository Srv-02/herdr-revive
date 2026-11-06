// herdr-revive: omp extension. oh-my-pi (omp) has no hooks file, so this runs
// Revive's engine the way Claude Code's SessionStart and SessionEnd hooks do,
// with the same payload. `revive.mjs install` links it into
// ~/.omp/agent/extensions/.
//
// It differs from pi's in two ways, both checked against omp 18.16.0:
// - omp's `session_shutdown` carries no reason. A person's /exit, Ctrl+C or
//   Ctrl+D reaches it without a signal; a reboot, a core restart or a closed
//   terminal sends SIGTERM or SIGHUP first. Only the first forgets the session.
// - /new, /resume and /fork switch sessions in the same process and report
//   `session_switch`, which is recorded like a start.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine is in the mod folder above this file; omp loads this file through a link.
const ENGINE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "revive.mjs");
const SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/** Runs `revive.mjs hook` with the payload on stdin; never fails, gives up after 10 seconds. */
function hook(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("node", [ENGINE, "hook", "--agent", "omp"], { stdio: ["pipe", "ignore", "ignore"] });
    } catch { resolve(); return; }
    const timer = setTimeout(() => child.kill(), 10_000);
    const done = () => { clearTimeout(timer); resolve(); };
    child.on("error", done);
    child.on("close", done);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export default function (pi: any) {
  if (!process.env.HC_TERMINAL_ID) return;
  let queue: Promise<void> = Promise.resolve();
  let signalled = false;
  let listening = false;
  const onSignal = () => { signalled = true; };

  const send = (ctx: any, fields: Record<string, unknown>) => {
    const transcript_path = ctx.sessionManager.getSessionFile();
    // --no-session: nothing is saved, so nothing can come back.
    if (!transcript_path) return queue;
    queue = queue.then(() => hook({
      ...fields,
      session_id: ctx.sessionManager.getSessionId(),
      transcript_path,
      cwd: ctx.cwd,
      // omp names its process `omp`, so ps no longer shows its flags.
      argv: ["omp", ...process.argv.slice(2)],
    }));
    return queue;
  };

  // Only the interactive omp in a terminal: -p, --mode json/rpc and subagents answer and quit.
  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    if (!listening) { for (const s of SIGNALS) process.on(s, onSignal); listening = true; }
    // Not awaited: omp starts while the engine records it.
    void send(ctx, { hook_event_name: "SessionStart", source: "startup" });
  });

  pi.on("session_switch", (event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    void send(ctx, { hook_event_name: "SessionStart", source: event?.reason ?? "switch" });
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    // A signal handler registered after omp's own runs after it: let it run first.
    await new Promise((r) => setImmediate(r));
    if (listening) { for (const s of SIGNALS) process.off(s, onSignal); listening = false; }
    // A reboot, a core restart or a kill (Claude Code's reason "other") keeps the record.
    if (signalled) return queue;
    // /exit, Ctrl+C twice, Ctrl+D: the person ended it.
    return send(ctx, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  });
}
