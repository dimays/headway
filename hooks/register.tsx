import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Board, Plan, SessionSummary, Step } from '../types'
import {
  EMPTY_PLAN,
  ENDED,
  activeStep,
  applyTodoWrite,
  applyUpdatePlan,
  applyWrapUp,
  progress,
} from './plan'
import type { Progress } from './plan'
import { barAlt, barSvg, barText, labels } from './bar'

const PANE = 'headway'
const TITLE = 'Headway'
const MAIN = 'main'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const STORE_PREFIX = 'session:'
const STALE_MS = 15 * 60 * 1000
const FORGET_MS = 7 * 24 * 60 * 60 * 1000

// The shape tag versions what is stored: a reload that changes Board's fields
// bumps it, and a value stored under an older tag is declined, not misdrawn.
const SHAPE = 'board-1'
const BOARD = { plugin: 'headway', key: 'board' } as const
const OTHERS = { plugin: 'headway', key: 'others' } as const
const EMPTY_BOARD: Board = { plans: {}, agents: [] }
// What the pane reads while drawing: atoms subscribe the pane to each write.
const boardAtom = atom(BOARD, EMPTY_BOARD, { shape: SHAPE })
const othersAtom = atom(OTHERS, [])

async function getBoard($: EngineInterface): Promise<Board> {
  const { value } = await $.state.get(BOARD)
  return value && value.shape === SHAPE ? value.value : EMPTY_BOARD
}

