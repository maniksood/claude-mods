import { describe, expect, test } from 'claude-code/testing'

import type { Bg, Status, Task } from '../types'
import { avatarSvg } from '../hooks/art'
import {
  ALL_DONE,
  applyHist,
  applyParsed,
  bgBand,
  bgDone,
  bgLeft,
  overallLeftText,
  overallOf,
  parseHist,
  parseLeft,
  parseReport,
  scanProgress,
  setBgProgress,
  applyTool,
  applyPlan,
  isPlanTool,
  noticeBg,
  bgReport,
  watchOf,
  bandLine,
  bandLines,
  bgLines,
  blankStatus,
  endBg,
  parseNotice,
  startBg,
  waitLine,
  addStep,
  stepLines,
  cardOf,
  expectFrom,
  normalize,
  parseText,
  progressOf,
  promptIdFrom,
  recover,
  runLines,
  scrub,
  settle,
  stateOf,
  titleOf,
  toolNow,
  type RunState,
  folderName,
  parseFolderLabels,
} from '../hooks/logic'

const NOW = 1_800_000_000_000
const MIN = 60_000
const base = (over: Partial<Status> = {}): Status => ({ ...blankStatus('s', '~/Work/x', 'main', NOW - 26 * MIN), prompt_id: 'MOD-3', start_known: true, updated_at: NOW, alive_at: NOW, ...over })
const task = (id: number, status: Task['status'], mark: Task['mark'] = null): Task => ({ id: String(id), subject: `Item ${id}`, status, mark })

/** 6 items: 2 done, the third open at `▶ mutant 30/40`. */
const six = (over: Partial<Status> = {}): Status =>
  base({
    tasks: [task(1, 'completed'), task(2, 'completed'), { ...task(3, 'in_progress'), subject: 'Phase 2: api server', mark: { kind: 'mutant', n: 30, N: 40 } }, task(4, 'pending'), task(5, 'pending'), task(6, 'pending')],
    ...over,
  })

describe('safety', () => {
  test('a Bash call shows its description and never its command', () => {
    expect(toolNow({ tool: 'Bash', description: 'Print a greeting', command: 'echo sk-live-AbCdEf1234567890XyZ' } as never)).toEqual({ name: 'Bash', detail: 'Print a greeting' })
  })
  test('other tools show a file name only, protected names are hidden', () => {
    expect(toolNow({ tool: 'Edit', file_path: '/a/b/c.ts' })).toEqual({ name: 'Edit', detail: 'c.ts' })
    expect(toolNow({ tool: 'Read', file_path: '/a/.env' }).detail).toBe('(protected file)')
  })
  test('token-like strings are cut from any shown line', () => {
    expect(scrub('key sk-live-AbCdEf1234567890XyZ here')).not.toContain('AbCdEf')
    expect(scrub('password: hunter2')).toBe('password=…')
  })
  test('a broken file is refused', () => {
    expect(normalize(null)).toBeNull()
    expect(normalize({ session: 'a' })).toBeNull()
    expect(normalize({ session: 'a', updated_at: NOW })?.tasks).toEqual([])
  })
})

describe('whole-prompt percent', () => {
  test('6 items, 2 done, the third at ▶ mutant 30/40 = (2 + 0.75) / 6 = 46%', () => {
    expect(progressOf(six(), NOW).pct).toBe(46)
    expect(cardOf(six(), NOW).pct).toBe('46%')
  })
  test('an open item with no marker counts 0 of itself', () => {
    expect(progressOf(six({ tasks: six().tasks.map(t => ({ ...t, mark: null })) }), NOW).pct).toBe(33)
  })
  test('the newest marker lands on the open item', () => {
    let s = six({ tasks: six().tasks.map(t => ({ ...t, mark: null })) })
    s = applyParsed(s, parseText('working\n▶ mutant 10/40', NOW), NOW)
    s = applyParsed(s, parseText('▶ mutant 20/40', NOW), NOW)
    expect(s.tasks[2]?.mark).toEqual({ kind: 'mutant', n: 20, N: 40 })
    expect(progressOf(s, NOW).pct).toBe(42)
  })
  test('with no to-do list the ▶ phase markers are used, as in MOD-2', () => {
    let s = base()
    s = applyParsed(s, parseText('▶ phase 2/4\n▶ step 5/10', NOW), NOW)
    expect(progressOf(s, NOW).pct).toBe(38)
  })
  test('no plan at all: no percent, and the band does not say "starting"', () => {
    expect(progressOf(base(), NOW).pct).toBeNull()
    expect(bandLine(base(), NOW)).not.toContain('starting')
    expect(bandLine(six(), NOW)).not.toContain('starting')
  })
})

