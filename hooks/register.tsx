import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Activity,
  AgentRow,
  ArchivedStep,
  BgTask,
  Board,
  Health,
  Intervention,
  InterventionKind,
  Plan,
  SessionSummary,
  Step,
  SubStep,
  View,
} from '../types'
import {
  EMPTY_PLAN,
  ENDED,
  activeStep,
  applyReport,
  applyTodoWrite,
  applyUpdatePlan,
  applyWrapUp,
  progress,
  stepSignalAt,
  toReport,
} from './plan'
import {
  HEALTH,
  ago,
  basisWords,
  calibrate,
  duration,
  estimateStep,
  health,
  isSample,
  isWaiting,
  kindOf,
  lastActivity,
  logEta,
  planEta,
  planFraction,
  range,
  slips,
  stepActiveMs,
  worst,
} from './eta'
import type { Context, Eta } from './eta'
import { barSvg, barText, percent } from './bar'
import type { BarSpec } from './bar'
import { INTERVENTION_LABEL, describeCall, describeScope, interventionText } from './describe'

const PANE = 'headway'
const TITLE = 'Headway'
const MAIN = 'main'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const REPORT = 'mcp__headway__report_progress'
const STORE_PREFIX = 'session:'
const STALE_MS = 15 * 60_000
const FORGET_MS = 7 * 24 * 60 * 60_000
const TASK_QUIET_MS = 5 * 60_000
/** A finished step, subagent or task stays in its section this long before it moves to the Archive. */
const RECENT_MS = 2 * 60_000
/** A row the engine has not listed this long after it started is not merely late to appear. */
const GRACE_MS = 10_000
/** The default for the `staleMinutes` option: a step in progress with no sign of work this long reads "stale?". */
const STALE_MINUTES = 10
/** A note for a running loop that has made no tool call this long goes as a message instead. */
const NEXT_STEP_PATIENCE_MS = 60_000
const TAIL_LIMIT = 256 * 1024
/** The tooltip card: a soft charcoal, fully opaque so nothing beneath shows through; rounded; readable in light and dark. */
const TIP = { background: '#34332F', border: '#4A4844', text: '#F4F2EE' } as const


// The shape tag versions what is stored: a reload that changes Board's fields
// bumps it, and a value stored under an older tag is declined, not misdrawn.
const SHAPE = 'board-2'
const BOARD = { plugin: 'headway', key: 'board' } as const
const OTHERS = { plugin: 'headway', key: 'others' } as const
const VIEW = { plugin: 'headway', key: 'view' } as const
const HISTORY = { plugin: 'headway', key: 'history' } as const
const EMPTY_BOARD: Board = { plans: {}, agents: [], activity: [], tasks: [], interventions: [], turn: { running: false }, work: [], waits: [], etaLog: [] }
const EMPTY_VIEW: View = { open: [] }
// What the pane reads while drawing: atoms subscribe the pane to each write.
const boardAtom = atom(BOARD, EMPTY_BOARD, { shape: SHAPE })
const othersAtom = atom(OTHERS, [])
const viewAtom = atom(VIEW, EMPTY_VIEW)
const historyAtom = atom(HISTORY, {})

const PROMPT_SECTION = [
  'Headway, a progress pane beside this chat, shows the user your plan, each step and how long it is taking.',
  'Right after you write or change your plan, call the report_progress tool (mcp__headway__report_progress) once with `sizes`: each step with a size (S, M, L or XL) or rough minutes, so the pane can estimate time left. Headway checks your sizes against how long finished steps really take.',
  'When a step has distinct parts, when you finish a meaningful part, when you can estimate the time left, or when you are blocked, call report_progress with the step, its sub-steps and their status, a rough percent and minutes left.',
  'Keep reports short and skip them for trivial steps.',
  'Text that begins "The user sent this from the Headway progress pane" is the user\'s own instruction, sent while you work: act on it.',
].join(' ')

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    sizes: {
      type: 'array',
      description: "Sizes for the plan's steps, usually all of them, right after writing the plan: S (a few minutes), M (~10), L (~20), XL (45+), or rough minutes.",
      items: {
        type: 'object',
        properties: {
          step: { type: 'string', description: 'The step, as written in the plan.' },
          size: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
          minutes: { type: 'number' },
        },
        required: ['step'],
      },
    },
    step: { type: 'string', description: 'The plan step this is about, as written in the plan. Defaults to the step in progress.' },
    subSteps: {
      type: 'array',
      description: 'The parts of this step, in order, each with its status.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          percent: { type: 'number', description: 'Optional: rough percent of this part done.' },
        },
        required: ['content', 'status'],
      },
    },
    percent: { type: 'number', description: 'Rough percent of this step done, 0–100.' },
    etaMinutes: { type: 'number', description: 'Rough minutes left on this step.' },
    blocker: { type: 'string', description: 'What is blocking the step, or an empty string once unblocked.' },
    note: { type: 'string', description: 'One line on what is happening now.' },
  },
} as const

// ── State helpers ────────────────────────────────────────────────────────

function asBoard(value: { shape: string; value: Board } | undefined): Board {
  return value && value.shape === SHAPE ? { ...EMPTY_BOARD, ...value.value } : EMPTY_BOARD
}

async function getBoard($: EngineInterface): Promise<Board> {
  const { value } = await $.state.get(BOARD)
  return asBoard(value)
}

// Writes go one at a time. Every hook of this module shares one queue, so
// parallel subagents' tool calls, timers and reports never race each other
// for the board's version: under a burst of them the old retry loop could run
// out of attempts and drop an update without a word.
let queueTail: Promise<unknown> = Promise.resolve()
function serially<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job)
  queueTail = run.catch(() => undefined)
  return run
}

/** Read-modify-write, one at a time, with a version check in case another process wrote first. */
async function changeBoard($: EngineInterface, change: (b: Board) => Board) {
  await serially(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const held = await $.state.get(BOARD)
      const before = asBoard(held.value)
      const after = change(before)
      if (after === before) return
      const { isSet } = await $.state.set(BOARD, { shape: SHAPE, value: after }, { ifVersion: held.version })
      if (isSet) return
    }
    $.ui.log('headway: a board update gave way to 20 writes from elsewhere and was dropped')
  })
}

async function changeView($: EngineInterface, change: (v: View) => View) {
  await serially(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const held = await $.state.get(VIEW)
      const before = held.value && Array.isArray(held.value.open) ? held.value : EMPTY_VIEW
      const { isSet } = await $.state.set(VIEW, change(before), { ifVersion: held.version })
      if (isSet) return
    }
  })
}

async function setPlan($: EngineInterface, loop: string, change: (p: Plan) => Plan) {
  await changeBoard($, b => {
    const before = b.plans[loop] ?? EMPTY_PLAN
    const after = change(before)
    return after === before ? b : { ...b, plans: { ...b.plans, [loop]: after } }
  })
}

let counter = 0
function newId(now: number): string {
  counter += 1
  return `${now.toString(36)}-${counter.toString(36)}`
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/** The step a loop is on: its own plan's, else (a subagent) the one it was spawned for. */
function stepOf(b: Board, loop: string): string | undefined {
  const own = activeStep(b.plans[loop])
  if (own) return own
  const row = b.agents.find(a => a.id === loop)
  return row?.step
}

// ── Background work ──────────────────────────────────────────────────────

/** Mirrors subagent statuses from the engine, which is their source of truth. */
async function refreshAgents($: EngineInterface) {
  const live = await $.agent.list()
  const now = await $.clock.now()
  await changeBoard($, b => {
    let changed = false
    const rows = b.agents.map(row => {
      const info = live.find(a => a.id === row.id)
      if (!info) {
        // The engine drops an agent's entry some time after it ends. One it no
        // longer lists, and that we still think is working, has ended: without
        // this it would read "running" forever.
        if (ENDED.has(row.status) || now - row.startedAt < GRACE_MS) return row
        changed = true
        return { ...row, status: 'completed', endedAt: now, endedBy: 'gone' as const }
      }
      if (info.status === row.status) return row
      changed = true
      return { ...row, status: info.status, endedAt: ENDED.has(info.status) ? (row.endedAt ?? now) : undefined, endedBy: ENDED.has(info.status) ? (row.endedBy ?? ('list' as const)) : undefined }
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
        step: stepOf(b, info.parentId ?? MAIN),
        startedAt: now,
      })
    }
    return changed ? { ...b, agents: rows.slice(-100) } : b
  })
}

/** Reads each running background command's output file: growth means it is alive. */
async function refreshTasks($: EngineInterface) {
  const b = await getBoard($)
  const now = await $.clock.now()
  const updates: Record<string, Partial<BgTask>> = {}
  for (const task of b.tasks) {
    if (task.status !== 'running') continue
    if (task.kind === 'monitor' && task.timeoutMs && now - task.startedAt > task.timeoutMs) {
      updates[task.id] = { status: 'completed', endedAt: task.startedAt + task.timeoutMs, endedBy: 'timeout' }
      continue
    }
    if (!task.outputPath) continue
    try {
      const stat = await $.fs.stat(task.outputPath)
      if (stat.size === task.bytes) continue
      const patch: Partial<BgTask> = { bytes: stat.size, lastOutputAt: stat.mtimeMs }
      if (stat.size <= TAIL_LIMIT) {
        const text = await $.fs.read(task.outputPath)
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
        const last = lines[lines.length - 1]
        if (last) patch.lastLine = last.slice(0, 160)
      }
      updates[task.id] = patch
    } catch {
      // The file may not exist yet, or was cleaned up; try again next tick.
    }
  }
  if (Object.keys(updates).length === 0) return
  await changeBoard($, board => ({
    ...board,
    tasks: board.tasks.map(t => (updates[t.id] ? { ...t, ...updates[t.id] } : t)),
  }))
}

// ── Evidence that work ended ─────────────────────────────────────────────
// Signals the engine already sends, so the model is never asked for more.

