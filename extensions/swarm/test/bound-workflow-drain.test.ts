import { expect, test } from "bun:test"
import type { ToolContext } from "@amira/api"
import { RUNNER_CAPABILITIES } from "../src/runner.ts"
import { MemberWorkflows, type WorkflowRunner } from "../src/workflows.ts"

for (const pendingStart of [false, true]) {
  test(`bound swarm shutdown drains workflow settlement (${pendingStart ? "racing start" : "established run"})`, async () => {
    const listeners = new Set<Parameters<WorkflowRunner["onResult"]>[1]>()
    const finish = () => {
      for (const listener of [...listeners]) listener({ runId: "wf_drain", name: "test", status: "stopped" })
    }
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const runner: WorkflowRunner = {
      capabilities: RUNNER_CAPABILITIES,
      start: async () => {
        throw new Error("legacy start must not be used")
      },
      startBound: async () => {
        if (pendingStart) await startGate
        return { runId: "wf_drain" }
      },
      status: () => undefined,
      stop: () => true,
      onProgress: () => () => {},
      onResult: (_id, listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const workflows = new MemberWorkflows(
      runner,
      { enabled: true, maxRunning: 3, maxPerMember: 1 },
      { board: () => {}, result: () => {}, changed: () => {}, canStart: () => true },
      {
        cwd: "D:/temporary-worktree",
        owner: {
          sessionId: "owner",
          label: "owner",
          signal: new AbortController().signal,
          createGroup: () => {
            throw new Error("the fake provider does not spawn")
          },
        },
        current: () => runner,
      },
    )
    const tool = workflows.tools("member").find((tool) => tool.name === "start_workflow")!
    const started = tool.execute({ script: "test" }, {
      signal: new AbortController().signal,
      session: { sessionId: "member-session" },
    } as ToolContext)
    if (!pendingStart) await started
    let settled = false
    const stopping = workflows.stop().then(() => {
      settled = true
    })
    try {
      releaseStart()
      await Bun.sleep(1)
      expect(settled).toBe(false)
      expect(listeners.size).toBeGreaterThan(0)
      finish()
      await started
      await stopping
      expect(settled).toBe(true)
    } finally {
      releaseStart()
      finish()
      await stopping
    }
  })
}
