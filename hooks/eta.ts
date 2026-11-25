// Estimates and health. Pure functions over plain data.
//
// The rule this file keeps: every number says what it rests on. An estimate
// is one of
//   reported    the session's own estimate for the step in progress
//   calibrated  the session's sizes, scaled by how its finished steps compared
//   sized       the session's sizes, not yet checked against a finished step
//   measured    the median of this plan's finished steps (no sizes given)
//   history     how long similar steps took in past sessions
//   none        nothing to go on: shown as "no estimate", never as a number
// and time is counted only while the loop is working, not while it waits.

import type { Activity, Health, Interval, Plan, Step, StepSize } from '../types'

const MIN = 60_000
/** No tool call for this long while a loop is meant to be working: quiet. */
export const QUIET_MS = 3 * MIN
/** A finished step shorter than this was a check-off, not work. */
const MIN_SAMPLE_MS = 10_000
/** What a size means before this session has checked it against a finished step. */
export const SIZE_MINUTES: Record<StepSize, number> = { S: 3, M: 8, L: 20, XL: 45 }
/** A past-session prior needs this many samples of its kind to count. */
const HISTORY_MIN_SAMPLES = 3

export type Basis = 'reported' | 'calibrated' | 'sized' | 'measured' | 'history' | 'none'

export type Context = {
  now: number
  loop: string
  /** A subagent works from its start to its end; the main loop only in its turns. */
  isAgent: boolean
  work: Interval[]
  waits: Interval[]
  history: Record<string, number[]>
}

// ── Active time ──────────────────────────────────────────────────────────

function overlapMs(from: number, to: number, spans: Interval[], loop: string, now: number): number {
  let sum = 0
  for (const s of spans) {
    if (s.loop !== loop) continue
    const a = Math.max(from, s.start)
    const z = Math.min(to, s.end ?? now)
    if (z > a) sum += z - a
  }
  return sum
}

/** Milliseconds a loop spent working between two times: turns only, waits taken out. */
export function activeBetween(from: number, to: number, ctx: Context): number {
  if (to <= from) return 0
  // No turn on record for this loop (Headway loaded mid-turn): count wall time.
  const hasTurns = ctx.work.some(w => w.loop === ctx.loop)
  const working = ctx.isAgent || !hasTurns ? to - from : overlapMs(from, to, ctx.work, ctx.loop, ctx.now)
  return Math.max(0, working - overlapMs(from, to, ctx.waits, ctx.loop, ctx.now))
}

export function stepActiveMs(step: Step, ctx: Context): number {
  if (step.startedAt === undefined) return 0
  return activeBetween(step.startedAt, step.completedAt ?? ctx.now, ctx)
}

/** Whether the loop is waiting on the person right now. */
export function isWaiting(ctx: Context): boolean {
  return ctx.waits.some(w => w.loop === ctx.loop && w.end === undefined)
}

// ── Kinds of step, for learning across sessions ──────────────────────────

const KINDS: [string, RegExp][] = [
  ['test', /\b(test|tests|spec|verify|validate|qa|check)\b/i],
  ['build', /\b(build|compile|bundle|package)\b/i],
  ['ship', /\b(commit|push|pr|pull request|merge|release|publish|deploy|ship)\b/i],
  ['research', /\b(read|research|explore|investigate|survey|look|find|understand|check how)\b/i],
  ['design', /\b(design|plan|spec out|outline|decide)\b/i],
  ['fix', /\b(fix|debug|repair|resolve|patch)\b/i],
  ['docs', /\b(docs?|readme|document|write ?up|changelog)\b/i],
  ['write', /\b(write|implement|add|create|build out|refactor|update|change|wire)\b/i],
]

export function kindOf(text: string): string {
  for (const [kind, re] of KINDS) if (re.test(text)) return kind
  return 'other'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, z) => a - z)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ── The plan's own evidence ──────────────────────────────────────────────

export function sizeMs(step: Step): number | undefined {
  if (step.estMinutes !== undefined) return step.estMinutes * MIN
  return step.size ? SIZE_MINUTES[step.size] * MIN : undefined
}