/** An agent's run ended (its report reached the parent, or a notification said so). */
async function endAgent($: EngineInterface, id: string, status: string, by: AgentRow['endedBy']) {
  const now = await $.clock.now()
  await changeBoard($, b => {
    const row = b.agents.find(a => a.id === id)
    if (!row || (ENDED.has(row.status) && row.status === status)) return b
    return { ...b, agents: b.agents.map(a => (a.id === id ? { ...a, status, endedAt: a.endedAt ?? now, endedBy: by } : a)) }
  })
}

/** Task statuses as notifications word them, in the board's words. */
function taskStatus(word: string): BgTask['status'] {
  return word === 'failed' || word === 'error' ? 'failed' : word === 'killed' || word === 'stopped' || word === 'cancelled' ? 'stopped' : 'completed'
}

/**
 * Reads the ids and statuses out of a background task's notification
 * (`<task-id>…</task-id>` … `<status>…</status>`), one or several.
 */
function parseNotifications(text: string): { id: string; status: string }[] {
  const found: { id: string; status: string }[] = []
  const blocks = text.split(/<task-notification>/i).slice(1)
  for (const block of blocks.length > 0 ? blocks : [text]) {
    const id = /<task[-_]id>\s*([^<\s]+)\s*<\/task[-_]id>/i.exec(block)?.[1]
    const status = /<status>\s*([^<]+?)\s*<\/status>/i.exec(block)?.[1]?.toLowerCase()
    if (id && status) found.push({ id, status })
  }
  return found
}

/** A notification said these tasks or agents ended. */
async function endByNotification($: EngineInterface, ended: { id: string; status: string }[]) {
  const done = ended.filter(n => n.status !== 'running' && n.status !== 'pending')
  if (done.length === 0) return
  const now = await $.clock.now()
  await changeBoard($, b => {
    let changed = false
    const tasks = b.tasks.map(t => {
      const n = done.find(x => x.id === t.id)
      if (!n || t.status !== 'running') return t
      changed = true
      return { ...t, status: taskStatus(n.status), endedAt: now, endedBy: 'notification' as const }
    })
    const agents = b.agents.map(a => {
      const n = done.find(x => x.id === a.id)
      if (!n || ENDED.has(a.status)) return a
      changed = true
      const status = n.status === 'failed' ? 'failed' : n.status === 'killed' || n.status === 'stopped' ? 'killed' : 'completed'
      return { ...a, status, endedAt: now, endedBy: 'notification' as const }
    })
    return changed ? { ...b, tasks, agents } : b
  })
}

/**
 * At a turn's end the engine lists the background work still in flight,
 * session-wide: a task of ours it no longer lists has ended.
 */
async function reconcileTasks($: EngineInterface, running: unknown) {
  if (!Array.isArray(running)) return
  const live = new Set(running.map(t => (t && typeof t === 'object' ? String((t as { id?: unknown }).id) : '')))
  const now = await $.clock.now()
  await changeBoard($, b => {
    const gone = b.tasks.filter(t => t.status === 'running' && !live.has(t.id) && now - t.startedAt >= GRACE_MS / 2)
    if (gone.length === 0) return b
    const ids = new Set(gone.map(t => t.id))
    return { ...b, tasks: b.tasks.map(t => (ids.has(t.id) ? { ...t, status: 'completed', endedAt: now, endedBy: 'turn-end' as const } : t)) }
  })
}

/** Sends what the pane queued, by the quickest route the target allows right now. */
async function deliverPending($: EngineInterface) {
  const b = await getBoard($)
  const now = await $.clock.now()
  for (const item of b.interventions) {
    if (item.status !== 'pending') continue
    if (item.target === MAIN) {
      if (b.turn.running) continue // lands on the next tool result instead
      await $.prompt.submit({ text: item.text })
      await markIntervention($, item.id, { status: 'delivered', via: 'new-turn', deliveredAt: now })
      continue
    }
    const agent = b.agents.find(a => a.id === item.target)
    if (!agent) {
      await markIntervention($, item.id, { status: 'failed', reason: 'That subagent is no longer known.' })
      continue
    }
    const isBusy = agent.status === 'running' && now - item.at < NEXT_STEP_PATIENCE_MS
    if (isBusy) continue
    const sent = await $.session.send({ to: { agentId: agent.id }, text: item.text })
    await markIntervention(
      $,
      item.id,
      sent.isDelivered
        ? { status: 'delivered', via: 'message', deliveredAt: now }
        : { status: 'failed', reason: sent.reason },
    )
  }
}

async function markIntervention($: EngineInterface, id: string, patch: Partial<Intervention>) {
  await changeBoard($, b => ({
    ...b,
    interventions: b.interventions.map(i => (i.id === id ? { ...i, ...patch } : i)),
  }))
}

/** Keeps the session's title, as the app names it, for the pane and the other sessions. */
async function keepTitle($: EngineInterface, raw: unknown) {
  const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  if (!title) return
  const b = await getBoard($)
  if (b.title !== title) await changeBoard($, x => ({ ...x, title }))
}