/** Read-modify-write with a version check, retried if another hook wrote first. */
async function changeBoard($: EngineInterface, change: (b: Board) => Board) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const held = await $.state.get(BOARD)
    const before = held.value && held.value.shape === SHAPE ? held.value.value : EMPTY_BOARD
    const after = change(before)
    if (after === before) return
    const { isSet } = await $.state.set(BOARD, { shape: SHAPE, value: after }, { ifVersion: held.version })
    if (isSet) return
  }
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const AGENT_MARK: Record<string, string> = {
  pending: '○',
  running: '◐',
  waiting: '◷',
  idle: '·',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

// Module variables start over on each reload; that is fine for these.
let lastPublished = ''
let lastOthers = ''

async function setPlan($: EngineInterface, loop: string, change: (p: Plan) => Plan) {
  await changeBoard($, b => {
    const before = b.plans[loop] ?? EMPTY_PLAN
    const after = change(before)
    return after === before ? b : { ...b, plans: { ...b.plans, [loop]: after } }
  })
}

/** Mirrors subagent statuses from the engine, which is their source of truth. */
async function refreshAgents($: EngineInterface) {
  const live = await $.agent.list()
  const now = await $.clock.now()
  await changeBoard($, b => {
    let changed = false
    const rows = b.agents.map(row => {
      const info = live.find(a => a.id === row.id)
      if (!info || info.status === row.status) return row
      changed = true
      return { ...row, status: info.status, endedAt: ENDED.has(info.status) ? now : undefined }
    })
    for (const info of live) {
      if (rows.some(r => r.id === info.id)) continue
      changed = true
      rows.push({
        id: info.id,
        description: info.description,
        type: info.type,
        status: info.status,
        parentId: info.parentId,
        startedAt: now,
      })
    }
    return changed ? { ...b, agents: rows } : b
  })
}

/** Publishes this session's summary to the shared store and reads everyone else's. */
async function syncSessions($: EngineInterface) {
  const id = await $.session.id()
  const now = await $.clock.now()
  const b = await getBoard($)
  const main = b.plans[MAIN]
  const p = progress(main)
  if (p.total > 0) {
    const root = await $.session.root()
    const mine: SessionSummary = {
      id,
      name: basename(root),
      root,
      done: p.done,
      total: p.total,
      active: activeStep(main),
      agentsRunning: b.agents.filter(a => !ENDED.has(a.status) && a.status !== 'idle').length,
      updatedAt: main?.updatedAt ?? now,
    }
    const text = JSON.stringify(mine)
    if (text !== lastPublished) {
      lastPublished = text
      await $.store.set(STORE_PREFIX + id, mine)
    }
  }

  const list: SessionSummary[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX) || key === STORE_PREFIX + id) continue
    const one = (await $.store.get(key)) as SessionSummary | undefined
    if (!one || typeof one.updatedAt !== 'number') continue
    if (now - one.updatedAt > FORGET_MS) {
      await $.store.delete(key)
      continue
    }
    list.push(one)
  }
  list.sort((a, z) => z.updatedAt - a.updatedAt)
  const text = JSON.stringify(list)
  if (text !== lastOthers) {
    lastOthers = text
    await $.state.set(OTHERS, list)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'headway',
      description: 'Show progress on this session’s plan, its subagents and your other sessions',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    $.clock.every(3000, () => void refreshAgents($))
    $.clock.every(5000, () => void syncSessions($))

    return started
  })

  on('command.run', { command: 'headway' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await changeBoard($, () => EMPTY_BOARD)
      return { text: 'Headway cleared this session’s board.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Headway pane opened. `/headway clear` resets this session’s board.' }
  })

  // Task lists, captured as the model writes them: no extra model calls.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny || ran.isError) return ran
    if (e.tool !== UPDATE_PLAN && e.tool !== 'TodoWrite' && e.tool !== WRAP_UP) return ran

    const loop = e.agentId ?? MAIN
    const at = await $.clock.now()
    const args = e as unknown as Record<string, unknown>
    if (e.tool === UPDATE_PLAN) await setPlan($, loop, p => applyUpdatePlan(p, args, at))
    else if (e.tool === 'TodoWrite') await setPlan($, loop, p => applyTodoWrite(p, args, at))
    else await setPlan($, loop, p => applyWrapUp(p, at))
    return ran
  }).catch(($, e, next) => next(e)) // never block the call over a headway bug

  // Subagents, nested under the step their parent was on when it spawned them.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!('agentId' in spawned) || !spawned.agentId) return spawned
    const agentId = spawned.agentId
    const now = await $.clock.now()
    await changeBoard($, b => {
      if (b.agents.some(a => a.id === agentId)) return b
      const parent = b.plans[e.parentAgentId ?? MAIN]
      const row: AgentRow = {
        id: agentId,
        description: e.description || e.subagentType,
        type: e.subagentType,
        status: 'running',
        parentId: e.parentAgentId,
        step: activeStep(parent),
        startedAt: now,
      }
      return { ...b, agents: [...b.agents, row].slice(-100) }
    })
    return spawned
  }).catch(($, e, next) => next(e)) // never block the call over a headway bug

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    // The terminal is the one surface without SVG; it gets a line of rules.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const b = await read($, boardAtom)
    const stored = await read($, othersAtom)
    const rest = Array.isArray(stored) ? stored : []
    const now = await $.clock.now()
    const here = basename(await $.session.root())
    const columns = Math.max(24, e.props.bodyColumns ?? 40)

    // ── Pieces ──────────────────────────────────────────────────────────

    const sectionLabel = (text: string) => (
      <Text size="caption" weight="semibold" dimColor>
        {text.toUpperCase()}
      </Text>
    )

    /** A rounded SVG pill where the surface draws SVG, a line of rules elsewhere. */
    const bar = (p: Progress, height: number, width: number) => {
      if (Svg) return <Svg source={barSvg(p, height)} alt={barAlt(p)} height={height} />
      const t = barText(p, width)
      const complete = p.total > 0 && p.done === p.total
      return (
        <Text>
          <Text color={complete ? 'success' : 'claude'}>{t.done}</Text>
          <Text color="claude" dimColor>
            {t.active}
          </Text>
          <Text color="subtle">{t.rest}</Text>
        </Text>
      )
    }

    /** Title on the left, `6/7  86%` on the right, sharing one baseline. */
    const header = (title: string, p: Progress, emphasis: 'semibold' | 'medium') => {
      const l = labels(p)
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" gap="sm">
          <Box flexShrink={1}>
            <Text weight={emphasis} wrap="truncate-end">
              {title}
            </Text>
          </Box>
          {p.total > 0 && (
            <Box flexDirection="row" gap="sm" flexShrink={0}>
              <Text mono dimColor>
                {l.count}
              </Text>
              <Text mono weight="semibold">
                {l.percent}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const meta = (parts: (string | false | undefined)[]) => (
      <Text size="caption" dimColor wrap="truncate-end">
        {parts.filter(Boolean).join('  ·  ')}
      </Text>
    )

    const agentRow = (row: AgentRow): ReturnType<typeof h> => {
      const plan = b.plans[row.id]
      const p = progress(plan)
      const mark = AGENT_MARK[row.status] ?? '?'
      const ended = ENDED.has(row.status)
      const color = row.status === 'failed' ? 'error' : ended ? 'subtle' : 'claude'
      const children = b.agents.filter(a => a.parentId === row.id)
      return (
        <Box key={`agent:${row.id}`} flexDirection="row" gap="sm">
          <Text mono color={color}>
            {mark}
          </Text>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} gap="xs">
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Box flexShrink={1}>
                <Text size="footnote" dimColor={ended} wrap="truncate-end">
                  {row.description}
                </Text>
              </Box>
              <Text size="caption" dimColor>
                {p.total > 0 ? `${labels(p).count}  ·  ${row.type}` : row.type}
              </Text>
            </Box>
            {p.total > 0 && bar(p, 4, columns - 8)}
            {children.map(child => agentRow(child))}
          </Box>
        </Box>
      )
    }

    const STEP_MARK = { completed: '✓', in_progress: '●', pending: '○' } as const
    const STEP_COLOR = { completed: 'success', in_progress: 'claude', pending: 'subtle' } as const

    const stepRow = (step: Step) => {
      const agents = b.agents.filter(a => !a.parentId && a.step === step.content)
      const current = step.status === 'in_progress'
      return (
        <Box key={`step:${step.content}`} flexDirection="row" gap="sm">
          <Text mono color={STEP_COLOR[step.status]}>
            {STEP_MARK[step.status]}
          </Text>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} gap="xs">
            <Text
              weight={current ? 'semibold' : 'regular'}
              dimColor={step.status === 'completed'}
              wrap="truncate-end"
            >
              {step.content}
            </Text>
            {agents.length > 0 && (
              <Box flexDirection="column" gap="xs">
                {agents.map(row => agentRow(row))}
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    // ── This session ────────────────────────────────────────────────────

    const main = b.plans[MAIN]
    const steps = main?.steps ?? []
    const p = progress(main)
    const stepNames = new Set(steps.map(s => s.content))
    const loose = b.agents.filter(a => !a.parentId && (!a.step || !stepNames.has(a.step)))
    const changes = main?.changes ?? []
    const first = changes[0]
    const last = changes[changes.length - 1]
    const delta = last ? last.added.length - last.removed.length : 0
    const running = b.agents.filter(a => !ENDED.has(a.status) && a.status !== 'idle').length

    const session = (
      <Box flexDirection="column" gap="sm">
        {sectionLabel('This session')}
        {steps.length === 0 ? (
          <Text dimColor>No plan yet. It appears here as soon as the session writes its task list.</Text>
        ) : (
          <Box flexDirection="column" gap="xs">
            <Box key="summary" flexDirection="column" gap="xs">
              {header(here, p, 'semibold')}
            </Box>
            {bar(p, 8, columns)}
            {meta([
              first && last && `Scope ${first.from} → ${steps.length}`,
              last && `${delta >= 0 ? '+' : '−'}${Math.abs(delta)} last change`,
              last ? `changed ${ago(now - last.at)}` : main && `updated ${ago(now - main.updatedAt)}`,
              running > 0 && `${running} agent${running === 1 ? '' : 's'} running`,
            ])}
          </Box>
        )}
      </Box>
    )

    const stepList = steps.length > 0 && (
      <Box flexDirection="column" gap="sm">
        {sectionLabel('Steps')}
        <Box flexDirection="column" gap="xs">
          {steps.map(step => stepRow(step))}
        </Box>
      </Box>
    )

    const subagents = loose.length > 0 && (
      <Box flexDirection="column" gap="sm">
        {sectionLabel('Subagents')}
        <Box flexDirection="column" gap="xs">
          {loose.map(row => agentRow(row))}
        </Box>
      </Box>
    )

    // ── Other sessions ──────────────────────────────────────────────────

    const othersBlock = (
      <Box flexDirection="column" gap="sm">
        {sectionLabel('Other sessions')}
        {rest.length === 0 ? (
          <Text size="footnote" dimColor>
            None reporting yet. Sessions with Headway installed show up here.
          </Text>
        ) : (
          <Box flexDirection="column" gap="md">
            {rest.map(one => {
              const stale = now - one.updatedAt > STALE_MS
              const op: Progress = {
                done: one.done,
                active: one.active ? 1 : 0,
                total: one.total,
                ratio: one.total === 0 ? 0 : one.done / one.total,
              }
              return (
                <Box flexDirection="column" gap="xs">
                  {header(one.name, op, 'medium')}
                  {bar(op, 6, columns)}
                  {meta([
                    one.active,
                    ago(now - one.updatedAt),
                    one.agentsRunning > 0 && `${one.agentsRunning} agent${one.agentsRunning === 1 ? '' : 's'}`,
                    stale && 'idle',
                  ])}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="lg" paddingX="xs" paddingY="xs">
        {session}
        {stepList}
        {subagents}
        {othersBlock}
      </Box>
    )
  })
}
