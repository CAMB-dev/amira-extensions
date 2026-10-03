import type { ToolContext } from "@amira/api"
import type { WorkflowRunner } from "../src/workflows.ts"

type Request = Parameters<WorkflowRunner["start"]>[0]
type Result = NonNullable<ReturnType<WorkflowRunner["status"]>>
type Started = Awaited<ReturnType<WorkflowRunner["start"]>>

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Public service fake with controllable confirmation and synchronous late-result replay. */
export function workflowRunner() {
  const starts: { request: Request; ctx: ToolContext }[] = []
  const stops: string[] = []
  const results = new Map<string, Result>()
  const listeners = new Map<string, Set<(result: Result) => void>>()
  let nextStart: ((request: Request, ctx: ToolContext) => Promise<Started>) | undefined
  let seq = 0
  const finish = (runId: string, status = "done", value: unknown = "workflow output") => {
    const result: Result = {
      ...results.get(runId)!,
      status,
      ...(status === "error" ? { error: String(value) } : { result: value }),
    }
    results.set(runId, result)
    for (const listener of [...(listeners.get(runId) ?? [])]) listener(result)
  }
  const runner: WorkflowRunner = {
    async start(request, ctx) {
      starts.push({ request, ctx })
      const runId = `wf${++seq}`
      results.set(runId, {
        runId,
        name: request.name ?? "inline",
        status: "running",
        startedBy: request.startedBy,
      })
      const start = nextStart
      nextStart = undefined
      return start ? start(request, ctx) : { runId }
    },
    status: (runId) => results.get(runId),
    stop: (runId) => {
      stops.push(runId)
      if (results.get(runId)?.status !== "running") return false
      finish(runId, "aborted", "stopped")
      return true
    },
    onResult: (runId, listener) => {
      const set = listeners.get(runId) ?? new Set()
      listeners.set(runId, set)
      set.add(listener)
      const result = results.get(runId)
      if (result && result.status !== "running") listener(result)
      return () => set.delete(listener)
    },
  }
  return {
    runner,
    starts,
    stops,
    results,
    listeners,
    finish,
    next: (start: (request: Request, ctx: ToolContext) => Promise<Started>) => {
      nextStart = start
    },
    pending: () => {
      const pending = deferred<Started>()
      nextStart = () => pending.promise
      return pending
    },
  }
}
