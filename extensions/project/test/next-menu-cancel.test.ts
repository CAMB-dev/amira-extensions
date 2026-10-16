import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { runStageCommand } from "../src/stage-commands.ts"
import { fixture } from "./implement-fixture.ts"

setDefaultTimeout(60_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await rm(f.home, { recursive: true, force: true })
})
async function pendingAcceptance() {
  const f = await fixture({ initialized: false })
  fixtures.push(f)
  let state = await f.approve()
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "menu-implementation",
  })
  state = await f.store.dispatch(state.revision, {
    type: "finish-work",
    expectedRevision: state.revision,
    attemptId: state.activeAttemptId!,
    changes: ["fixture:retained-changes"],
  })
  const summary = await f.store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: "implement",
    language: "en",
    summary: "Implementation finished",
    outputs: [],
    suggestion: "Propose acceptance",
  })
  state = await f.store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  state = await f.store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "menu-acceptance",
      from: "implement",
      to: "accept",
      kind: "advance",
      summaryId: summary.artifact.id,
      suggestion: "Review implementation",
      skippedStages: [],
      context: { ...state.approvedContext!, changes: state.attempts.at(-1)!.changes },
    },
  })
  return { ...f, before: state }
}

for (const language of ["en", "zh", "ja"]) {
  test(`${language}: dismissing next's four-option menu cannot invoke its absent spec action`, async () => {
    const f = await pendingAcceptance()
    const projection = path.join(f.root, ".amira/project/iterations/1/state.json")
    const bytes = await readFile(projection, "utf8")
    const generationCount = f.complete.mock.calls.length
    let generated = 0
    let presented: string[] = []
    f.ctx.ui.select = async (_title, options) => {
      presented = options
      return undefined
    }
    const after = await runStageCommand(
      "next",
      [],
      f.project,
      f.ctx,
      language,
      () => {},
      async () => {},
      () => {},
      async () => {
        generated++
      },
    )
    expect(presented).toHaveLength(4)
    expect(generated).toBe(0)
    expect(f.complete.mock.calls).toHaveLength(generationCount)
    expect(after).toEqual(f.before)
    expect(await f.store.read()).toEqual(f.before)
    expect(await readFile(projection, "utf8")).toBe(bytes)
  })
}

for (const dismiss of [true, false]) {
  test(`design menu ${dismiss ? "dismissal" : "explicit generation"} keeps the named optional action distinct`, async () => {
    const f = await fixture({ initialized: false })
    fixtures.push(f)
    let state = await f.store.read()
    state = await f.store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId: "menu-design",
    })
    state = await f.store.dispatch(state.revision, {
      type: "finish-work",
      expectedRevision: state.revision,
      attemptId: "menu-design",
      changes: [],
    })
    const summary = await f.store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage: "design",
      language: "en",
      summary: "Design ready",
      outputs: [],
      suggestion: "Review next step",
    })
    state = await f.store.dispatch(summary.state.revision, {
      type: "prepare-summary",
      expectedRevision: summary.state.revision,
      artifact: summary.artifact,
    })
    state = await f.store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: {
        id: "design-next-menu",
        from: "design",
        to: "prototype",
        kind: "advance",
        summaryId: summary.artifact.id,
        suggestion: "Review prototype",
        skippedStages: [],
      },
    })
    let generated = 0
    f.ctx.ui.select = async (_title, choices) => {
      expect(choices).toHaveLength(5)
      expect(choices).toContain("Generate implementation spec")
      return dismiss ? undefined : "Generate implementation spec"
    }
    const after = await runStageCommand(
      "next",
      [],
      f.project,
      f.ctx,
      "en",
      () => {},
      async () => {},
      () => {},
      async () => {
        generated++
      },
    )
    expect(generated).toBe(dismiss ? 0 : 1)
    if (dismiss) expect(after).toEqual(state)
    else {
      expect(after.revision).toBe(state.revision + 1)
      expect(after.pending).toBeUndefined()
    }
  })
}
