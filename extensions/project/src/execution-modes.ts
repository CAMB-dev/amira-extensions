import path from "node:path"
import type { ExtensionAPI, OwnedConversation, SpawnGroup, SpawnGroupOptions } from "@amira/api"

export type ExecutionMode = "single" | "workflow" | "swarm"
type BoundMode = Exclude<ExecutionMode, "single">
type Services = Pick<ExtensionAPI, "useService">

export interface RunnerOwner {
  sessionId: string
  label: string
  signal: AbortSignal
  createGroup(options: SpawnGroupOptions): SpawnGroup
}

/** Consumer-local mirrors: neither provider imports nor service-registry augmentation. */
export interface RunnerSnapshot {
  runId: string
  cwd?: string
  groupId?: string
  sessionIds?: string[]
  models?: string[]
  status?: string
  state?: string
  phase?: string
  result?: unknown
  error?: string
  reason?: string
  children?: { sessionId?: string; model?: string; label: string; state: string }[]
  members?: {
    sessionId?: string
    model?: string
    name: string
    status: string
    result?: string
    text?: string
    error?: string
    stopReason?: string
    note?: string
  }[]
}

export interface BoundRunner {
  available(): true | { reason: string }
  capabilities: { cwd: true; freshRun: true; models: true; ownedLifetime: true; progress: true }
  startBound(
    request: {
      cwd: string
      startedBy: { sessionId: string; label: string }
      script?: string
      args?: unknown
      goal?: string
      members?: { name: string; role: string; brief: string; model?: string }[]
    },
    owner: RunnerOwner,
  ): Promise<{ runId: string } | { error: string }>
  status(runId: string): RunnerSnapshot | undefined
  stop(runId: string): boolean
  onProgress(runId: string, listener: (snapshot: RunnerSnapshot) => void): () => void
  onResult(runId: string, listener: (result: RunnerSnapshot) => void): () => void
}

const capabilities = ["cwd", "freshRun", "models", "ownedLifetime", "progress"] as const
const methods = ["available", "startBound", "status", "stop", "onProgress", "onResult"] as const

export function boundRunner(api: Services, mode: BoundMode): BoundRunner {
  const value: unknown = api.useService(`${mode}.runner`)
  const reason = (detail: string) =>
    new Error(
      `${mode}.runner ${detail}. The approved ${mode} mode is blocked; review and approve a different mode before switching.`,
    )
  if (!value || typeof value !== "object") throw reason("is unavailable or disabled")
  const runner = value as Partial<BoundRunner>
  const missing = [
    ...capabilities
      .filter((key) => runner.capabilities?.[key] !== true)
      .map((key) => `capabilities.${key}=true`),
    ...methods.filter((key) => typeof runner[key] !== "function"),
  ]
  if (missing.length) throw reason(`is incompatible: requires ${missing.join(", ")}`)
  const availability = runner.available!()
  if (availability !== true)
    throw reason(`is unavailable: ${availability?.reason || "the provider did not report availability"}`)
  return runner as BoundRunner
}

export function discoverModes(api: Services): ExecutionMode[] {
  const modes: ExecutionMode[] = ["single"]
  for (const mode of ["workflow", "swarm"] as const) {
    try {
      boundRunner(api, mode)
      modes.push(mode)
    } catch {
      // Optional services can be absent, disabled, or from an older provider.
    }
  }
  return modes
}

/** Multiple ordered batches favor a workflow; one parallel batch favors a swarm. */
export function recommendMode(
  modes: readonly ExecutionMode[],
  batches: readonly { itemIds: readonly string[] }[],
): ExecutionMode {
  if (batches.length > 1 && modes.includes("workflow")) return "workflow"
  if (batches.some((batch) => batch.itemIds.length > 1)) {
    if (modes.includes("swarm")) return "swarm"
    if (modes.includes("workflow")) return "workflow"
  }
  return "single"
}

export interface BoundProgress {
  phase: string
  children: { sessionId?: string; model?: string; label: string; state: string }[]
  models: string[]
  cwd?: string
  runId: string
  groupId?: string
}
export interface BoundRunResult {
  text: string
  models: string[]
  runId: string
  sessionIds: string[]
  groupId?: string
  cwd: string
}

export class BoundRunError extends Error {
  readonly runId?: string
  readonly models: string[]
  readonly sessionIds: string[]
  readonly groupId?: string
  readonly cwd?: string

  constructor(
    message: string,
    metadata: Omit<BoundRunResult, "text" | "runId" | "cwd"> & { runId?: string; cwd?: string },
  ) {
    super(message)
    this.name = "BoundRunError"
    this.runId = metadata.runId
    this.models = metadata.models
    this.sessionIds = metadata.sessionIds
    this.groupId = metadata.groupId
    this.cwd = metadata.cwd
  }
}

export interface BoundRunOptions {
  api: Services
  mode: BoundMode
  handle: OwnedConversation
  signal: AbortSignal
  cwd: string
  model?: string
  batchId: string
  seed: string
  items: readonly { id: string; description: string }[]
  onProgress?(progress: BoundProgress): void
}

