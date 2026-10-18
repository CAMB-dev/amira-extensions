import path from "node:path"
import type { ExtensionAPI, SpawnGroup, SpawnGroupOptions } from "@amira/api"
import { type Bundle, NORMAL_CAPS, reviewCaps } from "./collect.ts"

// Consumer-local structural contract; no workflow implementation imports or registry augmentation.
export interface WorkflowSnapshot {
  runId: string
  status: string
  result?: unknown
  error?: string
  children?: { label: string; state: string }[]
}
export interface WorkflowRunner {
  capabilities: { cwd: true; freshRun: true; models: true; ownedLifetime: true; progress: true }
  available(): true | { reason: string }
  startBound(
    request: {
      script: string
      args: unknown
      cwd: string
      startedBy: { sessionId: string; label: string }
    },
    owner: {
      sessionId: string
      label: string
      signal: AbortSignal
      createGroup(options: SpawnGroupOptions): SpawnGroup
    },
  ): Promise<{ runId: string } | { error: string }>
  status(runId: string): WorkflowSnapshot | undefined
  stop(runId: string): boolean
  onProgress(runId: string, listener: (snapshot: WorkflowSnapshot) => void): () => void
  onResult(runId: string, listener: (result: WorkflowSnapshot) => void): () => void
}
const flags = ["cwd", "freshRun", "models", "ownedLifetime", "progress"] as const
const methods = ["available", "startBound", "status", "stop", "onProgress", "onResult"] as const

export function workflowRunner(api: Pick<ExtensionAPI, "useService">): WorkflowRunner {
  const value: unknown = api.useService?.("workflow.runner")
  if (!value || typeof value !== "object")
    throw new Error("Deep review needs workflow.runner (workflow 0.3.1 or later).")
  const runner = value as Partial<WorkflowRunner>
  const missing = [
    ...flags.filter((key) => runner.capabilities?.[key] !== true).map((key) => `capabilities.${key}=true`),
    ...methods.filter((key) => typeof runner[key] !== "function"),
  ]
  if (missing.length)
    throw new Error(`Deep review: incompatible workflow.runner; requires ${missing.join(", ")}.`)
  const available = runner.available!()
  if (available !== true)
    throw new Error(
      `Deep review unavailable: ${available?.reason || "workflow did not report availability"}.`,
    )
  return runner as WorkflowRunner
}

export const MAX_GROUPS = 12
export const DEEP_CANDIDATES = (MAX_GROUPS + 2) * 6
export const DEEP_PARALLEL = 6
// Count actual +/- lines, including source text resembling diff file headers.
const changedCounts = (change: Bundle["changes"][number]) => {
  let inHunk = false,
    added = 0,
    removed = 0
  for (const line of change.patch.split("\n")) {
    if (line.startsWith("@@ ")) inHunk = true
    else if (inHunk && line.startsWith("+")) added++
    else if (inHunk && line.startsWith("-")) removed++
  }
  return { added, removed }
}

