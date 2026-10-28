import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status } from '../types'
import { avatarSvg } from './art'
import {
  ALL_DONE,
  DELETE_MS,
  HEARTBEAT_MS,
  SESSION_CLOSED,
  TURN_ENDED,
  applyParsed,
  applyTool,
  bandLine,
  blankStatus,
  branchFromHead,
  cardOf,
  colorFor,
  expectFrom,
  homeShown,
  normalize,
  parseText,
  promptIdFrom,
  recover,
  roleFrom,
  runLines,
  scrub,
  setFolderLabels,
  settle,
  toolNow,
  visibleRuns,
} from './logic'

const PANE = 'builds'
const nowAtom = atom({ plugin: 'build-progress', key: 'now' } as const, 0)
const mine = atom({ plugin: 'build-progress', key: 'mine' } as const, null as Status | null)

const WRITE_EVERY_MS = 2000
const CLOCK_MS = 30_000
const TASK_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate']

type Eng = EngineInterface

let dir = ''
let status: Status | null = null
let lastWrite = 0
let isScheduled = false
let hasPrompt = false

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
  status = settle(fn(touch ? { ...status, updated_at: now, alive_at: now } : status), now)
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
    status = blankStatus(sid, scrub(homeShown(cwd, home), 120), branch, now)
    hasPrompt = false
    try {
      // the session's own history: its first prompt (id, EXPECT), its to-do list, its markers
      const rows = await $.session.messages()
      if (Array.isArray(rows) && rows.some(r => r.role === 'user' && r.text.trim() !== '')) {
        hasPrompt = true
        // the history carries no clock; the session's launch is the nearest stamp to its first prompt
        const launch = (await $.session.usage()).startedAt
        status = recover({ ...status, started_at: Number.isFinite(launch) ? launch : now }, rows, now)
      }
    } catch {
      // no history to read: the title stays the folder
    }
    try {
      // a reload starts from a blank status; the first prompt's time is kept from this session's own earlier file
      const old = normalize(JSON.parse(await $.fs.read(`${dir}/${sid}.json`)))
      if (old && old.session === sid && old.started_at < status.started_at) status = { ...status, started_at: old.started_at }
    } catch {
      // no earlier file
    }
    await writeNow($)
    await $.command.register({ name: 'builds', description: 'List every Claude Code session and its progress' })
    void $.ui.open({ id: PANE, title: 'Builds' })
    void update($, nowAtom, () => now)
    $.clock.every(CLOCK_MS, () => void $.clock.now().then(t => update($, nowAtom, () => t)))
    // a long tool call or helper writes nothing on its own: the heartbeat says the run is alive
    $.clock.every(HEARTBEAT_MS, () => {
      if (status && (status.tool_now || status.subagents.length > 0)) void change($, s => s, true)
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

  on('prompt.submit', async ($, e, next) => {
    if (status && !hasPrompt) {
      hasPrompt = true
      const now = await $.clock.now()
      const id = promptIdFrom(e.text)
      const role = roleFrom(e.text)
      const expect = expectFrom(e.text)
      await change($, s => ({ ...s, started_at: now, prompt_id: id, role: role ?? s.role, expect_h: expect }))
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
    if (!e.agentId && e.message.type === 'assistant') {
      const text = (Array.isArray(e.message.content) ? e.message.content : [])
        .flatMap(b => (b && typeof b === 'object' && 'type' in b && b.type === 'text' && 'text' in b ? [String(b.text)] : []))
        .join('\n')
      if (text.includes('▶')) {
        const now = await $.clock.now()
        const parsed = parseText(text, now)
        await change($, s => applyParsed(s, parsed, now))
      } else {
        await change($, s => s)
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      await change($, s => s)

      return next(e)
    }
    const startedAt = await $.clock.now()
    await change($, s => ({ ...s, tool_now: toolNow(e), tool_since: startedAt }))
    const ran = await next(e)
    // the session's to-do list is carried by these three tools' calls
    const isList = TASK_TOOLS.includes(e.tool) && !('deny' in ran && ran.deny)
    await change($, s => ({ ...s, tool_now: null, tool_since: null, tasks: isList ? applyTool(s.tasks, e.tool, e, ran.result) : s.tasks }))

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const key = e.tool_use_id || `sub-${Date.now()}`
    const now = await $.clock.now()
    await change($, s => ({
      ...s,
      subagents: [...s.subagents.filter(x => x.id !== key), { id: key, description: scrub(e.description, 60), started_at: now }],
    }))
    let result
    try {
      result = await next(e)
    } catch (err) {
      await change($, s => ({ ...s, subagents: s.subagents.filter(x => x.id !== key) }))
      throw err
    }
    const agentId = 'agentId' in result ? result.agentId : undefined
    if (agentId) await change($, s => ({ ...s, subagents: s.subagents.map(x => (x.id === key ? { ...x, id: agentId } : x)) }))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      await change($, s => ({ ...s, subagents: s.subagents.filter(x => x.id !== id) }))
    } else {
      const failed = e.reason === 'error' || e.reason === 'refusal'
      await change($, s => ({
        ...s,
        tool_now: null,
        tool_since: null,
        finished: s.finished ?? (failed ? { at: s.updated_at, verdict: scrub(`ended: ${e.reason}`, 60), ok: false } : e.reason === 'answer' && s.subagents.length === 0 ? { at: s.updated_at, verdict: TURN_ENDED, ok: true } : null),
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
      <Box>
        <Text wrap="truncate">{bandLine(me, now)}</Text>
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
        {c.pct !== '' && <Text bold>{c.pct}</Text>}
        <Text>{c.bar}</Text>
        <Text>{c.end ?? c.left}</Text>
        <Text dimColor>{c.running}</Text>
        {c.work !== '' && <Text bold>{c.work}</Text>}
        {c.doing !== '' && <Text>{c.doing}</Text>}
        {me.tasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {me.tasks.map(t => (
              <Text key={`t-${t.id}`} bold={t.status === 'in_progress'} dimColor={t.status === 'pending'}>
                {`${mark(t.status)} ${t.subject}`}
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
