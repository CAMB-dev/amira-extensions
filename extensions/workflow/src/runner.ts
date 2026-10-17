import type { SpawnGroup, SpawnGroupOptions, ToolContext } from "@amira/api"
import type { RunRecord } from "./journal.ts"
import type { FlowNode } from "./progress.ts"
import type { WorkflowRun } from "./run.ts"
import { agentStatusState } from "./status.ts"

// Provider-local structural contract. Consumers mirror it; no AmiraServices augmentation.
export interface RunnerOwner {
  sessionId: string
  label: string
  signal: AbortSignal
  createGroup(options: SpawnGroupOptions): SpawnGroup
}

export interface RunnerRequest {
  script?: string
  name?: string
  args?: unknown
  startedBy: { sessionId: string; label: string }
}

export interface RunnerResult {
  runId: string
  name: string
  status: string
  startedBy?: { sessionId: string; label: string }
  cwd?: string
  ownerSessionId?: string
  groupId?: string
  sessionIds?: string[]
  models?: string[]
  result?: unknown
  error?: string
}

export interface RunSnapshot extends RunnerResult {
  settled: boolean
  phase?: string
  children: {
    call: number
    label: string
    phase: string
    nest?: string
    childId?: string
    sessionId?: string
    model?: string
    status: string
    state: string
    error?: string
  }[]
}

export interface WorkflowRunner {
  capabilities: { cwd: true; freshRun: true; models: true; ownedLifetime: true; progress: true }
  start(request: RunnerRequest, ctx: ToolContext): Promise<{ runId: string } | { error: string }>
  startBound(
    request: RunnerRequest & { cwd: string },
    owner: RunnerOwner,
  ): Promise<{ runId: string } | { error: string }>
  status(runId: string): RunnerResult | undefined
  stop(runId: string): boolean
  onProgress(runId: string, listener: (snapshot: RunSnapshot) => void): () => void
  onResult(runId: string, listener: (result: RunnerResult) => void): () => void
}

export const runnerResult = (record: RunRecord): RunnerResult => ({
  runId: record.id,
  name: record.meta.name,
  status: record.status,
  ...(record.startedBy ? { startedBy: { ...record.startedBy } } : {}),
  ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
  ...(record.ownerSessionId !== undefined ? { ownerSessionId: record.ownerSessionId } : {}),
  ...(record.groupId !== undefined ? { groupId: record.groupId } : {}),
  ...(record.sessionIds ? { sessionIds: [...record.sessionIds] } : {}),
  ...(record.models ? { models: [...record.models] } : {}),
  ...(record.status === "done" ? { result: structuredClone(record.result) } : {}),
  ...(record.error !== undefined ? { error: record.error } : {}),
})

export function runSnapshot(run: WorkflowRun): RunSnapshot {
  const children: RunSnapshot["children"] = []
  const walk = (flow: FlowNode) => {
    for (const phase of flow.phases) {
      for (const item of phase.items) {
        if (item.kind === "workflow") walk(item)
        else
          children.push({
            call: item.call,
            label: item.label,
            phase: phase.title,
            ...(flow.nest ? { nest: flow.nest } : {}),
            ...(item.childId ? { childId: item.childId, sessionId: item.childId } : {}),
            ...(item.model ? { model: item.model } : {}),
            status: item.status,
            state: agentStatusState(item),
            ...(item.status === "error" || item.status === "aborted" ? { error: item.note } : {}),
          })
      }
    }
  }
  walk(run.flow)
  return {
    ...runnerResult(run.record),
    settled: run.settled,
    ...(run.flow.current !== undefined ? { phase: run.flow.current } : {}),
    children,
  }
}