describe('time left', () => {
  test('before 10%: EXPECT minus elapsed, shown as from the estimate', () => {
    const s = base({ expect_h: 4, tasks: [task(1, 'in_progress'), ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => task(i, 'pending'))] })
    expect(bandLine(s, NOW)).toContain('⏱ about 3 h 34 min left')
    expect(cardOf(s, NOW).left).toBe('about 3 h 34 min left (from the estimate)')
  })
  test('before 10% the estimate never goes below 5 min', () => {
    const s = base({ expect_h: 0.25, started_at: NOW - 60 * MIN })
    expect(progressOf(s, NOW).left).toBe(5)
  })
  test('from 10%: elapsed × (100 − %) ÷ %', () => {
    const s = six({ started_at: NOW - 50 * MIN, expect_h: 9 })
    // 46%: 50 × 54 / 46 = 58.7 min
    expect(Math.round((progressOf(s, NOW).left ?? 0) * 10) / 10).toBe(58.7)
    expect(cardOf(s, NOW).left).toBe('about 59 min left (from the pace so far)')
  })
  test('exactly 10% switches to elapsed-based', () => {
    const s = base({ started_at: NOW - 30 * MIN, expect_h: 5, tasks: [{ ...task(1, 'in_progress'), mark: { kind: 'x', n: 1, N: 1 } }, ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => task(i, 'pending'))] })
    expect(progressOf(s, NOW).pct).toBe(10)
    expect(cardOf(s, NOW).left).toBe('about 4 h 30 min left (from the pace so far)')
  })
  test('no EXPECT and under 10%: not known yet', () => {
    const s = base({ tasks: [task(1, 'in_progress'), ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => task(i, 'pending'))] })
    expect(cardOf(s, NOW).left).toBe('time left not known yet')
    expect(bandLine(s, NOW)).not.toContain('⏱')
  })
  test('elapsed counts from the first prompt, not from the mod load', () => {
    expect(cardOf(base({ started_at: NOW - 26 * MIN }), NOW).running).toBe('running for 26 min')
    expect(cardOf(base({ started_at: NOW - 90 * MIN }), NOW).running).toBe('running for 1 h 30 min')
  })
  test('EXPECT is read from the header line; none is handled', () => {
    expect(expectFrom('MODEL: Sonnet 5.5 EFFORT: medium WHY: x EXPECT: 1 h')).toBe(1)
    expect(expectFrom('# MOD-3\nEXPECT: 2.5 h\nbody')).toBe(2.5)
    expect(expectFrom('# MOD-3\nbody with no estimate')).toBeNull()
    expect(promptIdFrom('MODEL: x EXPECT: 1 h\nMOD-3 · Builds panel\nbody')).toBe('MOD-3')
  })
})

describe('the to-do list from the task tools', () => {
  test('TodoWrite sends the whole list', () => {
    const t = applyTool([], 'TodoWrite', { todos: [{ content: 'Step 0', status: 'completed', activeForm: 'x' }, { content: 'Phase 1', status: 'in_progress', activeForm: 'y' }] }, {})
    expect(t.map(x => `${x.subject}:${x.status}`)).toEqual(['Step 0:completed', 'Phase 1:in_progress'])
  })
  test('TaskCreate adds with the id of its result, TaskUpdate changes or deletes', () => {
    let t = applyTool([], 'TaskCreate', { subject: 'A', description: 'd' }, { task: { id: '7', subject: 'A' } })
    t = applyTool(t, 'TaskCreate', { subject: 'B', description: 'd' }, { task: { id: '8', subject: 'B' } })
    t = applyTool(t, 'TaskUpdate', { taskId: '7', status: 'completed' }, { success: true })
    t = applyTool(t, 'TaskUpdate', { taskId: '8', status: 'in_progress' }, { success: true })
    expect(t.map(x => `${x.id}:${x.status}`)).toEqual(['7:completed', '8:in_progress'])
    expect(applyTool(t, 'TaskUpdate', { taskId: '8', status: 'deleted' }, { success: true }).map(x => x.id)).toEqual(['7'])
    expect(applyTool(t, 'TaskUpdate', { taskId: '8', status: 'completed' }, { success: false })).toEqual(t)
  })
})

describe('status of the work', () => {
  test('the band is one line in the agreed shape', () => {
    const s = six({ started_at: NOW - 50 * MIN, tool_now: { name: 'Bash', detail: 'Running mutants' }, alive_at: NOW })
    expect(bandLine(s, NOW)).toBe('📊 46% overall · ⏱ about 59 min left · ▶ Phase 2: api server · mutant 30/40')
  })
  test('the card says the item, the marker and what runs now', () => {
    const c = cardOf(six({ tool_now: { name: 'Bash', detail: 'Running mutants' }, alive_at: NOW }), NOW)
    expect(c.work).toBe('Phase 2: api server · mutant 30 of 40')
    expect(c.doing).toBe('Now: Running mutants')
  })
  test('the states: tests, mutants, building', () => {
    const at = (s: Status): RunState => stateOf(s, NOW)
    const tools = { alive_at: NOW, updated_at: NOW }
    expect(at(six({ ...tools, tasks: six().tasks.map(t => ({ ...t, mark: null })), tool_now: { name: 'Bash', detail: 'Run the pytest suite' } }))).toBe('testing')
    expect(at(six(tools))).toBe('mutation')
    expect(at(base({ ...tools, tool_now: { name: 'Edit', detail: 'a.ts' } }))).toBe('building')
  })
  test('title is the prompt id; with none the folder and branch, never a session id', () => {
    expect(titleOf(base())).toBe('MOD-3')
    expect(titleOf(base({ prompt_id: '—' }))).toBe('x · main')
    expect(titleOf(base({ prompt_id: 'd2aef7d2-e2ea-4d7a-9b27-67abcdef1234' }))).toBe('x · main')
  })
})

describe('finished and quiet', () => {
  test('the last item done: finished, took the whole time, 100%', () => {
    const done = settle(base({ started_at: NOW - 161 * MIN, tasks: [task(1, 'completed'), task(2, 'completed')] }), NOW)
    expect(done.finished?.verdict).toBe(ALL_DONE)
    expect(bandLine(done, NOW)).toBe('✅ Finished · took 2 h 41 min')
    expect(progressOf(done, NOW).pct).toBe(100)
  })
  test('a new item takes the finish back', () => {
    const done = settle(base({ tasks: [task(1, 'completed')] }), NOW)
    expect(settle({ ...done, tasks: [...done.tasks, task(2, 'pending')] }, NOW + MIN).finished).toBeNull()
  })
  test('a ▶ done line finishes with no to-do list', () => {
    const s = applyParsed(base({ started_at: NOW - 10 * MIN }), parseText('▶ done all green', NOW), NOW)
    expect(bandLine(s, NOW)).toBe('✅ Finished · 0 steps · took 10 min')
  })
  test('quiet after 10 minutes with nothing running; the percent stays', () => {
    const s = six({ updated_at: NOW - 12 * MIN, alive_at: NOW - 12 * MIN })
    expect(bandLine(s, NOW)).toBe('😴 Quiet for 12 min · 📊 46% overall')
    expect(cardOf(s, NOW).pct).toBe('46%')
  })
  test('a running tool with a fresh heartbeat is not quiet', () => {
    expect(stateOf(six({ updated_at: NOW - 30 * MIN, alive_at: NOW - 20_000, tool_now: { name: 'Bash', detail: '' } }), NOW)).not.toBe('quiet')
  })
  test('a stopped run says so', () => {
    expect(bandLine(base({ started_at: NOW - 5 * MIN, finished: { at: NOW, verdict: 'ended: error', ok: false } }), NOW)).toBe('❌ Stopped · after 5 min')
  })
})

