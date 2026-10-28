import type { Bg, Finish, Marker, Report, Status, Step, Task } from '../types'

export const QUIET_MS = 10 * 60_000
export const STALE_TOOL_MS = 15 * 60_000
export const HEARTBEAT_MS = 60_000
export const HIDE_MS = 12 * 3_600_000
export const DELETE_MS = 2 * 24 * 3_600_000
export const ALL_DONE = 'all items done'
export const EARLY_PCT = 10
export const MIN_LEFT = 5
export const BG_DONE_MS = 10 * 60_000
export const BG_CAP_MS = 2 * 3_600_000
export const BG_KEEP = 20
export const STEPS_KEPT = 5
/** A status line the run printed is trusted for this long. */
export const REPORT_MS = 15 * 60_000
/** A background task's own pace is read after this long. */
export const BG_PACE_MIN = 2

export type RunState = 'building' | 'testing' | 'mutation' | 'quiet' | 'done' | 'failed'

export const EMOJI: Record<RunState, string> = {
  building: '🔨',
  testing: '🧪',
  mutation: '🧬',
  quiet: '😴',
  done: '✅',
  failed: '❌',
}

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#9c36b5', '#d6336c', '#c77700', '#0c8599', '#5c7cfa']

const hash = (s: string): number => {
  let h = 7
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export const colorFor = (promptId: string): string => COLORS[hash(promptId) % COLORS.length] ?? '#1c7ed6'

/** Cuts anything that looks like a secret out of a line that will be written or drawn. */
export const scrub = (text: string, max = 80): string =>
  text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA|AIza|ya29|eyJ)[-_A-Za-z0-9.]{8,}/g, '…')
    .replace(/(?<![\w/.-])[A-Za-z0-9+]{32,}={0,2}(?![\w/.-])/g, '…')
    .replace(/\b(token|secret|password|passwd|api[_-]?key|authorization|bearer)\s*[:=]\s*\S+/gi, '$1=…')
    .trim()
    .slice(0, max)

const SECRET_NAME = /^\.env|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa)|credential|secret|\.p12$|\.pfx$/i

/** The file's name only; a name that looks like a secret store is not shown. */
export const fileName = (path: unknown): string => {
  if (typeof path !== 'string') return ''
  const name = path.split('/').pop() ?? ''
  return SECRET_NAME.test(name) ? '(protected file)' : scrub(name, 60)
}

export type ToolLike = { tool: string; description?: unknown; file_path?: unknown; notebook_path?: unknown }

/** Tool name, and for Bash only its own description; for others the file name. Never a command. */
export const toolNow = (e: ToolLike): { name: string; detail: string } => {
  const name = scrub(String(e.tool), 40)
  if (e.tool === 'Bash') {
    return { name, detail: typeof e.description === 'string' ? scrub(e.description) : '' }
  }
  return { name, detail: fileName(e.file_path ?? e.notebook_path) }
}

export const blankStatus = (session: string, folder: string, branch: string, now: number): Status => ({
  v: 2,
  session,
  folder,
  branch,
  started_at: now,
  start_known: false,
  updated_at: now,
  prompt_id: '—',
  role: null,
  expect_h: null,
  phase: null,
  other: null,
  markers: [],
  tasks: [],
  tool_now: null,
  tool_since: null,
  alive_at: now,
  subagents: [],
  finished: null,
  bg: [],
  steps: 0,
  recent: [],
  watch: null,
  report: null,
  tasks_at: now,
  title: '',
})

/** A background task that has not ended and is within the 2-hour cap. */
export const isBgRunning = (b: Bg, now: number): boolean => b.ended_at === null && now - b.started_at <= BG_CAP_MS

export const bgRunning = (s: Status, now: number): Bg[] => s.bg.filter(b => isBgRunning(b, now))

/** Not ended, and no news for 2 hours: no longer counted as running. */
export const bgStale = (s: Status, now: number): Bg[] => s.bg.filter(b => b.ended_at === null && now - b.started_at > BG_CAP_MS)

export const bgDone = (s: Status, now: number): Bg[] => s.bg.filter(b => b.ended_at !== null && now - b.ended_at <= BG_DONE_MS)

export const pruneBg = (list: Bg[], now: number): Bg[] =>
  list.filter(b => b.ended_at === null || now - b.ended_at <= BG_DONE_MS).slice(-BG_KEEP)

export type BgStart = { id: string; toolUseId: string; kind: Bg['kind']; label: string }

/** A background task begins (or is seen again under a better id). */
export const startBg = (s: Status, b: BgStart, now: number): Status => {
  const old = s.bg.find(x => x.id === b.id || (b.toolUseId !== '' && x.tool_use_id === b.toolUseId))
  const made: Bg = { id: b.id, tool_use_id: b.toolUseId, kind: b.kind, label: b.label, started_at: old?.started_at ?? now, ended_at: null, ok: null, end: null, seen: old?.seen ?? null, pct: old?.pct ?? null, eta_at: old?.eta_at ?? null, prog_at: old?.prog_at ?? null }

  return { ...s, bg: pruneBg([...s.bg.filter(x => x !== old), made], now) }
}

const TERMINAL = /^(completed|failed|killed|stopped|cancell?ed|error|timed?[_ -]?out|done|finished)$/

/** A task ends. The word is the notification's own status; an unknown task changes nothing. */
const same = (b: Bg, key: { id?: string; toolUseId?: string }): boolean =>
  !!((key.id && (b.id === key.id || b.tool_use_id === key.id)) || (key.toolUseId && (b.tool_use_id === key.toolUseId || b.id === key.toolUseId)))

/** Handles one notification: ends the task it names, or only notes its status on the task. Reports whether it named a task. */
export const noticeBg = (s: Status, n: Notice, now: number): { status: Status; isKnown: boolean } => {
  const hit = s.bg.find(b => same(b, n))
  if (!hit) return { status: s, isKnown: false }
  if (n.isEnd) return { status: endBg(s, n, n.status, now), isKnown: true }

  return { status: { ...s, bg: s.bg.map(b => (b === hit ? { ...b, seen: n.status } : b)) }, isKnown: true }
}

export const endBg = (s: Status, key: { id?: string; toolUseId?: string }, status: string, now: number): Status => {
  const hit = s.bg.find(b => b.ended_at === null && same(b, key))
  if (!hit) return s
  const word = scrub(status, 20).toLowerCase()
  const bg = s.bg.map(b => (b === hit ? { ...b, ended_at: now, ok: word === 'completed' || word === 'done' || word === 'finished', end: word, seen: word } : b))
  const next = { ...s, bg: pruneBg(bg, now) }
  // the last one ends after the turn: the finish moves to now
  const finished = next.finished?.ok && bgRunning(next, now).length === 0 ? { ...next.finished, at: now } : next.finished

  return { ...next, finished }
}

export type Notice = { id?: string; toolUseId?: string; status: string; isEnd: boolean }

/** Reads a task notification's `<task-id>`, `<tool-use-id>` and `<status>`; null when it names no task or has no end status. */
export const parseNotice = (text: string): Notice | null => {
  const tag = (n: string): string | undefined => new RegExp(`<${n}>\\s*([^<]*?)\\s*</${n}>`).exec(text)?.[1]
  const id = tag('task-id')
  const toolUseId = tag('tool-use-id')
  const status = (tag('status') ?? '').toLowerCase()
  if (!id && !toolUseId) return null

  return { ...(id ? { id: scrub(id, 64) } : {}), ...(toolUseId ? { toolUseId: scrub(toolUseId, 64) } : {}), status: scrub(status, 20), isEnd: TERMINAL.test(status) }
}

