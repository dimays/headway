// Words: what a tool call did, what an intervention tells the model, and what
// a change of scope means. Pure functions.

import type { InterventionKind, Plan } from '../types'
import { ago } from './eta'

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

function clip(text: string, n = 70): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const NAMES: Record<string, string> = {
  mcp__ccd_turn__update_plan: 'Plan',
  mcp__ccd_turn__wrap_up: 'Wrap-up',
  mcp__headway__report_progress: 'Progress report',
  TodoWrite: 'Plan',
  AskUserQuestion: 'Question for you',
}

/** `Bash · npm test`, `Edit · register.tsx`, `linear · create_issue`. */
export function describeCall(tool: string, args: Record<string, unknown>): { tool: string; summary: string } {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const name = NAMES[tool]
  if (name) return { tool: name, summary: s('recap') || s('note') || s('step') || '' }
  if (tool.startsWith('mcp__')) {
    const [, server = '', action = tool] = tool.split('__')
    return { tool: server, summary: action.replace(/_/g, ' ') }
  }
  switch (tool) {
    case 'Bash':
      return { tool, summary: clip(s('description') || s('command')) }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return { tool, summary: basename(s('file_path') || s('notebook_path')) }
    case 'Grep':
    case 'Glob':
      return { tool, summary: clip(s('pattern')) }
    case 'WebFetch':
      return { tool, summary: clip(s('url').replace(/^https?:\/\//, '')) }
    case 'WebSearch':
    case 'ToolSearch':
      return { tool, summary: clip(s('query')) }
    case 'Agent':
    case 'Monitor':
      return { tool, summary: clip(s('description')) }
    case 'SendMessage':
      return { tool: 'Message', summary: clip(s('to')) }
    default:
      return { tool, summary: clip(s('description')) }
  }
}

const FROM = 'The user sent this from the Headway progress pane'

/** What the model reads for each intervention. */
export function interventionText(kind: InterventionKind, label: string, note = ''): string {
  const about = label ? ` about “${label}”` : ''
  switch (kind) {
    case 'estimate':
      return `${FROM}: the estimate for “${label}” has slipped${note ? ` (${note})` : ''}. Call report_progress with a fresh etaMinutes for the step in progress and sizes for the steps left, based on what you now know, then carry on.`
    case 'context':
      return `${FROM}${about}:\n\n${note}`
    case 'status':
      return `${FROM}: give a short status update on “${label}” — what is done, what is left, and anything blocking. Call report_progress with the same so the pane shows it, then carry on.`
    case 'wrap':
      return `${FROM}: wrap up “${label}”. Finish only what is essential, mark it done in your plan, and move to the next step.`
    case 'next':
      return `${FROM}: do “${label}” next, before the other remaining steps. Once your current action finishes, reorder your plan and start it.`
    case 'defer':
      return `${FROM}: defer “${label}” to the end of the plan. Move it last in your plan and carry on with the next step.`
    case 'skip':
      return `${FROM}: skip “${label}”. Remove it from your plan (or mark it done without doing it) and say so in one line.`
    case 'retry':
      return `${FROM}: retry “${label}”${note ? ` (${note})` : ''}. Start it again the same way, unless you can see why it failed; then fix that first.`
    case 'stop':
      return note
        ? `${FROM}: stop “${label}” now (${note}) with TaskStop. Do not restart it unless they ask; carry on without it or tell them what it blocks.`
        : `${FROM}: they stopped “${label}”. Do not restart it unless they ask; carry on without it or tell them what it blocks.`
  }
}

export const INTERVENTION_LABEL: Record<InterventionKind, string> = {
  estimate: 'New estimate',
  context: 'Note',
  status: 'Status check',
  wrap: 'Wrap up',
  next: 'Do next',
  defer: 'Defer',
  skip: 'Skip',
  stop: 'Stop',
  retry: 'Retry',
}

/** A plain sentence for how the plan's size moved, and the detail behind it. */
export function describeScope(plan: Plan | undefined, now: number): { headline: string; detail: string[] } | undefined {
  const changes = plan?.changes ?? []
  const first = changes[0]
  const last = changes[changes.length - 1]
  if (!plan || !first || !last) return undefined
  const from = first.from
  const to = plan.steps.length
  const n = changes.length
  const headline =
    to > from
      ? `Plan grew from ${from} to ${to} steps`
      : to < from
        ? `Plan shrank from ${from} to ${to} steps`
        : `Plan reshuffled, still ${to} steps`
  const list = (names: string[]) => names.map(x => `“${clip(x, 40)}”`).join(', ')
  const parts = [last.added.length > 0 && `added ${list(last.added)}`, last.removed.length > 0 && `dropped ${list(last.removed)}`]
    .filter(Boolean)
    .join('; ')
  const detail = [
    `Latest change ${ago(now - last.at)}: ${parts}.`,
    n > 1 ? `The plan has changed ${n} times since it was first written.` : 'This is the first change since the plan was written.',
    'Progress is measured against the current plan, so adding steps moves the bar back, and dropping them moves it forward.',
  ]
  return { headline: `${headline} · ${n} change${n === 1 ? '' : 's'}, last ${ago(now - last.at)}`, detail }
}
