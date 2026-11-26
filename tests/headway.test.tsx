import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'headway',
  component: 'Pane',
  requestId: 'headway',
  props: {
    title: 'Headway',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'
const REPORT = 'mcp__headway__report_progress'
const MIN = 60_000

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// Nothing sits beneath the plugin in a test: these hooks stand for the engine.
function engine(on: On, store: Map<string, unknown> | undefined = undefined, own: string[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  if (store) {
    // A store the test can look into, for what the session publishes.
    on('store.get', (_, e) => ({ value: store.get(e.key) }))
    on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
    on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else {
    mock.store(on)
  }
  const submitted: string[] = []
  // A test that answers one of these itself names it in `own`.
  if (!own.includes('command.register')) on('command.register', () => ({ value: { command: 'headway' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__headway__report_progress' } }))
  if (!own.includes('ui.open')) on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('tool.call', () => ({ result: {} }))
  if (!own.includes('agent.list')) on('agent.list', () => ({ value: [] }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { clock, submitted }
}

const steps = (...names: string[]) =>
  names.map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))

async function start($: Dollar, surface: 'desktop' | 'terminal' = 'desktop') {
  await $.session.start({ cwd: '/work/demo', surface, isInteractive: true })
}

test('an update_plan call becomes a bar and a step list, on every surface', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Read docs', 'Write code', 'Test it', 'Ship') })
  await $.tool.call({ tool: PLAN, advance: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const summary = (await ui.find({ key: 'summary' }))?.text
    expect(summary).toContain('demo')
    expect(summary).toContain('1/4')
    expect((await ui.find({ key: 'step:Read docs' }))?.text).toContain('✓Read docs')
    expect((await ui.find({ key: 'step:Write code' }))?.text).toContain('●Write code')
    expect((await ui.find({ key: 'step:Ship' }))?.text).toContain('○Ship')
    await ui.unmount()
  }
})

test('bars are rounded SVG where SVG draws, and rules on the terminal', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B') })
  await $.tool.call({ tool: PLAN, advance: true })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await desk.find({ type: 'Svg' })
  expect(String(svg?.props.source)).toContain('rx="4"')
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /━+/ })).toBeDefined()
  await term.unmount()
})

test('a grown plan reads as a plain sentence, with the detail behind it', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B') })
  await $.tool.call({ tool: PLAN, advance: true })
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'pending' },
      { content: 'D', status: 'pending' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Plan grew/ }))?.text).toMatch(/^Plan grew from 2 to 4 steps · 1 change, last just now/)
  // The detail floats above the line, holding what fits there, most important first.
  const tip = (await ui.find({ key: 'tip:scope' }))?.text
  expect(tip).toContain('added “C”, “D”')
  await ui.unmount()
})

test('tooltips are instant floating cards on pointer surfaces, and absent on the terminal', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B') })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The hover area is the whole status line. Its card leaves the flow (so
  // nothing moves) and floats up over the rows above, which it paints over.
  const line = await desk.find({ key: 'tip:status' })
  expect(line?.text).toContain('No estimate yet')
  const card = JSON.stringify(line?.children)
  expect(card).toContain('"display":"none"')
  expect(card).toContain('"hover":{"display":"flex"}')
  expect(card).toContain('"position":"absolute","bottom":1,"left":0,"right":0')
  expect(card).toContain('"key":"status"')
  const barCard = JSON.stringify((await desk.find({ key: 'tip:bar:step:A' }))?.children)
  expect(barCard).toContain('"position":"absolute","bottom":1,"left":0,"right":0')
  // Opaque: a solid hex background, no rgba.
  expect(card).toMatch(/"backgroundColor":"#[0-9A-F]{6}"/)
  expect(await desk.find({ key: 'tip:bar:step:A' })).toBeDefined()
  // Every bar's tip is a card too: no native <title> anywhere.
  for (const svg of await desk.findAll({ type: 'Svg' })) expect(String(svg.props.source)).not.toContain('<title>')
  const step = JSON.stringify((await desk.find({ key: 'step:A' }))?.children)
  expect(step).toContain('inferred from time')
  // Each step's bar has a line of its own under the name, in the same column:
  // no fixed widths to overflow, and nothing to overlap the text.
  for (const name of ['A', 'B']) {
    const row = JSON.stringify((await desk.find({ key: `step:${name}` }))?.children)
    expect(row).not.toMatch(/"width":\d/)
    expect(row.indexOf(`"${name}"`)).toBeLessThan(row.indexOf('"type":"Svg"'))
  }
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ key: 'tip:status' })).toBeUndefined()
  expect(await term.find({ key: 'status' })).toBeDefined()
  await term.unmount()
})