/** The background task a finished tool call started, or null. Label is a description or name, never a command. */
export const bgFromCall = (tool: string, input: unknown, result: unknown, toolUseId: string): BgStart | null => {
  const i = (input ?? {}) as Record<string, unknown>
  const r = (result ?? {}) as Record<string, unknown>
  const text = (v: unknown, max: number, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? scrub(v, max) : fallback)
  if (tool === 'Bash') {
    const id = typeof r.backgroundTaskId === 'string' && r.backgroundTaskId !== '' ? r.backgroundTaskId : ''
    if (!id && !(i.run_in_background === true && result === undefined)) return null

    return { id: id || toolUseId, toolUseId, kind: 'shell', label: text(i.description, 70, 'Background command') }
  }
  if (tool === 'Monitor') {
    const id = typeof r.taskId === 'string' && r.taskId !== '' ? r.taskId : toolUseId

    return { id, toolUseId, kind: 'monitor', label: text(i.description, 70, 'Monitor') }
  }
  if (tool === 'Agent' || tool === 'Task') {
    if (r.status === 'async_launched' && typeof r.agentId === 'string') return { id: r.agentId, toolUseId, kind: 'agent', label: text(i.description, 70, 'Background agent') }
    if (r.status === 'remote_launched' && typeof r.taskId === 'string') return { id: r.taskId, toolUseId, kind: 'agent', label: text(i.description, 70, 'Background agent') }
  }

  return null
}

/** One more tool call by the main loop. */
export const addStep = (s: Status, step: Step): Status => ({ ...s, steps: s.steps + 1, recent: [...s.recent, step].slice(-STEPS_KEPT) })

export const stepsText = (n: number): string => `${n} step${n === 1 ? '' : 's'}`

const MARK = /^\s*▶\s*([A-Za-z][\w-]*)\s+(\d+)\s*\/\s*(\d+)(.*)$/
const END = /^\s*▶\s*(done|finished|failed|stopped)\b[\s:—–-]*(.*)$/i

export type Parsed = {
  markers: Marker[]
  finished: Finish | null
  report: Report | null
}

/** Minutes left named by one line: `~288 min left`, `about 288 min left`, `4 h 48 min left`, `4h48m left`, `ETA 17:45` (local time, the next time it is that). Null when the line names none. */
export const parseLeft = (line: string, now: number): number | null => {
  const hm = /(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*left\b/i.exec(line)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0)
  const m = /(\d+(?:\.\d+)?)\s*min(?:ute)?s?\s*left\b/i.exec(line)
  if (m) return Math.round(Number(m[1]))
  const eta = /\bETA\s*(\d{1,2}):(\d{2})\b/i.exec(line)
  if (eta) {
    const at = new Date(now)
    at.setHours(Number(eta[1]), Number(eta[2]), 0, 0)
    let diff = at.getTime() - now
    if (diff < -5 * 60_000) diff += 24 * 3_600_000

    return Math.max(0, Math.round(diff / 60_000))
  }
  return null
}

const STAMPED = /^\s*\d{1,2}:\d{2}\s*[·|•-]\s.*\b\d{1,3}\s*%/
const PCT = /(?:^|[^\w.])(\d{1,3})\s*%/

/** The run's own newest status line: one that names a time left, or starts with a clock time and carries a %. Only the % and the end time are kept. */
export const parseReport = (text: string, now: number): Report | null => {
  let out: Report | null = null
  for (const line of text.split('\n')) {
    const left = parseLeft(line, now)
    if (left === null && !STAMPED.test(line)) continue
    const p = PCT.exec(line)
    const pct = p && Number(p[1]) <= 100 ? Number(p[1]) : null
    out = { at: now, pct, eta_at: left === null ? null : now + left * 60_000 }
  }
  return out
}

/** A background task's progress from the last lines of its output: the newest `▶ x n/N` or `NN%`, and the newest time-left line. Nothing of the text is kept. */
export const scanProgress = (raw: string, now: number): { pct: number | null; eta_at: number | null } => {
  let pct: number | null = null
  let eta: number | null = null
  for (const line of raw.replace(/\\n/g, '\n').split('\n')) {
    const m = /▶\s*[A-Za-z][\w-]*\s+(\d+)\s*\/\s*(\d+)/.exec(line)
    if (m && Number(m[2]) > 0) pct = Math.min(100, Math.max(0, Math.round((Number(m[1]) / Number(m[2])) * 100)))
    else {
      const p = PCT.exec(line)
      if (p && Number(p[1]) <= 100) pct = Number(p[1])
    }
    const left = parseLeft(line, now)
    if (left !== null) eta = now + left * 60_000
  }
  return { pct, eta_at: eta }
}

/** The share of a checklist done (items done + the open item's own n/N), or null for an empty one. */
export const listFraction = (tasks: readonly Task[]): number | null => {
  if (tasks.length === 0) return null
  const done = tasks.filter(t => t.status === 'completed').length
  const mark = tasks.find(t => t.status === 'in_progress')?.mark
  const own = mark && mark.N > 0 ? Math.min(1, Math.max(0, mark.n / mark.N)) : 0

  return Math.min(1, (done + own) / tasks.length)
}

/** Reads `▶ kind n/N` markers and `▶ done` / `▶ failed`. */
export const parseText = (text: string, now: number): Parsed => {
  const out: Parsed = { markers: [], finished: null, report: parseReport(text, now) }
  for (const raw of text.split('\n')) {
    const end = END.exec(raw)
    if (end) {
      const word = (end[1] ?? '').toLowerCase()
      const ok = word === 'done' || word === 'finished'
      const verdict = scrub(end[2] || (ok ? 'finished' : 'stopped'), 60)
      out.finished = { at: now, verdict, ok: ok && !/\b(fail|stopp|red|❌)/i.test(verdict) }
      continue
    }
    const m = MARK.exec(raw)
    if (m) {
      out.markers.push({
        kind: (m[1] ?? '').toLowerCase(),
        n: Number(m[2]),
        N: Number(m[3]),
        at: now,
        line: scrub(raw.replace(/^\s*▶\s*/, ''), 80),
      })
      continue
    }
  }
  return out
}

/** Folds parsed text into a status: newest phase marker, newest other marker (reset by a new phase), last 10 markers; each marker also lands on the in-progress item. */
export const applyParsed = (s: Status, p: Parsed, now: number = s.updated_at): Status => {
  let { phase, other, tasks } = s
  for (const m of p.markers) {
    if (m.kind === 'phase') {
      phase = { n: m.n, N: m.N }
      other = null
    } else other = { kind: m.kind, n: m.n, N: m.N }
    const at = tasks.findIndex(t => t.status === 'in_progress')
    if (at >= 0) tasks = tasks.map((t, i) => (i === at ? { ...t, mark: { kind: m.kind, n: m.n, N: m.N } } : t))
  }
  return settle(
    {
      ...s,
      phase,
      other,
      tasks,
      markers: [...s.markers, ...p.markers].slice(-10),
      finished: p.finished ?? s.finished,
      report: p.report ?? s.report,
      tasks_at: p.markers.length > 0 ? now : s.tasks_at,
    },
    now,
  )
}

const STATUSES = ['pending', 'in_progress', 'completed']

