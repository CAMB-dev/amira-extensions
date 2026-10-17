import type { Extension, SpawnGroup } from "@amira/api"
import type { BoundRunner, RunnerOwner, RunnerSnapshot } from "../src/execution-modes.ts"

/** Mock service protocol only; children, policy, file tools and model turns are the real host. */
export function workflowFixture(modelOverride?: string) {
  const runs: {
    request: Parameters<BoundRunner["startBound"]>[0]
    owner: RunnerOwner
    snapshot: RunnerSnapshot
    group: SpawnGroup
  }[] = []
  const progress = new Map<string, Set<(snapshot: RunnerSnapshot) => void>>()
  const results = new Map<string, Set<(snapshot: RunnerSnapshot) => void>>()
  const runner: BoundRunner = {
    available: () => true,
    capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
    async startBound(request, owner) {
      const args = request.args as {
        seed: string
        items: { id: string; description: string }[]
        model: string
      }
      const runId = `offline-workflow-${runs.length + 1}`
      const group = owner.createGroup({ name: `Workflow ${owner.label}`, maxConcurrent: 1, compact: true })
      group.setStatus("Implement · offline mock runner")
      const snapshot: RunnerSnapshot = {
        runId,
        cwd: request.cwd,
        groupId: group.id,
        status: "running",
        phase: "Implement",
        models: [],
        sessionIds: [],
        children: [],
      }
      runs.push({ request, owner, snapshot, group })
      void (async () => {
        try {
          const texts: string[] = []
          for (const item of args.items) {
            const child = group.spawn({
              title: item.id,
              role: "coder",
              context: "fresh",
              cwd: request.cwd,
              model: modelOverride ?? args.model,
              prompt: `${args.seed}\n\nImplement only ${item.id}: ${item.description}`,
            })
            const model = `${child.model.provider}/${child.model.model}`
            snapshot.models!.push(model)
            snapshot.sessionIds!.push(child.id)
            snapshot.children!.push({ sessionId: child.id, model, label: item.id, state: "working" })
            for (const listener of progress.get(runId) ?? []) listener(snapshot)
            const result = await child.result()
            if (result.status !== "done") throw new Error(result.error ?? result.status)
            texts.push(result.text)
            snapshot.children!.at(-1)!.state = "done"
          }
          group.end()
          await group.ended()
          snapshot.status = "done"
          snapshot.result = texts.join("\n\n")
        } catch (error) {
          group.end("Offline workflow failed")
          await group.ended()
          snapshot.status = "error"
          snapshot.error = String(error)
        }
        for (const listener of results.get(runId) ?? []) listener(snapshot)
      })()
      return { runId }
    },
    status: (runId) => runs.find((run) => run.snapshot.runId === runId)?.snapshot,
    stop(runId) {
      const run = runs.find((entry) => entry.snapshot.runId === runId)
      if (!run) return false
      run.group.end("Offline fixture stopped")
      return true
    },
    onProgress(runId, listener) {
      const listeners = progress.get(runId) ?? new Set()
      progress.set(runId, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onResult(runId, listener) {
      const listeners = results.get(runId) ?? new Set()
      results.set(runId, listeners)
      listeners.add(listener)
      const snapshot = runner.status(runId)
      if (snapshot && snapshot.status !== "running") listener(snapshot)
      return () => listeners.delete(listener)
    },
  }
  const extension: Extension = (api) => {
    api.provideService("workflow.runner", runner)
  }
  return { extension, runner, runs }
}
