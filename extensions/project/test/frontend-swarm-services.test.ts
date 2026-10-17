import { expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { IterationState } from "../src/stage.ts"
import { F6, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"
import { workflowFixture } from "./frontend-services-fixture.ts"
import { swarmFixture } from "./frontend-swarm-fixture.ts"
import { git, specDraft } from "./implement-fixture.ts"

setDefaultTimeout(180_000)
type Frontend = Awaited<ReturnType<typeof frontend>>

async function stateWhen(f: Frontend, check: (state: IterationState) => boolean) {
  for (let attempt = 0; attempt < 2400; attempt++) {
    const state = await f.store.read()
    if (check(state)) return state
    if (state.status === "interrupted")
      throw new Error(`Swarm interrupted: ${JSON.stringify(state)}\n${f.live()}`)
    await Bun.sleep(25)
  }
  throw new Error(`Swarm did not settle: ${JSON.stringify(await f.store.read())}\n${f.live()}`)
}

async function setup() {
  const swarm = swarmFixture()
  const workflow = workflowFixture()
  const f = await frontend(undefined, [], {
    rows: 36,
    extensions: [
      { name: "workflow", extension: workflow.extension },
      { name: "swarm", extension: swarm.extension },
    ],
  })
  try {
    f.agent.permissions.setMode("auto")
    // Only this disposable harness repository gets a baseline; the source checkout is untouched.
    await git(f.cwd, "init")
    await git(f.cwd, 'config user.name "Offline Swarm Frontend"')
    await git(f.cwd, 'config user.email "swarm@invalid.local"')
    await git(f.cwd, "config commit.gpgsign false")
    await git(f.cwd, 'add -A && git commit -m "Offline swarm fixture baseline"')
    f.mock.push({ text: JSON.stringify(specDraft()) })
    f.send("spec")
    await f.dialog("Choose execution mode")
    expect(f.live()).toContain("Single agent")
    expect(f.live()).toContain("Workflow")
    expect(f.live()).toContain("Swarm")
    expect((await f.store.read()).approvedContext).toBeUndefined()
    f.terminal.send("\x1b[B\x1b[B\r")
    await f.dialog("Review implementation spec")
    expect(swarm.runs).toEqual([])
    expect(workflow.runs).toEqual([])
    f.terminal.send("\r")
    await f.dismissed()
    expect((await f.store.read()).approvedContext).toMatchObject({
      mode: "swarm",
      model: "mock/frontend",
    })
    return { f, swarm, workflow }
  } catch (error) {
    swarm.release()
    await f.cleanup()
    throw error
  }
}

async function launch(f: Frontend, swarm: ReturnType<typeof swarmFixture>) {
  f.mock.push(
    {
      toolCalls: [
        { id: "swarm-write", name: "write", args: { path: "result.txt", content: "ready\n" } },
        { id: "swarm-denied", name: "offline_forbidden", args: {} },
        { id: "swarm-message", name: "send_message", args: { value: "Please verify the local result" } },
        { id: "swarm-board-write", name: "blackboard_write", args: { value: "Offline result is ready" } },
        { id: "swarm-board-read", name: "blackboard_read", args: {} },
        { id: "swarm-list", name: "list_agents", args: {} },
        { id: "swarm-finish", name: "finish", args: {} },
      ],
    },
    { text: "Writer implemented the approved offline result." },
    { text: "Research-only collaborator verified the local constraints without edits." },
  )
  f.send("implement")
  await f.dialog("Use committed base")
  f.terminal.send("\x1b[B\r")
  await waitFor(() => swarm.calls.some((call) => call.name === "finish"), "real member finish tool", 60_000)
  await f.idle()
  await f.visible("main idle")
  expect((await f.store.read()).status).toBe("working")
  f.terminal.send(F6)
  await waitFor(() => !f.live().includes("main idle"), "native return to main", 30_000)
  await f.idle()
  f.terminal.send("\x15")
  return swarm.runs[0]!
}

frontendSuite("frontend-swarm-services", () => {
  test("fullscreen offline: inherited member coordination tools execute and actual bound evidence proposes acceptance", async () => {
    const { f, swarm, workflow } = await setup()
    try {
      const run = await launch(f, swarm)
      expect(swarm.runs).toHaveLength(1)
      expect(workflow.runs).toEqual([])
      expect(run.owner.sessionId).toBe(run.request.startedBy.sessionId)
      expect(run.group.info().parentSessionId).toBe(run.owner.sessionId)
      expect(run.request.members?.map((member) => member.name)).toEqual(["item-1", "researcher"])
      expect(run.request.members?.map((member) => member.model)).toEqual(["mock/frontend", "mock/frontend"])
      expect(path.isAbsolute(run.request.cwd)).toBe(true)
      expect(run.request.cwd).not.toBe(f.cwd)
      expect(path.relative(f.root, run.request.cwd).startsWith("..")).toBe(false)
      expect(swarm.calls).toEqual(
        ["send_message", "blackboard_write", "blackboard_read", "list_agents", "finish"].map((name) => ({
          name,
          sessionId: run.snapshot.sessionIds![0],
          cwd: run.request.cwd,
        })),
      )
      expect(swarm.messages).toEqual(["Please verify the local result"])
      expect(swarm.forbiddenCalls()).toBe(0)
      expect(await readFile(path.join(run.request.cwd, "result.txt"), "utf8")).toBe("ready\n")
      expect(await Bun.file(path.join(f.cwd, "result.txt")).exists()).toBe(false)
      swarm.release()
      const state = await stateWhen(f, (value) => value.pending?.to === "accept")
      const result = await f.store.readArtifact(
        state.artifacts.findLast((ref) => ref.kind === "batch-result")!,
      )
      expect(result).toMatchObject({
        kind: "batch-result",
        implementerModels: ["mock/swarm-writer", "mock/swarm-researcher"],
        changedFiles: ["result.txt"],
        checks: [{ checkId: "C1", status: "passed", cwd: run.request.cwd }],
        execution: {
          mode: "swarm",
          runId: run.snapshot.runId,
          cwd: run.request.cwd,
          groupId: run.group.id,
          sessionIds: run.snapshot.sessionIds,
        },
      })
      if (result.kind !== "batch-result") throw new Error("Missing swarm result")
      expect(result.error).toBeUndefined()
      expect(result.summary).toContain("Writer implemented the approved offline result")
      expect(result.summary).toContain("Research-only collaborator verified")
      const feedback = JSON.stringify(
        f.mock.requests.filter((request) => request.model.id === "swarm-writer"),
      )
      expect(feedback).toContain("is not callable in this session")
      expect(feedback).toContain("Offline result is ready")
      expect(feedback).toContain("researcher")
      expect(f.mock.requests).toHaveLength(4)
      expect(state.stage).toBe("implement")
      expect(state.phase).toBe("proposed")
      expect(swarm.stopped).toEqual([])
      expect(run.progress.size).toBe(0)
      expect(run.results.size).toBe(0)
    } finally {
      swarm.release()
      await f.cleanup()
    }
  })

  test("fullscreen offline: revisiting design stops the bound owner and cannot propose acceptance", async () => {
    const { f, swarm, workflow } = await setup()
    try {
      const run = await launch(f, swarm)
      f.send("revisit design")
      await f.dialog("Revisit design?")
      f.terminal.send("\r")
      await f.dialog("Confirm stage change")
      f.terminal.send("\x1b[B\r")
      await f.dismissed()
      await waitFor(() => run.group.info().state === "ended", "swarm members drained", 30_000)
      const state = await f.store.read()
      expect(swarm.stopped).toEqual([run.snapshot.runId])
      expect(run.owner.signal.aborted).toBe(true)
      expect(state.stage).toBe("design")
      expect(state.pending).toBeUndefined()
      expect(state.activeAttemptId).toBeUndefined()
      expect(state.attempts.at(-1)?.status).toBe("interrupted")
      expect(state.artifacts.filter((ref) => ref.kind === "batch-result")).toEqual([])
      expect(workflow.runs).toEqual([])
      expect(await readFile(path.join(run.request.cwd, "result.txt"), "utf8")).toBe("ready\n")
      expect(run.progress.size).toBe(0)
      expect(run.results.size).toBe(0)
    } finally {
      swarm.release()
      await f.cleanup()
    }
  })
})
