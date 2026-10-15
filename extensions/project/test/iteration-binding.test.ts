import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { bindingFixture, human, renewApproval } from "./iteration-binding-helper.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("repartition B1(S1,S2) into B1(S1),B2(S2) invalidates the confirmed approval", async () => {
  const f = await bindingFixture(roots)
  const replacement = await f.store.saveArtifact(f.state.revision, {
    ...f.plan,
    batches: [
      { id: "B1", itemIds: ["S1"], decisionIds: [], files: [] },
      { id: "B2", itemIds: ["S2"], decisionIds: [], files: [] },
    ],
  })
  expect(replacement.state.phase).toBe("ready")
  expect(replacement.state.status).toBe("idle")
  expect(replacement.state.approvedContext).toBeUndefined()
  expect(replacement.state.receipts).toEqual(f.state.receipts)
  expect(await f.store.readArtifact(f.savedPlan.artifact)).toEqual(f.plan)
  await expect(
    f.store.dispatch(replacement.state.revision, {
      type: "start-work",
      expectedRevision: replacement.state.revision,
      attemptId: "unapproved",
    }),
  ).rejects.toThrow(/approv|confirm/i)
}, 60000)

test("interrupted A verdict cannot be consumed by continuation B", async () => {
  const f = await bindingFixture(roots)
  let state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const saved = await f.store.saveArtifact(state.revision, f.verdict)
  state = await f.store.dispatch(saved.state.revision, {
    type: "interrupt-work",
    expectedRevision: saved.state.revision,
    attemptId: "A",
    changes: [],
  })
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
  await expect(
    f.store.dispatch(state.revision, {
      type: "finish-work",
      expectedRevision: state.revision,
      attemptId: "B",
      changes: [],
      artifact: saved.artifact,
      acceptance: { verdict: "pass", failingItemIds: [], artifactId: saved.artifact.id },
    }),
  ).rejects.toThrow(/attempt|review/i)
  await expect(
    f.store.saveArtifact(state.revision, {
      ...f.verdict,
      attemptId: "B",
      attempt: 2,
      codeHash: "b".repeat(64),
    }),
  ).rejects.toThrow(/snapshot/i)
  const fresh = await f.store.saveArtifact(state.revision, { ...f.verdict, attemptId: "B", attempt: 2 })
  state = await f.store.dispatch(fresh.state.revision, {
    type: "finish-work",
    expectedRevision: fresh.state.revision,
    attemptId: "B",
    changes: [],
    artifact: fresh.artifact,
    acceptance: { verdict: "pass", failingItemIds: [], artifactId: fresh.artifact.id },
  })
  expect(state.attempts.map((attempt) => attempt.status)).toEqual(["interrupted", "finished"])
  expect(state.attempts[1]!.acceptance?.artifactId).toBe(fresh.artifact.id)
}, 60000)

test("coverage uses the pinned historical plan, not the latest repartition", async () => {
  const f = await bindingFixture(roots)
  const replacement = await f.store.saveArtifact(f.state.revision, {
    ...f.plan,
    batches: [
      { id: "B1", itemIds: ["S1"], decisionIds: [], files: [] },
      { id: "B2", itemIds: ["S2"], decisionIds: [], files: [] },
    ],
  })
  let state = await renewApproval(f.store, replacement.state, f.context)
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  await expect(
    f.store.saveArtifact(state.revision, {
      ...f.verdict,
      items: [f.verdict.items[0]!],
    }),
  ).rejects.toThrow(/every batch spec item/)
  await expect(
    f.store.saveArtifact(state.revision, {
      ...f.verdict,
      batchPlan: { artifactId: replacement.artifact.id, hash: replacement.artifact.hash },
      items: [f.verdict.items[0]!],
    }),
  ).rejects.toThrow(/exact approved/)
  const saved = await f.store.saveArtifact(state.revision, f.verdict)
  state = await f.store.dispatch(saved.state.revision, {
    type: "finish-work",
    expectedRevision: saved.state.revision,
    attemptId: "A",
    changes: [],
    artifact: saved.artifact,
    acceptance: { verdict: "pass", failingItemIds: [], artifactId: saved.artifact.id },
  })
  expect(state.attempts[0]!.context?.batchPlan).toEqual(f.context.batchPlan)
}, 60000)

test("a replacement plan needs a fresh summary and exact renewed approval", async () => {
  const f = await bindingFixture(roots)
  const replacement = await f.store.saveArtifact(f.state.revision, {
    ...f.plan,
    batches: [
      { id: "B1", itemIds: ["S1"], decisionIds: [], files: [] },
      { id: "B2", itemIds: ["S2"], decisionIds: [], files: [] },
    ],
  })
  const context = {
    ...f.context,
    batchPlan: { artifactId: replacement.artifact.id, hash: replacement.artifact.hash },
  }
  let state = await renewApproval(f.store, replacement.state, context)
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const saved = await f.store.saveArtifact(state.revision, {
    ...f.verdict,
    batchPlan: context.batchPlan,
    items: [f.verdict.items[0]!],
  })
  expect(await f.store.readArtifact(saved.artifact)).toMatchObject({ batchPlan: context.batchPlan })
  expect(saved.state.receipts).toHaveLength(2)
}, 60000)