/** A finished step whose timing is real: not a batch check-off, long enough to be work. */
export function isSample(step: Step, ctx: Context): boolean {
  return step.status === 'completed' && !step.isBatch && step.startedAt !== undefined && stepActiveMs(step, ctx) >= MIN_SAMPLE_MS
}

export type Model = {
  /** Real time over the session's sizes, from finished sized steps; 1 when unchecked. */
  scale: number
  scaled: number
  /** The median finished step, for plans without sizes. */
  medianMs?: number
  samples: number
}

export function calibrate(plan: Plan | undefined, ctx: Context): Model {
  const done = (plan?.steps ?? []).filter(s => isSample(s, ctx))
  const sized = done.filter(s => sizeMs(s) !== undefined)
  const actual = sized.reduce((sum, s) => sum + stepActiveMs(s, ctx), 0)
  const said = sized.reduce((sum, s) => sum + sizeMs(s)!, 0)
  return {
    scale: sized.length > 0 && said > 0 ? Math.min(5, Math.max(0.2, actual / said)) : 1,
    scaled: sized.length,
    medianMs: done.length > 0 ? median(done.map(s => stepActiveMs(s, ctx))) : undefined,
    samples: done.length,
  }
}

/** What a step is expected to take in all, and what that expectation rests on. */
export function expectation(step: Step, model: Model, ctx: Context): { ms?: number; basis: Basis } {
  const sized = sizeMs(step)
  if (sized !== undefined) return model.scaled > 0 ? { ms: sized * model.scale, basis: 'calibrated' } : { ms: sized, basis: 'sized' }
  if (model.medianMs !== undefined) return { ms: model.medianMs, basis: 'measured' }
  const past = ctx.history[kindOf(step.content)] ?? []
  if (past.length >= HISTORY_MIN_SAMPLES) return { ms: median(past) * MIN, basis: 'history' }
  return { basis: 'none' }
}

export type StepEstimate = {
  activeMs: number
  expectedMs?: number
  /** Time left to show; undefined when unknown or past its estimate. */
  remainingMs?: number
  /** What the plan's total counts for this step: an overrun is expected to run half as long again. */
  countedMs?: number
  basis: Basis
  overByMs?: number
  /** 0..1, and whether it is measured (reported) or inferred from time. */
  fraction: number
  isEstimated: boolean
}

export function estimateStep(step: Step, model: Model, ctx: Context): StepEstimate {
  const activeMs = stepActiveMs(step, ctx)
  const exp = expectation(step, model, ctx)
  if (step.status === 'completed' || step.priority === 'skip') {
    return { activeMs, expectedMs: exp.ms, remainingMs: 0, countedMs: 0, basis: exp.basis, fraction: step.status === 'completed' ? 1 : 0, isEstimated: false }
  }
  if (step.status === 'pending') {
    return { activeMs, expectedMs: exp.ms, remainingMs: exp.ms, countedMs: exp.ms, basis: exp.basis, fraction: 0, isEstimated: false }
  }

  // In progress: the session's own word first.
  if (step.etaMinutes !== undefined && step.reportedAt !== undefined) {
    const since = activeBetween(step.reportedAt, ctx.now, ctx)
    const left = step.etaMinutes * MIN - since
    const total = activeMs + Math.max(0, left)
    if (left >= 0) return { activeMs, expectedMs: total, remainingMs: left, countedMs: left, basis: 'reported', fraction: total > 0 ? activeMs / total : 0, isEstimated: true }
    return { activeMs, expectedMs: activeMs + left, countedMs: activeMs * 0.5, basis: 'reported', overByMs: -left, fraction: 0.9, isEstimated: true }
  }
  const subs = step.subSteps ?? []
  const reported =
    step.percent !== undefined
      ? step.percent / 100
      : subs.length > 0
        ? (subs.filter(s => s.status === 'completed').length + 0.5 * subs.filter(s => s.status === 'in_progress').length) / subs.length
        : undefined
  if (reported !== undefined && reported > 0.05 && activeMs > 0) {
    const left = (activeMs * (1 - reported)) / reported
    return { activeMs, expectedMs: activeMs + left, remainingMs: left, countedMs: left, basis: 'reported', fraction: reported, isEstimated: false }
  }
  if (exp.ms === undefined) {
    return { activeMs, basis: 'none', fraction: reported ?? 0, isEstimated: reported === undefined }
  }
  const left = exp.ms - activeMs
  if (left >= 0) {
    return { activeMs, expectedMs: exp.ms, remainingMs: left, countedMs: left, basis: exp.basis, fraction: reported ?? Math.min(0.9, activeMs / exp.ms), isEstimated: reported === undefined }
  }
  // Past its estimate: no pretend "1 minute left". Long tasks that overrun
  // tend to run on, so the total counts half as long again.
  return { activeMs, expectedMs: exp.ms, countedMs: activeMs * 0.5, basis: exp.basis, overByMs: -left, fraction: reported ?? 0.9, isEstimated: reported === undefined }
}