test('done and start set steps by number, and wrap-up checks off the last one', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B', 'C') })
  await $.tool.call({ tool: PLAN, done: [1], start: 3 })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'summary' }))?.text).toContain('2/3')
  expect((await ui.find({ key: 'step:B' }))?.text).toContain('○B')
  expect((await ui.find({ key: 'step:C' }))?.text).toContain('✓C')
  await ui.unmount()
})

test('TodoWrite plans count too', async ($, on) => {
  engine(on)
  await start($, 'terminal')
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'summary' }))?.text).toContain('1/2')
  await ui.unmount()
})

// ── Estimates ─────────────────────────────────────────────────────────

/** Opens a turn: the main loop's clock only runs inside one. */
function turns(on: On) {
  let n = 0
  on('turn.start', (_, e) => ({ turnId: `t${++n}`, text: e.text }))
  on('turn.complete', () => ({ text: 'ok' }))
  return {
    start: ($: Dollar) => $.turn.start({ text: 'go', turnId: `t${n + 1}` }),
    end: ($: Dollar) => $.turn.complete({ turnId: `t${n}`, answer: 'ok', durationMs: 0, isAborted: false } as Parameters<typeof $.turn.complete>[0]),
  }
}

test('with nothing to go on, the pane says so instead of guessing', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Research', 'Build', 'Ship') })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status' }))?.text).toContain('no estimate yet')
  expect((await ui.find({ key: 'step:Build' }))?.text).toContain('no estimate')
  await ui.unmount()
})

test('finished steps give a measured estimate, labelled as such', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B', 'C', 'D', 'E') })
  for (let i = 0; i < 3; i++) {
    await clock.advance(2 * MIN)
    await $.tool.call({ tool: PLAN, advance: true })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Two steps left at a measured ~2m each, spread by how few steps it rests on.
  const status = (await ui.find({ key: 'status' }))?.text
  // No turn is running, so the time is work left, with the clock stopped.
  expect(status).toMatch(/~3–6 min of work left · measured/)
  // A finished a while ago, so it waits in the Archive, collapsed.
  expect(await ui.find({ key: 'step:A' })).toBeUndefined()
  await ui.press({ key: 'toggle:archive' })
  expect((await ui.find({ key: 'step:A' }))?.text).toContain('✓A2m')
  expect((await ui.find({ key: 'step:E' }))?.text).toContain('~2m')
  await ui.unmount()
})

test("the session's sizes are a labelled guess until a finished step checks them", async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Write the parser', 'Write the tests', 'Ship') })
  const reply = await $.tool.call({
    tool: REPORT,
    sizes: [
      { step: 'Write the parser', size: 'L' },
      { step: 'Write the tests', size: 'M' },
      { step: 'Ship', minutes: 2 },
    ],
  })
  expect(JSON.stringify(reply)).toContain('Sized 3 steps')

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status' }))?.text).toContain('unchecked guess')
  expect((await ui.find({ key: 'step:Write the tests' }))?.text).toContain('~8m')
  await ui.unmount()

  // The parser (sized L, ~20m) took 10m: the session runs at half its sizes.
  await clock.advance(10 * MIN)
  await $.tool.call({ tool: PLAN, advance: true })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status' }))?.text).toContain('calibrated')
  expect((await ui.find({ key: 'step:Ship' }))?.text).toContain('~1m')
  await ui.unmount()
})

