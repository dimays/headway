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
function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const submitted: string[] = []
  on('command.register', () => ({ value: { command: 'headway' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__headway__report_progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [] }))
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
