export type GoalMode = "session" | "fresh"
export type GoalJudgeMode = "none" | "llm" | "verifier"
export type GoalPhase = "idle" | "running" | "verifying" | "paused" | "completed" | "failed" | "stopped"

export interface GoalCriterion {
  id: string
  text: string
  done: boolean
  evidence?: string
}

export interface GoalConfig {
  prompt: string
  mode: GoalMode
  verifyCommands: string[]
  judge: GoalJudgeMode
  maxIterations: number
  budgetUsd?: number
  requireCompleteTool: boolean
  criteria: GoalCriterion[]
}

export interface VerifyLogEntry {
  iteration: number
  timestamp: number
  ok: boolean
  summary: string
  details?: string
}

export interface GoalState {
  id: string
  config: GoalConfig
  phase: GoalPhase
  iteration: number
  startedAt: number
  updatedAt: number
  baselineCostUsd: number
  spentUsd: number
  completedSummary?: string
  pauseReason?: string
  /** Last N normalized failure hashes + workspace fingerprints for stuck detection. */
  recentFailures: { hash: string; diffHash: string }[]
  reflectionUsed: boolean
  logs: VerifyLogEntry[]
}

export interface GoalRunRequest {
  prompt: string
  mode?: GoalMode
  verifyCommands?: string[]
  judge?: GoalJudgeMode
  maxIterations?: number
  budgetUsd?: number
  criteria?: string[]
  requireCompleteTool?: boolean
}

export interface GoalRunResult {
  id: string
  status: "completed" | "paused" | "failed" | "stopped"
  iterations: number
  summary: string
  spentUsd: number
}

export interface GoalStatusSnapshot {
  id: string
  prompt: string
  phase: GoalPhase
  mode: GoalMode
  iteration: number
  maxIterations: number
  spentUsd: number
  budgetUsd?: number
  criteria: readonly GoalCriterion[]
  pauseReason?: string
  lastLog?: VerifyLogEntry
}

declare module "@amira/api" {
  interface AmiraServices {
    "goal.run": (req: GoalRunRequest) => Promise<GoalRunResult>
    "goal.status": () => GoalStatusSnapshot | undefined
    "goal.stop": (reason?: string) => Promise<void>
  }
}