test('a step past its estimate says so, and offers to ask for a new one', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Fix the bug', 'Ship') })
  await $.tool.call({ tool: REPORT, sizes: [{ step: 'Fix the bug', size: 'S' }, { step: 'Ship', size: 'S' }] })
  await clock.advance(10 * MIN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await ui.find({ key: 'step:Fix the bug' }))?.text
  expect(row).toContain('over by 7m')
  expect(row).not.toMatch(/~\d+m left/)
  await ui.press({ key: 'toggle:step:Fix the bug' })
  expect(await ui.find({ key: 'step:Fix the bug:Ask for a new estimate' })).toBeDefined()
  await ui.unmount()
})

test('time waiting between turns is not counted as work', async ($, on) => {
  const { clock } = engine(on)
  const turn = turns(on)
  await start($)
  await turn.start($)
  await $.tool.call({ tool: PLAN, items: steps('Build', 'Ship') })
  await $.tool.call({ tool: REPORT, sizes: [{ step: 'Build', minutes: 10 }] })
  await clock.advance(2 * MIN)
  await turn.end($)
  await clock.advance(60 * MIN) // the person is away for an hour
  await turn.start($)
  await clock.advance(1 * MIN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 3m of work against 10m sized, not 63m: ~7m left, not "over".
  expect((await ui.find({ key: 'step:Build' }))?.text).toContain('~7m left')
  await ui.unmount()
})

test('steps checked off together are not used as timings', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B', 'C') })
  await clock.advance(6 * MIN)
  await $.tool.call({ tool: PLAN, done: [1, 2], start: 3 })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:A' }))?.text).toContain('✓Adone')
  expect((await ui.find({ key: 'status' }))?.text).toContain('no estimate yet')
  await ui.unmount()
})

test('finished steps teach later sessions, by kind of step', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Run the tests', 'Run the tests again', 'Run the tests once more', 'Run the final tests') })
  for (let i = 0; i < 3; i++) {
    await clock.advance(4 * MIN)
    await $.tool.call({ tool: PLAN, advance: true })
  }
  // A new plan, with nothing finished in it yet: its test step takes its
  // estimate from how long test steps took before, and says so.
  await $.tool.call({ tool: PLAN, items: steps('Run the smoke tests', 'Ship') })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Run the smoke tests' }))?.text).toContain('~4m left')
  expect((await ui.find({ key: 'status' }))?.text).toContain('past sessions')
  await ui.unmount()
})

test('tooltips fit the room above them, and drop out rather than be cut off', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B', 'C', 'D', 'E', 'F') })

  // At the top of the pane the status line has a row or two above it: its
  // card keeps only what fits there, most important first.
  const top = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 50 } })
  const tipText = (await top.find({ key: 'tip:status' }))?.text ?? ''
  const status = (await top.find({ key: 'status' }))?.text ?? ''
  const card = tipText.slice(status.length)
  expect(card.length).toBeGreaterThan(0)
  expect(card.length).toBeLessThanOrEqual(44)
  // Scrolled so the header sits at the window's top edge: no room, no card.
  await top.unmount()
  const scrolled = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, scroll: { offset: 3, bodyRows: 40 } } })
  expect(await scrolled.find({ key: 'tip:status' })).toBeUndefined()
  // A step far down has room for its whole card.
  expect((await scrolled.find({ key: 'tip:bar:step:F' }))?.text).toContain("isn't counted in the time left")
  await scrolled.unmount()
})

test('a subagent shows under its step once the step is opened', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Research', 'Build') })
  // The kit's spawn takes the engine's whole input; the fields this test needs are these.
  await $.agent.spawn({ prompt: 'look around', description: 'Survey the API', subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Research' }))?.text).toContain('1 subagent')
  await ui.press({ key: 'toggle:step:Research' })
  const agent = (await ui.find({ key: 'agent:agent-1' }))?.text
  expect(agent).toContain('◐Survey the API')
  expect(agent).toContain('Explore')
  await ui.unmount()
})

test('report_progress gives the step its own parts and a measured bar', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Build the pane', 'Ship') })
  const reply = await $.tool.call({
    tool: REPORT,
    subSteps: [
      { content: 'Layout', status: 'completed' },
      { content: 'Bars', status: 'in_progress' },
      { content: 'Buttons', status: 'pending' },
    ],
    etaMinutes: 6,
    note: 'Drawing the bars',
  })
  expect(JSON.stringify(reply)).toContain('Recorded on “Build the pane”')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await ui.find({ key: 'step:Build the pane' }))?.text
  expect(row).toContain('1/3 parts · Drawing the bars')
  expect(row).toContain('~6m left')
  await ui.press({ key: 'toggle:step:Build the pane' })
  expect((await ui.find({ key: 'step:Build the pane' }))?.text).toContain('Buttons')
  await ui.unmount()
})

