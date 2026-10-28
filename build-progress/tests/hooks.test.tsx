import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/Users/tester'
const DIR = `${HOME}/.claude/build-progress`

type Rig = { ask: boolean; results: Record<string, unknown>; history: unknown[]; launch: number; files: Map<string, string>; toasts: string[]; sounds: string[]; snaps: string[]; opened: string[]; writes: number; settle: boolean; hold: number; clock: ReturnType<typeof mock.clock> }
type On = Parameters<typeof mock.session>[0]

const rig = (on: On, sid = 's1'): Rig => {
  const files = new Map<string, string>()
  const toasts: string[] = []
  const sounds: string[] = []
  const snaps: string[] = []
  const r = { ask: false, results: {} as Record<string, unknown>, history: [] as unknown[], launch: 0, files, toasts, sounds, snaps, opened: [] as string[], writes: 0, settle: true, hold: 0, clock: undefined as never } as Rig
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: `${HOME}/Work/claude-mods` }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    r.writes += 1

    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: e.path === '/private/tmp' ? [{ name: 'claude-501', kind: 'directory' as const, size: 0, mtimeMs: 0, isLink: false }] : [...files.entries()]
      .filter(([p]) => p.startsWith(DIR))
      .map(([p, t]) => ({ name: p.slice(DIR.length + 1), kind: 'file' as const, size: t.length, mtimeMs: clock.now(), isLink: false })),
  }))
  on('command.register', () => ({ value: { command: 'builds' } }))
  on('ui.open', (_, e) => {
    r.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('audio.play', (_, e) => {
    sounds.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', async (_, e) => {
    if (r.settle) await clock.advance(2500)
    if (r.hold) await clock.advance(r.hold)
    snaps.push([...files.values()].join('\n'))

    return { result: r.results[e.tool] ?? {} }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.check', () => ({ decision: (r.ask ? 'ask' : 'allow') as 'ask' | 'allow' }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: sid }) as never)

  on('session.messages', () => ({ value: r.history as never }))
  on('session.usage', () => ({ value: { startedAt: r.launch || clock.now() } as never }))
  r.clock = clock

  return r
}

const mine = (r: Rig, sid = 's1') => JSON.parse(r.files.get(`${DIR}/${sid}.json`) ?? '{}')

test('a Bash call writes its description, never its command', async ($, on) => {
  const r = rig(on)
  await $.session.start({ cwd: `${HOME}/Work/claude-mods`, surface: 'desktop', isInteractive: true })
  await r.clock.advance(2500)
  await $.tool.call({ tool: 'Bash', command: 'echo sk-live-AbCdEf1234567890XyZ', description: 'Print a greeting' })
  await r.clock.advance(2500)
  const all = [...r.files.values()].join('\n') + r.snaps.join('\n')
  expect(r.snaps.join('')).toContain('Print a greeting')
  expect(all).not.toContain('sk-live')
  expect(all).not.toContain('echo')
  expect(mine(r).folder).toBe('~/Work/claude-mods')
})

test('a subagent appears on start and disappears on finish', async ($, on) => {
  const r = rig(on)
  await $.session.start({ cwd: `${HOME}/Work/claude-mods`, surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Look around', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } } as never)
  await r.clock.advance(2500)
  expect(mine(r).subagents.map((s: { description: string }) => s.description)).toEqual(['Look around'])
  await $.turn.complete({ turnId: 'x', reason: 'answer', agentId: 'agent-1', text: 'ok' } as never)
  await r.clock.advance(2500)
  expect(mine(r).subagents).toEqual([])
})

test('writes are at most one in two seconds', async ($, on) => {
  const r = rig(on)
  await $.session.start({ cwd: `${HOME}/Work/claude-mods`, surface: 'desktop', isInteractive: true })
  r.settle = false
  const before = r.writes
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Edit', file_path: `/x/f${i}.ts`, old_string: 'a', new_string: 'b' })
  expect(r.writes - before).toBeLessThanOrEqual(1)
  await r.clock.advance(2500)
  expect(mine(r).tool_now).toBeNull()
})

const paneProps = { title: 'Builds', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

const other = (session: string, id: string, now: number) =>
  JSON.stringify({ v: 2, session, folder: '~/Work/' + id, branch: 'main', started_at: now - 3_600_000, updated_at: now, alive_at: now, prompt_id: id, role: null, expect_h: null, phase: { n: 1, N: 2 }, other: null, markers: [], tasks: [], tool_now: null, tool_since: null, subagents: [{ id: 'z', description: 'OTHER-HELPER', started_at: now }], finished: null })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal') =>
  $.ui.mount({ plugin: 'build-progress', surface, component: 'Pane', requestId: 'builds', props: paneProps })

const texts = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<string> => {
  const found = await ui.findAll({ type: 'Text' })
  return found.map((f: { text?: string }) => f.text ?? '').join('\n')
}

const START = { cwd: `${HOME}/Work/claude-mods`, surface: 'desktop', isInteractive: true } as const

test('only this session is drawn, even with four status files present', async ($, on) => {
  const r = rig(on)
  const now = r.clock.now()
  for (const [sid, id] of [['a', 'MOD-2'], ['b', 'DEMO-1b1'], ['c', '10-claude-shadow'], ['d', 'DEMO-1']]) r.files.set(`${DIR}/${sid}.json`, other(sid!, id!, now))
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-3 · mine\nEXPECT: 2 h' } as never)
  await r.clock.advance(5100)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await mountPane($, surface)
    const all = await texts(ui)
    expect(all).toContain('MOD-3')
    for (const n of ['MOD-2', 'DEMO-1b1', '10-claude-shadow', 'DEMO-1', 'OTHER-HELPER']) expect(all).not.toContain(n)
    const band = await $.ui.mount({ plugin: 'build-progress', surface, component: 'AbovePrompt', props: { hasSurvey: false } as never })
    expect(JSON.stringify(await band.findAll({ type: 'Text' }))).not.toContain('DEMO-1b')
    await band.unmount()
    await ui.unmount()
  }
})

test('/builds still lists every session as plain text', async ($, on) => {
  const r = rig(on)
  const now = r.clock.now()
  r.files.set(`${DIR}/a.json`, other('a', 'MOD-2', now))
  r.files.set(`${DIR}/b.json`, other('b', 'DEMO-1b1', now))
  await $.session.start(START)
  const out = await $.command.run({ command: 'builds', args: '' } as never)
  expect(JSON.stringify(out)).toContain('MOD-2')
  expect(JSON.stringify(out)).toContain('DEMO-1b1')
})

test('the to-do list comes from TaskCreate and TaskUpdate calls: 46% with 2 of 6 done and the third at ▶ mutant 30/40', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-3\nEXPECT: 1 h' } as never)
  for (let i = 1; i <= 6; i++) {
    r.results.TaskCreate = { task: { id: String(i), subject: `Item ${i}` } }
    await $.tool.call({ tool: 'TaskCreate', subject: `Item ${i}`, description: 'd' })
  }
  r.results.TaskUpdate = { success: true }
  for (const id of ['1', '2']) await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' })
  await $.session.append({ door: 'response', message: { type: 'assistant', content: [{ type: 'text', text: '▶ mutant 30/40' }] } } as never)
  await r.clock.advance(2500)
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toContain('46%')
  expect(all).toContain('✅ Item 1')
  expect(all).toContain('▶ Item 3')
  expect(all).toContain('○ Item 4')
  expect(all).toContain('Item 3 · mutant 30 of 40')
  expect(all).toContain('min left')
  await ui.unmount()
})

test('elapsed counts from the first prompt, not from when the mod loaded', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await r.clock.advance(20 * 60_000)
  await $.prompt.submit({ text: '# MOD-3\nEXPECT: 1 h' } as never)
  await r.clock.advance(6 * 60_000 + 500)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('running for 6 min')
  await ui.unmount()
})

test('a session that loads the mod mid-way reads its first prompt, EXPECT and to-do list from its history', async ($, on) => {
  const r = rig(on)
  r.launch = r.clock.now() - 40 * 60_000
  r.history = [
    { role: 'user', text: 'MOD-3 · Builds\nMODEL: x EXPECT: 4 h', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'TodoWrite', input: { todos: [{ content: 'One', status: 'completed', activeForm: 'a' }, { content: 'Two', status: 'in_progress', activeForm: 'b' }] }, result: {} }] },
  ]
  await $.session.start(START)
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toContain('50%')
  expect(all).toContain('running for at least 40 min')
  expect(all).toContain('at most 3 h 20 min left (from the estimate)')
  await ui.unmount()
})

test('no toast and no sound can fire: not on a permission ask, a question, a finish, a stop', async ($, on) => {
  const r = rig(on)
  r.ask = true
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-3' } as never)
  await $.tool.call({ tool: 'AskUserQuestion' } as never)
  r.results.TaskCreate = { task: { id: '1', subject: 'Only' } }
  await $.tool.call({ tool: 'TaskCreate', subject: 'Only', description: 'd' })
  r.results.TaskUpdate = { success: true }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.turn.complete({ turnId: 'x', reason: 'error', text: '', answer: '' } as never)
  await $.session.end({ reason: 'exit' } as never)
  await r.clock.advance(10 * 60_000)
  expect(r.toasts).toEqual([])
  expect(r.sounds).toEqual([])
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).not.toMatch(/needs you|Need you|waiting for you/i)
  await ui.unmount()
})