/** Publishes this session's summary to the shared store and reads everyone else's. */
async function syncSessions($: EngineInterface, id: string) {
  const now = await $.clock.now()
  const b = await getBoard($)
  const main = b.plans[MAIN]
  const p = progress(main)
  if (p.total > 0) {
    const root = await $.session.root()
    const { value: history } = await $.state.get(HISTORY)
    const eta = sessionEta(b, now, history ?? {})
    const model = calibrate(main, contextOf(b, MAIN, now, history ?? {}))
    const mine: SessionSummary = {
      id,
      name: b.title || basename(root),
      root,
      done: p.done,
      total: p.total,
      active: activeStep(main),
      health: sessionHealth(b, now, history ?? {}),
      eta: eta && eta.basis !== 'none' ? { low: eta.low, high: eta.high, basis: basisWords(eta.basis, model) } : undefined,
      agentsRunning: b.agents.filter(a => !ENDED.has(a.status) && a.status !== 'idle').length,
      tasksRunning: b.tasks.filter(t => t.status === 'running').length,
      steps: (main?.steps ?? []).slice(0, 20).map(s => ({ content: s.content, status: s.status })),
      updatedAt: Math.max(main?.updatedAt ?? 0, lastActivity(b.activity, MAIN) ?? 0) || now,
    }
    const text = JSON.stringify({ ...mine, updatedAt: 0, eta: mine.eta && [Math.round(mine.eta.low), Math.round(mine.eta.high)] })
    if (text !== lastPublished || now - lastPublishedAt > 60_000) {
      lastPublished = text
      lastPublishedAt = now
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
    list.push({ ...one, steps: Array.isArray(one.steps) ? one.steps : [], health: one.health ?? 'on-track' })
  }
  list.sort((a, z) => z.updatedAt - a.updatedAt)
  const text = JSON.stringify(list)
  if (text !== lastOthers) {
    lastOthers = text
    await $.state.set(OTHERS, list)
  }
}

// Module variables start over on each reload; that is fine for these.
let lastPublished = ''
let lastPublishedAt = 0
let lastOthers = ''
let sessionId = ''

// ── Health ───────────────────────────────────────────────────────────────

/** How a loop's time is counted: the main loop in its turns, a subagent throughout. */
function contextOf(b: Board, loop: string, now: number, history: Record<string, number[]>): Context {
  return { now, loop, isAgent: loop !== MAIN, work: b.work, waits: b.waits, history }
}

function loopHealth(b: Board, loop: string, now: number, history: Record<string, number[]> = {}): Health {
  const plan = b.plans[loop]
  const steps = plan?.steps ?? []
  if (loop === MAIN && steps.length > 0 && steps.every(s => s.status === 'completed')) return 'done'
  const agent = b.agents.find(a => a.id === loop)
  if (agent?.status === 'failed') return 'failed'
  if (agent && ENDED.has(agent.status)) return 'done'
  const ctx = contextOf(b, loop, now, history)
  const current = steps.find(s => s.status === 'in_progress')
  const est = current ? estimateStep(current, calibrate(plan, ctx), ctx) : undefined
  return health({
    now,
    isRunning: loop === MAIN ? b.turn.running : agent?.status === 'running',
    isWaiting: isWaiting(ctx) || b.activity.some(x => x.loop === loop && x.needsYou && x.endedAt === undefined),
    activeMs: est?.activeMs ?? 0,
    expectedMs: est?.expectedMs,
    lastActivityAt: lastActivity(b.activity, loop) ?? agent?.startedAt ?? b.turn.startedAt,
  })
}

function taskHealth(t: BgTask, now: number): Health {
  if (t.status === 'failed') return 'failed'
  if (t.status !== 'running') return 'done'
  const last = t.lastOutputAt ?? t.startedAt
  return t.kind === 'shell' && now - last > TASK_QUIET_MS ? 'quiet' : 'on-track'
}

function sessionHealth(b: Board, now: number, history: Record<string, number[]> = {}): Health {
  const loops = [MAIN, ...b.agents.filter(a => !ENDED.has(a.status)).map(a => a.id)]
  return worst([...loops.map(l => loopHealth(b, l, now, history)), ...b.tasks.filter(t => t.status === 'running').map(t => taskHealth(t, now))])
}

/**
 * Time the session's subagents still need, in ms: a running subagent with a
 * plan of its own counts its own estimate. The main plan cannot finish before
 * the subagents working on it.
 */
function agentsExtraMs(b: Board, now: number, history: Record<string, number[]>): number {
  let extra = 0
  for (const a of b.agents) {
    if (ENDED.has(a.status) || a.parentId) continue
    const eta = planEta(b.plans[a.id], contextOf(b, a.id, now, history))
    if (eta && eta.basis !== 'none') extra = Math.max(extra, eta.mid * 60_000)
  }
  return extra
}

/** The main plan's estimate, subagents included. */
function sessionEta(b: Board, now: number, history: Record<string, number[]>): Eta | undefined {
  return planEta(b.plans[MAIN], contextOf(b, MAIN, now, history), agentsExtraMs(b, now, history))
}

/** Samples the projected finish so the pane can say when an estimate slips. */
async function sampleEta($: EngineInterface) {
  const now = await $.clock.now()
  const { value: history } = await $.state.get(HISTORY)
  await changeBoard($, b => {
    if (!b.turn.running) return b
    const eta = sessionEta(b, now, history ?? {})
    const finish = eta && eta.basis !== 'none' ? now + eta.mid * 60_000 : undefined
    const log = logEta(b.etaLog, now, finish)
    return log === b.etaLog ? b : { ...b, etaLog: log }
  })
}

/** Remembers how long finished steps took, by kind, for later sessions' first guesses. */
async function learn($: EngineInterface, minutes: { kind: string; minutes: number }[]) {
  if (minutes.length === 0) return
  const stored = ((await $.store.get('history')) as Record<string, number[]> | undefined) ?? {}
  const next: Record<string, number[]> = { ...stored }
  for (const m of minutes) next[m.kind] = [...(next[m.kind] ?? []), Math.round(m.minutes * 10) / 10].slice(-40)
  await $.store.set('history', next)
  await $.state.set(HISTORY, next)
}

// ── Interventions ────────────────────────────────────────────────────────

type Target =
  | { kind: 'loop'; loop: string; label: string }
  | { kind: 'task'; task: BgTask }
  | { kind: 'session'; summary: SessionSummary; label: string }

async function intervene($: EngineInterface, kind: InterventionKind, target: Target, note = '') {
  const now = await $.clock.now()
  const id = newId(now)
  const label = target.kind === 'task' ? target.task.description : target.label

  if (target.kind === 'session') {
    const text = interventionText(kind, label, note)
    const sent = await $.session.send({ to: { sessionId: target.summary.id }, text })
    await record($, {
      id,
      kind,
      target: `session:${target.summary.id}`,
      label: `${target.summary.name}: ${label}`,
      text,
      at: now,
      ...(sent.isDelivered
        ? { status: 'delivered' as const, via: 'message' as const, deliveredAt: now }
        : { status: 'failed' as const, reason: sent.reason }),
    })
    return
  }

  if (target.kind === 'task') {
    const task = target.task
    if (kind === 'stop') {
      const ran = await $.tool.call({ tool: 'TaskStop', task_id: task.id })
      const failed = 'deny' in ran && ran.deny ? ran.deny : ran.isError ? ran.text ?? 'TaskStop failed.' : undefined
      await record($, {
        id,
        kind,
        target: task.id,
        label,
        text: '',
        at: now,
        ...(failed ? { status: 'failed' as const, reason: failed } : { status: 'delivered' as const, via: 'tool' as const, deliveredAt: now }),
      })
      if (!failed) {
        await changeBoard($, b => ({
          ...b,
          tasks: b.tasks.map(t => (t.id === task.id ? { ...t, status: 'stopped', endedAt: now } : t)),
        }))
        await queue($, { id: newId(now), kind: 'stop', target: task.loop, label, text: interventionText('stop', label), at: now, status: 'pending' })
      } else {
        // The plugin was not allowed to stop it: ask the session to, by the same id.
        await queue($, { id: newId(now), kind: 'stop', target: task.loop, label, text: interventionText('stop', label, `task id ${task.id}`), at: now, status: 'pending' })
      }
    } else {
      const detail = kind === 'retry' ? `it ${task.status === 'failed' ? 'failed' : 'was stopped'}` : note
      await queue($, { id, kind, target: task.loop, label, text: interventionText(kind, label, detail), at: now, status: 'pending' })
    }
    await deliverPending($)
    return
  }

  const loop = target.loop
  if (kind === 'stop') {
    const ran = await $.tool.call({ tool: 'TaskStop', task_id: loop })
    const failed = 'deny' in ran && ran.deny ? ran.deny : ran.isError ? ran.text ?? 'TaskStop failed.' : undefined
    await record($, {
      id,
      kind,
      target: loop,
      label,
      text: '',
      at: now,
      ...(failed ? { status: 'failed' as const, reason: failed } : { status: 'delivered' as const, via: 'tool' as const, deliveredAt: now }),
    })
    const parent = (await getBoard($)).agents.find(a => a.id === loop)?.parentId ?? MAIN
    // Told either way: that it was stopped, or (when the plugin was not allowed) to stop it.
    await queue($, {
      id: newId(now),
      kind: 'stop',
      target: parent,
      label,
      text: interventionText('stop', label, failed ? `agent id ${loop}` : ''),
      at: now,
      status: 'pending',
    })
    await deliverPending($)
    return
  }

  if (kind === 'next' || kind === 'defer' || kind === 'skip') {
    const priority = kind === 'defer' ? 'deferred' : kind
    await setPlan($, loop, p => ({
      ...p,
      steps: p.steps.map(s => (s.content === label ? { ...s, priority } : s)),
    }))
  }
  await queue($, { id, kind, target: loop, label, text: interventionText(kind, label, note), at: now, status: 'pending' })
  await deliverPending($)
}

async function queue($: EngineInterface, item: Intervention) {
  await changeBoard($, b => ({ ...b, interventions: [...b.interventions, item].slice(-40) }))
}

async function record($: EngineInterface, item: Intervention) {
  await queue($, item)
}

async function toggle($: EngineInterface, key: string) {
  await changeView($, v => ({
    ...v,
    open: v.open.includes(key) ? v.open.filter(k => k !== key) : [...v.open, key].slice(-50),
  }))
}

async function compose($: EngineInterface, key: string | undefined) {
  await changeView($, v => ({ ...v, composing: key }))
}

async function sendNote($: EngineInterface, target: Target, key: string, note: string) {
  const text = note.trim()
  if (!text) return
  await compose($, undefined)
  await intervene($, 'context', target, text)
  await $.ui.toast('Note sent to Headway’s queue')
  void key
}

// ── Hooks ────────────────────────────────────────────────────────────────

/** Opens the pane, and says in words why when it cannot be drawn now. */
async function openPane($: EngineInterface): Promise<string> {
  try {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return opened.isPlaced ? 'Headway pane opened.' : `Headway pane is open but not drawn yet: ${opened.reason}`
  } catch (err) {
    return `Headway could not open its pane: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const register: Register = (on, options) => {
  const configured = Number(options?.staleMinutes)
  const staleMs = (Number.isFinite(configured) && configured > 0 ? configured : STALE_MINUTES) * 60_000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()

    await $.command.register({
      name: 'headway',
      description: 'Show progress on this session’s plan, its subagents, background tasks and your other sessions',
      argumentHint: '[clear]',
      // Runs at once, mid-turn too: left out, `/headway` typed during a long
      // turn waited for the turn to end, so a closed pane seemed not to reopen.
      immediate: true,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on a plan step to the Headway pane beside the chat: its sub-steps, a rough percent, minutes left, and any blocker. Cheap; call it when a step has parts, when a part finishes, or when blocked.',
      inputSchema: REPORT_SCHEMA as unknown as Record<string, unknown>,
      isDeferred: false,
    })
    void openPane($)
    const stored = (await $.store.get('history')) as Record<string, number[]> | undefined
    if (stored && typeof stored === 'object') await $.state.set(HISTORY, stored)

    $.clock.every(3000, () => {
      void refreshAgents($)
      void refreshTasks($)
      void deliverPending($)
      void sampleEta($)
    })
    $.clock.every(5000, () => void syncSessions($, sessionId))

    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'headway', text: PROMPT_SECTION, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      await changeBoard($, b => ({
        ...b,
        turn: { running: true, startedAt: now },
        work: [...b.work.map(w => (w.loop === MAIN && w.end === undefined ? { ...w, end: now } : w)), { loop: MAIN, start: now }].slice(-300),
      }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await changeBoard($, b => ({
        ...b,
        turn: { running: false, startedAt: b.turn.startedAt },
        work: b.work.map(w => (w.loop === MAIN && w.end === undefined ? { ...w, end: now } : w)),
        // A turn's end closes any wait the loop had open.
        waits: b.waits.map(w => (w.loop === MAIN && w.end === undefined ? { ...w, end: now } : w)),
      }))
      await deliverPending($)
    }
    return done
  })

  on('command.run', { command: 'headway' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await changeBoard($, () => EMPTY_BOARD)
      return { text: 'Headway cleared this session’s board.' }
    }
    const said = await openPane($)
    return { text: `${said} \`/headway clear\` resets this session’s board.` }
  })

  // Every tool call: the activity timeline, plans, background tasks, and the
  // moment a queued note can ride along to the model as context.
  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? MAIN
    const args = e as unknown as Record<string, unknown>
    const startedAt = await $.clock.now()
    const said = describeCall(e.tool, args)
    const before = await getBoard($)
    const act: Activity = {
      id: e.tool_use_id,
      loop,
      tool: said.tool,
      summary: said.summary,
      step: stepOf(before, loop),
      startedAt,
      needsYou: e.tool === 'AskUserQuestion' ? true : undefined,
    }
    await changeBoard($, b => ({
      ...b,
      activity: [...b.activity, act].slice(-400),
      waits: act.needsYou ? [...b.waits, { loop, start: startedAt }].slice(-200) : b.waits,
    }))

    const ran = await next(e)
    const at = await $.clock.now()
    const failed = !!ran.deny || !!ran.isError
    await changeBoard($, b => ({
      ...b,
      activity: b.activity.map(a => (a.id === act.id ? { ...a, endedAt: at, isError: failed || undefined, needsYou: undefined } : a)),
      waits: b.waits.map(w => (w.loop === loop && w.end === undefined ? { ...w, end: at } : w)),
    }))
    if (ran.deny) return ran

    if (!ran.isError) {
      const plansBefore = (await getBoard($)).plans[loop]
      if (e.tool === UPDATE_PLAN) await setPlan($, loop, p => applyUpdatePlan(p, args, at))
      else if (e.tool === 'TodoWrite') await setPlan($, loop, p => applyTodoWrite(p, args, at))
      else if (e.tool === WRAP_UP) await setPlan($, loop, p => applyWrapUp(p, at))
      if (e.tool === UPDATE_PLAN || e.tool === 'TodoWrite' || e.tool === WRAP_UP) {
        const board = await getBoard($)
        const was = new Map((plansBefore?.steps ?? []).map(x => [x.content, x.status]))
        const ctx = contextOf(board, loop, at, {})
        const finished = (board.plans[loop]?.steps ?? []).filter(x => was.get(x.content) !== 'completed' && isSample(x, ctx))
        await learn($, finished.map(x => ({ kind: kindOf(x.content), minutes: stepActiveMs(x, ctx) / 60_000 })))
      }
      await trackTask($, e.tool, args, ran.result as Record<string, unknown> | undefined, loop, at)
    }

    // A note queued for this loop goes to the model now, with this result.
    const board = await getBoard($)
    const due = board.interventions.filter(i => i.status === 'pending' && i.target === loop)
    if (due.length === 0) return ran
    const ids = new Set(due.map(i => i.id))
    await changeBoard($, b => ({
      ...b,
      interventions: b.interventions.map(i => (ids.has(i.id) ? { ...i, status: 'delivered', via: 'next-step', deliveredAt: at } : i)),
    }))
    // The same result with the notes added as context: still this tool's own result type.
    return { ...ran, context: [...(ran.context ?? []), ...due.map(i => i.text)] } as typeof ran
  }).catch(($, e, next) => next(e)) // never block the call over a headway bug

  on('tool.call', { tool: REPORT }, async ($, e) => {
    const loop = e.agentId ?? MAIN
    const at = await $.clock.now()
    const report = toReport(e as unknown as Record<string, unknown>)
    let matched: string | undefined
    let sized = 0
    await setPlan($, loop, p => {
      const applied = applyReport(p, report, at)
      matched = applied.matched
      sized = applied.sized
      return applied.plan
    })
    // A subagent with no plan of its own: its report belongs to its own row.
    if (!matched && sized === 0 && e.agentId && (report.percent !== undefined || report.note || report.subSteps)) {
      const agentId = e.agentId
      let found = false
      await changeBoard($, b => {
        if (!b.agents.some(a => a.id === agentId)) return b
        found = true
        return {
          ...b,
          agents: b.agents.map(a =>
            a.id === agentId ? { ...a, report: { percent: report.percent ?? a.report?.percent, note: report.note ?? a.report?.note, subSteps: report.subSteps ?? a.report?.subSteps, at } } : a,
          ),
        }
      })
      if (found) return { result: 'Recorded on this subagent’s row. The user sees it in the Headway pane.' }
    }
    const said = [sized > 0 && `Sized ${sized} step${sized === 1 ? '' : 's'}.`, matched && `Recorded on “${matched}”.`].filter(Boolean)
    return {
      result:
        said.length > 0
          ? `${said.join(' ')} The user sees it in the Headway pane.`
          : 'No matching step: write your plan first (update_plan or TodoWrite), then report on a step of it.',
    }
  })

  // The app's title for the session arrives with each prompt (and on start),
  // so a rename shows from the next prompt on.
  on('classic.SessionStart', async ($, e, next) => {
    await keepTitle($, e.session_title)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await keepTitle($, e.session_title)
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold a prompt over a headway bug

  on('classic.PermissionRequest', async ($, e, next) => {
    const loop = (e as unknown as { agent_id?: string }).agent_id ?? MAIN
    const now = await $.clock.now()
    await changeBoard($, b => {
      const open = [...b.activity].reverse().find(a => a.loop === loop && a.endedAt === undefined)
      const waits = b.waits.some(w => w.loop === loop && w.end === undefined) ? b.waits : [...b.waits, { loop, start: now }].slice(-200)
      if (!open) return { ...b, waits }
      return { ...b, waits, activity: b.activity.map(a => (a.id === open.id ? { ...a, needsYou: true } : a)) }
    })
    return next(e)
  }).catch(($, e, next) => next(e)) // never block the prompt over a headway bug

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await reconcileTasks($, e.background_tasks)
    return result
  }).catch(($, e, next) => next(e)) // never hold the turn's end over a headway bug

  // A subagent's turn ending carries the same session-wide list: more chances
  // to see a background task end while the main turn runs on.
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await reconcileTasks($, e.background_tasks)
    return result
  }).catch(($, e, next) => next(e))

  // An agent's run ended: its report is on its way to the parent.
  on('agent.report', async ($, e, next) => {
    const result = await next(e)
    await endAgent($, e.agentId, e.status === 'stopped' ? 'killed' : e.status, 'report')
    return result
  }).catch(($, e, next) => next(e)) // never hold a report over a headway bug

  // A background task's notification says how it ended, as it arrives.
  on('prompt.submit', async ($, e, next) => {
    const origin = (e as unknown as { origin?: { kind?: string } }).origin
    if (origin?.kind === 'task-notification' || /<task-notification>/i.test(e.text)) await endByNotification($, parseNotifications(e.text))
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold a prompt over a headway bug

  // Subagents, nested under the step their parent was on when it spawned them.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!('agentId' in spawned) || !spawned.agentId) return spawned
    const agentId = spawned.agentId
    const now = await $.clock.now()
    await changeBoard($, b => {
      if (b.agents.some(a => a.id === agentId)) return b
      const row: AgentRow = {
        id: agentId,
        description: e.description || e.subagentType,
        type: e.subagentType,
        status: 'running',
        parentId: e.parentAgentId,
        step: stepOf(b, e.parentAgentId ?? MAIN),
        startedAt: now,
      }
      return { ...b, agents: [...b.agents, row].slice(-100) }
    })
    return spawned
  }).catch(($, e, next) => next(e)) // never block the spawn over a headway bug

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    // A drawing that throws makes the engine close the pane, and every reopen
    // would draw the same board and close it again. So a fault draws a plain
    // fallback instead, with a way out, and the pane stays.
    try {
      return await drawPane()
    } catch (err) {
      const { Box, Text, Button } = table
      return (
        <Box flexDirection="column" gap="sm" paddingX="xs" paddingY="xs">
          <Text weight="semibold">Headway hit a problem drawing this board.</Text>
          <Text size="caption" dimColor wrap="wrap">
            {err instanceof Error ? err.message : String(err)}
          </Text>
          <Button key="reset-board" label="Clear the board" onPress={() => void changeBoard($, () => EMPTY_BOARD)} />
        </Box>
      )
    }

    async function drawPane() {
    const { Box, Text, Button } = table
    // The terminal is the one surface without SVG; it gets lines of rules and no ⓘ.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const Input = 'Input' in table ? table.Input : undefined
    // A board saved by an earlier version lacks the newer fields: fill them in.
    const b: Board = { ...EMPTY_BOARD, ...(await read($, boardAtom)) }
    const storedOthers = await read($, othersAtom)
    const others = Array.isArray(storedOthers) ? storedOthers : []
    const storedView = await read($, viewAtom)
    const view: View = storedView && Array.isArray(storedView.open) ? storedView : EMPTY_VIEW
    const storedHistory = await read($, historyAtom)
    const history: Record<string, number[]> = storedHistory && typeof storedHistory === 'object' ? storedHistory : {}
    const now = await $.clock.now()
    // The session's title, not its folder: the app reuses worktree folders,
    // so a folder can carry the name of an older, unrelated session.
    const here = b.title || basename(await $.session.root())
    const columns = Math.max(24, e.props.bodyColumns ?? 40)
    const scrollTop = e.props.scroll?.offset ?? 0
    const isOpen = (key: string) => view.open.includes(key)

    // ── Where things sit ────────────────────────────────────────────────
    // A tooltip floats above its line, so it has only the rows between that
    // line and the top of the visible pane. The pane is drawn top to bottom
    // in the order this hook builds it, so `y` counts rows as they are built.
    // It counts low on purpose (each line as 0.8 of a row, gaps as nothing):
    // a card sized to fit an undercount always fits the real room.
    let y = 0
    const advance = (rows: number) => {
      y += rows
    }
    const LINE = 0.8
    const CARD_LINE = 0.85
    const CARD_FRAME = 1.3
    const perLine = Math.max(16, columns - 6)
    const linesOf = (text: string) => Math.max(1, Math.ceil(text.length / perLine))
    /**
     * The sentences that fit in the room above a line, most important first,
     * or none: a card is shown whole or not at all, never cut off by the pane.
     */
    const fit = (sentences: string[], at: number): string | undefined => {
      const room = at - scrollTop
      const maxLines = Math.floor((room - CARD_FRAME) / CARD_LINE)
      if (maxLines < 1) return undefined
      const kept: string[] = []
      for (const sentence of sentences.filter(Boolean)) {
        const next = [...kept, sentence].join(' ')
        if (linesOf(next) > maxLines) break
        kept.push(sentence)
      }
      if (kept.length > 0) return kept.join(' ')
      const first = sentences.find(Boolean)
      return first ? `${first.slice(0, maxLines * perLine - 1).trimEnd()}…` : undefined
    }

    // ── Primitives ──────────────────────────────────────────────────────

    const sectionLabel = (text: string, aside?: string) => {
      advance(LINE)
      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="caption" weight="semibold" dimColor>
            {text.toUpperCase()}
          </Text>
          {aside && (
            <Text size="caption" dimColor>
              {aside}
            </Text>
          )}
        </Box>
      )
    }

    const caption = (text: string, color?: string) => {
      advance(LINE)
      return (
        <Text size="caption" dimColor={!color} color={color} wrap="truncate-end">
          {text}
        </Text>
      )
    }

    // Tooltips. The trigger and its card sit in a keyed Box: a keyed Box is a
    // hover scope, so the card shows the instant the pointer is over it. The
    // card is absolute, so it leaves the flow and showing it moves nothing.
    // The engine places it against its parent (the keyed Box, as wide as the
    // trigger's line) and paints it over what comes before it, so it floats
    // upward (bottom: 1) over the rows above, opaque, sized by `fit` to the
    // room it has. The terminal has no pointer, so it gets the trigger alone.
    const pointer = e.surface !== 'terminal'
    const tip = (key: string, trigger: ReturnType<typeof h>, sentences: string[], at: number) => {
      const text = pointer ? fit(sentences, at) : undefined
      if (!text) return trigger
      return (
        <Box key={`tip:${key}`} flexDirection="column">
          {trigger}
          <Box
            display="none"
            hover={{ display: 'flex' }}
            position="absolute"
            bottom={1}
            left={0}
            right={0}
            flexDirection="column"
            paddingX="sm"
            paddingY="xs"
            borderStyle="round"
            borderColor={TIP.border}
            backgroundColor={TIP.background}
          >
            <Text size="caption" color={TIP.text} wrap="wrap">
              {text}
            </Text>
          </Box>
        </Box>
      )
    }
    /** A cue that the line it sits on explains itself on hover. */
    const infoIcon = () =>
      pointer ? (
        <Text size="caption" color="suggestion">
          ⓘ
        </Text>
      ) : null

    const textBar = (spec: BarSpec, t: { done: string; estimate: string; rest: string }) => {
      const color = spec.isComplete ? 'success' : spec.tone === 'error' ? 'error' : spec.tone === 'warning' ? 'warning' : 'claude'
      return (
        <Text>
          <Text color={color}>{t.done}</Text>
          <Text color={color} dimColor>
            {t.estimate}
          </Text>
          <Text color="subtle">{t.rest}</Text>
        </Text>
      )
    }
    const bar = (spec: BarSpec, height: number) => {
      advance(LINE)
      if (Svg) return <Svg source={barSvg(spec, height)} alt={`${Math.round(spec.done * 100)}% done`} height={height} />
      return textBar(spec, barText(spec, columns - 2))
    }
    const rowBar = (spec: BarSpec) => {
      advance(LINE * 0.6)
      if (Svg) return <Svg source={barSvg(spec, 4)} alt={`${Math.round((spec.done + spec.estimate) * 100)}%`} height={4} />
      return textBar(spec, barText(spec, Math.max(8, columns - 8)))
    }

    const toneOf = (hl: Health): BarSpec['tone'] =>
      hl === 'failed' || hl === 'needs-you' ? 'error' : hl === 'slow' || hl === 'quiet' ? 'warning' : 'normal'

    const badge = (hl: Health) => (
      <Box flexDirection="row" gap="xs" alignItems="center">
        <Text size="footnote" color={HEALTH[hl].color} weight="medium">
          ● {HEALTH[hl].label}
        </Text>
      </Box>
    )

    type Action = { label: string; run: () => void; primary?: boolean }
    /** At most two, and only the ones that make sense for the row's state. */
    const actions = (key: string, list: Action[]) => {
      if (list.length === 0) return null
      advance(1.2)
      return (
        <Box flexDirection="row" gap="xs">
          {list.slice(0, 2).map(a => (
            <Button key={`${key}:${a.label}`} label={a.label} variant={a.primary ? 'primary' : 'secondary'} onPress={() => a.run()} />
          ))}
        </Box>
      )
    }

    const composer = (key: string, target: Target, placeholder: string) => {
      if (view.composing !== key || !Input) return null
      advance(2)
      return <Input key={`note:${key}`} placeholder={placeholder} submitLabel="Send" rows={2} autoFocus onSubmit={value => void sendNote($, target, key, value)} />
    }

    const toggleButton = (key: string) => (
      <Button key={`toggle:${key}`} plain label={isOpen(key) ? '▾' : '▸'} onPress={() => void toggle($, key)} />
    )

    const timeline = (items: Activity[], since?: number) => {
      if (items.length === 0) return caption('No tool calls yet.')
      const shown = items.slice(-5)
      return (
        <Box flexDirection="column">
          {items.length > shown.length && caption(`${items.length - shown.length} earlier calls`)}
          {shown.map(a => {
            advance(LINE)
            const offset = since !== undefined ? `+${duration(a.startedAt - since)}` : ago(now - a.startedAt)
            const took = a.endedAt !== undefined ? duration(a.endedAt - a.startedAt) : '…'
            const color = a.isError || a.needsYou ? 'error' : a.endedAt === undefined ? 'claude' : undefined
            return (
              <Box key={`act:${a.id}`} flexDirection="row" gap="sm">
                <Text size="caption" mono dimColor>
                  {offset.padStart(6, ' ')}
                </Text>
                <Box flexShrink={1} flexGrow={1} minWidth={0}>
                  <Text size="caption" color={color} dimColor={!color} wrap="truncate-end">
                    {a.tool}
                    {a.summary ? ` · ${a.summary}` : ''}
                  </Text>
                </Box>
                <Text size="caption" mono dimColor>
                  {took}
                </Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    /**
     * A row: toggle and status mark, then one column holding the name (with
     * its tag and time on the same line) and, under it, the bar. Every bar
     * starts where the names start and runs to the right edge.
     */
    const rowLine = (
      key: string,
      mark: string,
      markColor: string,
      name: string,
      opts: { strong?: boolean; faded?: boolean; tag?: string; mini?: BarSpec; miniTip?: string[]; right?: string },
    ) => {
      advance(LINE)
      const barAt = y
      const barLine = opts.mini ? tip(`bar:${key}`, rowBar(opts.mini), opts.miniTip ?? [], barAt) : null
      return (
        <Box flexDirection="row" gap="sm">
          {toggleButton(key)}
          <Text mono color={markColor}>
            {mark}
          </Text>
          <Box flexDirection="column" gap="xs" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexDirection="row" gap="sm" alignItems="center">
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {/* The whole name opens and closes the row, not just the ▸ beside it. */}
                <Button key={`open:${key}`} plain onPress={() => void toggle($, key)}>
                  <Text weight={opts.strong ? 'semibold' : 'regular'} dimColor={opts.faded} wrap="truncate-end">
                    {name}
                  </Text>
                </Button>
              </Box>
              {opts.tag && (
                <Text size="caption" color="suggestion" weight="medium">
                  {opts.tag}
                </Text>
              )}
              {opts.right && (
                <Text size="caption" mono dimColor>
                  {opts.right}
                </Text>
              )}
            </Box>
            {barLine}
          </Box>
        </Box>
      )
    }

    // ── The numbers ─────────────────────────────────────────────────────

    const main = b.plans[MAIN]
    const steps = main?.steps ?? []
    const ctx = contextOf(b, MAIN, now, history)
    const model = calibrate(main, ctx)
    const mainH = loopHealth(b, MAIN, now, history)
    const eta = sessionEta(b, now, history)
    const slip = slips(b.etaLog, now)
    const isSlipping = slip.count >= 2 || slip.movedMs > 10 * 60_000
    const current = steps.find(s => s.status === 'in_progress')
    const currentEst = current ? estimateStep(current, model, ctx) : undefined
    const isPaused = steps.some(s => s.status !== 'completed') && !b.turn.running

    const BASIS_TAG: Record<string, string> = {
      reported: "session's estimate",
      calibrated: 'calibrated',
      measured: 'measured',
      history: 'past sessions',
      sized: 'unchecked guess',
    }

    // ── Steps: keys, evidence, details ──────────────────────────────────

    // Two steps of one name still get keys of their own.
    const keyed = new Map<Step, string>()
    const seenKeys = new Map<string, number>()
    for (const s of steps) {
      const base = `step:${s.content}`
      const n = (seenKeys.get(base) ?? 0) + 1
      seenKeys.set(base, n)
      keyed.set(s, n === 1 ? base : `${base}#${n}`)
    }
    const stepKey = (s: Step) => keyed.get(s) ?? `step:${s.content}`
    const active = activeStep(main)

    /** The last sign of work on a step: its own evidence, and the main turn while it runs on its active step. */
    const signalOf = (step: Step) => {
      const at = stepSignalAt(step, b.activity, b.agents, b.tasks)
      return at !== undefined && b.turn.running && step.content === active ? Math.max(at, b.turn.startedAt ?? 0) : at
    }

    /**
     * A step still marked in progress with nothing working on it and no sign
     * of work for `staleMinutes` reads "stale?": it may have finished without
     * being checked off. A running subagent, task or tool call on it keeps it live.
     */
    const staleness = (step: Step): { quietMs: number } | undefined => {
      if (step.status !== 'in_progress') return undefined
      const isLive =
        b.agents.some(a => a.step === step.content && !ENDED.has(a.status)) ||
        b.tasks.some(t => t.step === step.content && t.status === 'running') ||
        b.activity.some(a => a.step === step.content && a.endedAt === undefined)
      if (isLive) return undefined
      const at = signalOf(step)
      if (at === undefined || now - at <= staleMs) return undefined
      return { quietMs: now - at }
    }

    const stepFacts = (step: Step, stale: { quietMs: number } | undefined) => {
      if (step.status === 'pending') return 'Not started.'
      if (step.status === 'completed') {
        const when = step.completedAt !== undefined ? `Done ${ago(now - step.completedAt)}` : 'Done'
        return step.closedBy === 'report' ? `${when} · closed by its own report` : when
      }
      const signal = signalOf(step)
      return [
        step.startedAt !== undefined && `Started ${ago(now - step.startedAt)}`,
        signal !== undefined && `last sign of work ${ago(now - signal)}`,
        stale && 'stale?',
      ]
        .filter(Boolean)
        .join(' · ')
    }

    /**
     * Each part with a bar of its own: done parts full, a part's own percent
     * where reported, else the part in progress takes what the step's percent
     * leaves after the done ones (pale, at half, with no percent at all).
     */
    const subStepList = (key: string, step: Step, subs: SubStep[]) => {
      const done = subs.filter(x => x.status === 'completed').length
      const fromStep = step.percent !== undefined ? Math.min(1, Math.max(0, (step.percent / 100) * subs.length - done)) : undefined
      return (
        <Box flexDirection="column" gap="xs">
          {subs.map((x, i) => {
            const measured = x.status === 'completed' ? 1 : x.percent !== undefined ? x.percent / 100 : x.status === 'in_progress' && fromStep ? fromStep : 0
            const guessed = x.status === 'in_progress' && measured === 0 ? 0.5 : 0
            const words =
              x.status === 'completed' ? 'done' : measured > 0 ? `${Math.round(measured * 100)}%` : x.status === 'in_progress' ? 'in progress' : 'not started'
            advance(LINE)
            return (
              <Box key={`sub:${key}:${i}`} flexDirection="column">
                <Box flexDirection="row" gap="sm">
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text size="footnote" dimColor={x.status !== 'in_progress'} wrap="truncate-end">
                      {x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '●' : '○'} {x.content}
                    </Text>
                  </Box>
                  <Text size="caption" mono dimColor>
                    {words}
                  </Text>
                </Box>
                {rowBar({ done: measured, estimate: guessed, isComplete: x.status === 'completed' })}
              </Box>
            )
          })}
        </Box>
      )
    }

    /** A step a later plan dropped: what it was, and why it left. */
    const archivedStepRow = (step: ArchivedStep, i: number) => {
      const key = `archived:${i}:${step.content}`
      const isDone = step.reason === 'done'
      const head = rowLine(key, isDone ? '✓' : '⤳', isDone ? 'success' : 'subtle', step.content, {
        faded: true,
        right: isDone ? 'done' : 'superseded',
      })
      const subs = step.subSteps ?? []
      const body = isOpen(key) ? (
        <Box flexDirection="column" gap="xs" marginLeft="lg" marginTop="xs">
          {caption(
            isDone
              ? `Finished, then left out of a later plan ${ago(now - step.archivedAt)}.`
              : `A later plan replaced it ${ago(now - step.archivedAt)}, before it was checked off${step.status === 'in_progress' ? ' (it was in progress)' : ''}.`,
          )}
          {subs.length > 0 && subStepList(key, step, subs)}
        </Box>
      ) : null
      return (
        <Box key={key} flexDirection="column">
          {head}
          {body}
        </Box>
      )
    }

    // ── Rows ────────────────────────────────────────────────────────────

    const taskRow = (task: BgTask) => {
      const key = `task:${task.id}`
      const hl = taskHealth(task, now)
      const running = task.status === 'running'
      const mark = { running: '◐', completed: '✓', failed: '✗', stopped: '■' }[task.status]
      const color = task.status === 'failed' ? 'error' : running ? (hl === 'quiet' ? 'warning' : 'claude') : 'subtle'
      const elapsed = (task.endedAt ?? now) - task.startedAt
      const target: Target = { kind: 'task', task }
      const left = task.kind === 'monitor' && task.timeoutMs && running ? `ends by ${duration(task.timeoutMs - elapsed)}` : undefined
      const right = running ? left ?? duration(elapsed) : `${task.status} · ${duration(elapsed)}`
      const quiet = running && hl === 'quiet' ? `No output for ${duration(now - (task.lastOutputAt ?? task.startedAt))}` : undefined
      const head = rowLine(key, mark, color, task.description, { faded: !running, right })
      const under = quiet ? caption(quiet, 'warning') : running && task.lastLine ? caption(task.lastLine) : null
      const body = isOpen(key) ? (
        <Box flexDirection="column" gap="xs" marginLeft="lg" marginTop="xs">
          {caption(`${task.kind} · started ${ago(now - task.startedAt)}${task.step ? ` during “${task.step}”` : ''}${task.bytes !== undefined ? ` · ${Math.round(task.bytes / 1024)} KB output` : ''}`)}
          {caption(task.kind === 'shell' ? 'A shell command has no estimate: it runs until it exits.' : task.kind === 'monitor' ? 'A monitor ends at its deadline at the latest.' : 'A workflow reports when it finishes.')}
          {!running && task.lastLine && caption(`Last output: ${task.lastLine}`)}
          {actions(
            key,
            running
              ? [{ label: 'Stop', run: () => void intervene($, 'stop', target), primary: hl === 'quiet' }]
              : task.status === 'failed' || task.status === 'stopped'
                ? [{ label: 'Retry', run: () => void intervene($, 'retry', target) }]
                : [],
          )}
        </Box>
      ) : null
      return (
        <Box key={key} flexDirection="column">
          {head}
          {under}
          {body}
        </Box>
      )
    }

    const agentRow = (row: AgentRow): ReturnType<typeof h> => {
      const key = `agent:${row.id}`
      const plan = b.plans[row.id]
      const p = progress(plan)
      const actx = contextOf(b, row.id, now, history)
      const hl = loopHealth(b, row.id, now, history)
      const ended = ENDED.has(row.status)
      const mark = { pending: '○', running: '◐', waiting: '◷', idle: '·', completed: '✓', failed: '✗', killed: '■' }[row.status] ?? '?'
      const color = row.status === 'failed' ? 'error' : ended ? 'subtle' : hl === 'on-track' ? 'claude' : HEALTH[hl].color
      const elapsed = (row.endedAt ?? now) - row.startedAt
      const target: Target = { kind: 'loop', loop: row.id, label: row.description }
      const aeta = !ended ? planEta(plan, actx) : undefined
      const frac = planFraction(plan, actx)
      const said = row.report
      const saidFrac = said?.percent !== undefined ? said.percent / 100 : said?.subSteps?.length ? said.subSteps.filter(x => x.status === 'completed').length / said.subSteps.length : undefined
      const stuck = hl === 'quiet' || hl === 'slow'
      const right = ended ? `${row.type} · ${duration(elapsed)}` : aeta && aeta.basis !== 'none' ? `${range(aeta)}` : `${row.type} · ${duration(elapsed)}`
      const head = rowLine(key, mark, color, row.description, {
        faded: ended,
        mini:
          p.total > 0
            ? { done: frac.measured, estimate: frac.estimated, isComplete: p.done === p.total, tone: toneOf(hl) }
            : saidFrac !== undefined
              ? { done: saidFrac, estimate: 0, isComplete: ended || saidFrac >= 1, tone: toneOf(hl) }
              : undefined,
        miniTip: [
          p.total > 0 ? `${p.done} of ${p.total} of its own steps done.` : saidFrac !== undefined ? `${Math.round(saidFrac * 100)}%, as it reported ${ago(now - (said?.at ?? now))}.` : '',
          aeta && aeta.basis !== 'none' ? `About ${range(aeta)} left, from ${basisWords(aeta.basis, calibrate(plan, actx))}.` : 'No estimate for its remaining steps yet.',
        ],
        right,
      })
      const trouble =
        !ended && hl !== 'on-track' && hl !== 'idle'
          ? caption(`${HEALTH[hl].label}: ${HEALTH[hl].meaning}`, HEALTH[hl].color)
          : !ended && said?.note
            ? caption(said.note)
            : null
      const endWords =
        row.endedBy === 'gone'
          ? 'Ended: the engine no longer lists it.'
          : row.endedBy === 'report'
            ? `Ended ${ago(now - (row.endedAt ?? now))}: its report reached its parent.`
            : row.endedBy === 'notification'
              ? `Ended ${ago(now - (row.endedAt ?? now))}: a task notification said ${row.status}.`
              : ended
                ? `Ended ${ago(now - (row.endedAt ?? now))}.`
                : undefined
      const body = isOpen(key) ? (
        <Box flexDirection="column" gap="xs" marginLeft="lg" marginTop="xs">
          {endWords && caption(endWords)}
          {(!plan || plan.steps.length === 0) && said?.subSteps && said.subSteps.length > 0 && subStepList(key, { content: row.description, status: 'in_progress', percent: said.percent }, said.subSteps)}
          {plan && plan.steps.length > 0 && (
            <Box flexDirection="column">
              {plan.steps.map(s => {
                advance(LINE)
                return (
                  <Text key={`astep:${row.id}:${s.content}`} size="caption" dimColor={s.status !== 'in_progress'} wrap="truncate-end">
                    {s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '●' : '○'} {s.content}
                  </Text>
                )
              })}
            </Box>
          )}
          {timeline(b.activity.filter(a => a.loop === row.id), row.startedAt)}
          {b.tasks.filter(t => t.loop === row.id).map(t => taskRow(t))}
          {b.agents.filter(a => a.parentId === row.id).map(child => agentRow(child))}
          {!ended &&
            actions(
              key,
              stuck
                ? [
                    { label: 'Status check', run: () => void intervene($, 'status', target), primary: true },
                    { label: 'Stop', run: () => void intervene($, 'stop', target) },
                  ]
                : hl === 'needs-you'
                  ? []
                  : [{ label: 'Add context', run: () => void compose($, key) }],
            )}
          {composer(key, target, `Context for “${row.description}”…`)}
        </Box>
      ) : null
      return (
        <Box key={key} flexDirection="column">
          {head}
          {trouble}
          {body}
        </Box>
      )
    }

    const stepRow = (step: Step) => {
      const key = stepKey(step)
      const est = estimateStep(step, model, ctx)
      const isCurrent = step.status === 'in_progress'
      const agents = b.agents.filter(a => !a.parentId && a.step === step.content)
      const tasks = b.tasks.filter(t => t.step === step.content)
      const acts = b.activity.filter(a => a.loop === MAIN && a.step === step.content)
      const stale = staleness(step)
      const hl: Health = isCurrent ? (stale && mainH !== 'needs-you' ? 'quiet' : mainH) : 'on-track'
      const target: Target = { kind: 'loop', loop: MAIN, label: step.content }
      const mark = step.status === 'completed' ? '✓' : stale ? '◌' : isCurrent ? '●' : '○'
      const markColor = step.status === 'completed' ? 'success' : stale ? 'warning' : isCurrent ? (hl === 'on-track' || hl === 'idle' ? 'claude' : HEALTH[hl].color) : 'subtle'
      const right =
        stale
          ? `stale? · ${duration(stale.quietMs)}`
          : step.status === 'completed'
          ? step.isBatch || est.activeMs < 1000
            ? 'done'
            : duration(est.activeMs)
          : isCurrent
            ? est.overByMs !== undefined
              ? `over by ${duration(est.overByMs)}`
              : est.remainingMs !== undefined
                ? `~${duration(est.remainingMs)} left`
                : `${duration(est.activeMs)} so far`
            : est.expectedMs !== undefined
              ? `~${duration(est.expectedMs)}`
              : 'no estimate'
      const tag = step.priority === 'next' ? 'Up next' : step.priority === 'deferred' ? 'Deferred' : step.priority === 'skip' ? 'Skipping' : undefined
      const subs = step.subSteps ?? []
      const subsDone = subs.filter(s => s.status === 'completed').length
      const basis = basisWords(est.basis, model)
      const barTip =
        step.status === 'completed'
          ? [
              step.isBatch ? 'Checked off together with other steps, so its own time is unknown and it is left out of the estimates.' : `Took ${duration(est.activeMs)} of working time.`,
              est.expectedMs !== undefined && !step.isBatch ? `Expected ~${duration(est.expectedMs)}.` : '',
            ]
          : step.status === 'pending'
            ? est.expectedMs !== undefined
              ? [`Expected ~${duration(est.expectedMs)}, from ${basis}.`, step.size ? `Sized ${step.size}.` : '']
              : ["No estimate: the session hasn't sized this step and nothing similar has finished, so it isn't counted in the time left."]
            : [
                est.isEstimated
                  ? `About ${Math.round(est.fraction * 100)}%, inferred from time: ${duration(est.activeMs)} of working time so far.`
                  : `${Math.round(est.fraction * 100)}%, as the session reported${step.reportedAt ? ` ${ago(now - step.reportedAt)}` : ''}.`,
                est.overByMs !== undefined
                  ? `Past its estimate of ~${duration(est.expectedMs ?? 0)} by ${duration(est.overByMs)}; the time left is unknown, so it counts half as long again.`
                  : est.expectedMs !== undefined
                    ? `Expected ~${duration(est.expectedMs)} in all, from ${basis}.`
                    : 'No estimate for this step yet.',
                'Working time only: the clock stops while the session waits on you.',
              ]
      if (stale) barTip.unshift(`No sign of work for ${duration(stale.quietMs)}: no tool call, report, subagent or task on it. It may have finished without being checked off.`)
      const head = rowLine(key, mark, markColor, step.content, {
        strong: isCurrent,
        faded: step.status === 'completed',
        tag,
        mini: {
          done: est.isEstimated ? 0 : est.fraction,
          estimate: est.isEstimated ? est.fraction : 0,
          isComplete: step.status === 'completed',
          tone: isCurrent ? (est.overByMs !== undefined ? 'warning' : toneOf(hl)) : 'normal',
        },
        miniTip: barTip,
        right,
      })
      const summary = step.blocker
        ? caption(`Blocked: ${step.blocker}`, 'error')
        : stale
          ? caption(`Stale? No sign of work for ${duration(stale.quietMs)}: it may be done but never checked off.`, 'warning')
        : isCurrent && hl !== 'on-track' && hl !== 'idle'
          ? caption(`${HEALTH[hl].label}: ${HEALTH[hl].meaning}`, HEALTH[hl].color)
          : isCurrent && (subs.length > 0 || step.note)
            ? caption([subs.length > 0 && `${subsDone}/${subs.length} parts`, step.note].filter(Boolean).join(' · '))
            : null
      const agentsLive = agents.filter(a => !ENDED.has(a.status)).length
      const tasksLive = tasks.filter(t => t.status === 'running').length
      const finished = agents.length - agentsLive + tasks.length - tasksLive
      const nestedLine =
        !isOpen(key) && agents.length + tasks.length > 0
          ? caption(
              [
                agentsLive > 0 && `${agentsLive} subagent${agentsLive === 1 ? '' : 's'}`,
                tasksLive > 0 && `${tasksLive} background task${tasksLive === 1 ? '' : 's'}`,
                finished > 0 && `${finished} finished`,
              ]
                .filter(Boolean)
                .join(' · '),
            )
          : null
      const overrun = isCurrent && (est.overByMs !== undefined || isSlipping)
      const stepActions: Action[] = stale
        ? [
            { label: 'Status check', run: () => void intervene($, 'status', target), primary: true },
            { label: 'Add context', run: () => void compose($, key) },
          ]
        : isCurrent
        ? hl === 'needs-you'
          ? []
          : overrun
            ? [
                { label: 'Ask for a new estimate', run: () => void intervene($, 'estimate', target, est.overByMs !== undefined ? `over by ${duration(est.overByMs)}` : ''), primary: true },
                { label: 'Wrap up', run: () => void intervene($, 'wrap', target) },
              ]
            : hl === 'slow'
              ? [
                  { label: 'Wrap up', run: () => void intervene($, 'wrap', target), primary: true },
                  { label: 'Add context', run: () => void compose($, key) },
                ]
              : hl === 'quiet'
                ? [
                    { label: 'Status check', run: () => void intervene($, 'status', target), primary: true },
                    { label: 'Add context', run: () => void compose($, key) },
                  ]
                : [{ label: 'Add context', run: () => void compose($, key) }]
        : step.status === 'pending'
          ? [
              { label: 'Do next', run: () => void intervene($, 'next', target) },
              { label: 'Skip', run: () => void intervene($, 'skip', target) },
            ]
          : []
      const body = isOpen(key) ? (
        <Box flexDirection="column" gap="sm" marginLeft="lg" marginTop="xs">
          {caption(stepFacts(step, stale))}
          {subs.length > 0 ? subStepList(key, step, subs) : step.status === 'in_progress' && caption('No parts reported for this step.')}
          {agents.map(a => agentRow(a))}
          {tasks.map(t => taskRow(t))}
          {step.status !== 'pending' && timeline(acts, step.startedAt)}
          {actions(key, stepActions)}
          {composer(key, target, `Context for “${step.content}”…`)}
        </Box>
      ) : null
      return (
        <Box key={key} flexDirection="column">
          {head}
          {summary}
          {nestedLine}
          {body}
        </Box>
      )
    }

    // ── This session ────────────────────────────────────────────────────

    const p = progress(main)
    const frac = planFraction(main, ctx)
    const overall = sessionHealth(b, now, history)
    const scope = describeScope(main, now)
    const stepNames = new Set(steps.map(s => s.content))
    // What is finished, or was dropped, leaves its section for the Archive
    // once it has been done a little while, so the sections hold live work.
    const isOld = (endedAt: number | undefined) => endedAt === undefined || now - endedAt > RECENT_MS
    const loose = b.agents.filter(a => !a.parentId && (!a.step || !stepNames.has(a.step)))
    const looseLive = loose.filter(a => !ENDED.has(a.status) || !isOld(a.endedAt))
    const tasksRunning = b.tasks.filter(t => t.status === 'running')
    const tasksUntied = b.tasks.filter(t => !t.step || !stepNames.has(t.step))
    const tasksShown = b.tasks.filter(t => t.status === 'running' || !isOld(t.endedAt))
    const stepsShown = steps.filter(s => s.status !== 'completed' || !isOld(s.completedAt))
    const stepsArchived = steps.filter(s => !stepsShown.includes(s))
    const latest = [...b.interventions].reverse().find(i => i.status === 'pending' || now - (i.deliveredAt ?? i.at) < 2 * 60_000)
    const spec: BarSpec = { done: frac.measured, estimate: frac.estimated, isComplete: p.total > 0 && p.done === p.total, tone: toneOf(overall) }
    const deliveredWords = (i: Intervention) =>
      i.status === 'pending'
        ? 'waiting for its next step'
        : i.status === 'failed'
          ? `not sent: ${i.reason ?? 'refused'}`
          : i.via === 'next-step'
            ? 'delivered at its next step'
            : i.via === 'new-turn'
              ? 'sent as a new message'
              : i.via === 'tool'
                ? 'done'
                : 'sent as a message'

    // The ETA says what it rests on, always: a number with its basis, or
    // plainly that there is no estimate yet.
    const etaText = !eta
      ? undefined
      : eta.basis === 'none'
        ? 'no estimate yet'
        : `${range(eta)} ${isPaused ? 'of work left' : 'left'} · ${BASIS_TAG[eta.basis] ?? eta.basis}${eta.unknown > 0 ? ` +${eta.unknown} unsized` : ''}`
    const etaSentences = !eta
      ? []
      : eta.basis === 'none'
        ? [
            'No estimate yet: no step is sized and none has finished.',
            'It appears once the session sizes its steps (it is asked to when it writes its plan) or a step finishes.',
          ]
        : [
            `From ${basisWords(eta.basis, model)}; ${eta.confidence} confidence.`,
            eta.unknown > 0 ? `${eta.unknown} step${eta.unknown === 1 ? ' has' : 's have'} no size yet and ${eta.unknown === 1 ? 'is' : 'are'}n't counted.` : '',
            eta.isOverrun ? 'A step is past its estimate, so the range is widened.' : '',
            isPaused ? 'Paused: the clock only runs while the session works.' : 'Counts working time only.',
          ]

    advance(LINE) // section label
    const sectionHead = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text size="caption" weight="semibold" dimColor>
          THIS SESSION
        </Text>
      </Box>
    )
    let session: ReturnType<typeof h>
    if (steps.length === 0) {
      session = (
        <Box flexDirection="column" gap="sm">
          {sectionHead}
          {caption('No plan yet. It appears here as soon as the session writes its task list.')}
        </Box>
      )
    } else {
      advance(1) // name and count
      const summaryRow = (
        <Box key="summary" flexDirection="row" justifyContent="space-between" alignItems="flex-end" gap="sm">
          <Box flexShrink={1} minWidth={0}>
            <Text weight="semibold" wrap="truncate-end">
              {here}
            </Text>
          </Box>
          <Box flexDirection="row" gap="sm" flexShrink={0}>
            <Text mono dimColor>
              {p.done}/{p.total}
            </Text>
            <Text mono weight="semibold">
              {percent(frac.measured + frac.estimated)}
            </Text>
          </Box>
        </Box>
      )
      const barAt = y
      const mainBar = tip(
        'bar:main',
        bar(spec, 8),
        [
          `${p.done} of ${p.total} steps done.`,
          spec.estimate > 0.005 ? 'The pale part is the step in progress, inferred from its working time.' : '',
        ],
        barAt,
      )
      const statusAt = y
      advance(LINE)
      const statusLine = tip(
        'status',
        <Box key="status" flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          {badge(overall)}
          {etaText && (
            <Box flexDirection="row" gap="xs" alignItems="center" flexShrink={1} minWidth={0}>
              <Text size="footnote" dimColor wrap="truncate-end">
                {etaText}
              </Text>
              {infoIcon()}
            </Box>
          )}
        </Box>,
        [...etaSentences, `${HEALTH[overall].label}: ${HEALTH[overall].meaning}`],
        statusAt,
      )
      const slipLine = isSlipping
        ? caption(
            `Finish moved ${slip.movedMs > 0 ? `+${duration(slip.movedMs)} later ` : ''}in the last ${duration(slip.sinceMs)}${slip.count > 0 ? ` (${slip.count} slip${slip.count === 1 ? '' : 's'})` : ''}`,
            'warning',
          )
        : null
      const scopeAt = y
      const scopeLine = scope
        ? (() => {
            advance(LINE)
            return tip(
              'scope',
              <Box key="scope" flexDirection="row" gap="xs" alignItems="center">
                <Box flexShrink={1} minWidth={0}>
                  <Text size="caption" dimColor wrap="truncate-end">
                    {scope.headline}
                  </Text>
                </Box>
                {infoIcon()}
              </Box>,
              scope.detail,
              scopeAt,
            )
          })()
        : null
      const latestLine = latest ? caption(`${INTERVENTION_LABEL[latest.kind]} · ${latest.label} — ${deliveredWords(latest)}`, latest.status === 'failed' ? 'error' : undefined) : null
      session = (
        <Box flexDirection="column" gap="sm">
          {sectionHead}
          <Box flexDirection="column" gap="xs">
            {summaryRow}
            <Box>{mainBar}</Box>
            {statusLine}
            {slipLine}
            {scopeLine}
            {latestLine}
          </Box>
        </Box>
      )
    }

    const stepList = steps.length > 0 && (
      <Box flexDirection="column" gap="xs">
        {sectionLabel('Steps', stepsArchived.length > 0 ? `${stepsArchived.length} done in Archive` : undefined)}
        {stepsShown.map(step => stepRow(step))}
        {stepsShown.length === 0 && caption('Every step is done.')}
      </Box>
    )

    const subagents = looseLive.length > 0 && (
      <Box flexDirection="column" gap="xs">
        {sectionLabel('Subagents')}
        {looseLive.map(row => agentRow(row))}
      </Box>
    )

    const background = tasksShown.length > 0 && (
      <Box flexDirection="column" gap="xs">
        {sectionLabel('Background tasks', tasksRunning.length > 0 ? `${tasksRunning.length} running` : undefined)}
        {tasksShown.map(t => taskRow(t))}
      </Box>
    )

    // ── Other sessions ──────────────────────────────────────────────────

    // Another session that finished, or has not reported in a while, is archived too.
    const healthOf = (one: SessionSummary): Health => (one.health in HEALTH ? one.health : 'idle')
    const isOtherOld = (one: SessionSummary) => healthOf(one) === 'done' || now - one.updatedAt > STALE_MS
    const othersLive = others.filter(one => !isOtherOld(one))
    const othersArchived = others.filter(isOtherOld)
    const othersLabel = sectionLabel('Other sessions', othersArchived.length > 0 ? `${othersArchived.length} in Archive` : undefined)
    const otherRow = (one: SessionSummary) => {
            const key = `session:${one.id}`
            const stale = now - one.updatedAt > STALE_MS
            const hl: Health = stale && healthOf(one) !== 'done' ? 'idle' : healthOf(one)
            const op: BarSpec = { done: one.total ? one.done / one.total : 0, estimate: 0, isComplete: one.total > 0 && one.done === one.total, tone: toneOf(hl) }
            const target: Target = { kind: 'session', summary: one, label: one.active ?? one.name }
            const stuck = hl === 'slow' || hl === 'quiet' || stale
            advance(1)
            const headLine = (
              <Box flexDirection="row" gap="sm" alignItems="center">
                {toggleButton(key)}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text weight="medium" wrap="truncate-end">
                    {one.name}
                  </Text>
                </Box>
                <Text mono dimColor>
                  {one.done}/{one.total}
                </Text>
                <Text mono weight="semibold">
                  {percent(op.done)}
                </Text>
              </Box>
            )
            const at = y
            const barLine = tip(
              `bar:${key}`,
              bar(op, 6),
              [
                `${one.done} of ${one.total} steps done, updated ${ago(now - one.updatedAt)}.`,
                one.eta ? `About ${range(one.eta)} left, from ${one.eta.basis}.` : 'No estimate yet.',
              ],
              at,
            )
            const line = caption(
              [HEALTH[hl].label, one.eta && `${range(one.eta)} left`, one.active].filter(Boolean).join(' · '),
              hl === 'on-track' || hl === 'done' || hl === 'idle' ? undefined : HEALTH[hl].color,
            )
            const body = isOpen(key) ? (
              <Box flexDirection="column" gap="xs" marginLeft="lg">
                {one.steps.map(s => {
                  advance(LINE)
                  return (
                    <Text key={`os:${one.id}:${s.content}`} size="caption" dimColor={s.status !== 'in_progress'} wrap="truncate-end">
                      {s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '●' : '○'} {s.content}
                    </Text>
                  )
                })}
                {caption(`Updated ${ago(now - one.updatedAt)}${one.agentsRunning ? ` · ${one.agentsRunning} subagents` : ''}${one.tasksRunning ? ` · ${one.tasksRunning} background tasks` : ''}`)}
                {actions(
                  key,
                  stuck
                    ? [
                        { label: 'Status check', run: () => void intervene($, 'status', target), primary: true },
                        { label: 'Add context', run: () => void compose($, key) },
                      ]
                    : [{ label: 'Add context', run: () => void compose($, key) }],
                )}
                {composer(key, target, `Context for ${one.name}…`)}
              </Box>
            ) : null
            return (
              <Box key={key} flexDirection="column" gap="xs">
                {headLine}
                {barLine}
                {line}
                {body}
              </Box>
            )
    }
    const othersBody =
      othersLive.length === 0 ? (
        caption(others.length === 0 ? 'None reporting yet. Sessions started since Headway was installed show up here.' : 'None working right now.')
      ) : (
        <Box flexDirection="column" gap="sm">
          {othersLive.map(one => otherRow(one))}
        </Box>
      )

    // ── Archive ─────────────────────────────────────────────────────────
    // Finished, dropped and stale-by-age work, newest first, collapsed until
    // its header is pressed.

    type Archived = { at: number; draw: () => ReturnType<typeof h> }
    const dropped = (main?.archived ?? []).map((s, i): Archived => ({ at: s.archivedAt, draw: () => archivedStepRow(s, i) }))
    const archivedItems: Archived[] = [
      ...stepsArchived.map(s => ({ at: s.completedAt ?? 0, draw: () => stepRow(s) })),
      ...dropped,
      ...loose.filter(a => !looseLive.includes(a)).map(a => ({ at: a.endedAt ?? a.startedAt, draw: () => agentRow(a) })),
      ...tasksUntied.filter(t => !tasksShown.includes(t)).map(t => ({ at: t.endedAt ?? t.startedAt, draw: () => taskRow(t) })),
      ...othersArchived.map(one => ({ at: one.updatedAt, draw: () => otherRow(one) })),
    ].sort((x, z) => z.at - x.at)
    const ARCHIVE_SHOWN = 40
    const archiveOpen = isOpen('archive')
    advance(LINE)
    const archive = archivedItems.length > 0 && (
      <Box key="archive" flexDirection="column" gap="xs">
        <Button key="toggle:archive" plain onPress={() => void toggle($, 'archive')}>
          <Text size="caption" weight="semibold" dimColor>
            {archiveOpen ? '▾' : '▸'} ARCHIVE
          </Text>
          <Text size="caption" dimColor>
            {` · ${archivedItems.length}`}
          </Text>
        </Button>
        {archiveOpen && archivedItems.slice(0, ARCHIVE_SHOWN).map(item => item.draw())}
        {archiveOpen && archivedItems.length > ARCHIVE_SHOWN && caption(`${archivedItems.length - ARCHIVE_SHOWN} older not shown`)}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="lg" paddingX="xs" paddingY="xs" width="100%">
        {session}
        {stepList}
        {subagents}
        {background}
        <Box flexDirection="column" gap="xs">
          {othersLabel}
          {othersBody}
        </Box>
        {archive}
      </Box>
    )
    }
  })
}

/** Starts tracking a background task the call just launched, or ends one it stopped. */
async function trackTask(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  loop: string,
  at: number,
) {
  const s = (o: Record<string, unknown> | undefined, k: string) => (o && typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const b = await getBoard($)
  const step = stepOf(b, loop)
  let task: BgTask | undefined
  if (tool === 'Bash' && s(result, 'backgroundTaskId')) {
    task = {
      id: s(result, 'backgroundTaskId')!,
      kind: 'shell',
      description: s(args, 'description') ?? s(args, 'command')?.slice(0, 80) ?? 'Background command',
      loop,
      step,
      status: 'running',
      startedAt: at,
      outputPath: s(result, 'backgroundOutputPath'),
    }
  } else if (tool === 'Monitor' && s(result, 'taskId')) {
    task = {
      id: s(result, 'taskId')!,
      kind: 'monitor',
      description: s(args, 'description') ?? 'Monitor',
      loop,
      step,
      status: 'running',
      startedAt: at,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : typeof result?.timeoutMs === 'number' ? (result.timeoutMs as number) : undefined,
    }
  } else if (tool === 'Workflow' && s(result, 'taskId')) {
    task = {
      id: s(result, 'taskId')!,
      kind: 'workflow',
      description: s(result, 'workflowName') ?? s(result, 'summary') ?? 'Workflow',
      loop,
      step,
      status: 'running',
      startedAt: at,
    }
  } else if (tool === 'TaskStop') {
    const id = s(args, 'task_id') ?? s(args, 'shell_id')
    if (id) {
      await changeBoard($, board => ({
        ...board,
        tasks: board.tasks.map(t => (t.id === id && t.status === 'running' ? { ...t, status: 'stopped', endedAt: at } : t)),
      }))
    }
    return
  }
  if (!task) return
  const added = task
  await changeBoard($, board => (board.tasks.some(t => t.id === added.id) ? board : { ...board, tasks: [...board.tasks, added].slice(-60) }))
}
