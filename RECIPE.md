# Revive

Revive brings back the coding agent a Herdr terminal lost to a reboot or a herdr-core
restart, in the same pane, with the same session and flags. It also forks the focused
agent's conversation into a new session beside it.

## Installing it (for the agent doing it)

1. Read every file in this repository before copying anything.
2. Copy `mods/revive` to `~/.config/herdr-app/mods/revive`.
3. Run `herdr-app check ~/.config/herdr-app/mods/revive`. It must pass.
4. Merge `keys.json` into `~/.config/herdr-app/keys.json`. Ask the person first if
   `cmd-shift-r` is already bound.
5. Tell the person what `install` changes and ask before running it:
   `node ~/.config/herdr-app/mods/revive/revive.mjs install`. It edits
   `~/.claude/settings.json`, `~/.codex/hooks.json` (only if `~/.codex` exists) and the
   file their login shell reads (`~/.zshrc`; for bash the first existing of
   `~/.bash_profile`, `~/.bash_login`, `~/.profile`), keeping the original of each as
   `.revive-backup`. If they use both zsh and bash, add `--zsh --bash`.
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
      (outline); for one that needs you, a solid **Resume** `↵`. A Claude Code session
      with no transcript yet can't be forked: the Fork buttons are disabled, F/D/T do
      nothing, and the card says *This session has no message yet, so there is nothing to
      fork. Send it one first.* Without a session: *No Claude Code or Codex session in the
      focused terminal.* On another machine: a note that Revive works on this computer for
      now.
    - **NEED YOU**: other terminals whose session is lost, interrupted or failed. Each row
      (48px, 10px radius, filled with `raised`, `hover` on hover, 4px apart) shows the
      agent (13px medium), the short id, *space / tab* and *resumed 3m ago* in `dim`, the
      state, an **Auto** / **Auto off** ghost toggle and a solid **Resume**. Clicking the
      row closes the dialog and focuses that terminal.
    - **OTHER SESSIONS**: the remaining ones, same rows without the fill or **Resume**. Sessions found
      through their pid but not remembered say *not remembered* instead of the toggle.
  - A note line for errors (`ansi1`) or install output (`muted`), on `raised`.
  - A footer above a `border` line: `✓ Claude Code hooks`, `✓ Codex hooks` (only when
    Codex is installed), `✓ shell`, each `muted` with a `ansi2` ✓ when installed and
    `ansi1` with `✕` when not, and a solid **Install** button while anything is missing.
- The list refreshes every 4 seconds while the dialog is open.
- In a resumed pane, before the agent starts: `↻ Revive: resuming Claude Code session
  9e458eb4. REVIVE_AUTO=0 skips this.` in dim text.

## The files

| File | What it is |
| --- | --- |
| `mods/revive/main.js` | The dialog |
| `mods/revive/lib/core.js` | Agents, flags, labels, states and the resume script: plain functions shared by the dialog and the engine |
| `mods/revive/revive.mjs` | The engine, run with the person's Node: hooks, the shell check, list, resume, install |
| `mods/revive/package.json` | Marks the folder as ES modules for Node |
| `mods/revive/mod.json` | Opens as a dialog; docks nowhere |

## The record

A session is remembered as labels on its herdr-core terminal:

| Label | Value |
| --- | --- |
| `revive.agent` | `claude` or `codex` |
| `revive.session` | The session id |
| `revive.cwd` | The folder the session ran in |
| `revive.flags` | The carried launch flags, as a JSON array |
| `revive.env` | The agent's config folder when the session ran under one (`{"CLAUDE_CONFIG_DIR": …}` or `{"CODEX_HOME": …}`), as a JSON object; absent otherwise |
| `revive.shell` | The pid of the terminal's program when the session started or was resumed |
| `revive.since` | That program's start time (`ps -o lstart`), so a new shell that got an old pid after a reboot is still new |
| `revive.at` | When it was recorded (ms) |
| `revive.resumed` | When Revive last resumed it (ms); kept until a new session starts |
| `revive.failed` | When a resume gave up within 15 seconds (ms) |
| `revive.auto` | `off` turns automatic resume off for this terminal; kept across sessions |

Labels are kept by herdr-core across its restarts and go away with the terminal.

## Rules

- A hook acts only for the agent in its terminal's foreground: walking up from the hook's
  process must reach the foreground pid, and the agent processes on the way (`claude`, or
  `codex` as the first or second word) must be next to each other. An agent and its
  wrapper are one agent (npm's `node …/bin/codex` running the native `codex`, a launcher
  with another name). Agent, shell, agent is a tool call: a `claude -p` an agent runs
  inherits `HC_TERMINAL_ID`, but its hooks record nothing.
- A one-shot run in the foreground (`claude -p`/`--print`, `codex exec`/`e`) records
  nothing: it fires `SessionStart` and ends with reason `other`, so it would replace the
  interactive session on record and be resumed after the next restart.
- The hook records the agent's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` from its own
  environment. The transcript check looks in that folder, and resume and fork run the
  agent under it (`env CLAUDE_CONFIG_DIR=… claude …`). Only those two variables are read
  back from the label.
- The agent is known by the foreground command line first, then the command line of the
  agent process the hook came from, then the transcript path, and only then the
  terminal's last OSC report, which may still be a previous agent's. A running agent
  behind a wrapper is recognized by its report while something other than the shell is
  in the foreground.
- `SessionStart` for the remembered session id (a resume, a compaction) keeps its
  `resumed` mark and `at`; a new session id starts without.
- `SessionEnd` with a session id other than the remembered one is ignored.
- `SessionEnd` with reason `clear` or `resume` does nothing: the same process starts
  another session right away and its `SessionStart` records it; clearing could race it.
- `SessionEnd` with reason `other` (a signal) leaves the record. Any other reason
  (`prompt_input_exit` for `/exit` and Ctrl+C, `logout`, …) forgets it.
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
  `claude … --resume <id> --fork-session`, `codex fork … <id>`.
- Hooks never fail an agent: every error is swallowed and the exit code is 0.

## Settings

| Setting | Effect |
| --- | --- |
| `REVIVE_AUTO=0` | Shells with it set never resume automatically |
| `REVIVE_DEBUG=1` | The shell block says why it did or didn't resume, on stderr |
| `REVIVE_HC` | The `hc` binary the engine and the shell block use (default: `hc` on PATH) |
| `REVIVE_TTY` | The device the resume runs on, instead of the terminal's (for tests) |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ZDOTDIR` | Honored when finding the files to install into (a session's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME` is recorded with it); without `ZDOTDIR` in the environment, `zsh -c` is asked for it (it reads `~/.zshenv`) |

Install writes through symlinks to the file they point at, keeps each file's permissions,
and copies the original to `<file>.revive-backup` only the first time.
