import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { Acceptances } from "../src/accept.ts"
import { DecisionStore } from "../src/store.ts"
import { implement } from "./batch-test-helper.ts"
import { fixture } from "./implement-fixture.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(120_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
const question = {
  question: "Which result?",
  header: "Result",
  options: [
    { label: "Original", description: "Original requirement" },
    { label: "Revised", description: "New requirement" },
  ],
}

for (const stage of ["implement", "accept"] as const) {
  test(`${stage}: a fresh attempt cannot adopt superseded decisions as the baseline of an obsolete approved spec`, async () => {
    const f = await fixture({ initialized: false })
    homes.push(f.home)
    const decisions = new DecisionStore(f.project)
    await decisions.record([question], [{ selected: ["Original"] }], {
      sessionId: "design",
      askId: "old",
      language: "en",
    })
    const draft = f.drafts[0]!
    draft.spec.decisionIds = ["D1"]
    draft.spec.items[0]!.decisionIds = ["D1"]
    draft.batches[0]!.decisionIds = ["D1"]
    let state = await f.approve()
    if (stage === "accept") {
      state = await implement(f.store, state)
      state = await f.store.dispatch(state.revision, {
        type: "propose-transition",
        expectedRevision: state.revision,
        proposal: {
          id: "review",
          from: "implement",
          to: "accept",
          kind: "advance",
          summaryId: state.summaryId!,
          skippedStages: [],
          context: { ...state.approvedContext!, changes: ["existing-code"] },
          suggestion: "Review",
        },
      })
      state = await f.store.dispatch(state.revision, {
        type: "confirm-transition",
        expectedRevision: state.revision,
        receipt: human(state, "review", "accept"),
      })
    }
    const specRef = state.artifacts.findLast((entry) => entry.kind === "spec")!
    await decisions.record([question], [{ selected: ["Revised"] }], {
      sessionId: "design",
      askId: "new",
      language: "en",
      supersedes: ["D1"],
    })
    if (stage === "implement")
      await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
        "superseded decisions: D1",
      )
    else
      await expect(new Acceptances(f.api).run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
        "superseded decisions: D1",
      )
    expect(f.specs).toEqual([])
    expect(f.commands).toEqual([])
    expect(await f.store.readArtifact(specRef)).toMatchObject({ kind: "spec", decisionIds: ["D1"] })
    expect(await f.store.read()).toEqual(state)
    await expect(
      f.store.dispatch(state.revision, {
        type: "start-work",
        expectedRevision: state.revision,
        attemptId: "obsolete-launch",
        ...(stage === "accept" ? { review: { attempt: 1, codeHash: "0".repeat(64) } } : {}),
      }),
    ).rejects.toThrow("superseded decisions")
  })
}
