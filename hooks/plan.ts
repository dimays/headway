// Pure logic: turning task-list tool calls into plans, and plans into numbers.
// Nothing here touches `$`, so it is easy to test and to reason about.

import type { Plan, ScopeChange, Step, StepStatus } from '../types'

export const EMPTY_PLAN: Plan = { steps: [], changes: [], peak: 0, updatedAt: 0 }

const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'completed']

function toStatus(value: unknown): StepStatus {
  return STATUSES.includes(value as StepStatus) ? (value as StepStatus) : 'pending'
}

function toSteps(raw: unknown): Step[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object')
    .map(one => ({ content: String(one.content ?? '').trim(), status: toStatus(one.status) }))
    .filter(one => one.content.length > 0)
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

function replace(plan: Plan, steps: Step[], at: number): Plan {
  const change = scopeChange(plan.steps, steps, at)
  return {
    steps,
    changes: change ? [...plan.changes, change].slice(-20) : plan.changes,
    peak: Math.max(plan.peak, steps.length),
    updatedAt: at,
  }
}

function setStatus(steps: Step[], index: number, status: StepStatus): Step[] {
  return steps.map((s, i) => (i === index ? { ...s, status } : s))
}

/** The Claude desktop app's `update_plan`: items | advance | done + start (1-based). */
export function applyUpdatePlan(plan: Plan, args: Record<string, unknown>, at: number): Plan {
  const items = toSteps(args.items)
  if (items) return replace(plan, items, at)

  let steps = plan.steps
  if (args.advance === true) {
    const current = steps.findIndex(s => s.status === 'in_progress')
    if (current >= 0) steps = setStatus(steps, current, 'completed')
    const next = steps.findIndex((s, i) => i > current && s.status === 'pending')
    if (next >= 0) steps = setStatus(steps, next, 'in_progress')
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done) {
      if (typeof n === 'number' && steps[n - 1]) steps = setStatus(steps, n - 1, 'completed')
    }
  }
  if (typeof args.start === 'number' && steps[args.start - 1]) {
    steps = setStatus(steps, args.start - 1, 'in_progress')
  }
  return steps === plan.steps ? plan : { ...plan, steps, updatedAt: at }
}

/** Claude Code's `TodoWrite`: always the whole list. */
export function applyTodoWrite(plan: Plan, args: Record<string, unknown>, at: number): Plan {
  const todos = toSteps(args.todos)
  return todos ? replace(plan, todos, at) : plan
}

/** The desktop app's wrap-up checks off the step in progress. */
export function applyWrapUp(plan: Plan, at: number): Plan {
  const current = plan.steps.findIndex(s => s.status === 'in_progress')
  if (current < 0) return plan
  return { ...plan, steps: setStatus(plan.steps, current, 'completed'), updatedAt: at }
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

/** Splits a bar of `width` cells into done, active and remaining cells. */
export function barCells(p: Progress, width: number): { done: number; active: number; rest: number } {
  if (p.total === 0 || width <= 0) return { done: 0, active: 0, rest: Math.max(0, width) }
  const done = Math.round((p.done / p.total) * width)
  const active = Math.min(width - done, Math.max(p.active > 0 ? 1 : 0, Math.round((p.active / p.total) * width)))
  return { done, active, rest: width - done - active }
}

export const ENDED = new Set(['completed', 'failed', 'killed'])