test("acceptance and manual trials reject mismatched active review bindings at publication", async () => {
  const f = await bindingFixture(roots)
  const state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const trial = {
    kind: "manual-trial" as const,
    specHash: f.verdict.specHash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: f.context.batchPlan,
    attemptId: "A",
    attempt: 1,
    codeHash: f.verdict.codeHash,
    instructions: "Try the output",
    observe: ["Expected output"],
    status: "pending" as const,
  }
  for (const artifact of [f.verdict, trial]) {
    for (const change of [
      { attemptId: "B" },
      { attempt: 2 },
      { codeHash: "b".repeat(64) },
      { batchPlan: { artifactId: f.savedPlan.artifact.id, hash: "b".repeat(64) } },
    ]) {
      await expect(f.store.saveArtifact(state.revision, { ...artifact, ...change })).rejects.toThrow(
        /active review|exact approved/,
      )
    }
  }
  expect((await f.store.read()).revision).toBe(state.revision)
}, 60000)

test("interrupted A manual trial cannot be consumed by B even for the same code snapshot", async () => {
  const f = await bindingFixture(roots)
  let state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "A",
    review: { attempt: 1, codeHash: f.verdict.codeHash },
  })
  const saved = await f.store.saveArtifact(state.revision, {
    kind: "manual-trial",
    specHash: f.verdict.specHash,
    specRevision: 1,
    batchId: "B1",
    batchPlan: f.context.batchPlan,
    attemptId: "A",
    attempt: 1,
    codeHash: f.verdict.codeHash,
    instructions: "Try the output",
    observe: ["Expected output"],
    status: "pending",
  })
  state = await f.store.dispatch(saved.state.revision, {
    type: "interrupt-work",
    expectedRevision: saved.state.revision,
    attemptId: "A",
    changes: [],
  })
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
  await expect(
    f.store.dispatch(state.revision, {
      type: "record-manual-trial",
      expectedRevision: state.revision,
      artifact: saved.artifact,
      status: "pending",
    }),
  ).rejects.toThrow(/active review/)
}, 60000)

for (const phase of ["working", "proposed"] as const) {
  test(`batch plans cannot be replaced while ${phase}`, async () => {
    const f = await bindingFixture(roots)
    let state = f.state
    if (phase === "working") {
      state = await f.store.dispatch(state.revision, {
        type: "start-work",
        expectedRevision: state.revision,
        attemptId: "A",
        review: { attempt: 1, codeHash: f.verdict.codeHash },
      })
    } else {
      const summary = await f.store.saveArtifact(state.revision, {
        kind: "stage-summary",
        stage: "accept",
        language: "en",
        summary: "Renew review",
        outputs: [],
        suggestion: "Review",
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
          id: "renew",
          from: "accept",
          to: "accept",
          kind: "reapprove",
          summaryId: state.summaryId!,
          suggestion: "Review",
          skippedStages: [],
          context: f.context,
        },
      })
    }
    await expect(f.store.saveArtifact(state.revision, { ...f.plan, mode: "swarm" })).rejects.toThrow(
      /running|proposed/,
    )
    expect(await f.store.read()).toEqual(state)
  }, 60000)
}

test("renewed authorization never infers a plan and checks its exact spec, mode and batch", async () => {
  const f = await bindingFixture(roots)
  const saved = await f.store.saveArtifact(f.state.revision, {
    kind: "stage-summary",
    stage: "accept",
    language: "en",
    summary: "Review again",
    outputs: [],
    suggestion: "Review",
  })
  const state = await f.store.dispatch(saved.state.revision, {
    type: "prepare-summary",
    expectedRevision: saved.state.revision,
    artifact: saved.artifact,
  })
  for (const context of [
    { ...f.context, batchPlan: undefined },
    { ...f.context, batchPlan: { ...f.context.batchPlan, hash: "b".repeat(64) } },
    { ...f.context, spec: { ...f.context.spec, revision: 2 } },
    { ...f.context, mode: "swarm" as const },
    { ...f.context, batchId: "B2" },
  ]) {
    await expect(
      f.store.dispatch(state.revision, {
        type: "propose-transition",
        expectedRevision: state.revision,
        proposal: {
          id: "renew",
          from: "accept",
          to: "accept",
          kind: "reapprove",
          summaryId: state.summaryId!,
          suggestion: "Review",
          skippedStages: [],
          context,
        },
      }),
    ).rejects.toThrow(/Approval/)
  }
  expect(await f.store.read()).toEqual(state)
}, 60000)
