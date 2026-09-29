/** Messages between a run (the host) and the Worker its script runs in. */

/** What agent(prompt, opts) may pass; everything else is ignored. */
export interface AgentOpts {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  role?: string
  model?: string
  isolation?: "none" | "worktree"
}

export type WorkerMessage =
  | {
      t: "agent"
      id: number
      /** Results the script had received when it made the call (see Journal). */
      seen: number
      prompt: string
      opts: AgentOpts
      /** The nested workflow making the call. */
      nest?: string
    }
  | { t: "workflow"; id: number; name: string; args: unknown }
  /** A nested workflow's script returned (ok) or threw. */
  | { t: "nestEnd"; nest: string; ok: boolean }
  | { t: "phase"; title: string; nest?: string }
  | { t: "log"; msg: string; level: "info" | "warning"; nest?: string }
  | { t: "done"; value: unknown }
  | { t: "error"; message: string }

export type HostMessage =
  | { t: "run"; code: string; args: unknown; budgetTotal: number | null; spent: number }
  | { t: "result"; id: number; ok: true; value: unknown; spent: number }
  | { t: "result"; id: number; ok: false; error: string; spent: number }
  | { t: "budget"; spent: number }
