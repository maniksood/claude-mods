import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status, Task } from '../types'
import { avatarSvg } from './art'
import {
  ALL_DONE,
  BG_DONE_MS,
  DELETE_MS,
  HEARTBEAT_MS,
  HIST_PATTERN,
  SESSION_CLOSED,
  STOPPED_BY_YOU,
  TURN_ENDED,
  addStep,
  applyHist,
  applyParsed,
  applyPlan,
  applyTool,
  bandLines,
  bgFromCall,
  bgReport,
  bgRunning,
  blankStatus,
  branchFromHead,
  cardOf,
  colorFor,
  endBg,
  expectFrom,
  fractionOf,
  listFraction,
  parseHist,
  scanProgress,
  setBgProgress,
  type Found,
  type Hist,
  homeShown,
  isPlanTool,
  noticeBg,
  normalize,
  parseNotice,
  parseText,
  promptIdFrom,
  recoverAll,
  roleFrom,
  runLines,
  scrub,
  setFolderLabels,
  settle,
  startBg,
  toolNow,
  visibleRuns,
  watchOf,
} from './logic'

const PANE = 'builds'
const nowAtom = atom({ plugin: 'build-progress', key: 'now' } as const, 0)
const mine = atom({ plugin: 'build-progress', key: 'mine' } as const, null as Status | null)

const WRITE_EVERY_MS = 2000
const CLOCK_MS = 30_000
const TASK_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate']

const isBusy = (s: Status, now: number): boolean => s.tool_now !== null || s.subagents.length > 0 || bgRunning(s, now).length > 0

type Eng = EngineInterface

let dir = ''
let status: Status | null = null
let lastWrite = 0
let isScheduled = false
let hasPrompt = false
/** The last notifications that named no listed task, as `id status`; for /builds-tasks. */
let lost: string[] = []
/** The tasks that ended before the last reload, and where each end was read; for /builds-tasks. */
let found: Found[] = []
/** What the last reload read from the history (counts and whether the file was found); for /builds-tasks. */
let histNote = ''

/** A background agent's own checklist, by its agent id; for its %. */
const agentTasks = new Map<string, Task[]>()
let sessionId = ''
let cwdNow = ''
let homeDir = ''
let configDir = ''
let tasksDir: string | null = null
let isReconciling = false
let beats = 0

/** Where the transcript may be: under the app's own folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`), in the folder named for the working directory with every character outside letters, digits and `-` turned into `-`. */
const transcriptPaths = (): string[] =>
  [...new Set([configDir, `${homeDir}/.claude`].filter(d => d !== ''))].map(d => `${d}/projects/${cwdNow.replace(/[^A-Za-z0-9-]/g, '-')}/${sessionId}.jsonl`)

/** The transcript's ids, status words, clock times and the session's name, found with `grep`; null when it cannot be read. Nothing else is taken from it. */
const loadHist = async ($: Eng): Promise<Hist | null> => {
  try {
    let path = ''
    for (const p of transcriptPaths()) {
      if (await $.fs.exists(p)) {
        path = p
        break
      }
    }
    if (!path) return null
    const r = await $.process.run(['grep', '-noE', HIST_PATTERN, path], { timeoutMs: 30_000 })
    if (r.exitCode > 1) return null

    return parseHist(r.stdout)
  } catch {
    return null
  }
}

/** The folder the app writes background output into: `<tmp>/claude-<uid>/<project>/<session>/tasks`. */
const findTasksDir = async ($: Eng): Promise<string | null> => {
  if (tasksDir) return tasksDir
  const slug = cwdNow.replace(/[^A-Za-z0-9-]/g, '-')
  for (const root of ['/private/tmp', '/tmp']) {
    try {
      for (const f of await $.fs.list(root)) {
        if (f.kind !== 'dir' || !f.name.startsWith('claude-')) continue
        const dir = `${root}/${f.name}/${slug}/${sessionId}/tasks`
        if (await $.fs.exists(dir)) return (tasksDir = dir)
      }
    } catch {
      // not there: no % for shells
    }
  }
  return null
}

/** Reads the last lines of each running task's output file only to find `▶ n/N`, `NN%` and "N min left"; nothing of the text is kept. */
const scanOutputs = async ($: Eng): Promise<void> => {
  if (!status) return
  const dir = await findTasksDir($)
  if (!dir) return
  const now = await $.clock.now()
  for (const b of bgRunning(status, now)) {
    if (b.kind === 'monitor') continue
    try {
      const r = await $.process.run(['tail', '-c', '16384', `${dir}/${b.id}.output`], { timeoutMs: 5000 })
      if (r.exitCode !== 0) continue
      const p = scanProgress(r.stdout, now)
      await change($, s => setBgProgress(s, b.id, p, now), false)
    } catch {
      // no output file yet, or it cannot be read: no % reported
    }
  }
}

