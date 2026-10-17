import { type ToolContext, type ToolDefinition, textResult } from "@amira/api"
import { RUNNER_CAPABILITIES, type RunnerCapabilities, type RunnerOwner } from "./runner.ts"

export interface WorkflowStartRequest {
  script?: string
  name?: string
  args?: unknown
  startedBy: { sessionId: string; label: string }
}

export interface BoundWorkflow {
  cwd: string
  owner: RunnerOwner
  /** Recheck at each launch: cached services can be unloaded or replaced. */
  current(): unknown
}

export function isWorkflowRunner(value: unknown): value is WorkflowRunner {
  if (!value || typeof value !== "object") return false
  const runner = value as Partial<WorkflowRunner>
  return [runner.start, runner.status, runner.stop, runner.onResult].every((fn) => typeof fn === "function")
}

export function supportsBoundWorkflow(value: unknown): value is WorkflowRunner & {
  startBound: NonNullable<WorkflowRunner["startBound"]>
} {
  if (!isWorkflowRunner(value)) return false
  return (
    Object.keys(RUNNER_CAPABILITIES).every(
      (key) => value.capabilities?.[key as keyof RunnerCapabilities] === true,
    ) &&
    typeof value.startBound === "function" &&
    typeof value.onProgress === "function"
  )
}

export const BOUND_WORKFLOW_UNAVAILABLE =
  "Member workflows are disabled for this bound swarm: workflow.runner must be available with startBound, onProgress and cwd/freshRun/models/ownedLifetime/progress capabilities. No legacy workflow start will be used."

/** Structural contract of the optional workflow.runner service; no package dependency. */
export interface WorkflowRunner {
  capabilities?: RunnerCapabilities
  start(request: WorkflowStartRequest, ctx: ToolContext): Promise<{ runId: string } | { error: string }>
  startBound?(
    request: WorkflowStartRequest & { cwd: string },
    owner: RunnerOwner,
  ): Promise<{ runId: string } | { error: string }>
  onProgress?(runId: string, listener: (snapshot: unknown) => void): () => void
  status(runId: string): WorkflowResult | undefined
  stop(runId: string): boolean
  /** Replays an already completed result to late subscribers. */
  onResult(runId: string, listener: (result: WorkflowResult) => void): () => void
}

interface WorkflowResult {
  runId: string
  name: string
  status: string
  startedBy?: { sessionId: string; label: string }
  result?: unknown
  error?: string
}

export interface MemberWorkflowSettings {
  enabled: boolean
  maxRunning: number
  maxPerMember: number
}

const MAX_RESULT_CHARS = 8000
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

interface Run {
  owner: string
  name: string
  runId?: string
  running: boolean
  unsubscribe?: () => void
  settled?: Promise<void>
}

/** Owns reservations as well as runs, so concurrent confirmation dialogs cannot exceed limits. */
export class MemberWorkflows {
  #runs: Run[] = []
  #pending = new Set<Promise<unknown>>()
  #abort = new AbortController()

  constructor(
    private runner: WorkflowRunner | undefined,
    private limits: MemberWorkflowSettings,
    private hooks: {
      board(value: string): void
      result(owner: string, text: string): void
      changed(): void
      canStart(owner: string): boolean
    },
    private bound?: BoundWorkflow,
  ) {}

  runningFor(owner: string): boolean {
    return this.#runs.some((run) => run.owner === owner && run.running)
  }