// agent() always spawns fresh context; bound providers force isolation:none as well.
const script = `export const meta = {
  name: "project-implement",
  description: "Implement the approved project batch in its iteration checkout",
  phases: ["Implement"],
}
phase("Implement")
const results = []
for (const item of args.items) {
  const text = await agent(args.seed + "\\n\\nImplement only item " + item.id + ": " + item.description + ". Do not implement other items or create per-agent worktrees.", {
    label: item.id,
    role: "coder",
    model: args.model,
    isolation: "none",
  })
  results.push(item.id + ":\\n" + text)
}
return results.join("\\n\\n")`

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function runBound(options: BoundRunOptions): Promise<BoundRunResult> {
  const { api, mode, handle, signal: parentSignal, cwd, model, batchId, seed, items, onProgress } = options
  // Also cancels a provider's pending confirmation on service loss or idle-owner Stop.
  const cancellation = new AbortController()
  const signal = AbortSignal.any([parentSignal, cancellation.signal])
  if (signal.aborted) throw new Error(`Implementation aborted: ${message(signal.reason)}`)
  if (!path.isAbsolute(cwd)) throw new Error("Bound implementation requires an absolute cwd")
  if (!items.length) throw new Error("Bound implementation requires at least one item")
  // Deliberately rediscover at launch, never retain a recommendation-time service.
  const runner = boundRunner(api, mode)
  const stop = runner.stop.bind(runner)
  const label = `Implement ${batchId}`
  const startedBy = { sessionId: handle.id, label }
  const members = items.map((item, index) => ({
    name: `item-${index + 1}`,
    role: "coder",
    model,
    brief: `${seed}\n\nYour exclusive implementation assignment is ${item.id}: ${item.description}. Implement only this item. Other items belong to other members; coordinate shared-file edits before writing. Do not create per-agent worktrees.`,
  }))
  if (items.length === 1) {
    members.push({
      name: "researcher",
      role: "explorer",
      model,
      brief: `${seed}\n\nResearch-only collaborator for ${items[0]!.id}: ${items[0]!.description}. Read relevant code and report constraints and verification suggestions to item-1. Do not edit any files, implement the item, or create worktrees.`,
    })
  }

  return new Promise<BoundRunResult>((resolve, reject) => {
    let runId: string | undefined
    let groupId: string | undefined
    let effectiveCwd: string | undefined
    let finished = false
    let stopRequested = false
    let stopped = false
    const models = new Set<string>()
    const sessionIds = new Set<string>()
    let children: BoundProgress["children"] = []
    let phase: string | undefined
    let incompleteChild: BoundProgress["children"][number] | undefined
    let publishedProgress: string | undefined
    const subscriptions = new Set<() => void>()
    let timer: ReturnType<typeof setInterval> | undefined
    const metadata = () => ({
      runId,
      groupId,
      cwd: effectiveCwd,
      models: [...models],
      sessionIds: [...sessionIds],
    })
    const cleanup = () => {
      if (timer !== undefined) clearInterval(timer)
      signal.removeEventListener("abort", aborted)
      for (const unsubscribe of subscriptions) {
        try {
          unsubscribe()
        } catch {
          /* Still release the remaining subscriptions. */
        }
      }
      subscriptions.clear()
    }
    const stopRun = () => {
      if (!runId || stopped || !stopRequested) return
      stopped = true
      try {
        stop(runId)
      } catch {
        /* Preserve the original cancellation/loss reason. */
      }
    }
    const fail = (reason: unknown, shouldStop = true) => {
      if (finished) return
      finished = true
      stopRequested = shouldStop
      stopRun()
      cleanup()
      cancellation.abort(new Error(message(reason)))
      reject(new BoundRunError(message(reason), metadata()))
    }
    const aborted = () => fail(`Implementation aborted: ${message(signal.reason)}`)
    const current = () => {
      if (finished) return false
      try {
        if (signal.aborted) throw new Error(`Implementation aborted: ${message(signal.reason)}`)
        if (handle.status().state === "stopped") throw new Error("Implementation coordinator was stopped")
        if (boundRunner(api, mode) !== runner)
          throw new Error(`${mode}.runner was replaced during implementation`)
        return true
      } catch (error) {
        fail(error)
        return false
      }
    }
    const observe = (snapshot: RunnerSnapshot) => {
      if (!current()) return false
      for (const model of snapshot.models ?? []) models.add(model)
      for (const id of snapshot.sessionIds ?? []) sessionIds.add(id)
      groupId ??= snapshot.groupId
      // Workflow status() deliberately omits phase/children. Do not erase the
      // detailed onProgress snapshot on each liveness poll.
      if (mode === "swarm" && snapshot.members !== undefined)
        children = snapshot.members.map((member) => ({
          sessionId: member.sessionId,
          model: member.model,
          label: member.name,
          state: member.status,
        }))
      else if (snapshot.children !== undefined)
        children = snapshot.children.map((child) => ({
          sessionId: child.sessionId,
          model: child.model,
          label: child.label,
          state: child.state,
        }))
      phase = snapshot.phase ?? (mode === "swarm" ? snapshot.state : undefined) ?? phase
      for (const child of children) {
        if (mode === "workflow" && ["stopped", "failed", "error", "aborted"].includes(child.state))
          incompleteChild ??= { ...child }
        if (child.model) models.add(child.model)
        if (child.sessionId) sessionIds.add(child.sessionId)
      }
      if (snapshot.cwd !== undefined) effectiveCwd = snapshot.cwd
      if (snapshot.runId !== runId) {
        fail(`${mode}.runner returned a mismatched run ID`)
        return false
      }
      if (snapshot.cwd !== undefined && path.relative(path.resolve(cwd), path.resolve(snapshot.cwd))) {
        fail(`${mode}.runner effective cwd ${snapshot.cwd} does not match approved cwd ${cwd}`)
        return false
      }
      try {
        const progress: BoundProgress = {
          phase: phase ?? snapshot.status ?? "running",
          children,
          models: [...models],
          cwd: effectiveCwd,
          runId: runId!,
          groupId,
        }
        // Each panel invalidation also refreshes durable stage evidence. Liveness
        // polling must not turn unchanged provider status into repeated disk work.
        const fingerprint = JSON.stringify(progress)
        if (fingerprint !== publishedProgress) {
          publishedProgress = fingerprint
          onProgress?.(progress)
        }
      } catch (error) {
        fail(error)
      }
      return !finished
    }
    const poll = () => {
      if (!current() || !runId) return
      try {
        const snapshot = runner.status(runId)
        if (!snapshot) fail(`${mode}.runner lost run ${runId}`)
        else observe(snapshot)
      } catch (error) {
        fail(error)
      }
    }
    const result = (snapshot: RunnerSnapshot) => {
      if (!observe(snapshot)) return
      // Terminal status/progress is not a settlement barrier: only onResult reaches here.
      if (mode === "workflow" && (snapshot.status !== "done" || incompleteChild)) {
        fail(
          snapshot.error ??
            (incompleteChild
              ? `Workflow child ${incompleteChild.label} ${incompleteChild.state} before completion`
              : `Workflow ${snapshot.status ?? "failed"}`),
        )
        return
      }
      if (mode === "swarm") {
        const failed = snapshot.members?.find(
          (member) =>
            member.error ||
            member.stopReason ||
            ["error", "failed", "aborted"].includes(member.status) ||
            (member.note !== undefined && member.note !== snapshot.reason),
        )
        const normal =
          snapshot.reason === "every member ended" ||
          snapshot.reason === "every member is idle and no message is on its way"
        if (failed || !normal) {
          fail(
            (!normal ? snapshot.reason : undefined) ||
              failed?.error ||
              failed?.stopReason ||
              failed?.note ||
              (failed
                ? `Swarm member ${failed.name} ended before completion (${failed.status})`
                : "Swarm failed"),
          )
          return
        }
      }
      if (!effectiveCwd) {
        fail(`${mode}.runner did not report its effective cwd`)
        return
      }
      if (!models.size || !sessionIds.size) {
        fail(`${mode}.runner completed without effective models or child session IDs`)
        return
      }
      const text =
        mode === "swarm"
          ? (snapshot.members ?? [])
              .map((member) => `${member.name}:\n${member.result ?? member.text ?? ""}`)
              .join("\n\n")
          : typeof snapshot.result === "string"
            ? snapshot.result
            : (JSON.stringify(snapshot.result) ?? "")
      finished = true
      cleanup()
      resolve({ ...metadata(), runId: runId!, cwd: effectiveCwd, text })
    }
    // Synchronous replay may finish before a subscription returns its cleanup function.
    const subscribe = (register: () => () => void) => {
      const unsubscribe = register()
      if (finished) unsubscribe()
      else subscriptions.add(unsubscribe)
    }
    signal.addEventListener("abort", aborted, { once: true })
    timer = setInterval(poll, 100)
    const owner: RunnerOwner = {
      ...startedBy,
      signal,
      createGroup(groupOptions) {
        if (!current()) throw new Error("Implementation owner is no longer active; no group was created")
        const group = handle.createGroup(groupOptions)
        groupId ??= group.id
        return group
      },
    }
    void (async () => {
      try {
        if (!current()) return
        const started = await runner.startBound(
          mode === "workflow"
            ? { cwd, startedBy, script, args: { seed, items: [...items], model } }
            : { cwd, startedBy, goal: seed, members },
          owner,
        )
        if ("error" in started) {
          fail(`${mode}.runner could not start: ${started.error}`, false)
          return
        }
        runId = started.runId
        if (finished) {
          stopRun()
          return
        }
        if (!runId) {
          fail(`${mode}.runner did not return a run ID`, false)
          return
        }
        poll()
        if (finished) return
        subscribe(() =>
          runner.onProgress(runId!, (snapshot) => {
            observe(snapshot)
          }),
        )
        if (!finished) subscribe(() => runner.onResult(runId!, result))
      } catch (error) {
        fail(error)
      }
    })()
  })
}
