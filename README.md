# claude-mods

A collection of Claude Code mods.

| Mod | What it does |
| --- | --- |
| `build-progress` | A panel and a band that show a session's % done, time left, status and background tasks. |

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

**The band** sits above the chat box, in two lines, each cut at the window's edge on its own: overall %, overall time left and what the run is on; then the background tasks (the second line is left out when none runs).

```
📊 57% overall · ⏱ about 4 h 48 min left · ▶ P5 wait for siblings
🔄 1 in background: Watch sibling summaries 40%, ~12 min
```

- `📊 57% overall`: the main run's % while it works. It is never 100% while anything still runs.
- `⏱ about 4 h 48 min left`: the **longest** of the main run's time left and every running background task's time left (the session is not done until all are). If a running task has no time left known, the band says so: `⏱ about 4 h 48 min left (1 background task with no estimate)`. With an `EXPECT` line and an unknown start it says `at most …`.
- `▶ …`: the open item of the checklist and its newest marker.
- `🔄 …`: one task shows its name, its % and its time left. Several show `🔄 3 in background (2 with %): 40% ~12 min, 75% ~3 min, …` (three at most; the panel lists all).

With **no checklist, no `▶` markers and no `EXPECT` line** (an ordinary session) there is no % to show, so the band says what is happening:

```
🔨 Working · Now: Run the unit tests · 34 steps so far · running for at least 52 min
🔄 1 in background: Build the index
✅ Finished · 34 steps · took at least 52 min
```

When the turn has ended but background work still runs, the band does not say Finished. The overall % is then the average of the tasks that report one:

```
⏳ Waiting on 2 background tasks · 📊 58% overall · ⏱ about 12 min left
🔄 40% ~12 min, 75% ~3 min
```

When the last one ends it says `✅ Finished · took N min`.

**The Builds panel** is for this session only, top to bottom:

1. **The session's name** (from the app's sidebar) with the small character beside it; with no name, the prompt id; with none, the folder and branch.
2. **Overall**: the big %, the bar, `about 4 h 48 min left overall (1 background task with no estimate)`, `running for 1 h 18 min`.
3. **Main run**: its %, its time left with where it comes from (`(from the run)`, `(from the estimate)`, `(from the last N min)`, `(from the pace so far)`), the open item and marker, `Now: …`, then the checklist with ✅ done, ▶ open, ○ waiting (in an ordinary session, the last 5 steps instead).
4. **In the background**: one row per running task: icon (⌨️ command, 🤖 agent, 👁 monitor), name, `40% ▰▰▰▱▱▱▱▱` or `no % reported`, `running for N min` (from the task's own start), and its time left when known (`from its own line` or `from its pace`).
5. **Done in the background** (last 10 minutes).
6. Running helpers (👥).

```
╭──────────────────────────────────────────────╮
│ 🧬  GQ3B form losing areas                    │
│                                              │
│ Overall                                      │
│ 57%                                          │
│ ▰▰▰▰▰▰▱▱▱▱                                   │
│ about 4 h 48 min left overall                │
│ running for 1 h 18 min                       │
│                                              │
│ Main run                                     │
│ 57%  ▰▰▰▰▰▰▱▱▱▱                              │
│ about 4 h 48 min left (from the run)         │
│ P5 wait for siblings                         │
│ Now: Waiting for a helper                    │
│                                              │
│ ✅ P4: merge                                  │
│ ▶ P5 wait for siblings                       │
│ ○ P6: report                                 │
│                                              │
│ In the background                            │
│ 🤖 Watch sibling summaries · 40% ▰▰▰▱▱▱▱▱ ·  │
│    running for 5 min · about 12 min left     │
│    (from its pace)                           │
│ ⌨️ Build the index · no % reported · running  │
│    for 21 min                                │
╰──────────────────────────────────────────────╯
```

On the desktop app the character is a small animated figure; in a terminal it is the emoji.

### Background tasks

Each task is one row with its description only (a Bash call's `description`, an agent's description, a monitor's description), never the command. Finished tasks stay in "Done in the background" for 10 minutes, then disappear. A task whose end is never reported shows `❔ … · no news for 2 h` after 2 hours and is no longer counted as running.

How the mod knows a task ended: the app writes a "finished" row (an `attachment` row of kind `queued_command` that opens with a `<task-notification>` envelope holding `<task-id>` and `<status>`). The mod reads that row live. It also reads the session's transcript file with `grep` (ids, status words and clock times only; no message text is kept) when the session starts and every 2 minutes while the session works (a turn is open, or a task still counts as running), so a notice it missed (another plugin can pass the live event on before this mod sees it), or one that came before a reload, still ends the task at the time in the file, and each task shows **its own start time**, not the time of the reload. The same read gives the session's name. The transcript is looked for under the app's own folder: `CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`. A monitor's notices carry no status word: one that reaches its own time limit (`timeoutMs`) is ended there, as `timed out`. A task stopped with `TaskStop` ends at the time of the stop's result row. An end seen in the replayed history (which has no clock) takes its time from the file. A reloaded session whose last turn had ended shows **Finished**, timed from the last turn's end row (or a later task end), when nothing still runs. A session that finished because its whole to-do list was done is timed, after a reload, from its last to-do list call (the tool's name and the row's time only), or a later task end.

How a task's % is found: a background agent from its own checklist (`TodoWrite`, `update_plan`, `TaskCreate`) and its `▶ x n/N` lines; a background command from the **last lines of its output file** (the app's `tasks/<id>.output`), read only to find a `▶ x n/N` marker, an `NN%` figure or an `N min left` / `ETA hh:mm` line. The output itself is never shown or stored. A task that prints none of these shows `no % reported`.

The mod only watches; it never starts, stops or changes a task. `/builds-tasks` prints this session's background tasks with each one's start, its matched end (time and status word), and the last notification seen for it (task id and status only), and any notification that named no listed task. After a reload it also lists the tasks that had already ended, and says for each end whether it was read from the replayed history or the transcript file.

### Open, close, reopen

- The panel opens by itself when a session starts.
- Close it with Esc then `ctrl+x x`, or its close mark.
- It reopens at the next session start.
- `/builds-panel` reopens it now (the same panel, never a second one) and answers with one line, `Opened the Builds panel.`
- `/builds` prints, as plain text, every session that wrote a status file in the last 12 hours: emoji, prompt id, %, bar, time left, running time, the open item and what it is doing. Failed first, then working, quiet, finished.

### How % and time left are worked out

**Main run %**: from the session's own to-do list (TodoWrite, TaskCreate/TaskUpdate, or the desktop app's `update_plan`), read live and again from the history after a reload: (items done + the open item's `n/N`) ÷ items. The open item's `n/N` is the newest `▶ x n/N` marker. With no to-do list it uses `▶ phase n/N` markers. If the run prints its own **status line** with a %, the newer of the two wins.

**A status line** is a line that names a time left (`~288 min left`, `288 min left`, `about 288 min left`, `4 h 48 min left`, `4h48m left`, `ETA 17:45`) or starts with a clock time and carries a %, for example `12:51 · P5 waiting · 56% · ~288 min left`.

**Main run time left**, the first that applies:

1. the run's own newest status line, while it is under 15 minutes old: `(from the run)`;
2. `EXPECT: <hours> h` minus the time running (never below 5 min): `(from the estimate)`; with an unknown start, `at most N min left`;
3. from 10% done on, the real pace: time running × (100 − %) ÷ %: `(from the pace so far)`; with an unknown start, the speed the mod has seen since it loaded, after 10 minutes watched and with the % moved: `(from the last N min)`.

**Each background task's time left**: its own `N min left` / `ETA` line, else its pace (after 2 minutes running, with a %): time running × (100 − %) ÷ %. Otherwise none.

**Overall time left**: the longest of the main run's and every running task's. **Overall %**: the main run's % while it works; once its checklist is done and only background tasks run, the average % of the tasks that report one; never 100% while anything runs.

- The plain `Working · N steps` form is used only when there is no to-do list at all.
- "Running for N min" counts from the first prompt (or, in a session reloaded with history, from the transcript's first row, else the session's launch).

### How to make your runs show well

- Put a header line `EXPECT: 4 h`.
- Keep a checklist (to-do list), one item per phase.
- Print markers with counts: `▶ phase n/N` at each phase, `▶ <step> n/N` inside it (for example `▶ mutant 30/40`), and `▶ done` (or `▶ failed`) at the end.
- Print a status line now and then, such as `56% · ~288 min left` (or `12:51 · P5 waiting · 56% · ETA 17:45`).
- Make background commands print `▶ x n/N` or `NN%` lines (and, if you can, `N min left`); background agents should keep their own checklist.

Example header:

```
# DEMO-1 · build the api server
MODEL: Opus   EFFORT: high
EXPECT: 4 h
Keep a to-do list with one item per phase.
Print "▶ phase n/N" at each phase and "▶ <step> n/N" for counted steps, a status line like "56% · ~288 min left" every 10 minutes, and "▶ done" last.
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
- Time left is a guess until the run prints a status line with a time left, or is 10% done.
- Reading the transcript and a task's output uses `grep` and `tail` on this Mac. If they cannot run, the mod falls back to what it saw live: tasks then start at the reload and show no % for commands.

## Privacy

The mod writes status files only to `~/.claude/build-progress/`, never sends anything anywhere, and never shows commands, file contents or secrets. It reads this session's own transcript and its background tasks' output files only to find ids, status words, clock times, the session's name and progress figures; none of that text is shown or kept.

## Licence

MIT, see `LICENSE`.