/** The desktop app's own task list: `update_plan` (any server prefix). */
export const isPlanTool = (tool: string): boolean => /(^|__)update_plan$/.test(tool)

/** The list after one `update_plan` call: `items` replace it, `advance` completes the open step and opens the next, `done` / `start` (1-based) change steps. */
export const applyPlan = (tasks: Task[], input: unknown): Task[] => {
  const i = (input ?? {}) as Record<string, unknown>
  let out = tasks
  if (Array.isArray(i.items)) {
    out = i.items.flatMap((t: Record<string, unknown>, k: number) => {
      if (!t || typeof t.content !== 'string') return []
      const subject = scrub(t.content, 70)

      return [{ id: String(k + 1), subject, status: STATUSES.includes(String(t.status)) ? (t.status as Task['status']) : 'pending', mark: tasks.find(x => x.subject === subject)?.mark ?? null }]
    })
  }
  if (i.advance === true) {
    const at = out.findIndex(t => t.status === 'in_progress')
    const next = out.findIndex((t, k) => k > at && t.status === 'pending')
    out = out.map((t, k) => (k === at ? { ...t, status: 'completed' as const } : k === next ? { ...t, status: 'in_progress' as const } : t))
  }
  if (Array.isArray(i.done)) out = out.map((t, k) => ((i.done as unknown[]).includes(k + 1) ? { ...t, status: 'completed' as const } : t))
  if (typeof i.start === 'number') out = out.map((t, k) => (k + 1 === i.start ? { ...t, status: 'in_progress' as const } : t))

  return out
}

/** The to-do list after one task-tool call: TodoWrite sends the whole list, TaskCreate adds one, TaskUpdate changes or deletes one. */
export const applyTool = (tasks: Task[], tool: string, input: unknown, result: unknown): Task[] => {
  const i = (input ?? {}) as Record<string, unknown>
  const r = (result ?? {}) as Record<string, unknown>
  if (tool === 'TodoWrite') {
    if (!Array.isArray(i.todos)) return tasks
    return i.todos.flatMap((t: Record<string, unknown>, k: number) => {
      if (!t || typeof t.content !== 'string') return []
      const subject = scrub(t.content, 70)
      const status = STATUSES.includes(String(t.status)) ? (t.status as Task['status']) : 'pending'
      const old = tasks.find(x => x.subject === subject)

      return [{ id: String(k + 1), subject, status, mark: old?.mark ?? null }]
    })
  }
  if (tool === 'TaskCreate') {
    if (typeof i.subject !== 'string') return tasks
    const made = (r.task ?? {}) as Record<string, unknown>
    const id = typeof made.id === 'string' ? made.id : String(tasks.length + 1)

    return [...tasks.filter(t => t.id !== id), { id, subject: scrub(i.subject, 70), status: 'pending' as const, mark: null }]
  }
  if (tool === 'TaskUpdate') {
    if (r.success === false) return tasks
    const id = String(i.taskId ?? '')
    if (i.status === 'deleted') return tasks.filter(t => t.id !== id)

    return tasks.map(t =>
      t.id !== id
        ? t
        : {
            ...t,
            subject: typeof i.subject === 'string' ? scrub(i.subject, 70) : t.subject,
            status: STATUSES.includes(String(i.status)) ? (i.status as Task['status']) : t.status,
          },
    )
  }
  return tasks
}

/** Finished when the last item is done; takes that back when a new item appears. */
export const settle = (s: Status, now: number): Status => {
  const isAllDone = s.tasks.length > 0 && s.tasks.every(t => t.status === 'completed')
  if (isAllDone && !s.finished) return { ...s, finished: { at: now, verdict: ALL_DONE, ok: true } }
  if (!isAllDone && s.finished?.verdict === ALL_DONE) return { ...s, finished: null }
  return s
}

const SESSION_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$/i

/** An id for a title: never a session id. */
export const cleanId = (raw: string): string => {
  const id = scrub(raw, 24)
  return !id || SESSION_LIKE.test(id) ? '—' : id
}

/** The first word after "#" in the first heading, else a report path's file name, else "—". */
export const promptIdFrom = (text: string): string => {
  const heading = /^#{1,6}[ \t]+([^\s·|:—–]+)/m.exec(text)
  if (heading) return cleanId(heading[1] ?? '')
  const line = /^\s*([A-Z][A-Za-z0-9]*-\d[\w-]*)\s*·/m.exec(text)
  if (line) return cleanId(line[1] ?? '')
  const paths = text.match(/[\w~./-]+\.md\b/g)
  if (paths) {
    const base = ((paths[paths.length - 1] ?? '').split('/').pop() ?? '').replace(/\.md$/, '')
    if (base) return cleanId(base)
  }
  return '—'
}

/** Hours from the prompt header's `EXPECT: <hours> h`, else null. */
export const expectFrom = (text: string): number | null => {
  const m = /\bEXPECT:\s*(\d+(?:[.,]\d+)?)\s*h\b/i.exec(text)
  const h = m ? Number((m[1] ?? '').replace(',', '.')) : NaN
  return Number.isFinite(h) && h > 0 ? h : null
}

/** "lead" or "second" from the first heading, or from "you are the lead". */
export const roleFrom = (text: string): string | null => {
  const heading = /^#{1,6}[ \t]+(.*)$/m.exec(text)?.[1] ?? ''
  const m = /\b(lead|second)\b/i.exec(heading) ?? /\byou are (?:the |a )?(lead|second)\b/i.exec(text)
  return m ? (m[1] ?? '').toLowerCase() : null
}

export const shortFolder = (folder: string): string => folder.replace(/\/+$/, '').split('/').pop() || folder

export const homeShown = (path: string, home: string | undefined): string =>
  home && path === home ? '~' : home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path

/** Branch from the text of `.git/HEAD`. */
export const branchFromHead = (head: string): string => {
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
  return m ? scrub(m[1] ?? '', 40) : head.trim().slice(0, 7) || '—'
}

const isTool = (s: Status, now: number): boolean =>
  (s.tool_now !== null || s.subagents.length > 0 || bgRunning(s, now).length > 0) && now - s.alive_at <= STALE_TOOL_MS

export const stateOf = (s: Status, now: number): RunState => {
  // the turn is over but a background task runs: waiting, not done
  if (s.finished?.ok && bgRunning(s, now).length > 0) return 'quiet'
  if (s.finished) return s.finished.ok ? 'done' : 'failed'
  if (!isTool(s, now) && now - s.updated_at > QUIET_MS) return 'quiet'
  const current = s.tasks.find(t => t.status === 'in_progress')
  const detail = `${s.tool_now?.detail ?? ''} ${(current?.mark ?? s.other)?.kind ?? ''}`
  if (/mutant|mutation/i.test(detail)) return 'mutation'
  if (/test|suite|pytest|vitest|jest|spec/i.test(detail)) return 'testing'
  return 'building'
}

