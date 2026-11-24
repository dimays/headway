// Pure logic: turning task-list tool calls into plans, and plans into numbers.
// Nothing here touches `$`, so it is easy to test and to reason about.

import type { Plan, ScopeChange, Step, StepStatus, SubStep } from '../types'

export const EMPTY_PLAN: Plan = { steps: [], changes: [], peak: 0, createdAt: 0, updatedAt: 0 }

const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'completed']

function toStatus(value: unknown): StepStatus {
  return STATUSES.includes(value as StepStatus) ? (value as StepStatus) : 'pending'
}

function toItems(raw: unknown): SubStep[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object')
    .map(one => ({ content: String(one.content ?? '').trim(), status: toStatus(one.status) }))
    .filter(one => one.content.length > 0)
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

/** Replaces the step list, carrying each surviving step's timing and reports. */
function replace(plan: Plan, items: SubStep[], at: number): Plan {
  const old = new Map(plan.steps.map(s => [s.content, s]))
  const steps = items.map(item => {
    const kept: Step = old.get(item.content) ?? { content: item.content, status: 'pending' }
    return moveTo(kept, item.status, at)
  })
  const change = scopeChange(plan.steps, steps, at)
  return {
    steps,
    changes: change ? [...plan.changes, change].slice(-20) : plan.changes,
    peak: Math.max(plan.peak, steps.length),
    createdAt: plan.createdAt || at,
    updatedAt: at,
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
  return steps === plan.steps ? plan : { ...plan, steps, updatedAt: at }
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
export type Report = {
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
  return {
    step: str(args.step),
    subSteps: toItems(args.subSteps)?.slice(0, 30),
    percent: num(args.percent, 0, 100),
    etaMinutes: num(args.etaMinutes, 0, 24 * 60),
    blocker: typeof args.blocker === 'string' ? args.blocker.trim().slice(0, 400) : undefined,
    note: str(args.note),
  }
}

/**
 * Applies a report to the named step, or the one in progress. Returns the plan
 * unchanged with `matched: false` when there is no such step.
 */
export function applyReport(plan: Plan, r: Report, at: number): { plan: Plan; matched: string | undefined } {
  const lower = r.step?.toLowerCase()
  let index = lower ? plan.steps.findIndex(s => s.content.toLowerCase() === lower) : -1
  if (index < 0 && lower) index = plan.steps.findIndex(s => s.content.toLowerCase().includes(lower))
  if (index < 0) index = plan.steps.findIndex(s => s.status === 'in_progress')
  const step = plan.steps[index]
  if (!step) return { plan, matched: undefined }
  const next: Step = { ...step, reportedAt: at }
  if (r.subSteps) next.subSteps = r.subSteps
  if (r.percent !== undefined) next.percent = r.percent
  if (r.etaMinutes !== undefined) next.etaMinutes = r.etaMinutes
  if (r.blocker !== undefined) next.blocker = r.blocker || undefined
  if (r.note !== undefined) next.note = r.note
  const steps = plan.steps.map((s, i) => (i === index ? next : s))
  return { plan: { ...plan, steps, updatedAt: at }, matched: step.content }
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
