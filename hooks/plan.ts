// Pure logic: turning task-list tool calls into plans, and plans into numbers.
// Nothing here touches `$`, so it is easy to test and to reason about.

import type { Activity, AgentRow, ArchivedStep, BgTask, Plan, ScopeChange, Step, StepSize, StepStatus, SubStep } from '../types'

export const EMPTY_PLAN: Plan = { steps: [], changes: [], peak: 0, createdAt: 0, updatedAt: 0 }

const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'completed']

function toStatus(value: unknown): StepStatus {
  return STATUSES.includes(value as StepStatus) ? (value as StepStatus) : 'pending'
}

function toItems(raw: unknown): SubStep[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object')
    .map(one => {
      const item: SubStep = { content: String(one.content ?? '').trim(), status: toStatus(one.status) }
      if (typeof one.percent === 'number' && Number.isFinite(one.percent)) item.percent = Math.min(100, Math.max(0, one.percent))
      return item
    })
    .filter(one => one.content.length > 0)
}

// ── Matching names ───────────────────────────────────────────────────────
// The model names a step again in its own words: a report on "the tests" for
// "Run the tests", a rewritten plan that says "Fix the reopen bug" for "Fix
// reopen". Matching tolerantly keeps those updates instead of dropping them.

const FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with', 'step', 'it', 'its', 'this', 'that'])

/** The words of a name that carry its meaning: lowercased, punctuation and filler dropped, plurals folded. */
export function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !FILLER.has(w))
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

function overlap(a: string[], b: string[]): { shared: number; jaccard: number; aInB: boolean; bInA: boolean } {
  const A = new Set(a)
  const B = new Set(b)
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  const union = A.size + B.size - shared
  return { shared, jaccard: union === 0 ? 0 : shared / union, aInB: A.size > 0 && shared === A.size, bInA: B.size > 0 && shared === B.size }
}

/**
 * Whether two names are the same step, reworded: the same words, one's words
 * all inside the other's, or nearly all shared. Strict on purpose: it decides
 * whether a step's timing and reports carry into a rewritten plan.
 */
