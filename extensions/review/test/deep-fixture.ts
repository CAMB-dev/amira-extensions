import type { SpawnGroup } from "@amira/api"
import type { ReviewTask, WorkflowRunner, WorkflowSnapshot } from "../src/deep.ts"

/** Fake provider: real consumer-bound group, no script evaluation, model or network. */
export function fakeWorkflow(options: { maxConcurrent?: number } = {}) {
  type Owner = Parameters<WorkflowRunner["startBound"]>[1]
  type Request = Parameters<WorkflowRunner["startBound"]>[0]
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const starts: { request: Request; owner: Owner }[] = []
  const progress = new Set<(snapshot: WorkflowSnapshot) => void>()
  const results = new Set<(result: WorkflowSnapshot) => void>()
  let current: WorkflowSnapshot = { runId: "deep-run", status: "running", children: [] }
  let group: SpawnGroup | undefined
  let stops = 0
  let settled = false
  let availability: ReturnType<WorkflowRunner["available"]> = true
  const runner: WorkflowRunner = {
    capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
    available: () => availability,
    async startBound(request, owner) {
      starts.push({ request, owner })
      const args = request.args as { tasks: ReviewTask[]; model: string }
      group = owner.createGroup({
        name: "fake workflow",
        maxConcurrent: options.maxConcurrent ?? 10,
        maxAgents: 30,
        budget: { tokens: 1_000_000, costUsd: 5 },
      })
      const children = args.tasks.map((task) =>
        group!.spawn({ prompt: task.prompt, title: task.lens, tools: ["bash"], writeRoots: [request.cwd] }),
      )
      markStarted()
      current = { ...current, children: args.tasks.map((task) => ({ label: task.lens, state: "working" })) }
      void Promise.all(children.map((child) => child.result())).then(async (values) => {
        group!.end("Fake workflow settled")
        await group!.ended()
        current = {
          runId: "deep-run",
          status: "done",
          result: values.map((value) => value.value),
          children: args.tasks.map((task) => ({ label: task.lens, state: "done" })),
        }
        settled = true
        for (const listener of progress) listener(current)
        for (const listener of results) listener(current)
      })
      return { runId: "deep-run" }
    },
    status: () => structuredClone(current),
    stop() {
      stops++
      group?.end("Fake stop")
      return true
    },
    onProgress(_id, listener) {
      progress.add(listener)
      queueMicrotask(() => {
        if (progress.has(listener)) listener(structuredClone(current))
      })
      return () => {
        progress.delete(listener)
      }
    },
    onResult(_id, listener) {
      results.add(listener)
      queueMicrotask(() => {
        if (settled && results.has(listener)) listener(structuredClone(current))
      })
      return () => {
        results.delete(listener)
      }
    },
  }
  return {
    runner,
    starts,
    started,
    stops: () => stops,
    disable: () => {
      availability = { reason: "extensions.workflow.enabled: never" }
    },
  }
}
