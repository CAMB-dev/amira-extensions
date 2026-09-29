/**
 * Types of the API a workflow script sees (the Amira "workflow" extension). A script is a
 * TypeScript file whose top level runs as an async function body: it may use `await`, and it
 * ends with `return value` (or `export default value`). To type-check a saved workflow in an
 * editor, put this file next to it and start the script with:
 *
 *   /// <reference path="./workflow.d.ts" />
 *
 * Scripts cannot import anything, and have no files, processes, network, timers or modules.
 * `Date.now()`, `new Date()` and `Math.random()` throw: a run must take the same path when it
 * is resumed, so pass anything variable in through `args`.
 */

/** Options of one agent() call. Every field is part of the call's journal key. */
interface AgentOptions {
  /** A few words shown in the progress tree. Default: the prompt's first words. */
  label?: string
  /** The phase the agent is listed under. Default: the current phase(). */
  phase?: string
  /**
   * JSON Schema of the value the agent must hand back. With it, agent() resolves to that value
   * (checked against the schema) instead of the agent's final text.
   */
  schema?: Record<string, unknown>
  /** A sub-agent role: explorer (read-only), coder, reviewer (read-only), or one of the user's. */
  role?: string
  /** "provider/model". Default: the role's model, else the main session's. */
  model?: string
  /** "worktree": work in a separate git worktree, merged back when the agent finishes. Default "none". */
  isolation?: "none" | "worktree"
}

/**
 * Starts a sub-agent with `prompt` as its whole task (it sees nothing else) and resolves to its
 * final answer: its last reply's text, or with `schema` the value it returned. Rejects when the
 * agent fails, is stopped, or the run's limits (agents in all, budget) refuse it.
 */
declare function agent(prompt: string, opts?: AgentOptions): Promise<any>
declare function agent<T>(
  prompt: string,
  opts: AgentOptions & { schema: Record<string, unknown> },
): Promise<T>

/**
 * Runs the thunks at once (the run's maxConcurrent queues the rest) and resolves to their
 * results in order. A thunk that throws gives null, and the failure is logged.
 */
declare function parallel<T>(thunks: (() => T | Promise<T>)[]): Promise<(T | null)[]>

/**
 * Sends every item through the stages in order; items run at the same time and do not wait
 * for each other between stages. Each stage gets the previous stage's result, the item and its
 * index. Resolves to each item's last result, or null for an item a stage threw on.
 */
declare function pipeline<I>(
  items: I[],
  ...stages: ((previous: any, item: I, index: number) => unknown)[]
): Promise<unknown[]>

/** Starts a phase: agents started from now on are listed under it (see meta.phases). */
declare function phase(title: string): void

/** Adds a line to the run's log, shown in /workflow view. */
declare function log(...parts: unknown[]): void

/**
 * Runs a saved workflow (.amira/workflows/<name>.ts or ~/.amira/workflows/<name>.ts) with
 * `args`, and resolves to its result. It shares this run's limits, budget and journal, and is
 * shown under this run in the progress tree. Only one level deep: a nested workflow calling
 * workflow() throws.
 */
declare function workflow(name: string, args?: unknown): Promise<any>

/** What the run was started with: a JSON value, or null. */
declare const args: any

/** The run's token budget (settings workflow.budget.tokens); Infinity without one. */
declare const budget: {
  readonly total: number
  /** Tokens the run's agents have used so far. */
  spent(): number
  remaining(): number
}

/**
 * Every script starts with its meta, a plain literal (no expressions), which the user sees
 * before confirming the run.
 */
interface WorkflowMeta {
  /** Letters, digits, "-", "_" and ".". */
  name: string
  description: string
  /** Phase titles in order, as the script passes them to phase(). */
  phases: string[]
}