test('this session finishing shows the took line', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-3' } as never)
  r.results.TaskCreate = { task: { id: '1', subject: 'Only' } }
  await $.tool.call({ tool: 'TaskCreate', subject: 'Only', description: 'd' })
  await r.clock.advance(30 * 60_000)
  r.results.TaskUpdate = { success: true }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const ui = await mountPane($)
  expect(await texts(ui)).toMatch(/✅ Finished · took 3\d min/)
  await ui.unmount()
})

test('no checklist, turn ends with its answer: Finished with the minutes from the first prompt, no plan words', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-PUB2\nEXPECT: 0.5 h' } as never)
  await r.clock.advance(4 * 60_000)
  const working = await mountPane($)
  const live = await texts(working)
  expect(live).not.toContain('no plan yet')
  expect(live).toContain('min left')
  await working.unmount()
  await r.clock.advance(11 * 60_000)
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'Done', answer: 'Done' } as never)
  await r.clock.advance(31_000)
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toContain('✅ Finished · took 15 min')
  expect(all).not.toContain('min left')
  await ui.unmount()
  const band = await $.ui.mount({ plugin: 'build-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(JSON.stringify(await band.findAll({ type: 'Text' }))).toContain('✅ Finished · took 15 min')
  await band.unmount()
})

test('no checklist, turn ends in an error: Stopped after the minutes', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X' } as never)
  await r.clock.advance(15 * 60_000)
  await $.turn.complete({ turnId: 'x', reason: 'error', text: '', answer: '' } as never)
  await r.clock.advance(31_000)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('❌ Stopped · after 15 min')
  await ui.unmount()
})