export const fmtClock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "26 min", "3 h 40 min", "2 h". */
export const fmtMin = (min: number): string => {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

export const barText = (percent: number | null, cells = 10): string => {
  const on = percent === null ? 0 : Math.round((percent / 100) * cells)
  return '▰'.repeat(on) + '▱'.repeat(cells - on)
}

export const SESSION_CLOSED = 'session closed'
export const TURN_ENDED = 'turn ended'
export const STOPPED_BY_YOU = 'stopped by you'

const WORKTREE = /\/mw-([A-Za-z0-9]+)-[^/]+$/

let folderLabels: Array<[string, string]> = []

/** Reads the `folder_labels` option: `path-suffix=label` pairs, comma-separated. */
export const parseFolderLabels = (raw: unknown): Array<[string, string]> =>
  (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((pair): [string, string] => {
      const i = pair.lastIndexOf('=')
      return i < 0 ? ['', ''] : [pair.slice(0, i).trim().replace(/\/+$/, ''), scrub(pair.slice(i + 1), 40)]
    })
    .filter(([suffix, label]) => suffix !== '' && label !== '')

export const setFolderLabels = (raw: unknown): void => {
  folderLabels = parseFolderLabels(raw)
}

/** A plain name for a folder: its label if one is set, `12's worktree`, else its last part. */
export const folderName = (folder: string, labels: Array<[string, string]> = folderLabels): string => {
  const f = folder.replace(/\/+$/, '')
  const hit = labels.find(([suffix]) => f === suffix || f.endsWith(suffix.startsWith('/') ? suffix : `/${suffix}`))
  if (hit) return hit[1]
  const w = WORKTREE.exec(f)
  if (w) return `${w[1]}'s worktree`
  return shortFolder(f) || '—'
}

/** The prompt id; with none, the folder and branch. Never a session id. */
export const titleOf = (s: Status): string => {
  if (s.title) return s.title
  const f = folderName(s.folder)
  const id = cleanId(s.prompt_id)
  if (id !== '—') return id
  return s.branch && s.branch !== '—' ? `${f} · ${s.branch}` : f
}

export type Progress = {
  /** Whole number 0..100, or null when there is no plan at all. */
  pct: number | null
  /** Minutes left, or null when not known yet. */
  left: number | null
  isFromEstimate: boolean
  /** Minutes since the first prompt. */
  elapsed: number
  /** True when the start is only a lower bound, so `elapsed` is a minimum. */
  isAtLeast: boolean
  /** Where `left` comes from when the start is unknown: the speed seen since the mod loaded, or an upper bound from EXPECT. */
  basis?: { kind: 'speed'; watched: number } | { kind: 'atmost' } | { kind: 'pace' }
  /** True when `left` is the run's own status line. */
  isFromRun?: boolean
}

export const WATCH_MIN = 10

/** The baseline for the speed: the first share seen since the mod loaded; rebased if the share falls (the list grew). */
export const watchOf = (s: Status, now: number): Status => {
  const f = shareOf(s)
  if (f === null) return s.watch === null ? s : { ...s, watch: null }
  if (s.watch === null || f < s.watch.frac) return { ...s, watch: { at: now, frac: f } }

  return s
}

/** The share of the whole prompt done: from the to-do list (items done + the open item's own n/N), else the ▶ phase markers. */
export const fractionOf = (s: Status): number | null => {
  if (s.tasks.length > 0) return listFraction(s.tasks)
  if (s.phase && s.phase.N > 0) {
    const own = s.other && s.other.N > 0 ? Math.min(1, Math.max(0, s.other.n / s.other.N)) : 0
    return Math.min(1, Math.max(0, (s.phase.n - 1 + own) / s.phase.N))
  }
  return null
}

/** The run's share done: the run's own newest status line when it is newer than the last change of the checklist, else the checklist and markers. */
export const shareOf = (s: Status): number | null => {
  const r = s.report
  if (r && r.pct !== null && r.at >= s.tasks_at) return Math.min(1, r.pct / 100)

  return fractionOf(s)
}

/** % and time left. From the run's own status line (under 15 minutes old); else under 10%: EXPECT minus elapsed (not below 5 min); from 10%: elapsed × (100 − %) ÷ %. */
export const progressOf = (s: Status, now: number): Progress => {
  const frac = s.finished?.ok ? 1 : shareOf(s)
  const pct = frac === null ? null : Math.round(frac * 100)
  const elapsed = Math.max(0, (now - s.started_at) / 60_000)
  const isAtLeast = !s.start_known
  const r = s.report
  if (!s.finished && r && r.eta_at !== null && now - r.at <= REPORT_MS) {
    return { pct, left: Math.max(0, (r.eta_at - now) / 60_000), isFromEstimate: false, elapsed, isAtLeast, isFromRun: true }
  }
  if (isAtLeast) {
    // the start is a lower bound: time left comes from the speed seen since the mod loaded (≥ 10 min watched and the % moved), else an upper bound from EXPECT, else nothing
    const w = s.watch
    const watched = w ? (now - w.at) / 60_000 : 0
    if (w && frac !== null && !s.finished && watched >= WATCH_MIN && frac > w.frac) {
      const rate = (frac - w.frac) / watched
      return { pct, left: (1 - frac) / rate, isFromEstimate: false, elapsed, isAtLeast, basis: { kind: 'speed', watched } }
    }
    if (s.expect_h !== null) return { pct, left: Math.max(MIN_LEFT, s.expect_h * 60 - elapsed), isFromEstimate: true, elapsed, isAtLeast, basis: { kind: 'atmost' } }

    return { pct, left: null, isFromEstimate: false, elapsed, isAtLeast }
  }
  if (pct !== null && pct >= EARLY_PCT) return { pct, left: (elapsed * (100 - pct)) / pct, isFromEstimate: false, elapsed, isAtLeast, basis: { kind: 'pace' } }
  if (s.expect_h !== null) return { pct, left: Math.max(MIN_LEFT, s.expect_h * 60 - elapsed), isFromEstimate: true, elapsed, isAtLeast }
  return { pct, left: null, isFromEstimate: false, elapsed, isAtLeast }
}

/** The % alone; empty when there is no checklist. */
export const pctText = (p: Progress): string => (p.pct !== null ? `${p.pct}%` : '')

/** No checklist, no markers and no usable EXPECT: neither % nor time left is known. */
export const isPlain = (s: Status, now: number): boolean => {
  const p = progressOf({ ...s, finished: null }, now)

  return p.pct === null && p.left === null
}

export const leftText = (p: Progress): string => {
  if (p.left === null) return p.isAtLeast ? '' : 'time left not known yet'
  if (p.isFromRun) return `about ${fmtMin(p.left)} left (from the run)`
  if (p.basis?.kind === 'pace') return `about ${fmtMin(p.left)} left (from the pace so far)`
  if (p.basis?.kind === 'speed') return `about ${fmtMin(p.left)} left (from the last ${fmtMin(p.basis.watched)})`
  if (p.basis?.kind === 'atmost') return `at most ${fmtMin(p.left)} left (from the estimate)`

  return `about ${fmtMin(p.left)} left${p.isFromEstimate ? ' (from the estimate)' : ''}`
}

export const runningText = (p: Progress): string => `running for ${p.isAtLeast ? 'at least ' : ''}${fmtMin(p.elapsed)}`

/** The open item's name and its newest marker: `Phase 2: api server · mutant 30 of 40` (`30/40` when short). */
export const workParts = (s: Status, isShort = false): string[] => {
  const cur = s.tasks.find(t => t.status === 'in_progress')
  const item = cur ? cur.subject : s.phase ? `Phase ${s.phase.n} of ${s.phase.N}` : ''
  const m = cur ? cur.mark : s.other
  const mark = m ? `${m.kind} ${m.n}${isShort ? '/' : ' of '}${m.N}` : ''
  return [item, mark].filter(Boolean)
}

const VERBS: Record<string, string> = {
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Read: 'Reading',
  Grep: 'Searching',
  Glob: 'Searching',
}

/** What the run is doing, in words: a Bash call's own description, else a verb and a file name. */
export const doingWords = (s: Status): string => {
  const t = s.tool_now
  if (t) {
    if (t.name === 'Bash') return t.detail || 'Running a command'
    if (t.name === 'Agent' || t.name === 'Task') return 'Waiting for a helper'
    const verb = VERBS[t.name]
    if (verb) return t.detail ? `${verb} ${t.detail}` : `${verb} files`
    return t.detail ? `${t.name}: ${t.detail}` : `Using ${t.name}`
  }
  const sub = s.subagents[0]
  if (sub) return `Helper: ${sub.description}`
  return 'Thinking'
}

/** A background task's progress read from its output or checklist; unknown parts keep what was known. */
export const setBgProgress = (s: Status, id: string, p: { pct: number | null; eta_at: number | null }, now: number): Status => {
  if (p.pct === null && p.eta_at === null) return s

  return { ...s, bg: s.bg.map(b => (b.ended_at === null && (b.id === id || b.tool_use_id === id) ? { ...b, pct: p.pct ?? b.pct, eta_at: p.eta_at ?? b.eta_at, prog_at: now } : b)) }
}

/** Minutes left for one background task: its own end time while it has not long passed, else its pace (after 2 minutes, from its %). */
export const bgLeft = (b: Bg, now: number): { min: number; source: 'own' | 'pace' } | null => {
  if (b.eta_at !== null && b.eta_at - now > -5 * 60_000) return { min: Math.max(0, (b.eta_at - now) / 60_000), source: 'own' }
  const elapsed = (now - b.started_at) / 60_000
  if (b.pct !== null && b.pct > 0 && b.pct < 100 && elapsed >= BG_PACE_MIN) return { min: (elapsed * (100 - b.pct)) / b.pct, source: 'pace' }

  return null
}

export type Overall = {
  /** Never 100 while anything runs. */
  pct: number | null
  left: number | null
  /** Running background tasks with no time left known. */
  noEstimate: number
}

/** The whole session: % of the main run while it works (the average of the background tasks that report one once it is over); time left is the longest of the main run's and every running task's. */
export const overallOf = (s: Status, now: number): Overall => {
  const run = bgRunning(s, now)
  const p = progressOf(s, now)
  const isMainOpen = !s.finished
  const lefts = run.map(b => bgLeft(b, now)?.min ?? null)
  const known = lefts.filter((x): x is number => x !== null)
  const noEstimate = lefts.length - known.length
  let left: number | null = null
  if (isMainOpen) left = p.left === null ? null : Math.max(p.left, ...known)
  else if (known.length > 0) left = Math.max(...known)
  let pct: number | null
  if (run.length === 0) pct = p.pct
  else if (isMainOpen) pct = p.pct === null ? null : Math.min(99, p.pct)
  else {
    const reported = run.flatMap(b => (b.pct === null ? [] : [b.pct]))
    pct = reported.length === 0 ? null : Math.min(99, Math.round(reported.reduce((a, c) => a + c, 0) / reported.length))
  }
  return { pct, left, noEstimate }
}

/** `about 4 h 48 min left overall (1 background task with no estimate)`, or '' when not known. */
export const overallLeftText = (o: Overall): string =>
  o.left === null ? '' : `about ${fmtMin(o.left)} left overall${o.noEstimate > 0 ? ` (${o.noEstimate} background task${o.noEstimate === 1 ? '' : 's'} with no estimate)` : ''}`

const bgBits = (b: Bg, now: number): string[] => {
  const l = bgLeft(b, now)

  return [b.pct === null ? '' : `${b.pct}%`, l ? `~${fmtMin(l.min)}` : ''].filter(Boolean)
}

/** The band's background part: `🔄 1 in background: Watch 40%, ~12 min`, or `🔄 3 in background (2 with %): 40% ~12 min, 75% ~3 min, …`. */
export const bgBand = (s: Status, now: number): string => {
  const run = bgRunning(s, now)
  if (run.length === 0) return ''
  const first = run[0]
  if (run.length === 1 && first) return `🔄 1 in background: ${[first.label, bgBits(first, now).join(', ')].filter(Boolean).join(' ')}`
  const withPct = run.filter(b => b.pct !== null).length
  const entries = run.map(b => bgBits(b, now).join(' ')).filter(Boolean)
  const shown = entries.slice(0, 3).join(', ') + (entries.length > 3 ? ', …' : '')

  return `🔄 ${run.length} in background${withPct > 0 ? ` (${withPct} with %)` : ''}${shown ? `: ${shown}` : ''}`
}

const quietMin = (s: Status, now: number): number => Math.floor((now - s.updated_at) / 60_000)

/** `⏳ Waiting on 1 background task · running for 23 min` while the turn is over and a background task runs, else null. */
export const waitLine = (s: Status, now: number): string | null => {
  const run = bgRunning(s, now)
  if (!s.finished?.ok || run.length === 0) return null
  const oldest = Math.min(...run.map(b => b.started_at))

  return `⏳ Waiting on ${run.length} background task${run.length === 1 ? '' : 's'} · running for ${fmtMin((now - oldest) / 60_000)}`
}

/** `✅ Finished · took 2 h 41 min`, `❌ Stopped …`, `😴 Quiet for 12 min`, or null while working. */
const endLine = (s: Status, p: Progress, now: number): string | null => {
  const st = stateOf(s, now)
  const took = s.finished ? `${p.isAtLeast ? 'at least ' : ''}${fmtMin((s.finished.at - s.started_at) / 60_000)}` : ''
  if (st === 'done') {
    const steps = isPlain(s, now) ? ` · ${stepsText(s.steps)}` : ''

    return s.finished?.untimed ? `✅ Finished${steps}` : `✅ Finished${steps} · took ${took}`
  }
  if (s.finished?.verdict === STOPPED_BY_YOU) return `⏸ Stopped by you · after ${took}`
  if (st === 'failed') return `❌ Stopped${p.pct === null ? '' : ` at ${p.pct}%`} · after ${took}`
  if (st === 'quiet') return `😴 Quiet for ${quietMin(s, now)} min`
  return null
}

/** The band above the prompt, one line. */
export const bandLine = (s: Status, now: number): string => {
  const o = overallOf(s, now)
  const pctPart = o.pct === null ? '' : `📊 ${o.pct}% overall`
  const leftPart = o.left === null ? '' : `⏱ ${progressOf(s, now).basis?.kind === 'atmost' && o.noEstimate === 0 ? 'at most' : 'about'} ${fmtMin(o.left)} left${o.noEstimate > 0 ? ` (${o.noEstimate} background task${o.noEstimate === 1 ? '' : 's'} with no estimate)` : ''}`
  const back = bgBand(s, now)
  const wait = waitLine(s, now)
  if (wait) return [`⏳ Waiting on ${bgRunning(s, now).length} background task${bgRunning(s, now).length === 1 ? '' : 's'}`, pctPart, leftPart, back.replace(/^🔄 \d+ in background(?: \(\d+ with %\))?:? ?/, '🔄 ')].filter(x => x !== '🔄 ' && x !== '').join(' · ')
  const p = progressOf(s, now)
  const end = endLine(s, p, now)
  if (end) return s.finished ? end : [end, pctPart].filter(Boolean).join(' · ')
  const emoji = EMOJI[stateOf(s, now)]
  if (isPlain(s, now)) return [`${emoji === '😴' ? emoji : '🔨'} Working · Now: ${doingWords(s)} · ${stepsText(s.steps)} so far · ${runningText(p)}`, back].filter(Boolean).join(' · ')
  if (p.pct === null) return [[emoji, leftText(p), runningText(p), ...workParts(s, true)].filter(Boolean).join(' · ').replace(`${emoji} · `, `${emoji} `), back].filter(Boolean).join(' · ')
  const work = workParts(s, true).join(' · ')

  return [pctPart, leftPart, work === '' ? '' : `▶ ${work}`, back].filter(Boolean).join(' · ')
}

export const KIND_ICON: Record<Bg['kind'], string> = { shell: '⌨️', agent: '🤖', monitor: '👁' }

/** One running task as a row: icon, name, % (or "no % reported"), its own running time, and time left when known. */
export const bgRowText = (b: Bg, now: number): string => {
  const l = bgLeft(b, now)

  return [`${KIND_ICON[b.kind]} ${b.label}`, b.pct === null ? 'no % reported' : `${b.pct}% ${barText(b.pct, 8)}`, `running for ${fmtMin((now - b.started_at) / 60_000)}`, l ? `about ${fmtMin(l.min)} left (${l.source === 'own' ? 'from its own line' : 'from its pace'})` : ''].filter(Boolean).join(' · ')
}

/** The panel's background lists, as plain lines: those running (or without news) and those that ended in the last 10 minutes. */
export const bgLines = (s: Status, now: number): { running: string[]; done: string[] } => ({
  running: [
    ...bgRunning(s, now).map(b => bgRowText(b, now)),
    ...bgStale(s, now).map(b => `❔ ${b.label} · no news for 2 h`),
  ],
  done: bgDone(s, now).map(b => {
    const min = fmtMin(((b.ended_at ?? now) - b.started_at) / 60_000)

    return b.ok ? `✅ ${b.label} · took ${min}` : `❌ ${b.label} · ${b.end === 'killed' ? 'stopped' : 'failed'} after ${min}`
  }),
})

/** The last steps as plain lines: time (when known), tool name, description. */
export const stepLines = (s: Status): string[] =>
  s.recent.map(r => `${r.at > 0 ? `${fmtClock(r.at)} ` : ''}${r.name}${r.detail ? ` · ${r.detail}` : ''}`)

/** The lines of a card as plain data (the pane and /builds). */
export const cardOf = (s: Status, now: number) => {
  const st = stateOf(s, now)
  const p = progressOf(s, now)
  const plain = isPlain(s, now)
  const wait = waitLine(s, now)
  const o = overallOf(s, now)
  const over = st === 'done' || st === 'failed' || wait !== null

  return {
    state: st,
    emoji: wait ? '⏳' : EMOJI[st],
    title: titleOf(s),
    plain,
    pct: pctText(p),
    bar: plain ? '' : barText(p.pct),
    left: plain ? `Working · ${stepsText(s.steps)} so far` : leftText(p),
    running: runningText(p),
    end: wait ?? endLine(s, p, now),
    work: workParts(s).join(' · '),
    doing: over ? '' : `Now: ${doingWords(s)}`,
    bg: bgLines(s, now),
    steps: stepLines(s),
    overall: { pct: o.pct, bar: barText(o.pct), left: overallLeftText(o), running: runningText(p) },
    mainLeft: plain ? '' : leftText(p),
  }
}

/** Plain-text lines for one run, used by /builds. */
export const runLines = (s: Status, now: number): string[] => {
  const c = cardOf(s, now)
  const lines = [`${c.emoji} ${c.title}${c.pct ? `  ${c.pct}` : ''}`, `   ${c.bar ? `${c.bar}  ` : ''}${c.end ?? [c.left, c.running].filter(Boolean).join(' · ')}`]
  if (c.work) lines.push(`   ${c.work}`)
  if (c.doing) lines.push(`   ${c.doing}`)
  return lines
}

const RANK: Record<RunState, number> = { failed: 0, building: 1, testing: 1, mutation: 1, quiet: 2, done: 3 }

/** Which runs /builds lists: not stale (12 h); failed, working, quiet, finished; newest first within each. */
export const visibleRuns = (list: Status[], now: number, showFinished: boolean): Status[] =>
  list
    .filter(s => now - s.updated_at <= HIDE_MS && (showFinished || !s.finished))
    .sort((a, b) => RANK[stateOf(a, now)] - RANK[stateOf(b, now)] || b.updated_at - a.updated_at)

/**
 * What the session's transcript says about its background tasks, its turns and its name: ids, status words, clock times. No text.
 * `limits`: when a monitor reaches its own time limit (its start plus `timeoutMs`); its last notice carries no status word.
 * `first`: the earliest row time, the session's start. `turn_end`: the newest `turn_duration` row, the last turn's end.
 */
export type Hist = {
  title: string
  starts: Record<string, number>
  ends: Record<string, { at: number; status: string }>
  limits: Record<string, number>
  first: number | null
  turn_end: number | null
}

/** The pattern `grep -noE` runs over the transcript: row times, background starts and ends (a TaskStop's result row too), monitors' time limits, turn ends, the session's name. */
export const HIST_PATTERN = '"timestamp":"[^"]+"|"backgroundTaskId":"[A-Za-z0-9]+"|"status":"async_launched","agentId":"[A-Za-z0-9]+"|"taskId":"[A-Za-z0-9]+","timeoutMs":[0-9]+,"persistent":(true|false)|"task_id":"[A-Za-z0-9]+","task_type":"[a-z_]+"|<task-id>[^<]+</task-id>|<status>[^<]+</status>|"subtype":"turn_duration"|"customTitle":"[^"]*"'

/** The end word of a monitor that ran to its own time limit. */
export const TIMED_OUT = 'timed out'

/** Reads `grep -noE` output (`line:match`): a start is a row with a `backgroundTaskId`, an `async_launched` agent or a monitor's `taskId`; an end is a row with a `<task-id>` and a terminal `<status>`, or a TaskStop's result (`killed`); the first row time of each wins. */
export const parseHist = (stdout: string): Hist => {
  const out: Hist = { title: '', starts: {}, ends: {}, limits: {}, first: null, turn_end: null }
  const rows = new Map<string, { ts: number | null; starts: string[]; monitors: { id: string; ms: number; isPersistent: boolean }[]; stops: string[]; ids: string[]; statuses: string[]; isTurnEnd: boolean }>()
  for (const raw of stdout.split('\n')) {
    const i = raw.indexOf(':')
    if (i < 0) continue
    const key = raw.slice(0, i)
    const m = raw.slice(i + 1)
    const row = rows.get(key) ?? { ts: null, starts: [], monitors: [], stops: [], ids: [], statuses: [], isTurnEnd: false }
    rows.set(key, row)
    const ts = /^"timestamp":"([^"]+)"$/.exec(m)?.[1]
    const shell = /^"backgroundTaskId":"([A-Za-z0-9]+)"$/.exec(m)?.[1]
    const agent = /^"status":"async_launched","agentId":"([A-Za-z0-9]+)"$/.exec(m)?.[1]
    const monitor = /^"taskId":"([A-Za-z0-9]+)","timeoutMs":(\d+),"persistent":(true|false)$/.exec(m)
    const stop = /^"task_id":"([A-Za-z0-9]+)","task_type":"[a-z_]+"$/.exec(m)?.[1]
    const id = /^<task-id>([^<]+)<\/task-id>$/.exec(m)?.[1]
    const status = /^<status>([^<]+)<\/status>$/.exec(m)?.[1]
    const title = /^"customTitle":"(.*)"$/.exec(m)?.[1]
    if (ts && row.ts === null) {
      const t = Date.parse(ts)
      row.ts = Number.isFinite(t) ? t : null
    } else if (shell || agent) row.starts.push((shell ?? agent) as string)
    else if (monitor) row.monitors.push({ id: monitor[1] as string, ms: Number(monitor[2]), isPersistent: monitor[3] === 'true' })
    else if (stop) row.stops.push(stop)
    else if (m === '"subtype":"turn_duration"') row.isTurnEnd = true
    else if (id) row.ids.push(id.trim())
    else if (status) row.statuses.push(status.trim().toLowerCase())
    else if (title !== undefined) {
      try {
        out.title = scrub(JSON.parse(`"${title}"`) as string, 70)
      } catch {
        out.title = scrub(title, 70)
      }
    }
  }
  for (const row of rows.values()) {
    if (row.ts === null) continue
    out.first = Math.min(out.first ?? Infinity, row.ts)
    if (row.isTurnEnd) out.turn_end = Math.max(out.turn_end ?? -Infinity, row.ts)
    for (const id of row.starts) out.starts[id] = Math.min(out.starts[id] ?? Infinity, row.ts)
    for (const mon of row.monitors) {
      out.starts[mon.id] = Math.min(out.starts[mon.id] ?? Infinity, row.ts)
      if (!mon.isPersistent && mon.ms > 0) out.limits[mon.id] = Math.min(out.limits[mon.id] ?? Infinity, row.ts + mon.ms)
    }
    const id = row.ids[0]
    const status = row.statuses[0]
    const ends = [...row.stops.map(x => [x, 'killed']), ...(id && status && TERMINAL.test(status) ? [[id, status]] : [])]
    for (const [x, word] of ends as [string, string][]) {
      const was = out.ends[x]
      if (!was || row.ts < was.at) out.ends[x] = { at: row.ts, status: word }
    }
  }
  return out
}

