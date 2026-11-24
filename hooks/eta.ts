// Estimates and health, from timings alone. Pure functions over plain data.

import type { Activity, Health, Plan, Step } from '../types'

const MIN = 60_000
/** What a step is assumed to take before any step of this plan has finished. */
export const PRIOR_STEP_MS = 4 * MIN
/** No tool call for this long while a loop is meant to be working: quiet. */
export const QUIET_MS = 3 * MIN
/** A step that never registered a duration this short is a batch check-off, not work. */
const MIN_SAMPLE_MS = 10_000

function median(values: number[]): number {
  const sorted = [...values].sort((a, z) => a - z)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** How long a step of this plan usually takes, and how many finished steps say so. */
export function expectedStep(plan: Plan | undefined): { ms: number; samples: number } {
  const durations = (plan?.steps ?? [])
    .filter(s => s.status === 'completed' && s.startedAt !== undefined && s.completedAt !== undefined)
    .map(s => s.completedAt! - s.startedAt!)
    .filter(ms => ms >= MIN_SAMPLE_MS)
  return durations.length === 0 ? { ms: PRIOR_STEP_MS, samples: 0 } : { ms: median(durations), samples: durations.length }
}

/** How far along one step is, and whether that is measured or guessed from time. */
export function stepFraction(step: Step, now: number, expectedMs: number): { value: number; isEstimated: boolean } {
  if (step.status === 'completed') return { value: 1, isEstimated: false }
  if (step.status === 'pending') return { value: 0, isEstimated: false }
  if (step.percent !== undefined) return { value: step.percent / 100, isEstimated: false }
  const subs = step.subSteps ?? []
  if (subs.length > 0) {
    const done = subs.filter(s => s.status === 'completed').length
    const active = subs.filter(s => s.status === 'in_progress').length
    return { value: (done + active * 0.5) / subs.length, isEstimated: false }
  }
  const elapsed = now - (step.startedAt ?? now)
  // Approaches 90% as the step reaches its expected length, never claims done.
  return { value: Math.min(0.9, (elapsed / expectedMs) * 0.9), isEstimated: true }
}

/** Milliseconds left on one step. */
export function stepRemainingMs(step: Step, now: number, expectedMs: number): number {
  if (step.status === 'completed' || step.priority === 'skip') return 0
  if (step.status === 'pending') return expectedMs
  const elapsed = now - (step.startedAt ?? now)
  if (step.etaMinutes !== undefined) {
    const since = now - (step.reportedAt ?? now)
    return Math.max(0, step.etaMinutes * MIN - since)
  }
  const f = stepFraction(step, now, expectedMs)
  if (!f.isEstimated && f.value > 0.05) return (elapsed * (1 - f.value)) / f.value
  return Math.max(expectedMs - elapsed, expectedMs * 0.15)
}

export type Eta = { low: number; high: number; isRough: boolean; ms: number }

/** Minutes left on the whole plan, as a range that narrows as steps finish. */
export function planEta(plan: Plan | undefined, now: number): Eta | undefined {
  const steps = plan?.steps ?? []
  if (steps.length === 0 || steps.every(s => s.status === 'completed')) return undefined
  const { ms: expected, samples } = expectedStep(plan)
  const ms = steps.reduce((sum, s) => sum + stepRemainingMs(s, now, expected), 0)
  const isRough = samples < 3
  const [lo, hi] = isRough ? [0.6, 1.7] : [0.8, 1.3]
  return { low: (ms * lo) / MIN, high: (ms * hi) / MIN, isRough, ms }
}

/** The plan's progress counting partial work on the step in progress. */
export function planFraction(plan: Plan | undefined, now: number): number {
  const steps = plan?.steps ?? []
  if (steps.length === 0) return 0
  const { ms } = expectedStep(plan)
  return steps.reduce((sum, s) => sum + stepFraction(s, now, ms).value, 0) / steps.length
}

export type HealthInput = {
  now: number
  /** The loop is meant to be working right now. */
  isRunning: boolean
  startedAt?: number
  expectedMs: number
  samples: number
  lastActivityAt?: number
  needsYou?: boolean
  failed?: boolean
}

export function health(h: HealthInput): Health {
  if (h.failed) return 'failed'
  if (h.needsYou) return 'needs-you'
  if (!h.isRunning) return 'idle'
  const elapsed = h.now - (h.startedAt ?? h.now)
  const slowAfter = h.samples > 0 ? Math.max(2 * h.expectedMs, h.expectedMs + 5 * MIN) : 20 * MIN
  if (elapsed > slowAfter) return 'slow'
  if (h.lastActivityAt !== undefined && h.now - h.lastActivityAt > QUIET_MS) return 'quiet'
  return 'on-track'
}

const RANK: Record<Health, number> = { failed: 6, 'needs-you': 5, slow: 4, quiet: 3, 'on-track': 2, idle: 1, done: 0 }

export function worst(list: Health[]): Health {
  return list.reduce<Health>((a, b) => (RANK[b] > RANK[a] ? b : a), 'done')
}

export function lastActivity(activity: Activity[], loop: string): number | undefined {
  let at: number | undefined
  for (const a of activity) if (a.loop === loop) at = Math.max(at ?? 0, a.endedAt ?? a.startedAt)
  return at
}

export function isWaitingOnYou(activity: Activity[], loop: string): boolean {
  return activity.some(a => a.loop === loop && a.needsYou && a.endedAt === undefined)
}

// ── Words ──────────────────────────────────────────────────────────────

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

export function ago(ms: number): string {
  return ms < 5000 ? 'just now' : `${duration(ms)} ago`
}

export function range(eta: Eta): string {
  const lo = Math.max(1, Math.round(eta.low))
  const hi = Math.max(lo, Math.round(eta.high))
  if (hi >= 90) return `~${Math.round(lo / 6) / 10}–${Math.round(hi / 6) / 10} h`
  return lo === hi ? `~${lo} min` : `~${lo}–${hi} min`
}

export const HEALTH: Record<Health, { label: string; color: string; meaning: string }> = {
  'on-track': { label: 'On track', color: 'success', meaning: 'working, within the usual step time.' },
  slow: {
    label: 'Slower than usual',
    color: 'warning',
    meaning: 'running over twice the usual step time.',
  },
  quiet: {
    label: 'Quiet',
    color: 'warning',
    meaning: 'no tool call for 3+ minutes. Thinking, or stuck.',
  },
  'needs-you': {
    label: 'Needs you',
    color: 'error',
    meaning: 'a permission prompt or question is waiting in the chat.',
  },
  failed: { label: 'Failed', color: 'error', meaning: 'it ended with an error.' },
  idle: {
    label: 'Paused',
    color: 'subtle',
    meaning: 'turn finished with steps left; usually waiting on your reply.',
  },
  done: { label: 'Done', color: 'success', meaning: 'every step is complete.' },
}