export function sameStep(a: string, b: string): boolean {
  if (a === b) return true
  const wa = wordsOf(a)
  const wb = wordsOf(b)
  if (wa.length === 0 || wb.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase()
  const o = overlap(wa, wb)
  return o.aInB || o.bInA || o.jaccard >= 0.75
}

/**
 * The step a name in a report means, or -1: exact, then the same words, then
 * one name inside the other, then "3" or "step 3", then the step sharing the
 * most words (at least half of the shorter name's).
 */
export function matchStep(steps: readonly { content: string }[], name: string): number {
  const exact = steps.findIndex(s => s.content === name)
  if (exact >= 0) return exact
  const lower = name.trim().toLowerCase()
  const folded = steps.findIndex(s => s.content.trim().toLowerCase() === lower)
  if (folded >= 0) return folded
  const wn = wordsOf(name)
  const key = wn.join(' ')
  if (key) {
    const same = steps.findIndex(s => wordsOf(s.content).join(' ') === key)
    if (same >= 0) return same
  }
  const inside = steps.findIndex(s => {
    const c = s.content.toLowerCase()
    return c.includes(lower) || lower.includes(c)
  })
  if (inside >= 0 && lower.length >= 3) return inside
  const numbered = /^(?:step\s*)?#?(\d{1,2})$/i.exec(name.trim())
  if (numbered) {
    const i = Number(numbered[1]) - 1
    return steps[i] ? i : -1
  }
  let best = -1
  let bestScore = 0
  steps.forEach((s, i) => {
    const ws = wordsOf(s.content)
    const o = overlap(wn, ws)
    const need = Math.max(1, Math.ceil(Math.min(wn.length, ws.length) / 2))
    if (o.shared < need) return
    const score = o.jaccard + (o.aInB || o.bInA ? 0.5 : 0)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  return best
}

/** Moves a step to a status, stamping when it started and finished. */
function moveTo(step: Step, status: StepStatus, at: number): Step {
  if (step.status === status) return step
  const next: Step = { ...step, status }
  if (status === 'in_progress' && next.startedAt === undefined) next.startedAt = at
  if (status === 'completed') {
    next.completedAt = at
    if (next.startedAt === undefined) next.startedAt = at
    delete next.priority
  }
  if (status !== 'completed') delete next.completedAt
  return next
}

/** Records how scope moved when a plan's step list is replaced. */
function scopeChange(before: Step[], after: Step[], at: number): ScopeChange | undefined {
  if (before.length === 0) return undefined // the first plan sets scope, it does not change it
  const was = new Set(before.map(s => s.content))
  const now = new Set(after.map(s => s.content))
  const added = after.map(s => s.content).filter(c => !was.has(c))
  const removed = before.map(s => s.content).filter(c => !now.has(c))
  if (added.length === 0 && removed.length === 0) return undefined
  return { at, from: before.length, to: after.length, added, removed }
}

/**
 * Marks steps that this one update completed together. Models often tick off
 * several steps at once, after the fact: those finish times are not when the
 * work was done, so the estimator leaves them out of its timing.
 */
function markBatch(before: Step[], after: Step[]): Step[] {
  const was = new Map(before.map(s => [s.content, s.status]))
  const fresh = after.filter(s => s.status === 'completed' && was.get(s.content) !== 'completed')
  if (fresh.length < 2) return after
  const names = new Set(fresh.map(s => s.content))
  return after.map(s => (names.has(s.content) ? { ...s, isBatch: true } : s))
}

const ARCHIVE_LIMIT = 60

/**
 * Pairs each new item with the old step it continues: the same name first,
 * then (for the rest) the same step reworded. A finished step only continues
 * as a finished one, so a new step never inherits an old step's timing.
 */
function pairUp(before: Step[], items: SubStep[]): (Step | undefined)[] {
  const used = new Set<number>()
  const pairs: (Step | undefined)[] = items.map(item => {
    const i = before.findIndex((s, j) => !used.has(j) && s.content === item.content)
    if (i < 0) return undefined
    used.add(i)
    return before[i]
  })
  items.forEach((item, k) => {
    if (pairs[k]) return
    const i = before.findIndex(
      (s, j) => !used.has(j) && (s.status !== 'completed' || item.status === 'completed') && sameStep(s.content, item.content),
    )
    if (i < 0) return
    used.add(i)
    pairs[k] = before[i]
  })
  return pairs
}

/** Replaces the step list, carrying each surviving step's timing and reports; dropped steps go to the archive. */
function replace(plan: Plan, items: SubStep[], at: number): Plan {
  const pairs = pairUp(plan.steps, items)
  const steps = markBatch(
    plan.steps.map(s => {
      // Renamed steps compare by their new name.
      const k = pairs.indexOf(s)
      return k >= 0 ? { ...s, content: items[k]!.content } : s
    }),
    items.map((item, k) => {
      const kept: Step = pairs[k] ? { ...pairs[k]!, content: item.content } : { content: item.content, status: 'pending' }
      return moveTo(kept, item.status, at)
    }),
  )
  const kept = new Set(pairs.filter(Boolean))
  const dropped: ArchivedStep[] = plan.steps
    .filter(s => !kept.has(s))
    .map(s => ({ ...s, archivedAt: at, reason: s.status === 'completed' ? 'done' : 'superseded' }))
  const change = scopeChange(plan.steps, steps, at)
  const archived = dropped.length > 0 ? [...(plan.archived ?? []), ...dropped].slice(-ARCHIVE_LIMIT) : plan.archived
  return {
    steps,
    changes: change ? [...plan.changes, change].slice(-20) : plan.changes,
    peak: Math.max(plan.peak, steps.length),
    createdAt: plan.createdAt || at,
    updatedAt: at,
    ...(archived ? { archived } : {}),
  }
}

function setStatus(steps: Step[], index: number, status: StepStatus, at: number): Step[] {
  return steps.map((s, i) => (i === index ? moveTo(s, status, at) : s))
}

/** The Claude desktop app's `update_plan`: items | advance | done + start (1-based). */
export function applyUpdatePlan(plan: Plan, args: Record<string, unknown>, at: number): Plan {
  const items = toItems(args.items)
  if (items) return replace(plan, items, at)

  let steps = plan.steps
  if (args.advance === true) {
    const current = steps.findIndex(s => s.status === 'in_progress')
    if (current >= 0) steps = setStatus(steps, current, 'completed', at)
    const next = steps.findIndex((s, i) => i > current && s.status === 'pending')
    if (next >= 0) steps = setStatus(steps, next, 'in_progress', at)
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done) {
      if (typeof n === 'number' && steps[n - 1]) steps = setStatus(steps, n - 1, 'completed', at)
    }
  }
  if (typeof args.start === 'number' && steps[args.start - 1]) {
    steps = setStatus(steps, args.start - 1, 'in_progress', at)
  }
  return steps === plan.steps ? plan : { ...plan, steps: markBatch(plan.steps, steps), updatedAt: at }
}

/** Claude Code's `TodoWrite`: always the whole list. */
export function applyTodoWrite(plan: Plan, args: Record<string, unknown>, at: number): Plan {
  const todos = toItems(args.todos)
  return todos ? replace(plan, todos, at) : plan
}

/** The desktop app's wrap-up checks off the step in progress. */
export function applyWrapUp(plan: Plan, at: number): Plan {
  const current = plan.steps.findIndex(s => s.status === 'in_progress')
  if (current < 0) return plan
  return { ...plan, steps: setStatus(plan.steps, current, 'completed', at), updatedAt: at }
}

/** What the model sends through `report_progress`. */
export type Sizing = { step: string; size?: StepSize; minutes?: number }

export type Report = {
  /** Sizes for any steps of the plan, usually all of them, right after writing it. */
  sizes?: Sizing[]
  step?: string
  subSteps?: SubStep[]
  percent?: number
  etaMinutes?: number
  blocker?: string
  note?: string
}

export function toReport(args: Record<string, unknown>): Report {
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : undefined)
  const SIZES: readonly StepSize[] = ['S', 'M', 'L', 'XL']
  const sizes = Array.isArray(args.sizes)
    ? args.sizes
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map(x => ({
          step: str(x.step) ?? '',
          size: SIZES.includes(String(x.size).toUpperCase() as StepSize) ? (String(x.size).toUpperCase() as StepSize) : undefined,
          minutes: num(x.minutes, 0.5, 24 * 60),
        }))
        .filter(x => x.step && (x.size || x.minutes !== undefined))
        .slice(0, 40)
    : undefined
  return {
    sizes: sizes && sizes.length > 0 ? sizes : undefined,
    step: str(args.step),
    subSteps: toItems(args.subSteps)?.slice(0, 30),
    percent: num(args.percent, 0, 100),
    etaMinutes: num(args.etaMinutes, 0, 24 * 60),
    blocker: typeof args.blocker === 'string' ? args.blocker.trim().slice(0, 400) : undefined,
    note: str(args.note),
  }
}

/**
 * Applies a report to the named step (matched tolerantly), or the one in
 * progress. A report is evidence of the step's status too: progress on a step
 * not started starts it; 100%, or every part done, finishes it. Returns the
 * plan unchanged with `matched: undefined` when there is no such step.
 */
export function applyReport(plan: Plan, r: Report, at: number): { plan: Plan; matched: string | undefined; sized: number } {
  let sized = 0
  if (r.sizes) {
    const steps = [...plan.steps]
    for (const z of r.sizes) {
      const i = matchStep(steps, z.step)
      const step = steps[i]
      if (!step) continue
      steps[i] = { ...step, size: z.size ?? step.size, estMinutes: z.minutes ?? step.estMinutes }
      sized++
    }
    plan = { ...plan, steps, updatedAt: at }
  }
  const hasStepReport = r.step || r.subSteps || r.percent !== undefined || r.etaMinutes !== undefined || r.blocker !== undefined || r.note
  if (!hasStepReport) return { plan, matched: undefined, sized }
  let index = r.step ? matchStep(plan.steps, r.step) : -1
  if (index < 0) index = plan.steps.findIndex(s => s.status === 'in_progress')
  const step = plan.steps[index]
  if (!step) return { plan, matched: undefined, sized }
  let next: Step = { ...step, reportedAt: at }
  if (r.subSteps) next.subSteps = r.subSteps
  if (r.percent !== undefined) next.percent = r.percent
  if (r.etaMinutes !== undefined) next.etaMinutes = r.etaMinutes
  if (r.blocker !== undefined) next.blocker = r.blocker || undefined
  if (r.note !== undefined) next.note = r.note
  const parts = r.subSteps ?? []
  const isFinished = r.percent === 100 || (parts.length > 0 && parts.every(p => p.status === 'completed'))
  const isMoving = (r.percent ?? 0) > 0 || parts.some(p => p.status !== 'pending')
  if (isFinished && next.status !== 'completed') next = { ...moveTo(next, 'completed', at), closedBy: 'report' }
  else if (isMoving && next.status === 'pending') next = moveTo(next, 'in_progress', at)
  const steps = plan.steps.map((s, i) => (i === index ? next : s))
  return { plan: { ...plan, steps, updatedAt: at }, matched: step.content, sized }
}

export type Progress = { done: number; active: number; total: number; ratio: number }

export function progress(plan: Plan | undefined): Progress {
  const steps = plan?.steps ?? []
  const done = steps.filter(s => s.status === 'completed').length
  const active = steps.filter(s => s.status === 'in_progress').length
  const total = steps.length
  return { done, active, total, ratio: total === 0 ? 0 : done / total }
}

export function activeStep(plan: Plan | undefined): string | undefined {
  return plan?.steps.find(s => s.status === 'in_progress')?.content
}

export const ENDED = new Set(['completed', 'failed', 'killed'])

// ── Evidence of life ─────────────────────────────────────────────────────

/**
 * The last moment anything showed that a step is being worked on: it started,
 * a report on it, a tool call made on it, or a subagent or background task
 * working on it. Undefined for a step that never started.
 */
export function stepSignalAt(
  step: Step,
  activity: readonly Activity[],
  agents: readonly AgentRow[],
  tasks: readonly BgTask[],
): number | undefined {
  if (step.startedAt === undefined) return undefined
  let at = Math.max(step.startedAt, step.reportedAt ?? 0)
  for (const a of activity) if (a.step === step.content) at = Math.max(at, a.endedAt ?? a.startedAt)
  for (const g of agents) if (g.step === step.content) at = Math.max(at, g.endedAt ?? g.startedAt, g.report?.at ?? 0)
  for (const t of tasks) if (t.step === step.content) at = Math.max(at, t.endedAt ?? t.lastOutputAt ?? t.startedAt)
  return at
}
