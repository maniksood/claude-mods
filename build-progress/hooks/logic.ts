import type { Finish, Marker, Status, Task } from '../types'

export const QUIET_MS = 10 * 60_000
export const STALE_TOOL_MS = 15 * 60_000
export const HEARTBEAT_MS = 60_000
export const HIDE_MS = 12 * 3_600_000
export const DELETE_MS = 2 * 24 * 3_600_000
export const ALL_DONE = 'all items done'
export const EARLY_PCT = 10
export const MIN_LEFT = 5

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
})

const MARK = /^\s*▶\s*([A-Za-z][\w-]*)\s+(\d+)\s*\/\s*(\d+)(.*)$/
const END = /^\s*▶\s*(done|finished|failed|stopped)\b[\s:—–-]*(.*)$/i

export type Parsed = {
  markers: Marker[]
  finished: Finish | null
}

/** Reads `▶ kind n/N` markers and `▶ done` / `▶ failed`. */
export const parseText = (text: string, now: number): Parsed => {
  const out: Parsed = { markers: [], finished: null }
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
    },
    now,
  )
}

const STATUSES = ['pending', 'in_progress', 'completed']

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
  (s.tool_now !== null || s.subagents.length > 0) && now - s.alive_at <= STALE_TOOL_MS

export const stateOf = (s: Status, now: number): RunState => {
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
}

/** The share of the whole prompt done: from the to-do list (items done + the open item's own n/N), else the ▶ phase markers. */
export const fractionOf = (s: Status): number | null => {
  if (s.tasks.length > 0) {
    const done = s.tasks.filter(t => t.status === 'completed').length
    const mark = s.tasks.find(t => t.status === 'in_progress')?.mark
    const own = mark && mark.N > 0 ? Math.min(1, Math.max(0, mark.n / mark.N)) : 0
    return Math.min(1, (done + own) / s.tasks.length)
  }
  if (s.phase && s.phase.N > 0) {
    const own = s.other && s.other.N > 0 ? Math.min(1, Math.max(0, s.other.n / s.other.N)) : 0
    return Math.min(1, Math.max(0, (s.phase.n - 1 + own) / s.phase.N))
  }
  return null
}

/** % and time left. Under 10%: EXPECT minus elapsed (not below 5 min); from 10%: elapsed × (100 − %) ÷ %. */
export const progressOf = (s: Status, now: number): Progress => {
  const frac = s.finished?.ok ? 1 : fractionOf(s)
  const pct = frac === null ? null : Math.round(frac * 100)
  const elapsed = Math.max(0, (now - s.started_at) / 60_000)
  if (pct !== null && pct >= EARLY_PCT) return { pct, left: (elapsed * (100 - pct)) / pct, isFromEstimate: false, elapsed }
  if (s.expect_h !== null) return { pct, left: Math.max(MIN_LEFT, s.expect_h * 60 - elapsed), isFromEstimate: true, elapsed }
  return { pct, left: null, isFromEstimate: false, elapsed }
}

export const NOT_REPORTED = '% not reported'

/** The % alone; with no checklist it is empty, or says so only when nothing else (time left) is known either. */
export const pctText = (p: Progress): string => (p.pct !== null ? `${p.pct}%` : p.left === null ? NOT_REPORTED : '')

export const leftText = (p: Progress): string =>
  p.left === null ? 'time left not known yet' : `about ${fmtMin(p.left)} left${p.isFromEstimate ? ' (from the estimate)' : ''}`

export const runningText = (p: Progress): string => `running for ${fmtMin(p.elapsed)}`

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

const quietMin = (s: Status, now: number): number => Math.floor((now - s.updated_at) / 60_000)

/** `✅ Finished · took 2 h 41 min`, `❌ Stopped …`, `😴 Quiet for 12 min`, or null while working. */
const endLine = (s: Status, p: Progress, now: number): string | null => {
  const st = stateOf(s, now)
  const took = s.finished ? fmtMin((s.finished.at - s.started_at) / 60_000) : ''
  if (st === 'done') return `✅ Finished · took ${took}`
  if (st === 'failed') return `❌ Stopped${p.pct === null ? '' : ` at ${p.pct}%`} · after ${took}`
  if (st === 'quiet') return `😴 Quiet for ${quietMin(s, now)} min`
  return null
}

/** The band above the prompt, one line. */
export const bandLine = (s: Status, now: number): string => {
  const p = progressOf(s, now)
  const end = endLine(s, p, now)
  const bar = p.pct === null ? '' : `${p.pct}% ${barText(p.pct)}`
  if (end) return s.finished ? end : [end, bar].filter(Boolean).join(' · ')
  const emoji = EMOJI[stateOf(s, now)]
  if (p.pct === null) return [emoji, ...(p.left === null ? [NOT_REPORTED, leftText(p)] : [leftText(p)]), runningText(p), ...workParts(s, true)].join(' · ').replace(`${emoji} · `, `${emoji} `)
  return [`${emoji} ${bar}`, leftText(p), ...workParts(s, true)].join(' · ')
}

/** The lines of a card as plain data (the pane and /builds). */
export const cardOf = (s: Status, now: number) => {
  const st = stateOf(s, now)
  const p = progressOf(s, now)
  return {
    state: st,
    emoji: EMOJI[st],
    title: titleOf(s),
    pct: pctText(p),
    bar: barText(p.pct),
    left: leftText(p),
    running: runningText(p),
    end: endLine(s, p, now),
    work: workParts(s).join(' · '),
    doing: st === 'done' || st === 'failed' ? '' : `Now: ${doingWords(s)}`,
  }
}

/** Plain-text lines for one run, used by /builds. */
export const runLines = (s: Status, now: number): string[] => {
  const c = cardOf(s, now)
  const lines = [`${c.emoji} ${c.title}${c.pct ? `  ${c.pct}` : ''}`, `   ${c.bar}  ${c.end ?? `${c.left} · ${c.running}`}`]
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

/** Reads this session's earlier rows once: the first prompt's id, role and EXPECT, the to-do list, the markers. */
export type Row = { role: string; text?: string; toolUses?: { tool?: string; input?: unknown; result?: unknown; text?: unknown }[] }

export const recover = (s: Status, rows: readonly Row[], now: number): Status => {
  let out = s
  const first = rows.find(r => r.role === 'user' && typeof r.text === 'string' && r.text.trim() !== '')
  if (first?.text) {
    out = { ...out, prompt_id: promptIdFrom(first.text), role: roleFrom(first.text), expect_h: expectFrom(first.text) }
  }
  for (const r of rows) {
    if (r.role !== 'assistant') continue
    if (typeof r.text === 'string' && r.text.includes('▶')) out = applyParsed(out, parseText(r.text, now), now)
    for (const t of r.toolUses ?? []) {
      if (t.tool === 'TodoWrite' || t.tool === 'TaskCreate' || t.tool === 'TaskUpdate') {
        out = settle({ ...out, tasks: applyTool(out.tasks, t.tool, t.input, t.result) }, now)
      }
    }
  }
  const lastRow = rows[rows.length - 1]
  const open = lastRow?.role === 'assistant' ? lastRow.toolUses?.find(t => t.result === undefined && t.text === undefined) : undefined
  if (open) out = { ...out, tool_now: { name: scrub(String(open.tool ?? 'tool'), 40), detail: '' }, tool_since: now, alive_at: now }
  return out
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
        ? { at: fin.at as number, verdict: str(fin.verdict, 60), ok: fin.ok === true }
        : null,
  }
}