test('a turn that ends while a helper still runs is not finished', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 1 h' } as never)
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Look around', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } } as never)
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'ok', answer: 'ok' } as never)
  await r.clock.advance(31_000)
  const ui = await mountPane($)
  expect(await texts(ui)).not.toContain('Finished')
  await ui.unmount()
})

test('a new message after Finished goes back to working', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 1 h' } as never)
  await r.clock.advance(5 * 60_000)
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'ok', answer: 'ok' } as never)
  await $.prompt.submit({ text: 'one more thing' } as never)
  await r.clock.advance(31_000)
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).not.toContain('Finished')
  expect(all).toContain('min left')
  await ui.unmount()
})

test('a reload keeps the first prompt as the start of elapsed time', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 1 h' } as never)
  await r.clock.advance(11 * 60_000)
  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' })
  await r.clock.advance(2500)
  // the mod reloads: history exists, the launch stamp is the reload moment
  r.history = [{ role: 'user', text: '# MOD-X\nEXPECT: 1 h', toolUses: [] }]
  r.launch = r.clock.now()
  await $.session.start(START)
  await r.clock.advance(4 * 60_000)
  const ui = await mountPane($)
  expect(await texts(ui)).toMatch(/running for 1[56] min/)
  await ui.unmount()
})

const bandText = async ($: Engine): Promise<string> => {
  const band = await $.ui.mount({ plugin: 'build-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const t = JSON.stringify(await band.findAll({ type: 'Text' }))
  await band.unmount()

  return t
}

const finishedWindow = async ($: Engine, r: Rig) => {
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 1 h' } as never)
  await r.clock.advance(30 * 60_000)
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'ok', answer: 'ok' } as never)
  await r.clock.advance(3000)
  await $.session.end({ reason: 'exit' } as never)
  r.history = [{ role: 'user', text: '# MOD-X\nEXPECT: 1 h', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }]
  r.launch = r.clock.now()
}

