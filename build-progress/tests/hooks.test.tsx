import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/Users/tester'
const DIR = `${HOME}/.claude/build-progress`

type Rig = { ask: boolean; results: Record<string, unknown>; history: unknown[]; launch: number; files: Map<string, string>; toasts: string[]; sounds: string[]; snaps: string[]; writes: number; settle: boolean; hold: number; clock: ReturnType<typeof mock.clock> }
type On = Parameters<typeof mock.session>[0]

const rig = (on: On, sid = 's1'): Rig => {
  const files = new Map<string, string>()
  const toasts: string[] = []
  const sounds: string[] = []
  const snaps: string[] = []
  const r = { ask: false, results: {} as Record<string, unknown>, history: [] as unknown[], launch: 0, files, toasts, sounds, snaps, writes: 0, settle: true, hold: 0, clock: undefined as never } as Rig
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
  on('fs.list', () => ({
    value: [...files.entries()]
      .filter(([p]) => p.startsWith(DIR))
      .map(([p, t]) => ({ name: p.slice(DIR.length + 1), kind: 'file' as const, size: t.length, mtimeMs: clock.now(), isLink: false })),
  }))
  on('command.register', () => ({ value: { command: 'builds' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  expect(all).toContain('time left not known yet')
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
