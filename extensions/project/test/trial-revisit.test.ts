import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext } from "@amira/api"
import { runStageCommand, stageStatus } from "../src/stage-commands.ts"
import { nextSuggestion } from "../src/stage-view.ts"
import { readProject } from "../src/store.ts"
import { bindingFixture } from "./iteration-binding-helper.ts"

setDefaultTimeout(60_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const f = await bindingFixture(roots)
  const project = await readProject(roots.at(-1)!)
  let state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const trial = {
    kind: "manual-trial" as const,
    specHash: f.context.spec.hash,
    specRevision: f.context.spec.revision,
    batchPlan: f.context.batchPlan,
    batchId: f.context.batchId,
    attemptId: "A",
    attempt: 1,
    codeHash: f.verdict.codeHash,
    instructions: "Try the local UI",
    observe: ["Observe the result"],
    status: "pending" as const,
  }
  const saved = await f.store.saveArtifact(state.revision, trial)
  state = await f.store.dispatch(saved.state.revision, {
    type: "record-manual-trial",
    expectedRevision: saved.state.revision,
    artifact: saved.artifact,
    status: "pending",
  })
  const dialogs: string[] = []
  const output: string[] = []
  let confirm: boolean | undefined = true
  let select: (title: string, options: string[]) => string | undefined = (_title, options) => options[0]
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main" }) },
    ui: {
      select: async (title: string, options: string[]) => {
        dialogs.push(title)
        return select(title, options)
      },
      confirm: async (title: string) => {
        dialogs.push(title)
        return confirm
      },
    },
    print: (text: string) => output.push(text),
  } as unknown as CommandContext
  const run = (verb: "next" | "revisit", args: string[] = []) =>
    runStageCommand(
      verb,
      args,
      project,
      ctx,
      "en",
      () => {},
      async () => {},
    )
  return {
    ...f,
    state,
    trial,
    saved,
    run,
    dialogs,
    output,
    setConfirm: (value: typeof confirm) => {
      confirm = value
    },
    setSelect: (callback: typeof select) => {
      select = callback
    },
  }
}

test("interrupting a review with a pending trial proposes the revisit before any trial interaction", async () => {
  const f = await fixture()
  const state = await f.run("revisit", ["design"])
  expect(state.stage).toBe("design")
  expect(state.attempts[0]?.status).toBe("interrupted")
  expect(state.manualTrial).toBeUndefined()
  expect(f.dialogs).toEqual(["Revisit design?", "Confirm stage change"])
  expect(await f.store.readArtifact(f.saved.artifact)).toEqual(f.trial)
})

test("declining a pending-trial revisit and explicitly continuing does not resurrect the interrupted trial", async () => {
  const f = await fixture()
  f.setConfirm(undefined)
  let state = await f.run("revisit", ["design"])
  expect(state.pending?.kind).toBe("revisit")
  expect(nextSuggestion(state, "en")).toContain("Review the saved summary")
  expect(nextSuggestion(state, "en")).not.toContain("trial prompt")
  f.setSelect((_title, options) => options.find((option) => option === "Continue current stage"))
  state = await f.run("next")
  expect(state.revisit).toBeUndefined()
  expect(state.status).toBe("interrupted")
  f.setConfirm(true)
  state = await f.run("next")
  expect(state.phase).toBe("confirmed")
  expect(state.activeAttemptId).toBeUndefined()
  expect(state.manualTrial).toBeUndefined()
  expect(f.dialogs).not.toContain("Record manual UI trial")
  expect(await f.store.readArtifact(f.saved.artifact)).toEqual(f.trial)
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "B",
    review: { attempt: 2, codeHash: "b".repeat(64) },
  })
  await f.run("next")
  expect(f.dialogs).not.toContain("Record manual UI trial")
  const pending = await f.store.saveArtifact(state.revision, {
    ...f.trial,
    attemptId: "B",
    attempt: 2,
    codeHash: "b".repeat(64),
  })
  state = await f.store.dispatch(pending.state.revision, {
    type: "record-manual-trial",
    expectedRevision: pending.state.revision,
    artifact: pending.artifact,
    status: "pending",
  })
  f.setSelect((_title, options) => options.find((option) => option.startsWith("Explicitly defer trial")))
  state = await f.run("next")
  expect(state.manualTrial?.status).toBe("deferred")
  const artifact = await f.store.readArtifact(
    state.artifacts.find((ref) => ref.id === state.manualTrial!.artifactId)!,
  )
  expect(artifact).toMatchObject({ kind: "manual-trial", attemptId: "B", status: "deferred" })
})

test("a queued revisit does not force the pending trial and returns at the finished-review boundary", async () => {
  const f = await fixture()
  f.setSelect((_title, options) => options.find((option) => option === "Wait until this batch finishes"))
  let state = await f.run("revisit", ["design"])
  expect(state.status).toBe("working")
  await f.run("next")
  expect(f.dialogs).not.toContain("Record manual UI trial")
  const verdict = await f.store.saveArtifact(state.revision, f.verdict)
  state = await f.store.dispatch(verdict.state.revision, {
    type: "finish-work",
    expectedRevision: verdict.state.revision,
    attemptId: "A",
    changes: [],
    artifact: verdict.artifact,
    acceptance: { verdict: "pass", failingItemIds: [], artifactId: verdict.artifact.id },
  })
  expect(stageStatus(state, "en")).toContain("Batch B1 automated pass, manual trial pending")
  expect(stageStatus(state, "en")).not.toContain("\nAccepted, manual trial pending")
  expect(nextSuggestion(state, "en")).toContain("request to revisit design")
  expect(nextSuggestion(state, "en")).not.toContain("trial prompt")
  f.setSelect((_title, options) => options[0])
  state = await f.run("next")
  expect(state.stage).toBe("design")
  expect(state.attempts[0]?.status).toBe("finished")
  expect(f.dialogs).not.toContain("Record manual UI trial")
  expect(await f.store.readArtifact(f.saved.artifact)).toEqual(f.trial)
})