test('a finished window stays Finished after a reload, with the minutes from the file, and a slash command changes nothing', async ($, on) => {
  const r = rig(on)
  await finishedWindow($, r)
  await $.session.start(START)
  await r.clock.advance(40_000)
  expect(await bandText($)).toContain('✅ Finished · took 30 min')
  await $.prompt.submit({ text: '/reload-plugins' } as never)
  await $.prompt.submit({ text: '/builds' } as never)
  await r.clock.advance(40_000)
  const band = await bandText($)
  expect(band).toContain('✅ Finished · took 30 min')
  expect(band).not.toContain('at least')
  expect(mine(r).start_known).toBe(true)
})

test('a real message after a reload of a finished window goes back to working', async ($, on) => {
  const r = rig(on)
  await finishedWindow($, r)
  await $.session.start(START)
  await $.prompt.submit({ text: 'one more thing' } as never)
  await r.clock.advance(31_000)
  expect(await bandText($)).not.toContain('Finished')
})

test('a finished window with no status file is Finished without minutes', async ($, on) => {
  const r = rig(on)
  r.history = [{ role: 'user', text: '# MOD-X', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }]
  r.launch = r.clock.now()
  await $.session.start(START)
  await r.clock.advance(40_000)
  expect(await bandText($)).toContain('✅ Finished')
  expect(await bandText($)).not.toContain('took')
})

test('a reload with an open tool call is working, and a start from an older file without the flag says at least', async ($, on) => {
  const r = rig(on)
  r.files.set(`${DIR}/s1.json`, JSON.stringify({ v: 2, session: 's1', folder: '~/x', branch: 'main', started_at: r.clock.now() - 30 * 60_000, updated_at: r.clock.now(), prompt_id: 'MOD-X', finished: { at: r.clock.now(), verdict: 'session closed', ok: true } }))
  r.history = [{ role: 'user', text: '# MOD-X', toolUses: [] }, { role: 'assistant', text: 'Running', toolUses: [{ tool: 'Bash', input: {} }] }]
  r.launch = r.clock.now() - 3 * 60_000
  await $.session.start(START)
  await r.clock.advance(40_000)
  const band = await bandText($)
  expect(band).not.toContain('Finished')
  const ui = await mountPane($)
  expect(await texts(ui)).toMatch(/running for at least 3\d min/)
  await ui.unmount()
})

test('a turn the person stops shows Stopped by you', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X' } as never)
  await r.clock.advance(12 * 60_000)
  await $.turn.complete({ turnId: 'x', reason: 'aborted', isAborted: true, text: '', answer: '' } as never)
  await r.clock.advance(31_000)
  expect(await bandText($)).toContain('⏸ Stopped by you · after 12 min')
})

const notice = (id: string, status = 'completed') => ({
  message: { type: 'user', content: [{ type: 'text', text: `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>done</summary></task-notification>` }] },
  door: 'queue',
  origin: { kind: 'task-notification' },
  uuid: `u-${id}-${status}`,
}) as never

const SECRET_CMD = 'curl -H "x: sk-live-AbCdEf1234567890XyZ" https://example.test'