describe('/builds text and history', () => {
  test('runLines are plain text with no command', () => {
    const lines = runLines(six({ tool_now: { name: 'Bash', detail: 'Running mutants' }, alive_at: NOW }), NOW)
    expect(lines[0]).toBe('🧬 MOD-3  46%')
    expect(lines.join('\n')).toContain('Phase 2: api server · mutant 30 of 40')
  })
  test('the history gives the first prompt, EXPECT, the to-do list, the markers and the running call', () => {
    const s = recover(
      base({ prompt_id: '—' }),
      [
        { role: 'user', text: 'MOD-3 · Builds\nMODEL: x EXPECT: 1 h' },
        { role: 'assistant', text: '', toolUses: [{ tool: 'TaskCreate', input: { subject: 'One', description: '' }, result: { task: { id: '1', subject: 'One' } } }, { tool: 'TaskCreate', input: { subject: 'Two', description: '' }, result: { task: { id: '2', subject: 'Two' } } }] },
        { role: 'assistant', text: '', toolUses: [{ tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: { success: true } }, { tool: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' }, result: { success: true } }] },
        { role: 'assistant', text: '▶ mutant 1/2', toolUses: [{ tool: 'Bash', input: {} }] },
      ],
      NOW,
    )
    expect(s.prompt_id).toBe('MOD-3')
    expect(s.expect_h).toBe(1)
    expect(progressOf(s, NOW).pct).toBe(75)
    expect(s.tool_now?.name).toBe('Bash')
  })
  test('a history that ends in the assistant\'s answer is Finished without minutes; an open call is working', () => {
    const rows = [{ role: 'user', text: 'MOD-3 · x' }, { role: 'assistant', text: 'All done.', toolUses: [] }]
    const s = recover(base({ prompt_id: '—' }), rows, NOW)
    expect(s.finished?.untimed).toBe(true)
    expect(bandLine(s, NOW)).toBe('✅ Finished · 0 steps')
    const open = recover(base({ prompt_id: '—' }), [...rows.slice(0, 1), { role: 'assistant', text: 'Running', toolUses: [{ tool: 'Bash', input: {} }] }], NOW)
    expect(open.finished).toBeNull()
    expect(open.tool_now?.name).toBe('Bash')
  })
  test('an unknown start says "at least" and gives no time left', () => {
    const s = base({ start_known: false, expect_h: 1 })
    // EXPECT with an unknown start gives no time left, and no checklist: the plain band, not the old phrases
    expect(bandLine(s, NOW)).not.toContain('time left not known yet')
    expect(bandLine(s, NOW)).toContain('running for at least 26 min')
    expect(runLines(s, NOW).join('\n')).toContain('running for at least 26 min')
  })
  test('a stop by the person reads Stopped by you', () => {
    const s = base({ finished: { at: NOW, verdict: 'stopped by you', ok: false } })
    expect(bandLine(s, NOW)).toBe('⏸ Stopped by you · after 26 min')
  })
  test('with no history the title stays the folder', () => {
    expect(titleOf(recover(base({ prompt_id: '—' }), [], NOW))).toBe('x · main')
  })
})

describe('look', () => {
  test('the little character exists for each state and says no "Need you"', () => {
    for (const st of ['building', 'testing', 'mutation', 'quiet', 'done', 'failed'] as const) {
      const svg = avatarSvg(st, '#1c7ed6')
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).not.toContain('Need you')
    }
  })
})

describe('folder labels', () => {
  const labels = parseFolderLabels('Work/project-a=main clone, Work/project-b=design clone')
  test('a set label replaces the folder name', () => {
    expect(folderName('/Users/tester/Work/project-a', labels)).toBe('main clone')
    expect(folderName('/Users/tester/Work/project-b/', labels)).toBe('design clone')
  })
  test('with no label a folder shows its last part', () => {
    expect(folderName('/Users/tester/Work/project-a', [])).toBe('project-a')
    expect(folderName('/Users/tester/Work/project-c', labels)).toBe('project-c')
    expect(parseFolderLabels('')).toEqual([])
    expect(parseFolderLabels('junk')).toEqual([])
  })
})

const shell = (over: Partial<Status> = {}, label = 'Run the full test matrix', ago = 23): Status =>
  startBg(base(over), { id: 'b1', toolUseId: 'tu1', kind: 'shell', label }, NOW - ago * MIN)

describe('ordinary sessions: no checklist, no markers, no EXPECT', () => {
  test('the band says what is happening and never the two old phrases', () => {
    let s = base({ tool_now: { name: 'Bash', detail: 'Run the unit tests' } })
    for (let i = 0; i < 34; i++) s = addStep(s, { name: 'Bash', detail: '', at: NOW })
    const line = bandLine(s, NOW)
    expect(line).toBe('🔨 Working · Now: Run the unit tests · 34 steps so far · running for 26 min')
    for (const t of [line, ...runLines(s, NOW), JSON.stringify(cardOf(s, NOW))]) {
      expect(t).not.toContain('% not reported')
      expect(t).not.toContain('time left not known yet')
    }
  })
  test('between tools it says Thinking; an unknown start says at least', () => {
    const s = base({ start_known: false })
    expect(bandLine(s, NOW)).toBe('🔨 Working · Now: Thinking · 0 steps so far · running for at least 26 min')
  })
  test('finished: steps and minutes', () => {
    let s = base({ start_known: false, finished: { at: NOW, verdict: 'turn ended', ok: true } })
    for (let i = 0; i < 34; i++) s = addStep(s, { name: 'Read', detail: 'a.ts', at: NOW })
    expect(bandLine(s, NOW)).toBe('✅ Finished · 34 steps · took at least 26 min')
  })
  test('steps are counted from the history, and the last 5 keep name and description only', () => {
    const uses = Array.from({ length: 7 }, (_, i) => ({ tool: 'Bash', input: { command: 'echo sk-live-AbCdEf1234567890XyZ', description: `Step ${i + 1}` } }))
    const s = recover(base(), [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'ok', toolUses: uses }], NOW)
    expect(s.steps).toBe(7)
    expect(stepLines(s)).toEqual(['Bash · Step 3', 'Bash · Step 4', 'Bash · Step 5', 'Bash · Step 6', 'Bash · Step 7'])
    expect(JSON.stringify(s)).not.toContain('sk-live')
  })
  test('a checklist still shows its percent and no steps line', () => {
    expect(bandLine(six(), NOW)).toContain('46%')
    expect(cardOf(six(), NOW).plain).toBe(false)
  })
})

describe('background tasks', () => {
  test('one running: listed with its description, counted in the band', () => {
    const s = shell({ tool_now: { name: 'Bash', detail: 'Run the unit tests' } })
    expect(bgLines(s, NOW).running).toEqual(['⌨️ Run the full test matrix · no % reported · running for 23 min'])
    expect(bandLine(s, NOW)).toMatch(/^🔨 Working · Now: Run the unit tests.* · 🔄 1 in background: Run the full test matrix$/)
  })
  test('the count sits in front of a checklist line too', () => {
    const s = startBg(startBg(six(), { id: 'a', toolUseId: '', kind: 'agent', label: 'A' }, NOW), { id: 'b', toolUseId: '', kind: 'monitor', label: 'B' }, NOW)
    expect(bandLine(s, NOW).startsWith('📊 46% overall')).toBe(true)
    expect(bandLine(s, NOW).endsWith('🔄 2 in background')).toBe(true)
  })
  test('the band is two lines: the main run, then the background tasks; one line when none runs', () => {
    const s = startBg(startBg(six(), { id: 'a', toolUseId: '', kind: 'agent', label: 'A' }, NOW), { id: 'b', toolUseId: '', kind: 'monitor', label: 'B' }, NOW)
    const [main, back, ...rest] = bandLines(s, NOW)
    expect(main?.startsWith('📊 46% overall')).toBe(true)
    expect(main).not.toContain('🔄')
    expect(back).toBe('🔄 2 in background')
    expect(rest).toEqual([])
    expect(bandLines(six(), NOW)).toHaveLength(1)
    expect(bandLines(shell({ finished: { at: NOW - 20 * MIN, verdict: 'turn ended', ok: true } }), NOW)).toEqual(['⏳ Waiting on 1 background task', '🔄 Run the full test matrix'])
  })
  test('finished ones move to the done list for 10 minutes, then go', () => {
    const s = endBg(shell(), { id: 'b1' }, 'completed', NOW - 5 * MIN)
    expect(bgLines(s, NOW).done).toEqual(['✅ Run the full test matrix · took 18 min'])
    expect(bgLines(s, NOW).running).toEqual([])
    expect(bgLines(s, NOW + 6 * MIN).done).toEqual([])
    const bad = endBg(shell({}, 'Deploy', 4), { toolUseId: 'tu1' }, 'failed', NOW - MIN)
    expect(bgLines(bad, NOW).done).toEqual(['❌ Deploy · failed after 3 min'])
  })
  test('turn over with one running is Waiting, never Finished; the last end finishes', () => {
    const over = shell({ finished: { at: NOW - 20 * MIN, verdict: 'turn ended', ok: true } })
    expect(bandLine(over, NOW)).toBe('⏳ Waiting on 1 background task · 🔄 Run the full test matrix')
    expect(waitLine(startBg(over, { id: 'b2', toolUseId: '', kind: 'agent', label: 'x' }, NOW), NOW)).toContain('Waiting on 2 background tasks')
    const ended = endBg(over, { id: 'b1' }, 'completed', NOW)
    expect(waitLine(ended, NOW)).toBeNull()
    expect(bandLine(ended, NOW)).toMatch(/^✅ Finished · 0 steps · took 26 min$/)
  })
  test('no completion row for 2 hours: "no news", no longer counted as running', () => {
    const s = shell({}, 'Old job', 121)
    expect(bgLines(s, NOW).running).toEqual(['❔ Old job · no news for 2 h'])
    expect(bandLine(s, NOW)).not.toContain('in background')
  })
  test('a notification names its task and status; one without an end status names none', () => {
    expect(parseNotice('<task-notification><task-id>b1</task-id><tool-use-id>tu1</tool-use-id><status>completed</status><summary>x</summary></task-notification>')).toEqual({ id: 'b1', toolUseId: 'tu1', status: 'completed', isEnd: true })
    expect(parseNotice('<task-notification><task-id>m1</task-id><status>running</status></task-notification>')?.isEnd).toBe(false)
    expect(parseNotice('nothing here')).toBeNull()
  })
  test('a reload rebuilds from the history: an open background call runs, a finished one is gone', () => {
    const rows = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 'tu1', input: { description: 'Long build', run_in_background: true, command: 'make SECRET=hunter2hunter2' }, result: { backgroundTaskId: 'b1' } }, { tool: 'Bash', tool_use_id: 'tu2', input: { description: 'Quick job', run_in_background: true }, result: { backgroundTaskId: 'b2' } }] },
      { role: 'user', text: '<task-notification><task-id>b2</task-id><status>completed</status></task-notification>' },
      { role: 'assistant', text: 'Waiting for the build.', toolUses: [] },
    ]
    const s = recover(base(), rows, NOW)
    expect(s.bg.map(b => b.label)).toEqual(['Long build'])
    expect(bandLine(s, NOW)).toMatch(/^⏳ Waiting on 1 background task/)
    expect(JSON.stringify(s)).not.toContain('hunter2')
  })
  test('the file keeps labels, never commands', () => {
    const s = recover(base(), [{ role: 'user', text: 'go' }, { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 't', input: { command: 'curl -H "Authorization: Bearer abc123abc123abc123abc123abc123abc123"', run_in_background: true }, result: { backgroundTaskId: 'b' } }] }], NOW)
    expect(JSON.stringify(s)).not.toContain('abc123')
    expect(s.bg[0]?.label).toBe('Background command')
  })
})