/** The transcript's facts laid on the task list: the session's start when no prompt gave it, each task's own start, and its end when the transcript has it (a monitor past its time limit ended there). */
export const applyHist = (s: Status, h: Hist, now: number): Status => ({
  ...s,
  title: h.title || s.title,
  ...(!s.start_known && h.first !== null ? { started_at: h.first, start_known: true } : {}),
  bg: s.bg.map(b => {
    const start = h.starts[b.id] ?? h.starts[b.tool_use_id]
    const o = start === undefined ? b : { ...b, started_at: start }
    const limit = h.limits[b.id] ?? h.limits[b.tool_use_id]
    const end = h.ends[b.id] ?? h.ends[b.tool_use_id] ?? (limit !== undefined && limit <= now ? { at: limit, status: TIMED_OUT } : undefined)
    if (!end) return o
    // an end the replay gave has no time of its own (it was stamped at the reload): the file's earlier time replaces it
    if (o.ended_at !== null) return end.at < o.ended_at ? { ...o, ended_at: end.at } : o
    const word = scrub(end.status, 20).toLowerCase()
    // a time limit is no notice: the last notice seen stays as it was
    if (word === TIMED_OUT) return { ...o, ended_at: end.at, ok: true, end: word }

    return { ...o, ended_at: end.at, ok: word === 'completed' || word === 'done' || word === 'finished', end: word, seen: word }
  }),
})