test('a background Bash: listed, counted, then moved to Done for 10 minutes, then gone; the command never appears', async ($, on) => {
  const r = rig(on)
  r.results.Bash = { backgroundTaskId: 'b1', stdout: '' }
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 3 h' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: SECRET_CMD, description: 'Run the full test matrix', run_in_background: true } as never)
  await r.clock.advance(23 * 60_000)
  expect(await bandText($)).toContain('🔄 1 in background')
  let ui = await mountPane($)
  let all = await texts(ui)
  expect(all).toMatch(/⌨️ Run the full test matrix · no % reported · running for 2[34] min/)
  await ui.unmount()
  await r.clock.advance(18 * 60_000)
  await $.session.append(notice('b1'))
  await r.clock.advance(31_000)
  expect(await bandText($)).not.toContain('in background')
  ui = await mountPane($)
  all = await texts(ui)
  expect(all).toContain('Done in the background')
  expect(all).toMatch(/✅ Run the full test matrix · took 4[12] min/)
  expect(all).not.toContain('sk-live')
  expect([...r.files.values()].join('\n') + all).not.toContain('sk-live')
  await ui.unmount()
  await r.clock.advance(11 * 60_000)
  ui = await mountPane($)
  expect(await texts(ui)).not.toContain('Run the full test matrix')
  await ui.unmount()
})

test('two background tasks at once count 2', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  r.results.Bash = { backgroundTaskId: 'b1' }
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'a', description: 'First', run_in_background: true } as never)
  r.results.Monitor = { taskId: 'm1', timeoutMs: 0 }
  await $.tool.call({ tool: 'Monitor', tool_use_id: 'tu2', description: 'Watch the log', timeout_ms: 1000, command: 'tail -f x' } as never)
  await r.clock.advance(31_000)
  expect(await bandText($)).toContain('🔄 2 in background')
})

test('the turn ends while one runs: Waiting, not Finished; when it ends: Finished', async ($, on) => {
  const r = rig(on)
  r.results.Bash = { backgroundTaskId: 'b1' }
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 3 h' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'x', description: 'Run the full test matrix', run_in_background: true } as never)
  await r.clock.advance(5 * 60_000)
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'ok', answer: 'ok' } as never)
  await r.clock.advance(31_000)
  const waiting = await bandText($)
  expect(waiting).toMatch(/⏳ Waiting on 1 background task · 🔄 Run the full test matrix/)
  expect(waiting).not.toContain('Finished')
  let ui = await mountPane($)
  expect(await texts(ui)).not.toContain('Finished')
  await ui.unmount()
  await r.clock.advance(5 * 60_000)
  await $.session.append(notice('b1'))
  await r.clock.advance(31_000)
  expect(await bandText($)).toMatch(/✅ Finished · took 1\d min/)
  ui = await mountPane($)
  expect(await texts(ui)).toContain('✅ Finished')
  await ui.unmount()
})

test('a background agent is listed, keeps the turn from Finished, and ends with its own turn', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 3 h' } as never)
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Check every page', subagentType: 'Explore', background: true, provider: { plugin: 'engine', tier: 'core' } } as never)
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'ok', answer: 'ok' } as never)
  await r.clock.advance(31_000)
  expect(await bandText($)).toContain('⏳ Waiting on 1 background task')
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toContain('🤖 Check every page')
  expect(all).not.toContain('👥')
  await ui.unmount()
  await $.turn.complete({ turnId: 'y', reason: 'answer', agentId: 'agent-1', text: 'ok' } as never)
  await r.clock.advance(31_000)
  expect(await bandText($)).toContain('✅ Finished')
})

test('a reload with one open background call: running, count 1, not Finished', async ($, on) => {
  const r = rig(on)
  r.history = [
    { role: 'user', text: '# MOD-X\nEXPECT: 3 h', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 'tu1', input: { description: 'Run the full test matrix', command: SECRET_CMD, run_in_background: true }, result: { backgroundTaskId: 'b1' } }] },
    { role: 'assistant', text: 'The matrix is running.', toolUses: [] },
  ]
  r.launch = r.clock.now() - 30 * 60_000
  await $.session.start(START)
  await r.clock.advance(31_000)
  const band = await bandText($)
  expect(band).toContain('Waiting on 1 background task')
  expect(band).not.toContain('Finished')
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toContain('Run the full test matrix · no % reported')
  expect(all).not.toContain('sk-live')
  await ui.unmount()
})