test('a step that is going fine offers only Add context; a quiet one offers a status check', async ($, on) => {
  const { clock } = engine(on)
  on('turn.start', (_, e) => ({ turnId: 't1', text: e.text }))
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Build', 'Ship') })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle:step:Build' })
  expect(await ui.find({ key: 'step:Build:Add context' })).toBeDefined()
  expect(await ui.find({ key: 'step:Build:Status check' })).toBeUndefined()

  // Four minutes with no tool call while the turn runs: quiet.
  await clock.advance(4 * 60_000)
  await ui.unmount()
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await later.find({ key: 'step:Build' }))?.text).toContain('Quiet: no tool call for 3+ minutes')
  await later.press({ key: 'step:Build:Status check' })
  const ran = await $.tool.call({ tool: 'Read', file_path: '/work/demo/a.md' })
  expect(JSON.stringify(ran)).toContain('give a short status update on “Build”')
  await later.unmount()
})

test('a question waiting on the person reads Needs you', async ($, on) => {
  // Asked before the catch-all tool.call answer, so the question stays open.
  let wait: (ms: number) => Promise<void> = async () => {}
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await wait(30_000)
    return { result: { answers: {} } }
  })
  const { clock } = engine(on)
  wait = ms => clock.sleep(ms)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Decide', 'Build') })
  const asking = $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status' }))?.text).toContain('Needs you')
  expect((await ui.find({ key: 'step:Decide' }))?.text).toContain('Needs you: a permission prompt or question')
  await ui.unmount()
  await clock.advance(30_000)
  await asking
})

test('a pending step can be moved up, and the session is told at its next step', async ($, on) => {
  const { submitted } = engine(on)
  on('turn.start', (_, e) => ({ turnId: 't1', text: e.text }))
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Build', 'Docs', 'Ship') })
  // Mid-turn: notes wait for the next tool result instead of starting a turn.
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle:step:Ship' })
  await ui.press({ key: 'step:Ship:Do next' })
  expect(submitted.length).toBe(0)
  expect((await ui.find({ key: 'step:Ship' }))?.text).toContain('Up next')

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(JSON.stringify(ran)).toContain('do “Ship” next')
  expect((await ui.find({ type: 'Text', text: /^Do next · Ship/ }))?.text).toContain('delivered at its next step')
  await ui.unmount()
})

test('a note typed into a step is sent with the step named', async ($, on) => {
  const { submitted } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Build', 'Ship') })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle:step:Build' })
  await ui.press({ key: 'step:Build:Add context' })
  await ui.input({ key: 'note:step:Build', text: 'Use the staging database, not prod.' })
  // Not mid-turn, so it goes in as a new message.
  expect(submitted[0]).toContain('about “Build”')
  expect(submitted[0]).toContain('Use the staging database, not prod.')
  await ui.unmount()
})

test('a background command is tracked outside the plan, and can be stopped', async ($, on) => {
  // Registered before the catch-all tool.call answer, so they are asked first.
  const stopped: string[] = []
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' },
  }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    stopped.push(String((e as unknown as { task_id: string }).task_id))
    return { result: { message: 'stopped' } }
  })
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the release', run_in_background: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'task:bg-1' }))?.text).toContain('Build the release')
  await ui.press({ key: 'toggle:task:bg-1' })
  await ui.press({ key: 'task:bg-1:Stop' })
  expect(stopped).toEqual(['bg-1'])
  expect((await ui.find({ key: 'task:bg-1' }))?.text).toContain('stopped')
  await ui.unmount()
})