/** Reads this session's earlier rows once: the first prompt's id, role and EXPECT, the to-do list, the markers. */
export type Row = { role: string; text?: string; toolUses?: { tool?: string; tool_use_id?: string; input?: unknown; result?: unknown; text?: unknown }[] }

/** A background task that ended before a reload, and where its end was read: a notice in the replayed history (its time from the transcript file: `both`), or the transcript file. */
export type Found = Bg & { from: 'replay' | 'both' | 'file' }

/** A slash command's echo in the history (`/reload-plugins`, `/builds-tasks`): not work, and no sign the turn is still open. */
const isCommandEcho = (r: Row): boolean => r.role === 'user' && /^\s*<(command-name|command-message|local-command-[a-z]+)>/.test(r.text ?? '')

export const recover = (s: Status, rows: readonly Row[], now: number, hist: Hist | null = null): Status => recoverAll(s, rows, now, hist).status

/** `recover`, and every task that ended before the reload, for `/builds-tasks`. */
export const recoverAll = (s: Status, rows: readonly Row[], now: number, hist: Hist | null = null): { status: Status; ended: Found[] } => {
  let out = s
  const first = rows.find(r => r.role === 'user' && typeof r.text === 'string' && r.text.trim() !== '')
  if (first?.text) {
    out = { ...out, prompt_id: promptIdFrom(first.text), role: roleFrom(first.text), expect_h: expectFrom(first.text) }
  }
  for (const r of rows) {
    if (r.role === 'user') {
      // a background task's notification is a user row that opens with its envelope
      if (typeof r.text === 'string' && r.text.trimStart().startsWith('<task-notification')) {
        const n = parseNotice(r.text)
        if (n) out = noticeBg(out, n, now).status
      }
      continue
    }
    if (r.role !== 'assistant') continue
    if (typeof r.text === 'string' && r.text.includes('▶')) out = applyParsed(out, parseText(r.text, now), now)
    for (const t of r.toolUses ?? []) {
      const tool = String(t.tool ?? 'tool')
      const call = toolNow({ tool, ...((t.input ?? {}) as object) })
      out = addStep(out, { name: call.name, detail: call.detail, at: 0 })
      if (t.tool === 'TodoWrite' || t.tool === 'TaskCreate' || t.tool === 'TaskUpdate') {
        out = settle({ ...out, tasks: applyTool(out.tasks, t.tool, t.input, t.result) }, now)
      } else if (isPlanTool(tool)) {
        out = settle({ ...out, tasks: applyPlan(out.tasks, t.input) }, now)
      }
      const started = bgFromCall(tool, t.input, t.result, String(t.tool_use_id ?? ''))
      if (started) out = startBg({ ...out }, started, out.started_at)
      if (tool === 'TaskStop') {
        const id = ((t.input ?? {}) as Record<string, unknown>).task_id
        if (typeof id === 'string') out = endBg(out, { id }, 'killed', now)
      }
    }
  }
  // the replay carries a notice only when it opened a turn; the transcript file has the rest, and the times
  const byReplay = new Map(out.bg.flatMap(b => (b.ended_at === null ? [] : [[b.id, b.ended_at] as const])))
  out = hist ? applyHist(out, hist, now) : out
  const from = (b: Bg): Found['from'] => (!byReplay.has(b.id) ? 'file' : byReplay.get(b.id) === b.ended_at ? 'replay' : 'both')
  const ended: Found[] = out.bg.flatMap(b => (b.ended_at === null ? [] : [{ ...b, from: from(b) }]))
  // what ended before the reload is not known to the minute without the file: only the running ones are rebuilt (the status file's own earlier copy adds the recent ones)
  out = { ...out, bg: out.bg.filter(b => b.ended_at === null || (hist !== null && now - b.ended_at <= BG_DONE_MS)) }
  const lastRow = [...rows].reverse().find(r => !isCommandEcho(r))
  const open = lastRow?.role === 'assistant' ? lastRow.toolUses?.find(t => t.result === undefined && t.text === undefined && t.tool !== 'Monitor' && (t.input as Record<string, unknown> | undefined)?.run_in_background !== true) : undefined
  // the last row is the assistant's final answer and nothing is open: the turn is over; the transcript's last turn end (or a later task end) says when
  if (!open && !out.finished && lastRow?.role === 'assistant' && typeof lastRow.text === 'string' && lastRow.text.trim() !== '') {
    const turnEnd = hist?.turn_end ?? null
    out = { ...out, finished: turnEnd !== null ? { at: Math.max(turnEnd, ...ended.map(b => b.ended_at as number)), verdict: TURN_ENDED, ok: true } : { at: now, verdict: TURN_ENDED, ok: true, untimed: true } }
  }
  if (open) out = { ...out, tool_now: { name: scrub(String(open.tool ?? 'tool'), 40), detail: '' }, tool_since: now, alive_at: now }
  return { status: out, ended }
}

