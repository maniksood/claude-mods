# claude-mods

A collection of Claude Code mods.

| Mod | What it does |
| --- | --- |
| `build-progress` | A panel and a band that show a session's % done, time left and status. |

## Install on another Mac

Inside Claude Code:

```
/plugin marketplace add <github-user>/claude-mods
/plugin install build-progress@claude-mods
```

Replace `<github-user>` with your GitHub user name. Then start a new session (or run `/reload-plugins` in a running one).

## Using a mod after install

Start a new Claude Code session. Mods load by themselves. `/plugin` lists what is installed and lets you turn one off.

## Update

```
/plugin marketplace update claude-mods
/plugin update build-progress@claude-mods
```

## Remove

```
/plugin uninstall build-progress@claude-mods
```

## Adding a new mod later

Make a new folder beside `build-progress/` with its own `.claude-plugin/plugin.json`, then list it in `.claude-plugin/marketplace.json`. Give it a section below with the same headings as `build-progress`.

---

# build-progress

## How to use

### What you see

**The band** sits above the chat box. One line: emoji · % · bar · time left · what it is doing.

```
🧬 46% ▰▰▰▰▰▱▱▱▱▱ · about 59 min left · Phase 2: api server · mutant 30/40
```

**The Builds panel** has one card, for this session only:

- the prompt id, with the small character beside it
- the big %, and the bar
- time left, and "running for N min"
- what the run is on now (the open to-do item and its newest marker), and "Now: …"
- the to-do list, with ✅ done, ▶ open, ○ waiting
- running helpers (👥)

Example (a made-up session at 46%):

```
╭──────────────────────────────────────────────╮
│ 🧬  DEMO-1                                    │
│ 46%                                          │
│ ▰▰▰▰▰▱▱▱▱▱                                   │
│ about 59 min left                            │
│ running for 50 min                           │
│ Phase 2: api server · mutant 30 of 40        │
│ Now: Running mutants against the server      │
│                                              │
│ ✅ Step 0: read the prompt                    │
│ ✅ Phase 1: schema                            │
│ ▶ Phase 2: api server                        │
│ ○ Phase 3: runs                              │
│ ○ Phase 4: report                            │
│ ○ Write and print final report               │
│                                              │
│ 👥 Mutation runner 2 · 0 min                  │
╰──────────────────────────────────────────────╯
```

On the desktop app the character is a small animated figure; in a terminal it is the emoji.

### Open, close, reopen

- The panel opens by itself when a session starts.
- Close it with Esc then `ctrl+x x`, or its close mark.
- It reopens at the next session start.
- `/builds` prints, as plain text, every session that wrote a status file in the last 12 hours: emoji, prompt id, %, bar, time left, running time, the open item and what it is doing. Failed first, then working, quiet, finished.

### How % and time left are worked out

- **%** comes from the session's own to-do list: (items done + the open item's `n/N`) ÷ items. The open item's `n/N` is the newest `▶ x n/N` marker. With no to-do list it uses the `▶ phase n/N` markers.
- **Time left** comes from the prompt header's `EXPECT: <hours> h` until the run is 10% done: `EXPECT − time running` (never below 5 min). It is then shown as "(from the estimate)".
- From 10% done on, it uses the real speed: time running × (100 − %) ÷ %.
- With no `EXPECT` line and under 10%, it says "time left not known yet".
- "Running for N min" counts from the first prompt (or, in a session reloaded with history, from the session's launch).

### How to write a prompt so the panel shows it well

- Put a header line `EXPECT: 4 h`.
- Ask the run to keep a to-do list, one item per phase.
- Ask it to print markers with counts: `▶ phase n/N` at each phase, `▶ <step> n/N` inside it (for example `▶ mutant 30/40`).
- Ask it to print `▶ done` (or `▶ failed`) at the end.

Example header:

```
# DEMO-1 · build the api server
MODEL: Opus   EFFORT: high
EXPECT: 4 h
Keep a to-do list with one item per phase.
Print "▶ phase n/N" at each phase and "▶ <step> n/N" for counted steps, and "▶ done" last.
```

The prompt id is the first word of the first `#` heading, else a first line like `MOD-3 · …`, else a `.md` path in the prompt; with none, the folder and branch.

### What the emoji and animations mean

| Emoji | State | Animation (desktop) |
| --- | --- | --- |
| 🔨 | working | typing on a laptop |
| 🧪 | tests running | holding a bubbling test tube |
| 🧬 | mutants running | a purple blob and sparks |
| 👥 | a helper is running | listed under the card (a line, no animation) |
| 😴 | quiet: nothing running for 10 min | eyes closed, "zzz" |
| ✅ | finished | jumping, confetti |
| ❌ | stopped | head in hands |

### What it never shows

Command text (only a Bash call's own description), file contents (only file names; names that look like secret stores such as `.env`, `*.pem`, `*.key` are replaced by "(protected file)"), anything that looks like a key or token (cut out), and other sessions (the panel and band draw this session only; `/builds` lists the others as text).

### Settings: `folder_labels`

Optional. A comma-separated list of `path-suffix=label` pairs that gives folders a friendlier name in the band, panel and `/builds` when a session has no prompt id, for example `Work/project-a=main clone,Work/project-b=design clone`. A folder whose path ends with the suffix shows the label. Empty by default: a folder then shows as its last part. Set it when the plugin is installed, or later in `/config`.

### Where its files live

`~/.claude/build-progress/`, one small JSON file per session. They are safe to delete; the mod rewrites its own. Files older than 2 days are emptied.

### When it looks wrong

- A window that was already running needs `/reload-plugins` after an update.
- A run started before the mod was installed shows only from its next step.
- Time left is a guess until the run is 10% done.

## Privacy

The mod writes status files only to `~/.claude/build-progress/`, never sends anything anywhere, and never shows commands, file contents or secrets.

## Licence

MIT, see `LICENSE`.