test('a board saved before the newer fields existed still draws', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: '/work/demo' }))
  // board-2 as v0.2 saved it: no work, waits or etaLog.
  const old = {
    plans: { main: { steps: [{ content: 'Build', status: 'in_progress', startedAt: 900_000 }], changes: [], peak: 1, createdAt: 900_000, updatedAt: 900_000 } },
    agents: [],
    activity: [],
    tasks: [],
    interventions: [],
    turn: { running: true, startedAt: 900_000 },
  }
  on('state.get', (_, e) => ({ value: { value: (e as { key: string }).key === 'board' ? { shape: 'board-2', value: old } : undefined, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Build' }))?.text).toContain('Build')
  await ui.unmount()
})

test('a board an earlier shape stored is declined', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: '/work/demo' }))
  on('state.get', () => ({ value: { value: { shape: 'board-1', value: { plans: 'nope' } }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No plan yet/ })).toBeDefined()
  await ui.unmount()
})

test("a session goes by its title, not its folder, which the app may have reused", async ($, on) => {
  const store = new Map<string, unknown>()
  const { clock } = engine(on, store)
  on('classic.UserPromptSubmit', () => ({}))
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Plan the release', 'Ship') })

  // Before the engine names it, the folder is all there is.
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'summary' }))?.text).toContain('demo')
  await ui.unmount()

  await $.classic.UserPromptSubmit({ prompt: 'go', session_title: '2.1.0 release planning' })
  await clock.advance(6000)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const summary = (await ui.find({ key: 'summary' }))?.text
  expect(summary).toContain('2.1.0 release planning')
  expect(summary).not.toContain('demo')
  await ui.unmount()
  const mine = store.get('session:session-1') as { name: string; root: string } | undefined
  expect(mine?.name).toBe('2.1.0 release planning')
  expect(mine?.root).toBe('/work/demo')
})

// ── v0.4: reopening, capture, closure, archive, drill-down ────────────

test('/headway runs at once, mid-turn too, and reopens a closed pane', async ($, on) => {
  const registered: Record<string, unknown>[] = []
  const opened: string[] = []
  on('command.register', (_, e) => (registered.push(e as unknown as Record<string, unknown>), { value: { command: 'headway' } }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
    engine(on, undefined, ['command.register', 'ui.open'])
  await start($)
  // Left out, a command typed during a long turn waits for the turn to end.
  expect(registered[0]?.immediate).toBe(true)
  // After the person closes the pane, the command opens it again.
  const ran = await $.command.run({ command: 'headway', args: '' } as Parameters<typeof $.command.run>[0])
  expect(ran.text).toContain('Headway pane opened.')
  expect(opened.filter(id => id === 'headway').length).toBe(2)
})

test('/headway says why when the pane cannot be drawn yet', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is 90 columns wide' } }))
  engine(on, undefined, ['ui.open'])
  await start($)
  const ran = await $.command.run({ command: 'headway', args: '' } as Parameters<typeof $.command.run>[0])
  expect(ran.text).toContain('not drawn yet: the terminal is 90 columns wide')
})

test('a board the pane cannot draw shows a way out instead of closing the pane', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: '/work/demo' }))
  // A step whose parts are not a list: drawing it throws.
  const broken = {
    plans: { main: { steps: [{ content: 'Build', status: 'in_progress', startedAt: 900_000, subSteps: 'oops' }], changes: [], peak: 1, createdAt: 900_000, updatedAt: 900_000 } },
    agents: [],
    activity: [],
    tasks: [],
    interventions: [],
    turn: { running: false },
  }
  on('state.get', (_, e) => ({ value: { value: (e as { key: string }).key === 'board' ? { shape: 'board-2', value: broken } : undefined, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /problem drawing this board/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'reset-board' })).toBeDefined()
  await ui.unmount()
})