describe('a checklist is always shown, and the time left when the start is unknown', () => {
  const planned = (over: Partial<Status> = {}): Status => six({ start_known: false, ...over })
  test('the % shows with an unknown start, and the plain Working form is not used', () => {
    const line = bandLine(planned(), NOW)
    expect(line).toContain('46%')
    expect(line).not.toContain('Working')
    expect(line).not.toContain('time left not known yet')
  })
  test('unknown start, no EXPECT, nothing watched: no time-left phrase at all', () => {
    expect(bandLine(planned(), NOW)).toBe('📊 46% overall · ▶ Phase 2: api server · mutant 30/40')
  })
  test('unknown start with EXPECT: "at most", from the at-least elapsed', () => {
    expect(bandLine(planned({ expect_h: 1 }), NOW)).toContain('⏱ at most 34 min left')
    expect(cardOf(planned({ expect_h: 1 }), NOW).left).toBe('at most 34 min left (from the estimate)')
  })
  test('watched under 10 minutes: not yet a speed', () => {
    const s = planned({ watch: { at: NOW - 9 * MIN, frac: 0.2 } })
    expect(cardOf(s, NOW).left).not.toContain('from the last')
  })
  test('watched 12 min and the % moved from 20% to ~46%: about N min left from the last 12 min', () => {
    const s = planned({ watch: { at: NOW - 12 * MIN, frac: 0.2 } })
    const frac = 2.75 / 6
    const left = ((1 - frac) / ((frac - 0.2) / 12))
    expect(bandLine(s, NOW)).toContain(`⏱ about ${Math.round(left)} min left`)
    expect(cardOf(s, NOW).left).toContain(`about ${Math.round(left)} min left (from the last 12 min)`)
  })
  test('watched 15 min but the % has not moved: no speed', () => {
    const s = planned({ watch: { at: NOW - 15 * MIN, frac: 2.75 / 6 } })
    expect(cardOf(s, NOW).left).not.toContain('from the last')
  })
  test('the speed is only for an unknown start: a known one keeps elapsed × (100 − %) ÷ %', () => {
    expect(bandLine(six({ watch: { at: NOW - 12 * MIN, frac: 0.2 } }), NOW)).toContain('about 31 min left')
  })
  test('the baseline is the first share seen, rebased when the share falls', () => {
    const a = watchOf(six(), NOW)
    expect(Math.abs((a.watch?.frac ?? 0) - 2.75 / 6)).toBeLessThan(1e-9)
    expect(watchOf(a, NOW + MIN)).toBe(a)
    const grown = watchOf({ ...a, tasks: [...a.tasks, task(7, 'pending'), task(8, 'pending')] }, NOW + 2 * MIN)
    expect(grown.watch?.at).toBe(NOW + 2 * MIN)
    expect(watchOf(base(), NOW).watch).toBeNull()
  })
  test('the app\'s update_plan list is a checklist: items, advance, done, start', () => {
    expect(isPlanTool('mcp__ccd_turn__update_plan')).toBe(true)
    expect(isPlanTool('update_plan')).toBe(true)
    expect(isPlanTool('TodoWrite')).toBe(false)
    let t = applyPlan([], { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] })
    expect(t.map(x => x.status)).toEqual(['in_progress', 'pending', 'pending'])
    t = applyPlan(t, { advance: true })
    expect(t.map(x => x.status)).toEqual(['completed', 'in_progress', 'pending'])
    t = applyPlan(t, { done: [2], start: 3 })
    expect(t.map(x => x.status)).toEqual(['completed', 'completed', 'in_progress'])
  })
  test('a reload recovers the update_plan list from history, with the % shown and a started-unknown start', () => {
    const rows = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolUses: [{ tool: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } }] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'mcp__ccd_turn__update_plan', input: { advance: true } }] },
    ]
    const s = recover(base({ start_known: false }), rows, NOW)
    expect(s.tasks.map(t => t.status)).toEqual(['completed', 'in_progress'])
    expect(bandLine(s, NOW)).toContain('50%')
  })
  test('with 8 background tasks and a checklist the band shows both', () => {
    let s = planned()
    for (let i = 0; i < 8; i++) s = startBg(s, { id: `b${i}`, toolUseId: '', kind: 'shell', label: 'x' }, NOW)
    expect(bandLine(s, NOW).startsWith('📊 46% overall')).toBe(true)
    expect(bandLine(s, NOW).endsWith('🔄 8 in background')).toBe(true)
  })
})

