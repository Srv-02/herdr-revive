# ↻ Revive

[![CI](https://github.com/dmazlum/herdr-revive/actions/workflows/ci.yml/badge.svg)](https://github.com/dmazlum/herdr-revive/actions/workflows/ci.yml)

Bring back the coding agent a [Herdr](https://herdr.dev) terminal lost, and fork a live
session beside it.

Herdr keeps your terminals through app restarts and updates. When the machine reboots or
herdr-core stops, each pane comes back with a fresh shell in the same folder, but the agent
that was running there is gone. Revive remembers which session each terminal held and,
when its shell comes back, starts that session again in the same pane, with the same
flags.

![Revive](preview.png)

Requires the **Herdr desktop app 0.1.9+**, **Node 20+**, and **Claude Code**. Codex,
[Factory Droid](https://docs.factory.com) (`droid`) and the
[Cursor CLI](https://cursor.com/docs/cli/overview) (`cursor-agent`) are supported too, but
experimental: see [Limits](#limits).

## Features

- **Automatic resume.** After a reboot or a core restart, the pane's new shell runs
  `claude --resume <id>` (or `codex resume <id>`, `droid --resume <id>`,
  `cursor-agent --resume <id>`) in the session's folder, before you touch anything. A dim
  line says what it is doing.
- **Only what was lost.** A session you ended yourself (`/exit`, Ctrl+C, `/logout`) is
  forgotten on the spot. A session that was never sent a message is skipped, since it has
  nothing to resume. A shell you start inside a pane never resumes anything.
- **Same flags.** `--dangerously-skip-permissions`, `--model`, `--permission-mode`,
  `--add-dir` and similar flags come back with the session; for Droid
  `--auto` (its interactive mode has no `--skip-permissions-unsafe`); for Cursor `--force`/`--yolo`, `--model`,
  `--sandbox`, `--mode`. The first prompt, `--resume` itself and secrets (`--api-key`, `-H`)
  are left behind.
- **Fork.** Open the conversation of the focused agent as a new session beside it (right,
  below or in a new tab), with the same flags. Both work in the same folder; a fork copies
  the conversation, not the files. Claude Code, Codex and Droid (`droid --fork <id>`) fork;
  the Cursor CLI has no fork, so the dialog offers none for it.
- **Resume by hand.** An agent that died under a shell that survived it (a crash, a `kill`)
  is listed as *Interrupted*, with a **Resume** button. One whose resume failed is listed
  as *Resume failed*.
- **Per terminal.** Turn automatic resume off for one terminal in the dialog, or for a
  whole shell with `REVIVE_AUTO=0`.
- **Nothing to run.** No background process. Sessions are remembered as labels on their
  herdr-core terminals, so the record lives exactly as long as the terminal does.

## Install

In Herdr, ask your agent to add `github.com/dmazlum/herdr-revive`: it reads
[`RECIPE.md`](RECIPE.md) and every file, copies `mods/revive`, merges
[`keys.json`](keys.json), checks the mod and runs the install step. Or by hand:

```sh
git clone https://github.com/dmazlum/herdr-revive
cp -R herdr-revive/mods/revive ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/revive
node ~/.config/herdr-app/mods/revive/revive.mjs install
```

`install` adds two hooks (`SessionStart`, `SessionEnd`) to `~/.claude/settings.json`, the
same two to `~/.codex/hooks.json` when Codex is installed (`~/.codex` exists), to Droid's
hooks when `~/.factory` exists (`~/.factory/hooks.json` if you have one, else the `hooks` key
of `~/.factory/settings.json`, since Droid reads that one only while there is no
`hooks.json`), and `sessionStart`/`sessionEnd` to `~/.cursor/hooks.json` when `~/.cursor`
exists. Droid's and Cursor's hooks run `revive.mjs hook --agent droid|cursor`. It also adds a
short block to the file
your login shell reads at start: `~/.zshrc` for zsh, and for bash the first of
`~/.bash_profile`, `~/.bash_login` and `~/.profile` that exists (Herdr starts terminals as
login shells, which don't read `~/.bashrc`). zsh is asked where its `.zshrc` is, so a
`ZDOTDIR` set in `~/.zshenv` is followed. A symlinked file (a dotfiles repository) is
changed where the link points, and every file keeps its permissions. The first time it
changes a file, the original is copied to `<file>.revive-backup`; later runs keep that
copy. Running it again
changes nothing, so it is also how you update the shell block after updating Revive. The
**Install** button in the dialog does the same. Codex asks you to trust new hooks the next
time it starts; Droid warns that its hooks changed and shows them in `/hooks`. `--no-codex`,
`--no-droid` and `--no-cursor` leave that agent's files alone.

```sh
node ~/.config/herdr-app/mods/revive/revive.mjs install --zsh --bash   # both shells
node ~/.config/herdr-app/mods/revive/revive.mjs uninstall              # take it all out
node ~/.config/herdr-app/mods/revive/revive.mjs doctor                 # what is installed
```

Then merge [`keys.json`](keys.json) into `~/.config/herdr-app/keys.json`:

| Key | What it does |
| --- | --- |
| `cmd-shift-r` → `mod.open:revive` | Open the dialog for the focused terminal |
| `F` / `D` / `T` in the dialog | Fork the focused agent right / below / to a new tab |
| `↵` in the dialog | Resume the focused terminal's session |
| `R` | Refresh |
| Esc | Close |

While developing, link the folder instead of copying it, and Herdr reloads the mod on
every save:

```sh
ln -s "$PWD/herdr-revive/mods/revive" ~/.config/herdr-app/mods/revive
```

## How it works

1. When an agent starts a session in a Herdr terminal, its `SessionStart` hook runs
   `revive.mjs hook`. The session id is the hook's `session_id` (Claude Code, Codex, Droid)
   or `conversation_id` (Cursor, whose folder comes from `workspace_roots`). That labels the
   terminal (`hc label`) with the agent, the session id,
   the folder, the flags worth keeping, and the pid and start time of the terminal's
   program. Only the agent in the terminal's foreground is recorded (with any wrapper
   that launches it): a `claude -p` it runs as a tool is not.
2. When the session ends, `SessionEnd` tells why. You ended it: the labels go. A signal
   ended it (reason `other`): the labels stay. `/clear` leaves them to the new session,
   which records itself. Droid sends Claude Code's reasons. Cursor's `completed` and
   `user_close` forget the session; anything else (`aborted`, `error`, …) keeps it.
3. After a reboot or a core restart, herdr-core gives the terminal a new shell. Its rc file
   checks, without starting anything, that a session is remembered and that it is the
   terminal's own shell, then asks `revive.mjs check`. A terminal whose program is no
   longer the remembered one (by
   pid and start time, since pids start over after a reboot) lost its agent, so `check`
   prints the commands that resume the session. The shell runs them at its first prompt,
   once its rc files are done, and hands the agent the terminal device itself, so prompt
   themes that hold the shell's output while it starts (an instant prompt) don't get in
   the way.
4. If the agent exits with an error within 15 seconds, the terminal is marked as failed and
   the dialog offers a retry.

```sh
hc get t3 --json | jq '.labels | with_entries(select(.key | startswith("revive.")))'
hc label t3 revive.auto=off      # no automatic resume for t3
REVIVE_DEBUG=1 zsh               # say why a shell did or didn't resume
```

## Limits

- Local only. Terminals on another machine are not remembered yet.
- Sessions started before Revive was installed have no record. The dialog still finds a
  running one from the files its agent writes (Claude Code: `sessions/<pid>.json`; Droid:
  the newest `~/.factory/sessions/<folder, dashed>/<id>.jsonl` written since it started;
  Cursor: the newest `~/.cursor/chats/<md5 of the folder>/<id>/`), so it can be forked, but
  it won't come back by itself.
- An agent that died while its shell lived on is not resumed automatically, since nothing
  told the shell. Use **Resume** in the dialog.
- Codex has not been tested end to end. Its hooks follow the same format as Claude Code's,
  and Codex behind a wrapper (npm's `node …/bin/codex`, a launcher script) is recognized,
  but Revive can't check whether a Codex session can be resumed before trying.
- Droid (1.1.0) and the Cursor CLI (2026.10.22) were checked by hand: the hooks record the
  session and flags, and resume (and Droid's fork) reopen the conversation. Not checked
  yet: which `sessionEnd` reasons Cursor sends for `/exit`, Ctrl+C or a shutdown, and a
  real reboot with either. Like Codex, neither is checked for a resumable session before
  trying: a failed resume is marked *Resume failed*.
- Cursor installs as `cursor-agent` and `agent`. `agent` is a common name, so it counts as
  Cursor only under a path that says so (`…/cursor-agent/…`) or when it reports itself as
  Cursor to Herdr. Cursor's hooks also run for the Cursor editor's chats; outside a Herdr
  terminal they do nothing.
- Shell support: zsh and bash. Other shells can run `revive.mjs check --shell $$` from
  their own rc file and evaluate what it prints.

## Development

```sh
npm test    # labels, states, flags, quoting, the resume script, install and uninstall
```

The UI is checked in Herdr: `herdr-app check`, then `herdr-app shot` while the dialog is
open. To test a real restart without touching your own terminals, start a second
herdr-core with its own `HC_SESSION` and `XDG_STATE_HOME`/`XDG_RUNTIME_DIR` (a short path:
socket paths are limited to about 100 bytes) and restart that one.

## License

MIT