test('a burst of parallel updates from many subagents loses none', async ($, on) => {
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `bg-${++n}` } }))
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Audit the content', 'Build the pipeline') })
  const calls = Array.from({ length: 40 }, (_, i) =>
    $.tool.call({ tool: 'Bash', command: `job ${i}`, description: `Job ${i}`, run_in_background: true, agentId: `agent-${i % 8}` } as Parameters<typeof $.tool.call>[0]),
  )
  await Promise.all(calls)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (let i = 1; i <= 40; i++) expect(await ui.find({ key: `task:bg-${i}` })).toBeDefined()
  await ui.unmount()
})

test('a report names its step loosely and still lands', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Read the docs', 'Run the test suite', 'Ship the release') })
  // Plural, filler words and case differ from the plan's wording.
  let reply = await $.tool.call({ tool: REPORT, step: 'test suites', note: 'flaky one' })
  expect(JSON.stringify(reply)).toContain('Recorded on “Run the test suite”')
  // By number.
  reply = await $.tool.call({ tool: REPORT, step: 'step 3', percent: 10 })
  expect(JSON.stringify(reply)).toContain('Recorded on “Ship the release”')
  // Sizes match the same way.
  reply = await $.tool.call({ tool: REPORT, sizes: [{ step: 'docs', size: 'S' }, { step: 'Ship release', size: 'M' }] })
  expect(JSON.stringify(reply)).toContain('Sized 2 steps')
})

test('a rewritten plan keeps a reworded step’s reports and time, and archives what it dropped', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Fix reopen', 'Write docs', 'Old idea') })
  await $.tool.call({ tool: REPORT, subSteps: [{ content: 'Find cause', status: 'completed' }, { content: 'Patch', status: 'in_progress' }] })
  await clock.advance(MIN)
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Fix pane reopen', status: 'in_progress' },
      { content: 'Write docs', status: 'pending' },
      { content: 'Add tests', status: 'pending' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Fix pane reopen' }))?.text).toContain('1/2 parts')
  // The dropped step left the list for the Archive, collapsed by default.
  expect(await ui.find({ key: 'archived:0:Old idea' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle:archive' }))?.text).toContain('ARCHIVE · 1')
  await ui.press({ key: 'toggle:archive' })
  expect((await ui.find({ key: 'archived:0:Old idea' }))?.text).toContain('superseded')
  await ui.press({ key: 'toggle:archive' })
  expect(await ui.find({ key: 'archived:0:Old idea' })).toBeUndefined()
  await ui.unmount()
})

test('a report of 100% or every part done closes its step; progress on a pending one starts it', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Build', 'Test', 'Ship') })
  await $.tool.call({ tool: REPORT, step: 'Build', percent: 100 })
  await $.tool.call({ tool: REPORT, step: 'Test', subSteps: [{ content: 'Unit', status: 'in_progress' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Build' }))?.text).toContain('✓Build')
  expect((await ui.find({ key: 'step:Test' }))?.text).toContain('●Test')
  await ui.unmount()
  // The model's own advance then moves on from where the work really is.
  await $.tool.call({ tool: PLAN, advance: true })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ key: 'step:Test' }))?.text).toContain('✓Test')
  expect((await after.find({ key: 'step:Ship' }))?.text).toContain('●Ship')
  await after.unmount()
})

test('a step left in progress with no sign of work reads stale?, not in progress', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Audit pages', 'Publish') })
  await clock.advance(9 * MIN)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Audit pages' }))?.text).toContain('●Audit pages')
  await ui.unmount()

  await clock.advance(3 * MIN)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await ui.find({ key: 'step:Audit pages' }))?.text
  expect(row).toContain('◌Audit pages')
  expect(row).toContain('stale? · 12m')
  expect(row).toContain('it may be done but never checked off')
  await ui.press({ key: 'toggle:step:Audit pages' })
  expect(await ui.find({ key: 'step:Audit pages:Status check' })).toBeDefined()
  await ui.unmount()
})

test('stale? waits as long as the staleMinutes option says', { options: { staleMinutes: 30 } }, async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Audit pages', 'Publish') })
  await clock.advance(20 * MIN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Audit pages' }))?.text).not.toContain('stale?')
  await ui.unmount()
})