export type Eta = {
  low: number
  high: number
  /** Minutes. */
  mid: number
  basis: Basis
  confidence: 'low' | 'medium' | 'high'
  /** Steps left with nothing to estimate them by. */
  unknown: number
  isOverrun: boolean
}

const RANK: Record<Basis, number> = { reported: 5, calibrated: 4, measured: 3, history: 2, sized: 1, none: 0 }

/** Minutes left on the plan, as a range whose width says how much is known. */
export function planEta(plan: Plan | undefined, ctx: Context, extraMs = 0): Eta | undefined {
  const steps = (plan?.steps ?? []).filter(s => s.status !== 'completed' && s.priority !== 'skip')
  if (steps.length === 0) return undefined
  const model = calibrate(plan, ctx)
  const ests = steps.map(s => estimateStep(s, model, ctx))
  const known = ests.filter(e => e.countedMs !== undefined)
  const unknown = ests.length - known.length
  if (known.length === 0 && extraMs === 0) return { low: 0, high: 0, mid: 0, basis: 'none', confidence: 'low', unknown, isOverrun: false }

  const ms = known.reduce((sum, e) => sum + e.countedMs!, 0) + extraMs
  // The basis carrying the most of the time left speaks for the whole.
  const weight = new Map<Basis, number>()
  for (const e of known) weight.set(e.basis, (weight.get(e.basis) ?? 0) + e.countedMs!)
  const basis = [...weight.entries()].sort((a, z) => z[1] - a[1] || RANK[z[0]] - RANK[a[0]])[0]?.[0] ?? 'none'
  const n = basis === 'calibrated' ? model.scaled : model.samples
  const spread =
    basis === 'reported'
      ? 0.35
      : basis === 'calibrated'
        ? Math.max(0.2, 0.8 / Math.sqrt(n))
        : basis === 'measured'
          ? Math.max(0.25, 0.9 / Math.sqrt(n))
          : basis === 'history'
            ? 0.6
            : 0.8
  const isOverrun = ests.some(e => e.overByMs !== undefined)
  const mid = ms / MIN
  const confidence: Eta['confidence'] =
    unknown > 0 || basis === 'sized' || basis === 'history' || n < 2
      ? 'low'
      : spread <= 0.3 && !isOverrun
        ? 'high'
        : 'medium'
  return {
    mid,
    low: mid / (1 + spread),
    high: mid * (1 + spread) * (isOverrun ? 1.5 : 1),
    basis,
    confidence,
    unknown,
    isOverrun,
  }
}

/** The plan's progress, counting the step in progress by its estimate. */
export function planFraction(plan: Plan | undefined, ctx: Context): { measured: number; estimated: number } {
  const steps = plan?.steps ?? []
  if (steps.length === 0) return { measured: 0, estimated: 0 }
  const model = calibrate(plan, ctx)
  let measured = 0
  let estimated = 0
  for (const s of steps) {
    const e = estimateStep(s, model, ctx)
    if (e.isEstimated) estimated += e.fraction
    else measured += e.fraction
  }
  return { measured: measured / steps.length, estimated: estimated / steps.length }
}

// ── Slips ────────────────────────────────────────────────────────────────

/** Adds a sample of the projected finish time when it moved or a minute passed. */
export function logEta(log: { at: number; finish: number }[], now: number, finish: number | undefined): { at: number; finish: number }[] {
  if (finish === undefined) return log
  const last = log[log.length - 1]
  if (last && Math.abs(finish - last.finish) < 30_000 && now - last.at < 60_000) return log
  return [...log, { at: now, finish }].slice(-120)
}