test('a background task with no news for 2 hours stops counting as running', async ($, on) => {
  const r = rig(on)
  r.results.Bash = { backgroundTaskId: 'b1' }
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X\nEXPECT: 9 h' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'x', description: 'Never reports', run_in_background: true } as never)
  await r.clock.advance(121 * 60_000)
  expect(await bandText($)).not.toContain('in background')
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('❔ Never reports · no news for 2 h')
  await ui.unmount()
})

test('an ordinary session: Working with steps live and from history, the last 5 steps in the panel', async ($, on) => {
  const r = rig(on)
  r.history = [
    { role: 'user', text: 'fix the bug', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [{ tool: 'Read', input: { file_path: '/a/one.ts' } }, { tool: 'Bash', input: { command: 'ls', description: 'List files' } }] },
    { role: 'assistant', text: 'working', toolUses: [{ tool: 'Edit', input: { file_path: '/a/two.ts' }, result: {} }, { tool: 'Bash', input: { description: 'Run the unit tests' } }] },
  ]
  r.launch = r.clock.now() - 20 * 60_000
  await $.session.start(START)
  await r.clock.advance(31_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the unit tests' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/a/three.ts' } as never)
  await r.clock.advance(31_000)
  const band = await bandText($)
  expect(band).toContain('🔨 Working')
  expect(band).toContain('6 steps so far')
  expect(band).not.toContain('% not reported')
  expect(band).not.toContain('time left not known yet')
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toContain('Last steps')
  expect(all).toContain('Read · three.ts')
  expect(all).not.toContain('one.ts')
  expect(all).not.toContain('% not reported')
  expect(all).not.toContain('time left not known yet')
  expect(all).not.toContain('npm test')
  await ui.unmount()
  await $.turn.complete({ turnId: 'x', reason: 'answer', text: 'done', answer: 'done' } as never)
  await r.clock.advance(31_000)
  expect(await bandText($)).toMatch(/✅ Finished · 6 steps · took (at least )?\d+ min/)
})

test('/builds-panel reopens the one pane and says so; /builds still prints the list', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  const a = await $.command.run({ command: 'builds-panel', args: '' } as never)
  const b = await $.command.run({ command: 'builds-panel', args: '' } as never)
  expect(JSON.stringify(a)).toContain('Opened the Builds panel.')
  expect(JSON.stringify(b)).toContain('Opened the Builds panel.')
  expect(new Set(r.opened)).toEqual(new Set(['builds']))
  expect(JSON.stringify(await $.command.run({ command: 'builds', args: '' } as never))).toContain('claude-mods')
})

const PLAN = 'mcp__ccd_turn__update_plan'

test('the app\'s update_plan list gives the % live, and from history after a reload, with an unknown start', async ($, on) => {
  const r = rig(on)
  r.history = [
    { role: 'user', text: 'long job', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: PLAN, input: { items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }, { content: 'D', status: 'pending' }] } }] },
  ]
  r.launch = r.clock.now() - 71 * 60_000
  await $.session.start(START)
  await r.clock.advance(31_000)
  const band = await bandText($)
  expect(band).toContain('25%')
  expect(band).not.toContain('Working')
  // live: advance the plan; 12 minutes later a speed shows
  await r.clock.advance(12 * 60_000)
  await $.tool.call({ tool: PLAN, items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }, { content: 'C', status: 'in_progress' }, { content: 'D', status: 'pending' }] } as never)
  await r.clock.advance(31_000)
  const later = await bandText($)
  expect(later).toContain('50%')
  expect(later).toMatch(/⏱ about \d+ min left/)
})

