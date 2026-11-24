export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** A part of a step, as the model reports it through `report_progress`. */
export type SubStep = { content: string; status: StepStatus }

export type Step = {
  content: string
  status: StepStatus
  /** When the step first went in progress, and when it completed. */
  startedAt?: number
  completedAt?: number
  /** What the model last reported for this step. */
  subSteps?: SubStep[]
  percent?: number
  etaMinutes?: number
  blocker?: string
  note?: string
  reportedAt?: number
  /** What the user asked for from the pane, shown as a badge until it lands. */
  priority?: 'next' | 'deferred' | 'skip'
}

/** One moment the plan's scope moved: steps added or dropped by a rewrite. */
export type ScopeChange = {
  at: number
  from: number
  to: number
  added: string[]
  removed: string[]
}

/** A task list kept by one loop: the main session or one subagent. */
export type Plan = {
  steps: Step[]
  changes: ScopeChange[]
  /** The most steps the plan ever held, so a shrink still shows. */
  peak: number
  createdAt: number
  updatedAt: number
}

export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  /** The loop that spawned it; absent for the main session. */
  parentId?: string
  /** The parent's in-progress step when it spawned, so it nests there. */
  step?: string
  startedAt: number
  endedAt?: number
}

/** One tool call, for the activity timeline and for spotting a loop gone quiet. */
export type Activity = {
  id: string
  /** `main` or a subagent's id. */
  loop: string
  tool: string
  summary: string
  /** The step its loop was on (for a subagent without a plan, its parent's). */
  step?: string
  startedAt: number
  endedAt?: number
  isError?: boolean
  /** A permission prompt or a question is waiting on the person. */
  needsYou?: boolean
}

export type TaskKind = 'shell' | 'monitor' | 'workflow'

/** Work running in the background: outside any plan, so Headway tracks it itself. */
export type BgTask = {
  id: string
  kind: TaskKind
  description: string
  loop: string
  step?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  outputPath?: string
  bytes?: number
  lastLine?: string
  lastOutputAt?: number
  timeoutMs?: number
}

export type InterventionKind =
  | 'context'
  | 'status'
  | 'wrap'
  | 'next'
  | 'defer'
  | 'skip'
  | 'stop'
  | 'retry'

/** Something the person asked for from the pane, and how far it got. */
export type Intervention = {
  id: string
  kind: InterventionKind
  /** A loop (`main` or an agent id) or a background task id. */
  target: string
  /** What it is about, for the pane: a step's or task's name. */
  label: string
  text: string
  at: number
  status: 'pending' | 'delivered' | 'failed'
  via?: 'next-step' | 'new-turn' | 'message' | 'tool'
  deliveredAt?: number
  reason?: string
}

export type Board = {
  /** Keyed by loop: `main`, or a subagent's id. */
  plans: Record<string, Plan>
  agents: AgentRow[]
  activity: Activity[]
  tasks: BgTask[]
  interventions: Intervention[]
  /** Whether the main loop is mid-turn, so a note can land at its next step. */
  turn: { running: boolean; startedAt?: number }
}

/** What the pane shows open, kept apart from the data it draws. */
export type View = {
  /** Keys of rows drilled into: `step:<name>`, `agent:<id>`, `task:<id>`, `session:<id>`. */
  open: string[]
  /** The row whose "add context" field is showing. */
  composing?: string
}

export type Health = 'on-track' | 'slow' | 'quiet' | 'needs-you' | 'failed' | 'done' | 'idle'

/** What one session publishes to the shared store for the others to see. */
export type SessionSummary = {
  id: string
  name: string
  root: string
  done: number
  total: number
  active?: string
  health: Health
  /** Minutes left, as a range. */
  eta?: { low: number; high: number; isRough: boolean }
  agentsRunning: number
  tasksRunning: number
  steps: { content: string; status: StepStatus }[]
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    headway: {
      board: Shaped<Board>
      others: SessionSummary[]
      view: View
    }
  }
}