/** What the transcript says (ends the live notices missed, each task's own start, the name) and what the tasks' outputs say. */
const reconcile = async ($: Eng): Promise<void> => {
  if (isReconciling || !status) return
  isReconciling = true
  try {
    const hist = await loadHist($)
    const now = await $.clock.now()
    if (hist) await change($, s => applyHist(s, hist, now), false)
    await scanOutputs($)
  } finally {
    isReconciling = false
  }
}

/** This session's own file is only for `/builds`; the pane and the band read the in-memory copy. */
const writeNow = async ($: Eng): Promise<void> => {
  if (!status) return
  lastWrite = await $.clock.now()
  isScheduled = false
  const out = { ...status, markers: status.markers.slice(-10) }
  try {
    await $.fs.write(`${dir}/${status.session}.json`, JSON.stringify(out))
  } catch {
    // a failed write only means /builds is a moment late
  }
  await update($, mine, () => out)
}

/** Every change goes through here: at most one write in 2 seconds, the whole file each time. */
const change = async ($: Eng, fn: (s: Status) => Status, touch = true): Promise<void> => {
  if (!status) return
  const now = await $.clock.now()
  const before = fractionOf(status)
  const next = settle(fn(touch ? { ...status, updated_at: now, alive_at: now } : status), now)
  status = watchOf(fractionOf(next) === before ? next : { ...next, tasks_at: now }, now)
  const wait = lastWrite + WRITE_EVERY_MS - now
  if (wait <= 0) {
    await writeNow($)
  } else if (!isScheduled) {
    isScheduled = true
    $.clock.after(wait, () => void writeNow($))
  }
}

/** For `/builds` only: reads every status file. A file that does not parse is skipped. */
const listAll = async ($: Eng): Promise<Status[]> => {
  const now = await $.clock.now()
  const found: Status[] = []
  let entries: Awaited<ReturnType<Eng['fs']['list']>> = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return found
  }
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.size <= 2) continue
    if (now - f.mtimeMs > DELETE_MS) {
      // no delete call exists on `$.fs`: an old file is emptied, and skipped from then on
      await $.fs.write(`${dir}/${f.name}`, '{}').catch(() => undefined)
      continue
    }
    try {
      const s = normalize(JSON.parse(await $.fs.read(`${dir}/${f.name}`)))
      if (s) found.push(s)
    } catch {
      // half written or broken
    }
  }
  return found
}