test('a running subagent keeps its step live, and its report ends it', async ($, on) => {
  const { clock } = engine(on, undefined, ['agent.list'])
  on('agent.list', () => ({ value: [{ id: 'agent-1', description: 'Audit section A', type: 'general-purpose', status: 'running' }] as never }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  on('agent.report', (_, e) => ({ text: e.text }))
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Audit', 'Publish') })
  await $.agent.spawn({ prompt: 'audit', description: 'Audit section A', subagentType: 'general-purpose' } as Parameters<typeof $.agent.spawn>[0])
  await clock.advance(30 * MIN)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Audit' }))?.text).not.toContain('stale?')
  await ui.unmount()

  await $.agent.report({ agentId: 'agent-1', subagentType: 'general-purpose', status: 'completed', text: 'done' } as Parameters<typeof $.agent.report>[0])
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'step:Audit' }))?.text).toContain('1 finished')
  await ui.unmount()
})

test('a subagent the engine stopped listing is ended, not running forever', async ($, on) => {
  const { clock } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-9' }))
  await start($)
  // No plan: it is a loose subagent.
  await $.agent.spawn({ prompt: 'x', description: 'Survey', subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'agent:agent-9' }))?.text).toContain('◐Survey')
  await ui.unmount()
  // agent.list answers [] (engine above): past the grace it reads ended,
  // and once it has been done a while it moves to the Archive.
  await clock.advance(5 * MIN)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'agent:agent-9' })).toBeUndefined()
  await ui.press({ key: 'toggle:archive' })
  expect((await ui.find({ key: 'agent:agent-9' }))?.text).toContain('✓Survey')
  await ui.unmount()
})

test('a task notification ends its background task as it arrives', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-7' } }))
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'make data', description: 'Build the data pipeline', run_in_background: true })
  await $.prompt.submit({ text: '<task-notification>\n<task-id>bg-7</task-id>\n<status>failed</status>\n<summary>exit 1</summary>\n</task-notification>' } as Parameters<typeof $.prompt.submit>[0])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'task:bg-7' }))?.text).toContain('failed')
  await ui.unmount()
})

test('a subagent’s turn end reconciles background tasks the main turn never saw end', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-3' } }))
  on('classic.SubagentStop', () => ({}))
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Wait a bit', run_in_background: true, agentId: 'agent-2' } as Parameters<typeof $.tool.call>[0])
  await clock.advance(MIN)
  await $.classic.SubagentStop({ agent_id: 'agent-2', agent_type: 'general-purpose', agent_transcript_path: '/t', stop_hook_active: false, background_tasks: [] } as unknown as Parameters<typeof $.classic.SubagentStop>[0])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'task:bg-3' }))?.text).toContain('completed')
  await ui.unmount()
})

test('clicking a step’s name opens its parts, each with a bar, and clicking again closes it', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('Build the pane', 'Ship') })
  await $.tool.call({
    tool: REPORT,
    percent: 50,
    subSteps: [
      { content: 'Layout', status: 'completed' },
      { content: 'Bars', status: 'in_progress' },
      { content: 'Buttons', status: 'pending', percent: 0 },
    ],
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'sub:step:Build the pane:0' })).toBeUndefined()
    await ui.press({ key: 'open:step:Build the pane' })
    const layout = await ui.find({ key: 'sub:step:Build the pane:0' })
    const bars = await ui.find({ key: 'sub:step:Build the pane:1' })
    expect(layout?.text).toContain('Layout')
    expect(layout?.text).toContain('done')
    // Half the step done with one of three parts finished: the part in progress is at 50%.
    expect(bars?.text).toContain('50%')
    if (surface === 'desktop') expect(JSON.stringify(bars?.children)).toContain('"type":"Svg"')
    expect((await ui.find({ key: 'sub:step:Build the pane:2' }))?.text).toContain('not started')
    expect((await ui.find({ key: 'step:Build the pane' }))?.text).toContain('Started just now')
    await ui.press({ key: 'open:step:Build the pane' })
    expect(await ui.find({ key: 'sub:step:Build the pane:0' })).toBeUndefined()
    await ui.unmount()
  }
})
