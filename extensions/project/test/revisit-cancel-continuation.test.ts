import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { reduceStage } from "../src/stage.ts"
import { bindingFixture, human } from "./iteration-binding-helper.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("cancelling an unentered revisit permits explicit continuation without inventing a correction", async () => {
  const f = await bindingFixture(roots)
  let state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const requested = { ...human(state, "A", "design"), context: undefined }
  state = await f.store.dispatch(state.revision, {
    type: "request-revisit",
    expectedRevision: state.revision,
    target: "design",
    policy: "interrupt",
    attemptId: "A",
    changes: ["diff:preserved"],
    receipt: requested,
  })
  state = await f.store.dispatch(state.revision, {
    type: "cancel-revisit",
    expectedRevision: state.revision,
    receipt: { ...human(state, requested.id, "cancel-revisit"), context: undefined },
  })
  expect(state.revisit).toBeUndefined()
  expect(state.revisitHistory?.at(-1)?.cancelReceiptId).toBeDefined()
  expect(state.attempts[0]?.changes).toContain("diff:preserved")
  const legacy = structuredClone(state)
  delete legacy.correctionObligations
  const migrated = reduceStage(legacy, {
    type: "confirm-continuation",
    expectedRevision: legacy.revision,
    receipt: human(legacy, "A", "resume"),
  })
  expect(migrated.correctionObligations).toEqual([])
  expect(
    reduceStage(migrated, {
      type: "start-work",
      expectedRevision: migrated.revision,
      attemptId: "B",
      review: { attempt: 2, codeHash: f.verdict.codeHash },
    }).status,
  ).toBe("working")
  state = await f.store.dispatch(state.revision, {
    type: "confirm-continuation",
    expectedRevision: state.revision,
    receipt: human(state, "A", "resume"),
  })
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "B",
    review: { attempt: 2, codeHash: f.verdict.codeHash },
  })
  expect(state.status).toBe("working")
  expect(state.attempts.map((attempt) => attempt.status)).toEqual(["interrupted", "working"])
}, 60000)