/** A status read from disk (v1 or v2), or null when it is broken or half written; every string is cut again. */
export const normalize = (raw: unknown): Status | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.session !== 'string' || typeof r.updated_at !== 'number') return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? scrub(v, max) : '')
  const markers = Array.isArray(r.markers)
    ? r.markers.slice(-10).flatMap((m: Record<string, unknown>) =>
        m && num(m.n) !== null && num(m.N) !== null && num(m.at) !== null
          ? [{ kind: str(m.kind, 24), n: m.n as number, N: m.N as number, at: m.at as number, line: str(m.line, 80) }]
          : [],
      )
    : []
  const pair = (v: unknown): { n: number; N: number } | null => {
    const o = v as Record<string, unknown> | null
    return o && num(o.n) !== null && num(o.N) !== null ? { n: o.n as number, N: o.N as number } : null
  }
  const pair2 = (v: unknown): { at: number; frac: number } | null => {
    const o = v as Record<string, unknown> | null

    return o && num(o.at) !== null && num(o.frac) !== null ? { at: o.at as number, frac: o.frac as number } : null
  }
  const report = (v: unknown): Report | null => {
    const o = v as Record<string, unknown> | null

    return o && num(o.at) !== null ? { at: o.at as number, pct: num(o.pct), eta_at: num(o.eta_at) } : null
  }
  const phase = pair(r.phase)
  const oth = pair(r.other)
  const tool = r.tool_now as Record<string, unknown> | null
  const fin = r.finished as Record<string, unknown> | null
  const tasks = Array.isArray(r.tasks)
    ? r.tasks.slice(0, 60).flatMap((t: Record<string, unknown>) => {
        if (!t || typeof t.subject !== 'string' || !STATUSES.includes(String(t.status))) return []
        const mk = t.mark as Record<string, unknown> | null
        const mark = mk && num(mk.n) !== null && num(mk.N) !== null ? { kind: str(mk.kind, 24), n: mk.n as number, N: mk.N as number } : null

        return [{ id: str(t.id, 24), subject: str(t.subject, 70), status: t.status as Task['status'], mark }]
      })
    : []
  return {
    v: 2,
    session: str(r.session, 64),
    folder: str(r.folder, 120),
    branch: str(r.branch, 40) || '—',
    started_at: num(r.started_at) ?? (r.updated_at as number),
    start_known: r.start_known === true,
    updated_at: r.updated_at as number,
    prompt_id: cleanId(str(r.prompt_id, 24)),
    role: r.role === 'lead' || r.role === 'second' ? r.role : null,
    expect_h: num(r.expect_h),
    phase,
    other: oth ? { kind: str((r.other as Record<string, unknown>).kind, 24), ...oth } : null,
    markers,
    tasks,
    tool_now: tool && typeof tool === 'object' ? { name: str(tool.name, 40), detail: str(tool.detail, 80) } : null,
    tool_since: num(r.tool_since),
    alive_at: num(r.alive_at) ?? (r.updated_at as number),
    subagents: Array.isArray(r.subagents)
      ? r.subagents.slice(0, 20).flatMap((x: Record<string, unknown>) =>
          x && num(x.started_at) !== null
            ? [{ id: str(x.id, 64), description: str(x.description, 60), started_at: x.started_at as number }]
            : [],
        )
      : [],
    finished:
      fin && typeof fin === 'object' && num(fin.at) !== null
        ? { at: fin.at as number, verdict: str(fin.verdict, 60), ok: fin.ok === true, ...(fin.untimed === true ? { untimed: true as const } : {}) }
        : null,
    bg: Array.isArray(r.bg)
      ? r.bg.slice(-BG_KEEP).flatMap((b: Record<string, unknown>) =>
          b && num(b.started_at) !== null && (b.kind === 'shell' || b.kind === 'agent' || b.kind === 'monitor')
            ? [{ id: str(b.id, 64), tool_use_id: str(b.tool_use_id, 64), kind: b.kind, label: str(b.label, 70), started_at: b.started_at as number, ended_at: num(b.ended_at), ok: typeof b.ok === 'boolean' ? b.ok : null, end: typeof b.end === 'string' ? str(b.end, 20) : null, seen: typeof b.seen === 'string' ? str(b.seen, 20) : null, pct: num(b.pct), eta_at: num(b.eta_at), prog_at: num(b.prog_at) }]
            : [],
        )
      : [],
    watch: pair2(r.watch),
    report: report(r.report),
    tasks_at: num(r.tasks_at) ?? (r.updated_at as number),
    title: str(r.title, 70),
    steps: num(r.steps) ?? 0,
    recent: Array.isArray(r.recent)
      ? r.recent.slice(-STEPS_KEPT).flatMap((x: Record<string, unknown>) => (x && typeof x.name === 'string' ? [{ name: str(x.name, 40), detail: str(x.detail, 80), at: num(x.at) ?? 0 }] : []))
      : [],
  }
}