describe('reading a notification', () => {
  const env = (inner: string) => `<task-notification>${inner}</task-notification>`
  test('matches by task id, by tool-use id, or a task-id that is the call id', () => {
    const s = startBg(startBg(base(), { id: 'b1', toolUseId: 'tu1', kind: 'shell', label: 'One' }, NOW), { id: 'tu2', toolUseId: 'tu2', kind: 'shell', label: 'Two' }, NOW)
    const a = noticeBg(s, parseNotice(env('<task-id>b1</task-id><status>completed</status>'))!, NOW)
    const b = noticeBg(a.status, parseNotice(env('<tool-use-id>tu2</tool-use-id><status>failed</status>'))!, NOW)
    const c = noticeBg(startBg(base(), { id: 'tu9', toolUseId: 'tu9', kind: 'shell', label: 'Three' }, NOW), parseNotice(env('<task-id>tu9</task-id><status>killed</status>'))!, NOW)
    expect(a.status.bg.map(x => x.ended_at !== null)).toEqual([true, false])
    expect(b.status.bg.map(x => x.ended_at !== null)).toEqual([true, true])
    expect(c.status.bg[0]?.end).toBe('killed')
  })
  test('tags with spaces and line breaks around the values, and extra tags, still read', () => {
    const n = parseNotice(env('\n  <task-id>\n b7 \n</task-id>\n  <output-file>/x/y</output-file>\n  <status> completed </status>\n  <summary>Background command "x" completed (exit code 0)</summary>\n'))
    expect(n).toEqual({ id: 'b7', status: 'completed', isEnd: true })
  })
  test('a progress notice does not end the task but is remembered for /builds-tasks', () => {
    const s = startBg(base(), { id: 'm1', toolUseId: '', kind: 'monitor', label: 'Watch' }, NOW)
    const r = noticeBg(s, parseNotice(env('<task-id>m1</task-id><status>running</status>'))!, NOW)
    expect(r.status.bg[0]?.ended_at).toBeNull()
    expect(bgReport(r.status, [], NOW)).toContain('last notice: m1 running')
  })
  test('an unknown task id is reported as unknown', () => {
    expect(noticeBg(base(), parseNotice(env('<task-id>zz</task-id><status>completed</status>'))!, NOW).isKnown).toBe(false)
  })
})

