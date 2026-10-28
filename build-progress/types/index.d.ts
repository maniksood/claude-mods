export type Marker = { kind: string; n: number; N: number; at: number; line: string }
export type Sub = { id: string; description: string; started_at: number }
/** `untimed`: the end is known but not when, so no minutes are shown. */
export type Finish = { at: number; verdict: string; ok: boolean; untimed?: true }
/** One background task: a command started in the background, a background subagent or a monitor. `label` is its description or name, never a command. */
export type Bg = {
  /** The task's id (a shell's or monitor's `taskId`, an agent's `agentId`); the call's `tool_use_id` until the id is known. */
  id: string
  tool_use_id: string
  kind: 'shell' | 'agent' | 'monitor'
  label: string
  started_at: number
  /** null while it runs (or until the 2-hour cap shows "no news"). */
  ended_at: number | null
  ok: boolean | null
  /** `completed`, `failed` or `killed`, when it ended. */
  end: string | null
  /** The status word of the last notification seen for it (id and status only). */
  seen: string | null
  /** Its own % (0..100) from `▶ x n/N`, `NN%` or its checklist; null when it reports none. */
  pct: number | null
  /** When its own "N min left" / ETA line says it will end (ms); null when it says nothing. */
  eta_at: number | null
  /** When `pct` / `eta_at` were last read. */
  prog_at: number | null
}
/** The run's own newest status line: its % and when it says it will end. */
export type Report = { at: number; pct: number | null; eta_at: number | null }
/** One tool call: its name and its description or file name, never a command. `at` is 0 when a reload could not know. */
export type Step = { name: string; detail: string; at: number }
/** One item of the session's own to-do list; `mark` is the newest `▶ kind n/N` seen while it was in progress. */
export type Task = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  mark: { kind: string; n: number; N: number } | null
}

/** One session's status file, `~/.claude/build-progress/<session id>.json`; only `/builds` reads other sessions' files. */
export type Status = {
  v: 2
  session: string
  folder: string
  branch: string
  /** The session's first prompt, in `$.clock.now()` milliseconds. */
  started_at: number
  /** False when `started_at` is only a lower bound (a reload could not find the first prompt's time). */
  start_known: boolean
  updated_at: number
  prompt_id: string
  /** "lead" or "second" when the prompt says so. */
  role: string | null
  /** Hours from the prompt header's `EXPECT: <hours> h`. */
  expect_h: number | null
  phase: { n: number; N: number } | null
  other: { kind: string; n: number; N: number } | null
  markers: Marker[]
  tasks: Task[]
  tool_now: { name: string; detail: string } | null
  /** When the running tool call started. */
  tool_since: number | null
  /** Last sign of life: an event, or the heartbeat while a tool or helper runs. */
  alive_at: number
  subagents: Sub[]
  finished: Finish | null
  /** Background tasks: running ones and those that ended in the last 10 minutes. */
  bg: Bg[]
  /** Tool calls made by the main loop in this session. */
  steps: number
  /** The last 5 tool calls. */
  recent: Step[]
  /** The first share of the work seen since the mod loaded; the speed for the time left is read from it. */
  watch: { at: number; frac: number } | null
  /** The newest status line the run printed (`56% · ~288 min left`). */
  report: Report | null
  /** When the checklist's share last changed. */
  tasks_at: number
  /** The session's name in the app's sidebar, read from its transcript; '' when unknown. */
  title: string
}

declare module 'claude-code' {
  interface PluginState {
    'build-progress': {
      now: number
      mine: Status | null
    }
  }
}
