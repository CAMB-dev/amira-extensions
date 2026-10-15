import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { commandHarness, consume, implement, startReview, summarize, trial } from "./batch-test-helper.ts"
import { bindingFixture } from "./iteration-binding-helper.ts"

setDefaultTimeout(120_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

for (const beforeSummary of [false, true]) {
  test(`human problem ${beforeSummary ? "before" : "after"} summary repairs the same pinned batch, then requires fresh review and trial`, async () => {
    const f = await bindingFixture(roots, true, true)
    const h = commandHarness(f.project)
    const review = await startReview(f.store, f.state, f.verdict)
    let state = await consume(f.store, review.state, review.verdict, true)
    if (!beforeSummary) state = await summarize(f.store, state)
    await trial(f.store, state, review.verdict, "pending")
    h.control.pick = async (_title, options) => options.find((option) => option === "Record a problem")
    state = await h.run()
    expect(state.manualTrial?.status).toBe("problem")
    const original = structuredClone(state.attempts.at(-1))
    h.control.pick = async (_title, options) => options[0]
    h.control.confirm = async () => false
    state = await h.run()
    expect(state.pending?.kind).toBe("repair")
    const summaryRef = state.artifacts.find((artifact) => artifact.id === state.pending!.summaryId)!
    const repairSummary = await f.store.readArtifact(summaryRef)
    expect(repairSummary).toMatchObject({
      kind: "stage-summary",
      outputs: expect.arrayContaining([state.manualTrial!.artifactId, original!.acceptance!.artifactId]),
    })
    expect(state.pending?.context).toEqual(f.context)
    expect(state.manualTrial?.status).toBe("problem")
    expect(state.batchResolutions).toEqual([])
    h.control.confirm = async () => true
    state = await h.run()
    expect(state.stage).toBe("implement")
    expect(state.phase).toBe("confirmed")
    expect(state.attempts).toHaveLength(1)
    expect(state.attempts[0]).toEqual(original)
    expect(state.attempts[0]?.acceptance).toMatchObject({ verdict: "pass", failingItemIds: [] })
    state = await implement(f.store, state, ["diff:B1-repaired"])
    state = await h.run()
    expect(state.stage).toBe("accept")
    const fresh = await startReview(f.store, state, { ...f.verdict, codeHash: "b".repeat(64) })
    expect(fresh.verdict.attempt).toBe(2)
    state = await summarize(f.store, await consume(f.store, fresh.state, fresh.verdict, true))
    state = await h.run()
    expect(state.batchResolutions).toEqual([])
    state = await trial(f.store, state, fresh.verdict, "pending")
    state = await trial(f.store, state, fresh.verdict, "tried")
    state = await h.run()
    expect(state.stage).toBe("implement")
    expect(state.approvedContext?.batchId).toBe("B2")
    expect(state.batchResolutions?.[0]).toMatchObject({
      batchId: "B1",
      status: "accepted",
      attemptId: fresh.verdict.attemptId,
    })
    expect(state.attempts[0]).toEqual(original)
  })
}