describe('0.5.0: reading the run\'s own status line', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 28, h, m, 0, 0).getTime()
  test('every time-left form is read', () => {
    expect(parseLeft('56% · ~288 min left', NOW)).toBe(288)
    expect(parseLeft('288 min left', NOW)).toBe(288)
    expect(parseLeft('about 288 min left', NOW)).toBe(288)
    expect(parseLeft('4 h 48 min left', NOW)).toBe(288)
    expect(parseLeft('4h48m left', NOW)).toBe(288)
    expect(parseLeft('2 h left', NOW)).toBe(120)
    expect(parseLeft('nothing here', NOW)).toBeNull()
  })
  test('ETA 17:45 becomes minutes from now, the next time it is that', () => {
    expect(parseLeft('ETA 17:45', at(15, 0))).toBe(165)
    expect(parseLeft('ETA 09:00', at(15, 0))).toBe(18 * 60)
  })
  test('a status line gives its % and end time; an ordinary line with a % is not one', () => {
    const r = parseReport('12:51 · P5 waiting · 56% · ~288 min left', NOW)
    expect(r).toEqual({ at: NOW, pct: 56, eta_at: NOW + 288 * MIN })
    expect(parseReport('12:51 · P5 waiting · 56%', NOW)?.pct).toBe(56)
    expect(parseReport('coverage went up 3% today', NOW)).toBeNull()
    expect(parseReport('first\n10% · 20 min left\nlater\n40% · 9 min left', NOW)?.pct).toBe(40)
  })
  test('the run\'s end time is used while the line is under 15 minutes old, then the estimate', () => {
    const s = six({ report: { at: NOW - 2 * MIN, pct: null, eta_at: NOW - 2 * MIN + 288 * MIN }, expect_h: 4 })
    expect(Math.round((progressOf(s, NOW).left) ?? -1)).toBe(286)
    expect(cardOf(s, NOW).left).toBe('about 4 h 46 min left (from the run)')
    expect(bandLine(s, NOW)).toContain('⏱ about 4 h 46 min left')
    const old = six({ report: { at: NOW - 16 * MIN, pct: null, eta_at: NOW + 100 * MIN }, expect_h: 4, started_at: NOW - 50 * MIN })
    expect(cardOf(old, NOW).left).not.toContain('from the run')
  })
  test('the newer of the checklist and the status line gives the %', () => {
    const newerLine = six({ tasks_at: NOW - 5 * MIN, report: { at: NOW - MIN, pct: 56, eta_at: null } })
    expect(progressOf(newerLine, NOW).pct).toBe(56)
    const newerList = six({ tasks_at: NOW, report: { at: NOW - MIN, pct: 56, eta_at: null } })
    expect(progressOf(newerList, NOW).pct).toBe(46)
  })
  test('a status line in the run\'s text lands in the status', () => {
    const s = applyParsed(base(), parseText('12:51 · P5 waiting · 56% · ~288 min left', NOW), NOW)
    expect(s.report).toEqual({ at: NOW, pct: 56, eta_at: NOW + 288 * MIN })
  })
})

