export type Marker = { kind: string; n: number; N: number; at: number; line: string }
export type Sub = { id: string; description: string; started_at: number }
export type Finish = { at: number; verdict: string; ok: boolean }
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
}

declare module 'claude-code' {
  interface PluginState {
    'build-progress': {
      now: number
      mine: Status | null
    }
  }
}