/** How far the projected finish moved later in a window, and in how many jumps. */
export function slips(log: { at: number; finish: number }[], now: number, windowMs = 30 * MIN): { count: number; movedMs: number; sinceMs: number } {
  const recent = log.filter(x => now - x.at <= windowMs)
  let count = 0
  for (let i = 1; i < recent.length; i++) {
    const jump = recent[i]!.finish - recent[i - 1]!.finish
    if (jump > Math.max(MIN, 0.1 * (recent[i - 1]!.finish - recent[i - 1]!.at))) count++
  }
  const first = recent[0]
  const last = recent[recent.length - 1]
  return { count, movedMs: first && last ? Math.max(0, last.finish - first.finish) : 0, sinceMs: first ? now - first.at : 0 }
}

// ── Health ───────────────────────────────────────────────────────────────

export type HealthInput = {
  now: number
  isRunning: boolean
  isWaiting: boolean
  activeMs: number
  expectedMs?: number
  lastActivityAt?: number
  failed?: boolean
}

export function health(h: HealthInput): Health {
  if (h.failed) return 'failed'
  if (h.isWaiting) return 'needs-you'
  if (!h.isRunning) return 'idle'
  if (h.expectedMs !== undefined && h.activeMs > Math.max(2 * h.expectedMs, h.expectedMs + 5 * MIN)) return 'slow'
  if (h.lastActivityAt !== undefined && h.now - h.lastActivityAt > QUIET_MS) return 'quiet'
  return 'on-track'
}

const HEALTH_RANK: Record<Health, number> = { failed: 6, 'needs-you': 5, slow: 4, quiet: 3, 'on-track': 2, idle: 1, done: 0 }

export function worst(list: Health[]): Health {
  return list.reduce<Health>((a, b) => (HEALTH_RANK[b] > HEALTH_RANK[a] ? b : a), 'done')
}

export function lastActivity(activity: Activity[], loop: string): number | undefined {
  let at: number | undefined
  for (const a of activity) if (a.loop === loop) at = Math.max(at ?? 0, a.endedAt ?? a.startedAt)
  return at
}

// ── Words ────────────────────────────────────────────────────────────────

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

export function range(eta: Pick<Eta, 'low' | 'high'>): string {
  const lo = Math.max(1, Math.round(eta.low))
  const hi = Math.max(lo, Math.round(eta.high))
  if (hi >= 90) return `~${Math.round(lo / 6) / 10}–${Math.round(hi / 6) / 10} h`
  return lo === hi ? `~${lo} min` : `~${lo}–${hi} min`
}

/** What an estimate rests on, in a few words. */
export function basisWords(basis: Basis, model: Pick<Model, 'samples' | 'scaled'>): string {
  const n = basis === 'calibrated' ? model.scaled : model.samples
  switch (basis) {
    case 'reported':
      return "the session's own estimate"
    case 'calibrated':
      return `session's sizes, checked against ${n} finished step${n === 1 ? '' : 's'}`
    case 'sized':
      return "session's sizes, not yet checked"
    case 'measured':
      return `typical of ${n} finished step${n === 1 ? '' : 's'}`
    case 'history':
      return 'similar steps in past sessions'
    case 'none':
      return 'nothing to estimate from yet'
  }
}

export const HEALTH: Record<Health, { label: string; color: string; meaning: string }> = {
  'on-track': { label: 'On track', color: 'success', meaning: 'working, within its estimate.' },
  slow: { label: 'Over estimate', color: 'warning', meaning: 'running over twice its estimate.' },
  quiet: { label: 'Quiet', color: 'warning', meaning: 'no tool call for 3+ minutes. Thinking, or stuck.' },
  'needs-you': { label: 'Needs you', color: 'error', meaning: 'a permission prompt or question is waiting in the chat.' },
  failed: { label: 'Failed', color: 'error', meaning: 'it ended with an error.' },
  idle: { label: 'Paused', color: 'subtle', meaning: 'turn finished with steps left; the clock is stopped until it works again.' },
  done: { label: 'Done', color: 'success', meaning: 'every step is complete.' },
}
