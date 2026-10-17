import { resolve } from "node:path"
import type { SpawnGroup, SpawnGroupOptions } from "@amira/api"
import type { MemberSpec, Swarm, SwarmReport, SwarmSnapshot } from "./swarm.ts"

/** Provider/consumer-local contracts, not additions to @amira/api. */
export interface RunnerOwner {
  sessionId: string
  label: string
  signal: AbortSignal
  createGroup(options: SpawnGroupOptions): SpawnGroup
}

export const RUNNER_CAPABILITIES = Object.freeze({
  cwd: true,
  freshRun: true,
  models: true,
  ownedLifetime: true,
  progress: true,
} as const)

export type RunnerCapabilities = typeof RUNNER_CAPABILITIES
export interface SwarmStartRequest {
  goal: string
  members: MemberSpec[]
  cwd: string
  startedBy: { sessionId: string; label: string }
  limits?: Record<string, unknown>
}

export interface SwarmRunSnapshot extends SwarmSnapshot {
  runId: string
  cwd: string
  startedBy: SwarmStartRequest["startedBy"]
}

export interface SwarmRunReport extends SwarmReport {
  runId: string
  cwd: string
  startedBy: SwarmStartRequest["startedBy"]
}

export interface SwarmRunner {
  capabilities: RunnerCapabilities
  startBound(request: SwarmStartRequest, owner: RunnerOwner): Promise<{ runId: string } | { error: string }>
  status(runId: string): SwarmRunSnapshot | undefined
  stop(runId: string): boolean
  onProgress(runId: string, listener: (snapshot: SwarmRunSnapshot) => void): () => void
  /** Replays only after the swarm's done promise settles, including group/workflow shutdown. */
  onResult(runId: string, listener: (report: SwarmRunReport) => void): () => void
}

/** Wraps the shared launcher without depending on main-session lifetime or presentation. */
export function createSwarmRunner(
  launch: (request: SwarmStartRequest, owner: RunnerOwner) => Promise<Swarm | string>,
  reportError: (message: string) => void,
) {
  const runs = new Map<
    string,
    {
      swarm: Swarm
      cwd: string
      startedBy: SwarmStartRequest["startedBy"]
      report?: SwarmRunReport
      progress: Set<(snapshot: SwarmRunSnapshot) => void>
      results: Set<(report: SwarmRunReport) => void>
    }
  >()
  const deliver = <T>(listener: (value: T) => void, value: T) => {
    try {
      listener(value)
    } catch (error) {
      reportError(`swarm.runner listener: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const runner: SwarmRunner = {
    capabilities: RUNNER_CAPABILITIES,
    async startBound(request, owner) {
      if (!request || !Array.isArray(request.members) || !request.startedBy)
        return { error: "A bound swarm requires members and startedBy attribution." }
      if (!owner || typeof owner.createGroup !== "function" || !owner.signal)
        return { error: "A bound swarm requires an owner with a signal and createGroup." }
      // Copy caller-owned values before an asynchronous confirmation can change them.
      let captured: SwarmStartRequest
      try {
        captured = structuredClone(request)
      } catch {
        return { error: "The swarm request must contain cloneable data." }
      }
      const boundOwner = {
        sessionId: owner.sessionId,
        label: owner.label,
        signal: owner.signal,
        createGroup: owner.createGroup.bind(owner),
      }
      let swarm: Swarm | string
      try {
        swarm = await launch(captured, boundOwner)
      } catch (error) {
        return {
          error: `The swarm could not start: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (typeof swarm === "string") return { error: swarm }
      const run = {
        swarm,
        cwd: resolve(captured.cwd),
        startedBy: captured.startedBy,
        progress: new Set<(snapshot: SwarmRunSnapshot) => void>(),
        results: new Set<(report: SwarmRunReport) => void>(),
        report: undefined as SwarmRunReport | undefined,
      }
      runs.set(swarm.id, run)
      void swarm.done.then((report) => {
        run.report = { ...report, runId: swarm.id, cwd: run.cwd, startedBy: { ...run.startedBy } }
        for (const listener of [...run.results]) {
          if (run.results.delete(listener)) deliver(listener, structuredClone(run.report))
        }
      })
      return { runId: swarm.id }
    },
    status(runId) {
      const run = runs.get(runId)
      return run
        ? structuredClone({
            ...run.swarm.snapshot(),
            runId,
            cwd: run.cwd,
            startedBy: run.startedBy,
          })
        : undefined
    },
    stop(runId) {
      const run = runs.get(runId)
      if (!run?.swarm.live) return false
      void run.swarm.stop("stopped by swarm.runner")
      return true
    },
    onProgress(runId, listener) {
      const run = runs.get(runId)
      if (!run) return () => {}
      run.progress.add(listener)
      queueMicrotask(() => {
        if (run.progress.has(listener)) deliver(listener, runner.status(runId)!)
      })
      return () => {
        run.progress.delete(listener)
      }
    },
    onResult(runId, listener) {
      const run = runs.get(runId)
      if (!run) return () => {}
      run.results.add(listener)
      queueMicrotask(() => {
        if (run.report && run.results.delete(listener)) deliver(listener, structuredClone(run.report))
      })
      return () => {
        run.results.delete(listener)
      }
    },
  }
  return {
    runner,
    changed(runId: string) {
      const run = runs.get(runId)
      if (!run) return
      for (const listener of [...run.progress]) {
        if (run.progress.has(listener)) deliver(listener, runner.status(runId)!)
      }
    },
  }
}
