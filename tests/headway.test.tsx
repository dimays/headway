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
  // The detail is a native tooltip on the ⓘ, so it takes no room in the pane.
  const tip = (await ui.find({ key: 'tip:scope' }))?.text
  expect(tip).toContain('added “C”, “D”')
  expect(tip).toContain('adding steps moves the bar back')
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
  expect(line?.text).toContain('waiting on your reply')
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
  expect(step).toContain('estimated from time')
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

test('ETAs come from how long finished steps took, and narrow as more finish', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await $.tool.call({ tool: PLAN, items: steps('A', 'B', 'C', 'D', 'E') })
  for (let i = 0; i < 3; i++) {
    await clock.advance(2 * MIN)
    await $.tool.call({ tool: PLAN, advance: true })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 2 steps left at ~2m each, not rough after 3 samples: ~3–5 min.
  const status = await ui.find({ key: 'status' })
  expect(status?.text).toMatch(/~3–5 min left/)
  expect(status?.text).not.toContain('rough')
  expect((await ui.find({ key: 'tip:status' }))?.text).toContain('2 steps at ~2m each, from 3 finished')
  expect((await ui.find({ key: 'step:A' }))?.text).toContain('✓A2m')
  await ui.unmount()
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
  expect((await later.find({ key: 'step:Build' }))?.text).toContain('Quiet for 4m')
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
  expect((await ui.find({ key: 'step:Decide' }))?.text).toContain('Waiting on you in the chat')
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

test('a board an earlier shape stored is declined', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: '/work/demo' }))
  on('state.get', () => ({ value: { value: { shape: 'board-1', value: { plans: 'nope' } }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No plan yet/ })).toBeDefined()
  await ui.unmount()
})