test('a notification row without the engine stamp still ends its task; /builds-tasks says what it saw', async ($, on) => {
  const r = rig(on)
  r.results.Bash = { backgroundTaskId: 'b1' }
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'x', description: 'One', run_in_background: true } as never)
  r.results.Bash = { backgroundTaskId: 'b2' }
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu2', command: 'x', description: 'Two', run_in_background: true } as never)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' }] }, door: 'queue', origin: { kind: 'unclassified' }, uuid: 'u1' } as never)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<task-notification><task-id>zz</task-id><status>completed</status></task-notification>' }] }, door: 'queue', origin: { kind: 'task-notification' }, uuid: 'u2' } as never)
  // a tool result that merely contains the envelope is data
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<task-notification><task-id>b1</task-id><status>failed</status></task-notification>' }] }, door: 'tool-result', origin: { kind: 'tool', tool: 'Read' }, uuid: 'u3' } as never)
  const report = JSON.stringify(await $.command.run({ command: 'builds-tasks', args: '' } as never))
  expect(report).toContain('ended · shell · One')
  expect(report).toContain('running · shell · Two')
  expect(report).toContain('1 counted as running, 2 listed')
  expect(report).toContain('last notice: b1 completed')
  expect(report).toContain('zz completed')
  expect(report).not.toContain('failed')
  expect(report).not.toContain('sk-live')
})

/** The real shape of a finished background task: an attachment row `queued_command`, stamped `task-notification`, the envelope inside a system reminder. Ids and words only. */
const attachmentNotice = (id: string, status = 'completed') => ({
  message: { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: `<system-reminder>\n<task-notification><task-id>${id}</task-id><tool-use-id>toolu_x</tool-use-id><output-file>/x/${id}.output</output-file><status>${status}</status><summary>S</summary></task-notification>\n</system-reminder>` }] },
  door: 'attachment',
  origin: { kind: 'task-notification' },
  uuid: `a-${id}`,
}) as never

test('the real finished row (an attachment) ends the shell and the agent, and /builds-tasks shows it', async ($, on) => {
  const r = rig(on)
  r.results.Bash = { backgroundTaskId: 'bsh1' }
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'x', description: 'Sample shell', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 'tu2', prompt: 'p', description: 'Sample agent', subagentType: 'general-purpose', background: true, provider: { plugin: 'engine', tier: 'core' } } as never)
  await r.clock.advance(5000)
  expect(mine(r).bg.filter((b: { ended_at: number | null }) => b.ended_at === null).length).toBe(2)
  await $.session.append(attachmentNotice('bsh1'))
  await $.session.append(attachmentNotice('agent-1'))
  await r.clock.advance(5000)
  expect(mine(r).bg.map((b: { id: string; end: string }) => [b.id, b.end])).toEqual([['bsh1', 'completed'], ['agent-1', 'completed']])
  const text = await $.command.run({ command: 'builds-tasks' } as never)
  expect(JSON.stringify(text)).toMatch(/0 counted as running, 2 listed/)
  expect(JSON.stringify(text)).toMatch(/ended \d\d:\d\d \(completed\)/)
})

const GREP = (ts: string, body: string): string => `${body}`.replace('TS', ts)

test('a reload: the transcript gives each task its own start, the end the live hook never saw, and the session\'s name', async ($, on) => {
  const r = rig(on)
  const path = `${HOME}/.claude/projects/-Users-tester-Work-claude-mods/s1.jsonl`
  const T = r.clock.now()
  const iso = (minAgo: number): string => new Date(T - minAgo * 60_000).toISOString()
  const grep = [
    `10:"timestamp":"${iso(200)}"`, '10:"backgroundTaskId":"old1"',
    `11:"timestamp":"${iso(80)}"`, '11:"backgroundTaskId":"run1"',
    `20:"timestamp":"${iso(120)}"`, '20:<task-id>old1</task-id>', '20:<status>completed</status>',
    '30:"customTitle":"GQ3B form losing areas"',
  ].join('\n')
  const calls: string[][] = []
  on('fs.exists', (_, e) => ({ value: e.path === path }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])

    return { value: { exitCode: 0, stdout: e.argv[0] === 'grep' ? grep : '', stderr: '' } as never }
  })
  r.history = [
    { role: 'user', text: '# MOD-X' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 'a', input: { description: 'Old job', run_in_background: true }, result: { backgroundTaskId: 'old1' } }] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 'b', input: { description: 'Running job', run_in_background: true }, result: { backgroundTaskId: 'run1' } }] },
  ]
  await $.session.start(START)
  await r.clock.advance(5000)
  expect(calls.some(c => c[0] === 'grep' && c[3] === path)).toBe(true)
  const bg = mine(r).bg as Array<{ id: string; started_at: number; ended_at: number | null }>
  // the old one ended two hours ago and is gone; the other keeps its own start, not the reload
  expect(bg.map(b => b.id)).toEqual(['run1'])
  expect(bg[0]?.started_at).toBe(Date.parse(iso(80)))
  expect(mine(r).title).toBe('GQ3B form losing areas')
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('GQ3B form losing areas')
  await ui.unmount()
})

