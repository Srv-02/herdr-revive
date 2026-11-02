// herdr-revive: pi extension. pi has no hooks file, so this runs Revive's engine
// the way Claude Code's SessionStart and SessionEnd hooks do, with the same payload.
// `revive.mjs install` links it into ~/.pi/agent/extensions/.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine is in the mod folder above this file; pi loads this file through a link.
const ENGINE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "revive.mjs");
const SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/** Runs `revive.mjs hook` with the payload on stdin; never fails, gives up after 10 seconds. */
function hook(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("node", [ENGINE, "hook"], { stdio: ["pipe", "ignore", "ignore"] });
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
      // pi names its process `pi`, so ps no longer shows its flags.
      argv: ["pi", ...process.argv.slice(2)],
    }));
    return queue;
  };

  // Only the interactive pi in a terminal: -p, --mode json/rpc and subagents answer and quit.
  pi.on("session_start", (event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    for (const s of SIGNALS) process.on(s, onSignal);
    // Not awaited: pi starts while the engine records it.
    void send(ctx, { hook_event_name: "SessionStart", source: event.reason });
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    // On SIGTERM or SIGHUP, pi's own handler reports "quit" before ours runs: let it run first.
    await new Promise((r) => setImmediate(r));
    for (const s of SIGNALS) process.off(s, onSignal);
    // A reboot, a core restart or a kill (Claude Code's reason "other") keeps the record,
    // and so do /new, /resume, /fork and reload, whose next session records itself.
    if (event.reason !== "quit" || signalled) return queue;
    // /quit, Ctrl+C twice, Ctrl+D: the person ended it.
    return send(ctx, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  });
}