/** For /builds-tasks: this session's background tasks, each with its start and the last notification seen for it (id and status only). */
export const bgReport = (s: Status, lost: readonly string[], now: number, found: readonly Found[] = []): string => {
  const from = (b: Bg): string => {
    const f = b.ended_at === null ? undefined : found.find(x => x.id === b.id)

    return f ? ` · end read from ${f.from === 'replay' ? 'the replayed history' : f.from === 'both' ? 'the replayed history, its time from the transcript file' : 'the transcript file'}` : ''
  }
  const before = found.filter(f => !s.bg.some(b => b.id === f.id))
  const rows = [...s.bg, ...before].map(b => `${b.ended_at === null ? (now - b.started_at > BG_CAP_MS ? 'no news' : 'running') : 'ended'} · ${b.kind} · ${b.label} · id ${b.id} · started ${fmtClock(b.started_at)}${b.ended_at === null ? '' : ` · ended ${fmtClock(b.ended_at)} (${b.end ?? '?'})`} · last notice: ${b.seen ? `${b.id} ${b.seen}` : 'none'}${from(b)}`)
  const head = `${bgRunning(s, now).length} counted as running, ${s.bg.length} listed${before.length > 0 ? `, ${before.length} more ended before the reload` : ''}.`
  const extra = lost.length > 0 ? [`Notifications that named no listed task (id, status): ${lost.join('; ')}`] : []

  return [head, ...rows, ...extra].join('\n')
}