/** Directory-ordered first-fit packing: related paths stay together where size permits. */
export function groupChanges(bundle: Bundle): Bundle[] {
  const cap = reviewCaps(bundle.scope)
  if (
    bundle.changes.length > cap.files ||
    bundle.added + bundle.removed > cap.lines ||
    Buffer.byteLength(bundle.patch) > cap.patchBytes
  )
    throw new Error("Deep review exceeds its admission cap; narrow --path.")
  const groups: { changes: Bundle["changes"]; lines: number; bytes: number }[] = []
  for (const change of [...bundle.changes].sort(
    (a, b) =>
      path.posix.dirname(a.path).localeCompare(path.posix.dirname(b.path), "en") ||
      a.path.localeCompare(b.path, "en"),
  )) {
    const counts = changedCounts(change)
    const lines = counts.added + counts.removed,
      bytes = Buffer.byteLength(change.patch)
    if (lines > NORMAL_CAPS.lines || bytes > 32 * 1024)
      throw new Error(
        "A deep-review file exceeds the per-group line or per-file patch cap; narrow the change set.",
      )
    const fits = (group: (typeof groups)[number]) =>
      group.changes.length < NORMAL_CAPS.files &&
      group.lines + lines <= NORMAL_CAPS.lines &&
      group.bytes + bytes <= NORMAL_CAPS.patchBytes
    const directory = path.posix.dirname(change.path)
    const group =
      groups.find(
        (entry) => fits(entry) && entry.changes.some((item) => path.posix.dirname(item.path) === directory),
      ) ?? groups.find(fits)
    if (group) {
      group.changes.push(change)
      group.lines += lines
      group.bytes += bytes
    } else {
      if (groups.length >= MAX_GROUPS)
        throw new Error(`Deep review exceeds ${MAX_GROUPS} groups; narrow --path.`)
      groups.push({ changes: [change], lines, bytes })
    }
  }
  return groups.map(({ changes }) => ({
    ...bundle,
    changes,
    added: changes.reduce((sum, change) => sum + changedCounts(change).added, 0),
    removed: changes.reduce((sum, change) => sum + changedCounts(change).removed, 0),
    patch: changes.map((change) => change.patch).join(""),
  }))
}

export interface ReviewTask {
  lens: string
  prompt: string
}
export const REVIEW_FANOUT = `export const meta = {
  name: "code-review-deep",
  description: "Review sanitized change groups and two independent lenses in parallel; return candidates for host validation and assessment",
  phases: ["Review"],
}
phase("Review")
return await parallel(args.tasks.map((task) => () => agent(task.prompt, {
  label: task.lens,
  model: args.model,
  schema: args.schema,
})))`

/** onResult, not a terminal status/progress event, is the provider settlement barrier. */
export async function runFanout(
  api: Pick<ExtensionAPI, "useService">,
  options: {
    cwd: string
    origin: string
    ownerId: string
    signal: AbortSignal
    createGroup(options: SpawnGroupOptions): SpawnGroup
    args: unknown
    progress(snapshot: WorkflowSnapshot): void
    attached(runner: WorkflowRunner, runId: string): void
  },
): Promise<unknown[]> {
  const runner = workflowRunner(api)
  options.signal.throwIfAborted()
  const started = await runner.startBound(
    {
      script: REVIEW_FANOUT,
      args: options.args,
      cwd: options.cwd,
      startedBy: { sessionId: options.origin, label: "Code review" },
    },
    {
      sessionId: options.ownerId,
      label: "Code review",
      signal: options.signal,
      createGroup: options.createGroup,
    },
  )
  if ("error" in started) throw new Error(started.error)
  const runId = started.runId
  if (typeof runId !== "string" || !runId) throw new Error("Workflow returned no run ID.")
  options.attached(runner, runId)
  let offProgress = () => {},
    offResult = () => {}
  let unavailable: unknown
  const stop = () => runner.stop(runId)
  const check = () => {
    try {
      if (workflowRunner(api) !== runner) throw new Error("workflow.runner changed during deep review.")
    } catch (error) {
      unavailable = error
      stop()
    }
  }
  const timer = setInterval(check, 250)
  options.signal.addEventListener("abort", stop, { once: true })
  try {
    const result = await new Promise<WorkflowSnapshot>((resolve, reject) => {
      offProgress = runner.onProgress(runId, (snapshot) => {
        if (snapshot.runId === runId) options.progress(snapshot)
      })
      offResult = runner.onResult(runId, (snapshot) => {
        if (snapshot.runId !== runId) return
        check()
        if (unavailable) reject(unavailable)
        else resolve(snapshot)
      })
      if (options.signal.aborted) stop()
      check()
    })
    options.signal.throwIfAborted()
    if (result.status !== "done")
      throw new Error(result.error || `Deep workflow ${result.status}; no normal review was substituted.`)
    if (!Array.isArray(result.result)) throw new Error("Deep workflow returned an invalid candidate batch.")
    return result.result
  } finally {
    clearInterval(timer)
    options.signal.removeEventListener("abort", stop)
    offProgress()
    offResult()
  }
}