  #listing(): string {
    return (
      this.#runs
        .filter((run) => run.running)
        .map((run) => `${run.owner}: ${run.runId ?? "awaiting start"} (${run.name})`)
        .join("\n") || "No member workflows running."
    )
  }

  #publish() {
    this.hooks.board(this.#listing())
  }

  tools(owner: string): ToolDefinition[] {
    if (!this.limits.enabled) return []
    if (this.bound && !supportsBoundWorkflow(this.runner)) {
      return [
        {
          name: "start_workflow",
          description: BOUND_WORKFLOW_UNAVAILABLE,
          parameters: { type: "object", properties: {} },
          execute: async () => textResult(BOUND_WORKFLOW_UNAVAILABLE, true),
        },
      ]
    }
    return [
      {
        name: "start_workflow",
        description:
          'Start a workflow by script or saved name. Load the workflow skill first. Results arrive as messages; end your turn. Check the "workflows" board to coordinate.',
        parameters: {
          type: "object",
          properties: {
            script: { type: "string" },
            name: { type: "string" },
            args: {},
          },
        },
        execute: (params, ctx) => {
          const pending = this.#start(owner, params, ctx)
          this.#pending.add(pending)
          // Handle either settlement without leaving a rejected finally() promise behind.
          void pending.then(
            () => this.#pending.delete(pending),
            () => this.#pending.delete(pending),
          )
          return pending
        },
      },
      {
        name: "workflow_status",
        description: "Show your workflows; omit runId to list all your runs.",
        parameters: { type: "object", properties: { runId: { type: "string" } } },
        execute: async (params) => {
          const runs = this.#runs.filter(
            (run) => run.owner === owner && (!params.runId || run.runId === params.runId),
          )
          if (params.runId && !runs.length)
            return textResult(`No workflow run ${params.runId} belongs to you.`, true)
          return textResult(
            runs
              .map((run) =>
                run.runId
                  ? JSON.stringify(
                      this.runner?.status(run.runId) ?? { runId: run.runId, status: "unavailable" },
                    )
                  : `${run.name}: ${run.running ? "awaiting start" : "not started"}`,
              )
              .join("\n") || "You have not started a workflow.",
          )
        },
      },
      {
        name: "stop_workflow",
        description: "Stop one of your workflows by runId.",
        parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
        execute: async (params) => {
          const run = this.#runs.find((run) => run.owner === owner && run.runId === params.runId && run.runId)
          if (!run) return textResult(`No workflow run ${params.runId} belongs to you.`, true)
          return textResult(
            this.runner?.stop(run.runId!)
              ? `Stopping workflow ${run.runId}.`
              : `Workflow ${run.runId} is not running.`,
          )
        },
      },
    ]
  }

  async #stopRun(runner: WorkflowRunner, runId: string) {
    if (!this.bound) {
      runner.stop(runId)
      return
    }
    // A terminal status is not the provider's shutdown barrier; wait for settled onResult.
    let unsubscribe: (() => void) | undefined
    await new Promise<void>((resolve) => {
      let settled = false
      unsubscribe = runner.onResult(runId, () => {
        settled = true
        unsubscribe?.()
        resolve()
      })
      if (settled) unsubscribe()
      runner.stop(runId)
    })
  }

  async #start(owner: string, params: { script?: string; name?: string; args?: unknown }, ctx: ToolContext) {
    if (this.#abort.signal.aborted || !this.hooks.canStart(owner))
      return textResult("The member or swarm is stopping; no workflow started.", true)
    if (ctx.signal.aborted || this.bound?.owner.signal.aborted)
      return textResult("The workflow start was cancelled.", true)
    const runner = this.runner
    if (!runner || (this.bound && (!supportsBoundWorkflow(runner) || this.bound.current() !== runner)))
      return textResult(BOUND_WORKFLOW_UNAVAILABLE, true)
    if (!ctx.session) return textResult("A member session is required to start a workflow.", true)
    const running = this.#runs.filter((run) => run.running)
    const own = running.filter((run) => run.owner === owner)
    if (running.length >= this.limits.maxRunning || own.length >= this.limits.maxPerMember) {
      return textResult(
        `Workflow limit reached (${this.limits.maxRunning} per swarm, ${this.limits.maxPerMember} per member). Running or awaiting start:\n${this.#listing()}\nCoordinate with these members using send_message or read the "workflows" board; wait for a result before starting more.`,
        true,
      )
    }
    const run: Run = { owner, name: params.name ?? "inline script", running: true }
    this.#runs.push(run)
    const signal = AbortSignal.any([
      ctx.signal,
      this.#abort.signal,
      ...(this.bound ? [this.bound.owner.signal] : []),
    ])
    try {
      this.#publish()
      const request = { ...params, startedBy: { sessionId: ctx.session.sessionId, label: owner } }
      const started = this.bound
        ? await runner.startBound!({ ...request, cwd: this.bound.cwd }, { ...this.bound.owner, signal })
        : await runner.start(request, { ...ctx, signal })
      if ("error" in started) {
        run.running = false
        return textResult(started.error, true)
      }
      run.runId = started.runId
      // A confirmation can settle concurrently with stop, even if the service ignores abort.
      if (signal.aborted || !this.hooks.canStart(owner)) {
        run.running = false
        await this.#stopRun(runner, run.runId)
        return textResult(`Workflow ${run.runId} stopped because its start was cancelled.`, true)
      }
      if (this.bound && (this.bound.current() !== runner || !supportsBoundWorkflow(runner))) {
        run.running = false
        await this.#stopRun(runner, run.runId)
        return textResult(BOUND_WORKFLOW_UNAVAILABLE, true)
      }
      run.name = runner.status(run.runId)?.name ?? run.name
      this.#publish()
      let settle!: () => void
      run.settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      run.unsubscribe = runner.onResult(run.runId, (result) => {
        settle()
        if (!run.running) {
          run.unsubscribe?.()
          return
        }
        run.running = false
        this.#publish()
        this.hooks.result(
          owner,
          clip(
            `Workflow ${result.runId} (${result.name}) ${result.status}.\n${result.error !== undefined ? `Error: ${result.error}` : `Result: ${JSON.stringify(result.result) ?? "null"}`}`,
            MAX_RESULT_CHARS,
          ),
        )
        run.unsubscribe?.()
        this.hooks.changed()
      })
      // onResult may replay a completed result synchronously, before returning its disposer.
      if (!run.running) run.unsubscribe()
      return textResult(
        `Started workflow ${run.runId} (${run.name}). Its result will arrive as a message; end your turn unless you have other work.`,
      )
    } catch (error) {
      run.running = false
      run.unsubscribe?.()
      if (run.runId) await this.#stopRun(runner, run.runId)
      return textResult(
        `Workflow could not start: ${error instanceof Error ? error.message : String(error)}`,
        true,
      )
    } finally {
      if (!run.running) this.#publish()
      this.hooks.changed()
    }
  }

  async stop(): Promise<void> {
    this.#abort.abort()
    // Stop established runs before waiting for any outstanding confirmation to cancel.
    for (const run of this.#runs) {
      if (!run.running || !run.runId) continue
      run.running = false
      if (!this.bound) run.unsubscribe?.()
      this.runner?.stop(run.runId)
    }
    await Promise.allSettled(this.#pending)
    if (this.bound) await Promise.all(this.#runs.flatMap((run) => (run.settled ? [run.settled] : [])))
    this.#publish()
  }
}