describe('0.5.0: background progress', () => {
  const two = (a: Partial<Bg>, b: Partial<Bg>, over: Partial<Status> = {}): Status => {
    let s = startBg(startBg(base(over), { id: 'x1', toolUseId: '', kind: 'shell', label: 'Alpha' }, NOW - 20 * MIN), { id: 'x2', toolUseId: '', kind: 'agent', label: 'Beta' }, NOW - 10 * MIN)
    s = { ...s, bg: s.bg.map(t => (t.id === 'x1' ? { ...t, ...a } : { ...t, ...b })) }

    return s
  }
  test('the output\'s last lines give a % and an end time; nothing of the text comes back', () => {
    const out = scanProgress('compiling secret-token-abc\n▶ step 3/4\nbuilding 40% done\n12 min left\n', NOW)
    expect(out).toEqual({ pct: 40, eta_at: NOW + 12 * MIN })
    expect(scanProgress('▶ step 1/2\n▶ step 2/2\n', NOW).pct).toBe(100)
    expect(scanProgress('nothing\n', NOW)).toEqual({ pct: null, eta_at: null })
    expect(JSON.stringify(scanProgress('password=hunter2 ▶ x 1/2', NOW))).not.toContain('hunter2')
  })
  test('an agent\'s output file is JSON lines: escaped line breaks are read as lines', () => {
    expect(scanProgress('{"text":"a\\n▶ page 3/6\\nb"}', NOW).pct).toBe(50)
  })
  test('setBgProgress keeps what was known and never touches an ended task', () => {
    const s = two({}, {})
    const a = setBgProgress(s, 'x1', { pct: 30, eta_at: null }, NOW)
    expect(a.bg[0]?.pct).toBe(30)
    expect(setBgProgress(a, 'x1', { pct: null, eta_at: NOW + 5 * MIN }, NOW).bg[0]).toMatchObject({ pct: 30, eta_at: NOW + 5 * MIN })
    const done = endBg(a, { id: 'x1' }, 'completed', NOW)
    expect(setBgProgress(done, 'x1', { pct: 90, eta_at: null }, NOW).bg[0]?.pct).toBe(30)
  })
  test('a task\'s time left: its own line first, else its pace after 2 minutes, else none', () => {
    const s = two({ pct: 50, eta_at: NOW + 7 * MIN }, { pct: 25 })
    expect(bgLeft(s.bg[0] as Bg, NOW)).toEqual({ min: 7, source: 'own' })
    // 10 minutes in at 25%: 10 × 75 / 25 = 30
    expect(bgLeft(s.bg[1] as Bg, NOW)).toEqual({ min: 30, source: 'pace' })
    expect(bgLeft({ ...(s.bg[1] as Bg), pct: null }, NOW)).toBeNull()
    expect(bgLeft({ ...(s.bg[1] as Bg), started_at: NOW - MIN }, NOW)).toBeNull()
  })
  test('the panel row: icon, name, %, running for, time left; or "no % reported"', () => {
    const s = two({ pct: 40, eta_at: NOW + 12 * MIN }, {})
    expect(bgLines(s, NOW).running).toEqual([
      '⌨️ Alpha · 40% ▰▰▰▱▱▱▱▱ · running for 20 min · about 12 min left (from its own line)',
      '🤖 Beta · no % reported · running for 10 min',
    ])
  })
  test('the band: one task shows its name; several show their % and time, cut after three', () => {
    const one = startBg(six(), { id: 'w', toolUseId: '', kind: 'shell', label: 'Watch sibling summaries' }, NOW - 5 * MIN)
    const withPct = { ...one, bg: one.bg.map(b => ({ ...b, pct: 40, eta_at: NOW + 12 * MIN })) }
    expect(bandLine(withPct, NOW)).toBe('📊 46% overall · ⏱ about 31 min left · ▶ Phase 2: api server · mutant 30/40 · 🔄 1 in background: Watch sibling summaries 40%, ~12 min')
    const three = two({ pct: 40, eta_at: NOW + 12 * MIN }, { pct: 75, eta_at: NOW + 3 * MIN }, { tasks: [] })
    expect(bgBand(three, NOW)).toBe('🔄 2 in background (2 with %): 40% ~12 min, 75% ~3 min')
    let many = three
    for (const i of [3, 4, 5]) many = startBg(many, { id: `m${i}`, toolUseId: '', kind: 'shell', label: `M${i}` }, NOW - 5 * MIN)
    many = { ...many, bg: many.bg.map(b => (b.id.startsWith('m') ? { ...b, pct: 10, eta_at: NOW + 60 * MIN } : b)) }
    expect(bgBand(many, NOW)).toBe('🔄 5 in background (5 with %): 40% ~12 min, 75% ~3 min, 10% ~1 h, …')
  })
})

describe('0.5.0: overall', () => {
  const withBg = (over: Partial<Status>, bgs: Array<Partial<Bg>>): Status => {
    let s = base(over)
    bgs.forEach((b, i) => {
      s = startBg(s, { id: `t${i}`, toolUseId: '', kind: 'shell', label: `T${i}` }, NOW - 10 * MIN)
      s = { ...s, bg: s.bg.map(x => (x.id === `t${i}` ? { ...x, ...b } : x)) }
    })

    return s
  }
  const main = (left: number): Partial<Status> => ({ report: { at: NOW, pct: null, eta_at: NOW + left * MIN }, tasks: six().tasks })
  test('time left overall is the longest of the main run and every running task', () => {
    const s = withBg(main(30), [{ eta_at: NOW + 90 * MIN }, { eta_at: NOW + 20 * MIN }])
    expect(Math.round((overallOf(s, NOW).left) ?? -1)).toBe(90)
    const longMain = withBg(main(288), [{ eta_at: NOW + 20 * MIN }])
    expect(Math.round((overallOf(longMain, NOW).left) ?? -1)).toBe(288)
    expect(overallLeftText(overallOf(longMain, NOW))).toBe('about 4 h 48 min left overall')
  })
  test('a running task with no estimate is said so', () => {
    const s = withBg(main(288), [{ eta_at: NOW + 20 * MIN }, {}])
    expect(overallLeftText(overallOf(s, NOW))).toBe('about 4 h 48 min left overall (1 background task with no estimate)')
    expect(bandLine(s, NOW)).toContain('⏱ about 4 h 48 min left (1 background task with no estimate)')
  })
  test('while the main run works its % is the overall %; never 100 while anything runs', () => {
    const s = withBg({ tasks: [task(1, 'completed')] }, [{}])
    expect(progressOf(s, NOW).pct).toBe(100)
    expect(overallOf(s, NOW).pct).toBe(99)
    expect(overallOf(base({ tasks: [task(1, 'completed')] }), NOW).pct).toBe(100)
    expect(overallOf(withBg({ tasks: six().tasks }, [{ pct: 90 }]), NOW).pct).toBe(46)
  })
  test('once the main run is over the overall % is the average of the tasks that report one', () => {
    const over = { finished: { at: NOW - MIN, verdict: 'turn ended', ok: true } }
    const s = withBg(over, [{ pct: 40 }, { pct: 75 }, {}])
    expect(overallOf(s, NOW).pct).toBe(58)
    expect(overallOf(withBg(over, [{}]), NOW).pct).toBeNull()
    expect(overallOf(withBg(over, [{ pct: 100 }]), NOW).pct).toBe(99)
    expect(bandLine(s, NOW)).toMatch(/^⏳ Waiting on 3 background tasks · 📊 58% overall/)
  })
  test('the card carries the overall block and the main run\'s own time left', () => {
    const c = cardOf(withBg(main(288), [{ eta_at: NOW + 20 * MIN }]), NOW)
    expect(c.overall.left).toBe('about 4 h 48 min left overall')
    expect(c.overall.pct).toBe(46)
    expect(c.mainLeft).toBe('about 4 h 48 min left (from the run)')
  })
})

