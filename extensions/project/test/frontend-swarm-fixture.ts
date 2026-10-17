import type { Extension, SpawnGroup, ToolDefinition } from "@amira/api"
import type { BoundRunner, RunnerOwner, RunnerSnapshot } from "../src/execution-modes.ts"

/** Structural service only: member turns, extra-tool execution and policy are the real host. */
export function swarmFixture() {
  type Run = {
    request: Parameters<BoundRunner["startBound"]>[0]
    owner: RunnerOwner
    group: SpawnGroup
    snapshot: RunnerSnapshot
    progress: Set<(snapshot: RunnerSnapshot) => void>
    results: Set<(snapshot: RunnerSnapshot) => void>
  }
  const runs: Run[] = []
  const stopped: string[] = []
  const calls: { name: string; sessionId?: string; cwd: string }[] = []
  const messages: string[] = []
  let blackboard = ""
  let forbiddenCalls = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const find = (id: string) => runs.find((run) => run.snapshot.runId === id)!
  const runner: BoundRunner = {
    available: () => true,
    capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
    startBound(request, owner) {
      const group = owner.createGroup({ name: `Swarm ${owner.label}`, maxAgents: 2, maxConcurrent: 1 })
      const snapshot: RunnerSnapshot = {
        runId: `offline-swarm-${runs.length + 1}`,
        cwd: request.cwd,
        groupId: group.id,
        status: "running",
        phase: "Implement",
        models: [],
        sessionIds: [],
        members: [],
      }
      const run: Run = { request, owner, group, snapshot, progress: new Set(), results: new Set() }
      runs.push(run)
      const tools: ToolDefinition[] = [
        "send_message",
        "list_agents",
        "blackboard_read",
        "blackboard_write",
        "finish",
      ].map((name) => ({
        name,
        description: `Offline swarm fixture ${name}`,
        parameters: { type: "object", properties: { value: { type: "string" } } },
        async execute(args, ctx) {
          calls.push({ name, sessionId: ctx.session?.sessionId, cwd: ctx.cwd })
          if (name === "send_message") messages.push(String(args.value))
          if (name === "blackboard_write") blackboard = String(args.value)
          if (name === "finish") {
            // A bounded test gate; real owner cancellation must release the executing tool.
            await Promise.race([
              held,
              new Promise<void>((resolve) => {
                if (ctx.signal.aborted) resolve()
                else ctx.signal.addEventListener("abort", () => resolve(), { once: true })
              }),
            ])
          }
          const value = name === "list_agents" ? snapshot.members!.map((member) => member.name) : blackboard
          return { content: [{ type: "text", text: JSON.stringify({ name, value }) }] }
        },
      }))
      tools.push({
        name: "offline_forbidden",
        description: "Must remain outside the inherited callable-tool ceiling",
        parameters: { type: "object", properties: {} },
        async execute() {
          forbiddenCalls++
          return { content: [{ type: "text", text: "Policy unexpectedly bypassed" }] }
        },
      })
      const children = request.members!.map((member, index) => {
        const child = group.spawn({
          title: member.name,
          role: member.role,
          context: "fresh",
          cwd: request.cwd,
          model: index === 0 ? "mock/swarm-writer" : "mock/swarm-researcher",
          prompt: `${request.goal}\n\n${member.brief}`,
          extraTools: tools,
        })
        const model = `${child.model.provider}/${child.model.model}`
        snapshot.models!.push(model)
        snapshot.sessionIds!.push(child.id)
        snapshot.members!.push({ name: member.name, model, sessionId: child.id, status: "working" })
        return child
      })
      void (async () => {
        await Promise.all(
          children.map(async (child, index) => {
            const result = await child.result()
            Object.assign(snapshot.members![index]!, {
              status: result.status,
              result: result.text,
              ...(result.note !== undefined ? { note: result.note } : {}),
              ...(result.status !== "done" ? { error: result.error ?? result.status } : {}),
            })
            for (const listener of run.progress) listener(snapshot)
          }),
        )
        group.end()
        await group.ended()
        snapshot.status = "done"
        snapshot.reason = "every member ended"
        for (const listener of run.results) listener(snapshot)
      })()
      return Promise.resolve({ runId: snapshot.runId })
    },
    status: (id) => find(id)?.snapshot,
    stop(id) {
      stopped.push(id)
      const run = find(id)
      if (!run) return false
      run.group.end("Offline swarm stopped")
      return true
    },
    onProgress(id, listener) {
      const listeners = find(id).progress
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onResult(id, listener) {
      const run = find(id)
      run.results.add(listener)
      if (run.snapshot.status !== "running") listener(run.snapshot)
      return () => run.results.delete(listener)
    },
  }
  const extension: Extension = (api) => {
    api.provideService("swarm.runner", runner)
  }
  return { extension, runs, stopped, calls, messages, release, forbiddenCalls: () => forbiddenCalls }
}