test('the safety net: a task whose notice was missed is ended by the transcript within a minute', async ($, on) => {
  const r = rig(on)
  const path = `${HOME}/.claude/projects/-Users-tester-Work-claude-mods/s1.jsonl`
  let grep = ''
  on('fs.exists', (_, e) => ({ value: e.path === path }))
  on('process.run', (_, e) => ({ value: { exitCode: grep ? 0 : 1, stdout: e.argv[0] === 'grep' ? grep : '', stderr: '' } as never }))
  r.results.Bash = { backgroundTaskId: 'bsh1' }
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'x', description: 'Sample', run_in_background: true } as never)
  grep = ['5:"timestamp":"2026-10-28T07:41:50.500Z"', '5:<task-id>bsh1</task-id>', '5:<status>completed</status>'].join('\n')
  await r.clock.advance(61_000)
  await r.clock.advance(3000)
  expect(mine(r).bg[0]).toMatchObject({ id: 'bsh1', end: 'completed' })
})

test('a running shell\'s output is scanned for a % and an end time, and none of it is shown or stored', async ($, on) => {
  const r = rig(on)
  const dir = '/private/tmp/claude-501/-Users-tester-Work-claude-mods/s1/tasks'
  on('fs.exists', (_, e) => ({ value: e.path === dir }))
  on('process.run', (_, e) => ({ value: { exitCode: e.argv[0] === 'tail' ? 0 : 1, stdout: e.argv[0] === 'tail' ? 'building with token sk-live-AbCdEf1234567890XyZ\n▶ step 1/4\n12 min left\n' : '', stderr: '' } as never }))
  r.results.Bash = { backgroundTaskId: 'bsh1' }
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'x', description: 'Sample', run_in_background: true } as never)
  await r.clock.advance(61_000)
  await r.clock.advance(3000)
  expect(mine(r).bg[0]).toMatchObject({ id: 'bsh1', pct: 25 })
  expect([...r.files.values()].join('\n')).not.toContain('sk-live')
  const ui = await mountPane($)
  const all = await texts(ui)
  expect(all).toMatch(/Sample · 25% ▰▰▱▱▱▱▱▱ · running for 1 min · about 1[12] min left \(from its own line\)/)
  expect(all).not.toContain('sk-live')
  expect(await bandText($)).toContain('1 in background: Sample 25%, ~1')
  await ui.unmount()
})

test('a background agent\'s own checklist gives its %', async ($, on) => {
  const r = rig(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '# MOD-X' } as never)
  await $.agent.spawn({ tool_use_id: 'tu2', prompt: 'p', description: 'Sample agent', subagentType: 'general-purpose', background: true, provider: { plugin: 'engine', tier: 'core' } } as never)
  await $.tool.call({ tool: 'TodoWrite', agentId: 'agent-1', todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }, { content: 'D', status: 'pending' }] } as never)
  await r.clock.advance(5000)
  expect(mine(r).bg[0]).toMatchObject({ id: 'agent-1', pct: 25 })
  await $.session.append({ door: 'response', agentId: 'agent-1', message: { type: 'assistant', content: [{ type: 'text', text: '▶ page 3/4' }] } } as never)
  await r.clock.advance(5000)
  expect(mine(r).bg[0]).toMatchObject({ pct: 75 })
})
