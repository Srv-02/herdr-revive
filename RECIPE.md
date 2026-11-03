# Revive

Revive brings back the coding agent a Herdr terminal lost to a reboot or a herdr-core
restart, in the same pane, with the same session and flags. It also forks the focused
agent's conversation into a new session beside it. Agents: Claude Code, Codex, Factory
Droid (`droid`) and the Cursor CLI (`cursor-agent`); Droid and Cursor are built from their
docs and not tested end to end yet.

## Installing it (for the agent doing it)

1. Read every file in this repository before copying anything.
2. Copy `mods/revive` to `~/.config/herdr-app/mods/revive`.
3. Run `herdr-app check ~/.config/herdr-app/mods/revive`. It must pass.
4. Merge `keys.json` into `~/.config/herdr-app/keys.json`. Ask the person first if
   `cmd-shift-r` is already bound.
5. Tell the person what `install` changes and ask before running it:
   `node ~/.config/herdr-app/mods/revive/revive.mjs install`. It edits
   `~/.claude/settings.json` (only if `~/.claude` exists), `~/.codex/hooks.json` (only if `~/.codex` exists), Droid's
   `~/.factory/hooks.json` if it exists, else `~/.factory/settings.json` (only if
   `~/.factory` exists and the `droid` CLI is on `PATH` or in `~/.local/bin`),
   `~/.cursor/hooks.json` (only if `cursor-agent` is on `PATH`, in `~/.local/bin`, or
   `~/.local/share/cursor-agent` exists; `~/.cursor` alone is the editor's), links
   `~/.pi/agent/extensions/herdr-revive.ts` to `mods/revive/pi/revive.ts` (only if
   `~/.pi/agent` exists) and the
   file their login shell reads (`~/.zshrc`; for bash the first existing of
   `~/.bash_profile`, `~/.bash_login`, `~/.profile`), keeping the original of each as
   `.revive-backup`. If they use both zsh and bash, add `--zsh --bash`; `--no-codex`,
   `--no-droid`, `--no-cursor` skip an agent.
6. Run `node ~/.config/herdr-app/mods/revive/revive.mjs doctor` and report what it shows.
7. New sessions are remembered from now on. Sessions already running are not; they come
   back by themselves only after they are restarted once.

## What you see

- **Dialog** (`mod.open:revive`, 620px wide, as tall as its content, on `popover`, 20px
  padding at the sides, 18px above and 16px below). The sessions scroll once the dialog
  would pass 85% of the window; the header, the note and the footer always show.
  - A header: **↻ Revive** (16px semibold) and *Agent sessions, remembered on their
    terminals* in `dim`.
  - Sections titled in 10.5px medium `dim` capitals:
    - **FOCUSED TERMINAL**: a `raised` card with a `border`, 12px radius, 14px padding. The
      agent's name (14px semibold), the first 8 characters of the session id in JetBrains
      Mono `dim`, and a state on the right: a 6px dot and a word in the state's color
      (*Running* in `ansi2`, *Lost to a restart* and *Interrupted* in `ansi3`, *Resume
      failed* in `ansi1`). Under it the folder in `muted`, with the home folder as `~`, the
      carried flags in 10.5px mono `dim`, and for a session started before Revive was
      installed, a note that it can be forked but won't come back by itself. Buttons: for a
      running agent, **Fork right** `F`, **Fork below** `D` and **Fork to a tab** `T`
      (outline); for one that needs you, a solid **Resume** `↵`. For a running agent that
      can't fork (Cursor): no fork buttons, and *Cursor can't fork a session.* in `dim`. A
      Claude Code session
      with no transcript yet can't be forked: the Fork buttons are disabled, F/D/T do
      nothing, and the card says *This session has no message yet, so there is nothing to
      fork. Send it one first.* An agent running in the terminal with nothing on record
      gets the same card without an id or buttons: its name, *Running*, its folder, and a
      `dim` note that Revive has no record of it, so it can't be forked or brought back.
      For Codex the note adds that Codex records a session at its first message, and not
      at all while its shared background server runs it (`daemon_auto_start`). Without an
      agent: *No agent session in the focused terminal.* On another machine:
      a note that Revive works on this computer for now.
    - **NEED YOU**: other terminals whose session is lost, interrupted or failed. Each row
      (48px, 10px radius, filled with `raised`, `hover` on hover, 4px apart) shows the
      agent (13px medium), the short id, *space / tab* and *resumed 3m ago* in `dim`, the
      state, an **Auto** / **Auto off** ghost toggle and a solid **Resume**. Clicking the
      row closes the dialog and focuses that terminal.
    - **OTHER SESSIONS**: the remaining ones, same rows without the fill or **Resume**. Sessions found
      through their pid but not remembered say *not remembered* instead of the toggle.
  - A note line for errors (`ansi1`) or install output (`muted`), on `raised`.
  - A footer above a `border` line: `✓ Claude Code hooks`, `✓ Codex hooks`, `✓ pi extension`,
    `✓ Droid hooks`, `✓ Cursor hooks` (each only when that agent is installed), `✓ shell`,
    each `muted` with a `ansi2` ✓ when installed and `ansi1` with `✕` when not, and a solid
    **Install** button while anything is missing.
- The list refreshes every 4 seconds while the dialog is open.
- In a resumed pane, before the agent starts: `↻ Revive: resuming Claude Code session
  9e458eb4. REVIVE_AUTO=0 skips this.` in dim text.

## The files

| File | What it is |
| --- | --- |
| `mods/revive/main.js` | The dialog |
| `mods/revive/lib/core.js` | Agents (the `AGENTS` table), flags, hook payloads, labels, states and the resume script: plain functions shared by the dialog and the engine |
| `mods/revive/lib/sessions.js` | Engine only: finding a running agent's session from the files it writes, for one nobody recorded |
| `mods/revive/revive.mjs` | The engine, run with the person's Node: hooks, the shell check, list, resume, install |
| `mods/revive/pi/revive.ts` | pi's extension: runs `revive.mjs hook` at pi's session start and end, with Claude Code's payload |
| `mods/revive/package.json` | Marks the folder as ES modules for Node |
| `mods/revive/mod.json` | Opens as a dialog; docks nowhere |

## The record

A session is remembered as labels on its herdr-core terminal:

| Label | Value |
| --- | --- |
| `revive.agent` | `claude`, `codex`, `pi`, `droid` or `cursor` |
| `revive.session` | The session id |
| `revive.cwd` | The folder the session ran in |
| `revive.flags` | The carried launch flags, as a JSON array |
| `revive.env` | The agent's config folder when the session ran under one (`{"CLAUDE_CONFIG_DIR": …}`, `{"CODEX_HOME": …}`, `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR`), as a JSON object; absent otherwise |
| `revive.transcript` | pi only: the session file pi named |
| `revive.shell` | The pid of the terminal's program when the session started or was resumed |
| `revive.since` | That program's start time (`ps -o lstart`), so a new shell that got an old pid after a reboot is still new |
| `revive.at` | When it was recorded (ms) |
| `revive.resumed` | When Revive last resumed it (ms); kept until a new session starts |
| `revive.failed` | When a resume gave up within 15 seconds (ms) |
| `revive.auto` | `off` turns automatic resume off for this terminal; kept across sessions |

Labels are kept by herdr-core across its restarts and go away with the terminal.

## Agents

One entry each in `AGENTS` (`lib/core.js`), one hook target in `HOOK_TARGETS`
(`revive.mjs`), and optionally a finder in `lib/sessions.js`: that is all an agent needs.

| Agent | Known by | Resume | Fork | Hooks installed into | Session id from | Carried flags |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude`; report `claude-code` | `claude … --resume <id>` | `claude … --resume <id> --fork-session` | `~/.claude/settings.json` | `session_id` | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode`, `--model`, `--add-dir`, `--settings`, `--agent` |
| Codex | `codex`; report `codex` | `codex resume … <id>` | `codex fork … <id>` | `~/.codex/hooks.json`, groups with `"matcher": ""` | `session_id` | `--no-daemon`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--full-auto`, `--search`, `-m`/`--model`, `-s`/`--sandbox`, `-a`/`--ask-for-approval`, `-p`/`--profile` |
| Droid | `droid`; report `droid` | `droid … --resume <id>` | `droid … --fork <id>` | `~/.factory/hooks.json` (event map, no `hooks` wrapper) if it exists, else `hooks` in `~/.factory/settings.json`; command `… hook --agent droid` | `session_id` | `--auto`, `--settings`, `--use-spec`, `--disable-builtin-skills`, `--append-system-prompt`, `--append-system-prompt-file` (interactive flags only: `--skip-permissions-unsafe`, `-m` and the reasoning/tool flags are `droid exec` only, and interactive droid reads them as the prompt) |
| Cursor | `cursor-agent`, or `agent`/`node`/`index.js` under a `cursor` or `cursor-agent` folder; report `cursor`, `cursor-agent` | `cursor-agent … --resume <id>` | none | `~/.cursor/hooks.json`: `{"version": 1, "hooks": {"sessionStart": [{"command": …}], "sessionEnd": […]}}`, no timeout; command `… hook --agent cursor` | `conversation_id`; folder from `workspace_roots[0]` | `-f`/`--force`, `--yolo`, `--model` (it has no `-m`), `--sandbox`, `--approve-mcps`, `--mode`, `--plan`, `--workspace`, `--plugin-dir` |

A running agent nobody recorded is found from its files: Claude Code by
`~/.claude/sessions/<pid>.json`; Droid by the newest `<id>.jsonl` in
`~/.factory/sessions/<cwd, every non-alphanumeric a dash>/` written since the agent started;
Cursor by the newest `<id>/` (folder or its `store.db`) in `~/.cursor/chats/<md5 of the
cwd>/` written since then. Codex: not found.

Checked by hand with droid 1.1.0 and cursor-agent 2026.10.22 on macOS: Droid reports
`droid` to Herdr; its SessionStart hook records the session and its flags; `droid --auto
high --resume <id>` reopens the same session id in high autonomy; `droid --fork <id>` opens
an interactive copy under a new id. Cursor's `sessionStart` fires for a new chat with a
`conversation_id` that `cursor-agent --force --resume <id>` reopens with its history;
it does not fire again when a chat is resumed, so the record a resume leaves on the
terminal carries it to the next restart. Both session-file layouts above match. Not
checked yet: Cursor's `sessionEnd` reasons for `/exit`, Ctrl+C and a shutdown, and a real
reboot with either agent.

## Rules

- A hook acts only for the agent in its terminal's foreground: walking up from the hook's
  process must reach the foreground pid, and the agent processes on the way (`claude`, or
  `codex` as the first or second word) must be next to each other. An agent and its
  wrapper are one agent (npm's `node …/bin/codex` running the native `codex`, a launcher
  with another name). Agent, shell, agent is a tool call: a `claude -p` an agent runs
  inherits `HC_TERMINAL_ID`, but its hooks record nothing.
- A one-shot run in the foreground (`claude -p`/`--print`, `codex exec`/`e`, `pi -p`,
  `pi --mode json|rpc`, `pi --no-session`, `droid exec`, `cursor-agent -p`/`--print`)
  records nothing: it fires `SessionStart` and
  ends with reason `other`, so it would replace the interactive session on record and be
  resumed after the next restart.
- pi's extension acts only when `HC_TERMINAL_ID` is set, in pi's `tui` mode, for a session
  with a file. It sends `SessionStart` at every `session_start` (startup, `/new`,
  `/resume`, `/fork`, reload), with pi's command line as `argv` (pi renames its process
  `pi`). At `session_shutdown` it sends `SessionEnd` with reason `prompt_input_exit` only
  for `quit` without a SIGTERM or SIGHUP; a signal, or a session replaced in the same
  process, sends nothing, which keeps the record like Claude Code's `other`. It finds the
  engine as `../revive.mjs` from its own real path, so it must be linked, not copied
  away from the mod.
- The hook records the agent's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` from its own
  environment. The transcript check looks in that folder, and resume and fork run the
  agent under it (`env CLAUDE_CONFIG_DIR=… claude …`). Only those two variables are read
  back from the label.
- The agent is known by the command line the hook sent (pi), then the foreground command
  line, then the agent process the hook came from, then the hook's `--agent`, then the
  payload (its transcript path, Cursor's `cursor_version`), and only then the terminal's
  last OSC report, which may still be a previous agent's. A bare `agent` on a command
  line is no agent: Cursor's only under a path that says Cursor, or by its report. A running agent
  behind a wrapper is recognized by its report while something other than the shell is
  in the foreground.
- `SessionStart` for the remembered session id (a resume, a compaction) keeps its
  `resumed` mark and `at`; a new session id starts without.
- `SessionEnd` with a session id other than the remembered one is ignored.
- `SessionEnd` with reason `clear` or `resume` does nothing: the same process starts
  another session right away and its `SessionStart` records it; clearing could race it.
- `SessionEnd` with reason `other` (a signal) leaves the record. Any other reason
  (`prompt_input_exit` for `/exit` and Ctrl+C, `logout`, …) forgets it. Codex and Droid
  follow these. Cursor: `completed` and `user_close` forget it, any other reason keeps it.
- Hook payloads are read the same for every agent: the event with its first letter
  capitalized (Cursor's `sessionStart`), the id from `session_id` or else
  `conversation_id`, the folder from `cwd` or else `workspace_roots[0]`.
- The shell block asks `${REVIVE_HC:-hc}` for the terminal and starts node only when its
  answer has a `revive.session` label and the terminal's `"pid"` is the shell's `$$`. A
  shell started inside the terminal costs one `hc get`.
- `check` resumes only when all hold: it runs in the terminal's own shell (`$$` is the
  terminal's pid), the terminal's program is not the remembered one (another pid, or the
  same pid with another start time), automatic resume is on, the agent and the id are
  valid, the last resume did not fail (`revive.failed` is unset), and (for Claude Code)
  the session's transcript exists. Without a transcript the record is dropped. A failed
  resume is not retried at every restart; **Resume** in the dialog still tries it.
- `list` checks the transcript only for the focused terminal's running Claude Code
  session, the one whose card offers Fork. It says `forkable: false` only when it is
  sure: the record names its config folder, or the agent's `sessions/<pid>.json` is in
  this process's folder. Otherwise it says `null` and the fork is let through, since an
  agent started with a `CLAUDE_CONFIG_DIR` the app doesn't have keeps its transcripts
  elsewhere.
- `check` marks the terminal (`shell`, `since`, `resumed`) before printing, so a second
  shell can't resume the same session again.
- The shell block runs what `check` printed at the first prompt (zsh: a one-time `precmd`
  hook; bash: `PROMPT_COMMAND`), not while the rc files run. The resume runs with its
  input and output on the terminal's own device (`/dev/$(ps -o tty= -p $$)`), never
  `/dev/tty`: Claude Code's runtime crashes on macOS when its input is that alias.
- The shell block leaves `$?` at 0.
- Session ids must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; anything else is refused.
  Every word of a command is shell-quoted.
- **Resume** in the dialog sends the command to the terminal with `hc send`, only when its
  foreground is the terminal's own shell, never into another running program.
- Fork opens `terminal.open {argv, folder, place}` with the agent's fork command:
  `claude … --resume <id> --fork-session`, `codex fork … <id>`, `pi … --fork <id>`,
  `droid … --fork <id>`. An agent with no fork (Cursor) gets no fork buttons or keys.
- pi's transcript check is the recorded session file: it exists, or the session never got
  a message. A record without one is let through.
- Install writes an agent's hooks only into the file it reads now, and takes Revive's
  out of every other file it may be in (Droid's `settings.json` once a `hooks.json`
  exists). A file without Revive in it is never rewritten by uninstall.
- Hooks never fail an agent: every error is swallowed and the exit code is 0.

## Settings

| Setting | Effect |
| --- | --- |
| `REVIVE_AUTO=0` | Shells with it set never resume automatically |
| `REVIVE_DEBUG=1` | The shell block says why it did or didn't resume, on stderr |
| `REVIVE_HC` | The `hc` binary the engine and the shell block use (default: `hc` on PATH) |
| `REVIVE_TTY` | The device the resume runs on, instead of the terminal's (for tests) |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `ZDOTDIR` | Honored when finding the files to install into (a session's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` is recorded with it); without `ZDOTDIR` in the environment, `zsh -c` is asked for it (it reads `~/.zshenv`). Droid and Cursor: always `~/.factory` and `~/.cursor` |

Install writes through symlinks to the file they point at, keeps each file's permissions,
and copies the original to `<file>.revive-backup` only the first time. A settings file
whose Revive hooks are already right (the same command and timeout) is not written, even
when another tool reformatted it or added its own groups after Revive's: other tools (Herdr's
own Codex integration among them) rewrite `~/.codex/hooks.json` too. Each hook has a
10 second timeout, except Codex's `SessionEnd`, which gets 3: Codex clamps it to 3 and
warns at every start about anything longer.