describe('0.5.0: what the transcript says', () => {
  // `grep -noE` over this session's transcript: `row:match`. Shapes copied from a real session; the text of every row is gone.
  const grep = [
    '97:"timestamp":"2026-10-28T07:37:00.100Z"',
    '97:"backgroundTaskId":"bsh1"',
    '98:"timestamp":"2026-10-28T07:37:01.200Z"',
    '98:"status":"async_launched","agentId":"aag1"',
    '128:"timestamp":"2026-10-28T07:39:30.000Z"',
    '128:<task-id>aag1</task-id>',
    '128:<status>completed</status>',
    '133:"timestamp":"2026-10-28T07:39:31.000Z"',
    '133:<task-id>aag1</task-id>',
    '133:<status>completed</status>',
    '138:<task-id>aag1</task-id>',
    '138:<status>completed</status>',
    '152:"timestamp":"2026-10-28T07:41:50.500Z"',
    '152:<task-id>bsh1</task-id>',
    '152:<status>completed</status>',
    '160:<task-id>zz</task-id>',
    '160:<status>running</status>',
    '170:"customTitle":"GQ3B form losing areas"',
    '175:"customTitle":"GQ3B form \\"losing\\" areas"',
  ].join('\n')
  test('starts, ends, times and the name are read; blob rows without a time and non-end statuses are ignored', () => {
    const h = parseHist(grep)
    expect(h.starts).toEqual({ bsh1: Date.parse('2026-10-28T07:37:00.100Z'), aag1: Date.parse('2026-10-28T07:37:01.200Z') })
    expect(h.ends).toEqual({ aag1: { at: Date.parse('2026-10-28T07:39:30.000Z'), status: 'completed' }, bsh1: { at: Date.parse('2026-10-28T07:41:50.500Z'), status: 'completed' } })
    expect(h.title).toBe('GQ3B form "losing" areas')
  })
  test('each task gets its own start, and an end the live hook missed', () => {
    const h = parseHist(grep)
    let s = startBg(startBg(base(), { id: 'bsh1', toolUseId: '', kind: 'shell', label: 'Sample' }, NOW), { id: 'aag1', toolUseId: '', kind: 'agent', label: 'Agent' }, NOW)
    s = startBg(s, { id: 'still', toolUseId: '', kind: 'shell', label: 'Still' }, NOW)
    const out = applyHist(s, h, NOW)
    expect(out.bg.find(b => b.id === 'bsh1')).toMatchObject({ started_at: Date.parse('2026-10-28T07:37:00.100Z'), ended_at: Date.parse('2026-10-28T07:41:50.500Z'), ok: true, end: 'completed', seen: 'completed' })
    expect(out.bg.find(b => b.id === 'still')).toMatchObject({ started_at: NOW, ended_at: null })
    expect(out.title).toBe('GQ3B form "losing" areas')
    expect(titleOf(out)).toBe('GQ3B form "losing" areas')
  })
  test('a reload: the task starts at its own time, not at the reload; one that ended long ago is gone, a recent end is kept', () => {
    const t0 = Date.parse('2026-10-28T07:37:00.100Z')
    const rows = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 'tu1', input: { description: 'Sample', run_in_background: true }, result: { backgroundTaskId: 'bsh1' } }] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 'tu2', input: { description: 'Other', run_in_background: true }, result: { backgroundTaskId: 'bsh2' } }] },
    ]
    const h = parseHist(`${grep}\n200:"timestamp":"2026-10-28T07:00:00.000Z"\n200:"backgroundTaskId":"bsh2"`)
    const recent = recover(base(), rows, t0 + 5 * MIN, h)
    expect(recent.bg.map(b => [b.id, b.started_at < t0 + MIN, b.ended_at !== null])).toEqual([['bsh1', true, true], ['bsh2', true, false]])
    expect(bgDone(recent, t0 + 5 * MIN).map(b => b.id)).toEqual(['bsh1'])
    const later = recover(base(), rows, t0 + 60 * MIN, h)
    expect(later.bg.map(b => b.id)).toEqual(['bsh2'])
    expect(later.bg[0]?.started_at).toBe(Date.parse('2026-10-28T07:00:00.000Z'))
  })
  test('/builds-tasks shows the matched end', () => {
    const s = applyHist(startBg(base(), { id: 'bsh1', toolUseId: '', kind: 'shell', label: 'Sample' }, NOW), parseHist(grep), NOW)
    expect(bgReport(s, [], NOW)).toMatch(/ended \d\d:\d\d \(completed\) · last notice: bsh1 completed/)
  })
  test('the status file keeps the new fields', () => {
    const s = { ...startBg(base(), { id: 'a', toolUseId: '', kind: 'shell', label: 'A' }, NOW), report: { at: NOW, pct: 5, eta_at: NOW + MIN }, title: 'T' }
    const back = normalize(JSON.parse(JSON.stringify({ ...s, bg: s.bg.map(b => ({ ...b, pct: 20, eta_at: NOW + MIN, prog_at: NOW })) })))
    expect(back?.title).toBe('T')
    expect(back?.report).toEqual({ at: NOW, pct: 5, eta_at: NOW + MIN })
    expect(back?.bg[0]).toMatchObject({ pct: 20, eta_at: NOW + MIN })
  })
})
