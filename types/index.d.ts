export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = { content: string; status: StepStatus }

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

export type Board = {
  /** Keyed by loop: `main`, or a subagent's id. */
  plans: Record<string, Plan>
  agents: AgentRow[]
}

/** What one session publishes to the shared store for the others to see. */
export type SessionSummary = {
  id: string
  name: string
  root: string
  done: number
  total: number
  active?: string
  agentsRunning: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    headway: {
      board: Shaped<Board>
      others: SessionSummary[]
    }
  }
}
