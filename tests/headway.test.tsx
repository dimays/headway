import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'headway',
  component: 'Pane',
  requestId: 'headway',
  props: {
    title: 'Headway',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'

// Nothing sits beneath the plugin in a test: these hooks stand for the engine.
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'headway' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.list', () => ({ value: [] }))
  on('session.root', () => ({ value: '/work/demo' }))
}

const steps = (...names: string[]) =>
  names.map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))

test('an update_plan call becomes a bar and a step list, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: PLAN, items: steps('Read docs', 'Write code', 'Test it', 'Ship') })
  await $.tool.call({ tool: PLAN, advance: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const summary = (await ui.find({ key: 'summary' }))?.text
    expect(summary).toContain('demo')
    expect(summary).toContain('1/4')
    expect(summary).toContain('25%')
    expect((await ui.find({ key: 'step:Read docs' }))?.text).toBe('✓Read docs')
    expect((await ui.find({ key: 'step:Write code' }))?.text).toBe('●Write code')
    expect((await ui.find({ key: 'step:Ship' }))?.text).toBe('○Ship')
    await ui.unmount()
  }
})

test('the bar is a rounded SVG where the surface draws SVG, and rules on the terminal', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: PLAN, items: steps('A', 'B') })
  await $.tool.call({ tool: PLAN, advance: true })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await desk.find({ type: 'Svg' })
  expect(String(svg?.props.source)).toContain('rx="4"')
  expect(String(svg?.props.source)).toContain('width="50.00%"')
  expect(svg?.props.alt).toBe('1 of 2 steps done, 1 in progress')
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /━+─*/ })).toBeDefined()
  await term.unmount()
})

test('a rewrite that grows the plan is shown as a scope change, and the bar drops', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
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
  expect((await ui.find({ key: 'summary' }))?.text).toContain('25%')
  expect((await ui.find({ type: 'Text', text: /Scope/ }))?.text).toMatch(/^Scope 2 → 4  ·  \+2 last change  ·  changed/)
  await ui.unmount()
})

test('done and start set steps by number, and wrap-up checks off the last one', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: PLAN, items: steps('A', 'B', 'C') })
  await $.tool.call({ tool: PLAN, done: [1], start: 3 })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'summary' }))?.text).toContain('67%')
  expect((await ui.find({ key: 'step:B' }))?.text).toBe('○B')
  expect((await ui.find({ key: 'step:C' }))?.text).toBe('✓C')
  await ui.unmount()
})

test('TodoWrite plans count too', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'summary' }))?.text).toContain('50%')
  await ui.unmount()
})

test('a subagent nests under the step that was in progress when it spawned', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: PLAN, items: steps('Research', 'Build') })
  await $.agent.spawn({ prompt: 'look around', description: 'Survey the API', subagentType: 'Explore' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const step = (await ui.find({ key: 'step:Research' }))?.text
  expect(step).toContain('Research')
  expect(step).toContain('◐Survey the API')
  expect(step).toContain('Explore')
  await ui.unmount()
})

test('a board an earlier shape stored is declined', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: '/work/demo' }))
  on('state.get', () => ({ value: { value: { shape: 'board-0', value: { plans: 'nope' } }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No plan yet/ }))).toBeDefined()
  await ui.unmount()
})