export const register: Register = (on, options) => {
  setFolderLabels(options.folder_labels)
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const sid = await $.session.id()
    const cwd = await $.session.cwd()
    const home = await $.env.get('HOME').catch(() => undefined)
    const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
    dir = `${home ?? ''}/.claude/build-progress`
    let branch = '—'
    try {
      const head = await $.fs.read(`${cwd}/.git/HEAD`)
      if (typeof head === 'string') branch = branchFromHead(head)
    } catch {
      try {
        // a worktree: `.git` is a file naming its own folder, whose HEAD is this session's
        const link = await $.fs.read(`${cwd}/.git`)
        const gitdir = typeof link === 'string' ? /^gitdir:\s*(.+)$/m.exec(link)?.[1]?.trim() : undefined
        const head = gitdir ? await $.fs.read(`${gitdir}/HEAD`) : ''
        if (typeof head === 'string' && head) branch = branchFromHead(head)
      } catch {
        // not a repository: branch stays "—"
      }
    }
    sessionId = sid
    cwdNow = cwd
    homeDir = home ?? ''
    configDir = config ?? ''
    tasksDir = null
    agentTasks.clear()
    status = blankStatus(sid, scrub(homeShown(cwd, home), 120), branch, now)
    const hist = await loadHist($)
    hasPrompt = false
    found = []
    histNote = ''
    try {
      // the session's own history: its first prompt (id, EXPECT), its to-do list, its markers
      const rows = await $.session.messages()
      if (Array.isArray(rows) && rows.some(r => r.role === 'user' && r.text.trim() !== '')) {
        hasPrompt = true
        // the history carries no clock; the session's launch is the nearest stamp to its first prompt
        const launch = (await $.session.usage()).startedAt
        const got = recoverAll({ ...status, started_at: Number.isFinite(launch) ? launch : now }, rows, now, hist)
        status = got.status
        found = got.ended
        const byReplay = found.filter(f => f.from !== 'file').length
        const timed = found.filter(f => f.from === 'both').length
        histNote = `At the reload: ${rows.length} messages replayed, ${byReplay} task end${byReplay === 1 ? '' : 's'} in them; ${hist ? `the transcript file gave ${found.length - byReplay} more and the time of ${timed} of those` : 'the transcript file could not be read'}.`
      }
    } catch {
      // no history to read: the title stays the folder
    }
    try {
      // a reload starts from a blank status; the first prompt's time and the end time are kept from this session's own earlier file
      const old = normalize(JSON.parse(await $.fs.read(`${dir}/${sid}.json`)))
      if (old && old.session === sid) {
        // background tasks: the history says what runs; this session's own earlier file knows when each began and what ended in the last 10 minutes
        const known = status.bg.map(b => {
          const was = old.bg.find(x => x.id === b.id || (b.tool_use_id !== '' && x.tool_use_id === b.tool_use_id))

          return was && hist?.starts[b.id] === undefined ? { ...b, started_at: was.started_at } : b
        })
        const recent = old.bg.filter(x => x.ended_at !== null && now - x.ended_at <= BG_DONE_MS && !known.some(b => b.id === x.id))
        status = { ...status, report: old.report, title: status.title || old.title }
        status = { ...status, bg: [...known, ...recent] }
        if (old.start_known) status = { ...status, started_at: old.started_at, start_known: true }
        else if (!status.start_known && old.started_at < status.started_at) status = { ...status, started_at: old.started_at }
        if (status.finished?.untimed && old.finished && !old.finished.untimed && old.finished.verdict !== ALL_DONE) {
          status = { ...status, finished: { ...old.finished, verdict: old.finished.verdict === SESSION_CLOSED ? TURN_ENDED : old.finished.verdict } }
        }
      }
    } catch {
      // no earlier file
    }
    if (hist) status = applyHist(status, hist, now)
    status = watchOf({ ...status, watch: null, tasks_at: now }, now)
    lost = []
    await writeNow($)
    await $.command.register({ name: 'builds', description: 'List every Claude Code session and its progress' })
    await $.command.register({ name: 'builds-tasks', description: 'List this session\'s background tasks and the last notification seen for each' })
    await $.command.register({ name: 'builds-panel', description: 'Open the Builds panel' })
    void $.ui.open({ id: PANE, title: 'Builds' })
    void update($, nowAtom, () => now)
    $.clock.every(CLOCK_MS, () => void $.clock.now().then(t => update($, nowAtom, () => t)))
    // a long tool call or helper writes nothing on its own: the heartbeat says the run is alive
    $.clock.every(HEARTBEAT_MS, () => {
      if (status) void $.clock.now().then(t => status && isBusy(status, t) && change($, s => s, true))
      // the transcript is the safety net for a notice the live hook missed; quiet sessions look every fifth beat
      beats += 1
      if (status) void $.clock.now().then(t => status && (bgRunning(status, t).length > 0 || beats % 5 === 0) && reconcile($))
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      await change($, s => ({ ...s, subagents: [], tool_now: null, tool_since: null, finished: s.finished ?? { at: s.updated_at, verdict: SESSION_CLOSED, ok: true } }))
      await writeNow($)
    }

    return next(e)
  })

  // The one place other sessions are read, and only as text, when asked.
  on('command.run', { command: 'builds' }, async $ => {
    const now = await $.clock.now()
    const list = visibleRuns(await listAll($), now, true)
    const text = list.length === 0 ? 'No sessions have written a status file in the last 12 hours.' : list.flatMap(s => runLines(s, now)).join('\n')

    return { text }
  })

  // This session only: why each background task is still counted, from the ids and status words alone.
  on('command.run', { command: 'builds-tasks' }, async $ => ({ text: status ? [bgReport(status, lost, await $.clock.now(), found), histNote].filter(Boolean).join('\n') : 'No session yet.' }))

  // same pane id: opening it again re-seats the one pane, never a second
  on('command.run', { command: 'builds-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Builds' })

    return { text: 'Opened the Builds panel.' }
  })

  on('prompt.submit', async ($, e, next) => {
    // a slash command is not work: it changes neither the finish nor the start time
    if (e.text.trimStart().startsWith('/')) return next(e)
    if (status && !hasPrompt) {
      hasPrompt = true
      const now = await $.clock.now()
      const id = promptIdFrom(e.text)
      const role = roleFrom(e.text)
      const expect = expectFrom(e.text)
      await change($, s => ({ ...s, started_at: now, start_known: true, prompt_id: id, role: role ?? s.role, expect_h: expect }))
    } else {
      await change($, s => ({ ...s, finished: s.finished?.verdict === ALL_DONE ? s.finished : null }))
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await change($, s => ({ ...s, finished: s.finished?.verdict === ALL_DONE ? s.finished : null }))

    return next(e)
  })

  // The model's text comes from `session.append`: rows from the `response` door, main loop only.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId && e.message.type === 'assistant') {
      // a background agent's own markers give its %
      const text = (Array.isArray(e.message.content) ? e.message.content : [])
        .flatMap(b => (b && typeof b === 'object' && 'type' in b && b.type === 'text' && 'text' in b ? [String(b.text)] : []))
        .join('\n')
      const id = e.agentId
      if (/▶|%|left|ETA/.test(text)) {
        const now = await $.clock.now()
        const p = scanProgress(text, now)
        await change($, s => setBgProgress(s, id, p, now), false)
      }
    }
    if (!e.agentId && e.message.type === 'assistant') {
      const text = (Array.isArray(e.message.content) ? e.message.content : [])
        .flatMap(b => (b && typeof b === 'object' && 'type' in b && b.type === 'text' && 'text' in b ? [String(b.text)] : []))
        .join('\n')
      if (/▶|%|left|ETA/.test(text)) {
        const now = await $.clock.now()
        const parsed = parseText(text, now)
        await change($, s => applyParsed(s, parsed, now))
      } else {
        await change($, s => s)
      }
    }

    return next(e)
  })

  // A background task ends with a notification row: its id and status are read from the envelope, nothing else.
  on('session.append', async ($, e, next) => {
    const content: unknown = e.message.content
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).flatMap(b => (b && typeof b === 'object' && 'text' in b ? [String(b.text)] : [])).join('\n')
    // the engine's stamp, or a user/attachment row that opens with the envelope (never a tool result, whose text is data)
    const isNotice = e.origin.kind === 'task-notification' || (e.door !== 'tool-result' && e.message.type !== 'assistant' && text.trimStart().startsWith('<task-notification'))
    if (!e.agentId && isNotice) {
      const notice = parseNotice(text)
      if (notice) {
        const now = await $.clock.now()
        let isKnown = true
        await change($, s => {
          const r = noticeBg(s, notice, now)
          isKnown = r.isKnown

          return r.status
        })
        if (!isKnown) lost = [...lost, `${notice.id ?? notice.toolUseId} ${notice.status}`].slice(-5)
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const ran = await next(e)
      const isList = (TASK_TOOLS.includes(e.tool) || isPlanTool(e.tool)) && !('deny' in ran && ran.deny)
      const now = await $.clock.now()
      if (isList) {
        const was = agentTasks.get(id) ?? []
        const tasks = isPlanTool(e.tool) ? applyPlan(was, e) : applyTool(was, e.tool, e, ran.result)
        agentTasks.set(id, tasks)
        const f = listFraction(tasks)
        await change($, s => setBgProgress(s, id, { pct: f === null ? null : Math.round(f * 100), eta_at: null }, now))
      } else {
        await change($, s => s)
      }

      return ran
    }
    const startedAt = await $.clock.now()
    const call = toolNow(e)
    await change($, s => addStep({ ...s, tool_now: call, tool_since: startedAt }, { ...call, at: startedAt }))
    const ran = await next(e)
    const isDenied = 'deny' in ran && !!ran.deny
    // the session's to-do list is carried by these three tools' calls
    const isList = (TASK_TOOLS.includes(e.tool) || isPlanTool(e.tool)) && !isDenied
    const endedAt = await $.clock.now()
    // a background command or monitor is told by its call's result; the task's end comes later, from its notification
    const started = isDenied ? null : bgFromCall(e.tool, e, ran.result, e.tool_use_id ?? '')
    const stopped = !isDenied && e.tool === 'TaskStop' && typeof e.task_id === 'string' ? e.task_id : ''
    await change($, s => {
      let out: Status = { ...s, tool_now: null, tool_since: null, tasks: isList ? (isPlanTool(e.tool) ? applyPlan(s.tasks, e) : applyTool(s.tasks, e.tool, e, ran.result)) : s.tasks }
      if (started) out = startBg(out, started, endedAt)
      if (stopped) out = endBg(out, { id: stopped }, 'killed', endedAt)

      return out
    })

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const key = e.tool_use_id || `sub-${Date.now()}`
    const now = await $.clock.now()
    const isBg = e.background === true
    const label = scrub(e.description, 60)
    // a background agent is listed with the background tasks; the others stay helpers
    await change($, s =>
      isBg
        ? startBg(s, { id: key, toolUseId: e.tool_use_id || '', kind: 'agent', label }, now)
        : { ...s, subagents: [...s.subagents.filter(x => x.id !== key), { id: key, description: label, started_at: now }] },
    )
    let result
    try {
      result = await next(e)
    } catch (err) {
      await change($, s => ({ ...s, subagents: s.subagents.filter(x => x.id !== key), bg: s.bg.filter(x => x.id !== key) }))
      throw err
    }
    const agentId = 'agentId' in result ? result.agentId : undefined
    if (agentId) {
      await change($, s =>
        isBg
          ? startBg(s, { id: agentId, toolUseId: e.tool_use_id || '', kind: 'agent', label }, now)
          : { ...s, subagents: s.subagents.map(x => (x.id === key ? { ...x, id: agentId } : x)) },
      )
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const now = await $.clock.now()
      const word = e.reason === 'aborted' ? 'killed' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'completed'
      await change($, s => endBg({ ...s, subagents: s.subagents.filter(x => x.id !== id) }, { id }, word, now))
    } else {
      const failed = e.reason === 'error' || e.reason === 'refusal'
      const stopped = e.reason === 'aborted'
      await change($, s => ({
        ...s,
        tool_now: null,
        tool_since: null,
        finished: s.finished ?? (stopped ? { at: s.updated_at, verdict: STOPPED_BY_YOU, ok: false } : failed ? { at: s.updated_at, verdict: scrub(`ended: ${e.reason}`, 60), ok: false } : e.reason === 'answer' && s.subagents.length === 0 ? { at: s.updated_at, verdict: TURN_ENDED, ok: true } : null),
      }))
    }

    return next(e)
  })

  // ---- drawing: this session only ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const me = await read($, mine)
    if (e.props.hasSurvey || !me) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        {bandLines(me, now).map((line, i) => (
          <Text key={`band-${i}`} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : null
    const me = await read($, mine)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    if (!me) return <Text dimColor>Waiting for this session to start.</Text>
    const c = cardOf(me, now)
    const mark = (st: string) => (st === 'completed' ? '✅' : st === 'in_progress' ? '▶' : '○')

    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box gap={1} alignItems="center">
          {Svg ? <Svg source={avatarSvg(c.state, colorFor(me.prompt_id === '—' ? me.folder : me.prompt_id))} alt={c.state} width={32} height={30} isInteractive /> : <Text>{c.emoji}</Text>}
          <Text bold>{c.title}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Overall</Text>
          {c.overall.pct !== null && <Text bold>{`${c.overall.pct}%`}</Text>}
          {c.overall.pct !== null && <Text>{c.overall.bar}</Text>}
          {c.overall.left !== '' && <Text>{c.overall.left}</Text>}
          <Text dimColor>{c.overall.running}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Main run</Text>
          {c.end !== null && <Text>{c.end}</Text>}
          {c.pct !== '' && <Text>{`${c.pct}  ${c.bar}`}</Text>}
          {c.end === null && c.mainLeft !== '' && <Text>{c.mainLeft}</Text>}
          {c.work !== '' && <Text bold>{c.work}</Text>}
          {c.doing !== '' && <Text>{c.doing}</Text>}
        </Box>
        {c.plain && c.steps.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Last steps</Text>
            {c.steps.map((line, i) => (
              <Text key={`s-${i}`} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        )}
        {!c.plain && me.tasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {me.tasks.map(t => (
              <Text key={`t-${t.id}`} bold={t.status === 'in_progress'} dimColor={t.status === 'pending'}>
                {`${mark(t.status)} ${t.subject}`}
              </Text>
            ))}
          </Box>
        )}
        {c.bg.running.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>In the background</Text>
            {c.bg.running.map((line, i) => (
              <Text key={`b-${i}`}>{line}</Text>
            ))}
          </Box>
        )}
        {c.bg.done.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Done in the background</Text>
            {c.bg.done.map((line, i) => (
              <Text key={`g-${i}`} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        )}
        {me.subagents.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {me.subagents.map(sub => (
              <Text key={`d-${sub.id}`} dimColor>
                {`👥 ${sub.description} · ${Math.max(0, Math.floor((now - sub.started_at) / 60_000))} min`}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
