import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import type { AcceptanceArtifact, SpecArtifact } from "../src/artifacts.ts"
import { resolveShipEvidence } from "../src/ship-evidence.ts"
import type { AcceptedBatchRef, IterationState } from "../src/stage.ts"
import { DecisionStore, IterationStore } from "../src/store.ts"
import { commandHarness, consume, implement, startReview, summarize } from "./batch-test-helper.ts"
import { bindingFixture, human, renewApproval } from "./iteration-binding-helper.ts"

setDefaultTimeout(240_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const question = {
  question: "Which behavior?",
  header: "Behavior",
  options: [
    { label: "Original", description: "Original" },
    { label: "Revised", description: "Revised" },
  ],
}
async function checkedFixture() {
  const f = await bindingFixture(roots, true)
  const decisions = new DecisionStore(f.project)
  await decisions.record([question], [{ selected: ["Original"] }], {
    sessionId: "offline",
    askId: "original",
    language: "en",
  })
  const prior = await f.store.readArtifact(f.state.artifacts.find((ref) => ref.kind === "spec")!)
  if (prior.kind !== "spec") throw new Error("Missing fixture spec")
  const spec: SpecArtifact = {
    ...prior,
    revision: 2,
    decisionIds: ["D1"],
    items: prior.items.map((item, index) => ({ ...item, checkIds: [`C${index + 1}`] })),
    checks: [
      { id: "C1", command: "offline-check-one", cwd: "." },
      { id: "C2", command: "offline-check-two", cwd: "nested" },
    ],
  }
  const savedSpec = await f.store.saveArtifact(f.state.revision, spec)
  const savedPlan = await f.store.saveArtifact(savedSpec.state.revision, {
    ...f.plan,
    specHash: savedSpec.artifact.hash,
    specRevision: 2,
  })
  const context = {
    ...f.context,
    spec: { artifactId: savedSpec.artifact.id, revision: 2, hash: savedSpec.artifact.hash },
    batchPlan: { artifactId: savedPlan.artifact.id, hash: savedPlan.artifact.hash },
  }
  const state = await renewApproval(f.store, savedPlan.state, context)
  const verdict = {
    ...f.verdict,
    specHash: savedSpec.artifact.hash,
    specRevision: 2,
    batchPlan: context.batchPlan,
  }
  return { ...f, state, spec, context, verdict, decisions }
}
function results(projectRoot: string, spec: SpecArtifact, batchId: string): AcceptanceArtifact["checks"] {
  const check = spec.checks.find((entry) => entry.id === (batchId === "B1" ? "C1" : "C2"))!
  return [
    {
      checkId: check.id,
      cwd: path.resolve(projectRoot, check.cwd ?? "."),
      command: check.command,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      status: "passed",
      exitCode: 0,
      output: "Offline recorded evidence; no command was executed",
    },
  ]
}
async function revisitDesign(store: IterationStore, state: IterationState) {
  state = await store.dispatch(state.revision, {
    type: "request-revisit",
    expectedRevision: state.revision,
    target: "design",
    policy: "interrupt",
    changes: [],
    receipt: { ...human(state, `revisit:${state.stage}`, "design"), context: undefined },
  })
  state = await summarize(store, state)
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "ship-correction",
      from: state.stage,
      to: "design",
      kind: "revisit",
      summaryId: state.summaryId!,
      suggestion: "Correct the design",
      skippedStages: [],
    },
  })
  return store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: { ...human(state, "ship-correction", "design"), context: undefined },
  })
}

test("an idle acceptance stage without evidence is unavailable, not verified", async () => {
  const f = await bindingFixture(roots, true)
  const evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("unavailable")
  expect(evidence.reason).toMatch(/complet|consum/i)
})

test("a consumed B1 pass does not authorize shipping unresolved B2", async () => {
  const f = await bindingFixture(roots, true)
  const b1 = await startReview(f.store, f.state, f.verdict)
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  await commandHarness(f.project).run()
  const evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("unavailable")
  expect(evidence.state.batchResolutions).toHaveLength(1)
})

test("completion resolves both consumed batches after activeAttemptId is cleared", async () => {
  const f = await bindingFixture(roots, true)
  const h = commandHarness(f.project)
  const b1 = await startReview(f.store, f.state, f.verdict)
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  let state = await h.run()
  state = await implement(f.store, state)
  state = await h.run()
  const b2 = await startReview(f.store, state, f.verdict)
  await summarize(f.store, await consume(f.store, b2.state, b2.verdict))
  state = await h.run()
  expect(state.activeAttemptId).toBeUndefined()
  const evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("verified")
  expect(evidence.state).toEqual(state)
  expect(evidence.skipped).toEqual([])
  expect(evidence.references).toBeDefined()

  // Lost durable evidence cannot become a verified result merely because the
  // completion transition cleared the active acceptance pointer.
  const ref = state.artifacts.find((entry) => entry.id === state.attempts.at(-1)?.acceptance?.artifactId)!
  await rm(path.join(f.project.root, ref.path))
  expect((await resolveShipEvidence(f.project)).status).toBe("unavailable")
})

test("explicit whole-acceptance skips stay visible and are not claimed as passing reviews", async () => {
  const f = await bindingFixture(roots, true)
  await commandHarness(f.project).run("skip", ["accept"])
  const evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("verified")
  expect(evidence.skipped).toEqual(["B1", "B2"])
  expect(evidence.state.completion).toBe("skipped")
})

test("full ship checks include all current items; superseded decisions and revisits block ship", async () => {
  const f = await checkedFixture()
  await commandHarness(f.project).run("skip", ["accept"])
  let evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("verified")
  expect(evidence.checks).toEqual(f.spec.checks)
  await f.decisions.record([question], [{ selected: ["Revised"] }], {
    sessionId: "offline",
    askId: "revised",
    language: "en",
    supersedes: ["D1"],
  })
  evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("stale")
  expect(evidence.reason).toContain("superseded")

  let state = await f.store.read()
  state = await f.store.dispatch(state.revision, {
    type: "request-revisit",
    expectedRevision: state.revision,
    target: "design",
    policy: "interrupt",
    changes: [],
    receipt: { ...human(state, "revisit:accept", "design"), context: undefined },
  })
  evidence = await resolveShipEvidence(f.project)
  expect(evidence.status).toBe("stale")
  expect(evidence.reason).toMatch(/revisit/i)
  expect(evidence.state.revisit).toEqual(state.revisit)
})

test("historical passing evidence binds exact cwd independently of today's content/HEAD", async () => {
  const f = await checkedFixture()
  const h = commandHarness(f.project)
  const b1 = await startReview(f.store, f.state, f.verdict)
  b1.verdict.checks = results(f.project.root, f.spec, "B1")
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  let state = await h.run()
  state = await implement(f.store, state)
  state = await h.run()
  const b2 = await startReview(f.store, state, f.verdict)
  b2.verdict.checks = results(f.project.root, f.spec, "B2")
  await summarize(f.store, await consume(f.store, b2.state, b2.verdict))
  await h.run()
  // There isn't even a Git repository in this fixture. This resolver validates
  // evidence only; the ship executor is responsible for fresh full checks.
  expect((await resolveShipEvidence(f.project)).status).toBe("verified")
  const original = IterationStore.prototype.readArtifact
  const spy = spyOn(IterationStore.prototype, "readArtifact").mockImplementation(async function (
    this: IterationStore,
    ref,
  ) {
    const artifact = await original.call(this, ref)
    return artifact.kind === "acceptance"
      ? {
          ...artifact,
          checks: artifact.checks.map((check) => ({ ...check, cwd: path.join(check.cwd, "wrong") })),
        }
      : artifact
  })
  try {
    const evidence = await resolveShipEvidence(f.project)
    expect(evidence.status).toBe("unavailable")
    expect(evidence.reason).toMatch(/command\/cwd/i)
  } finally {
    spy.mockRestore()
  }
})

test("mode replacement retains historical receipt owners rather than requiring a new review of carried B1", async () => {
  const f = await bindingFixture(roots, true, false, "workflow")
  const h = commandHarness(f.project)
  const b1 = await startReview(f.store, f.state, f.verdict)
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  let state = await h.run()
  const resolution = state.batchResolutions![0]!
  const carried = [{ batchId: resolution.batchId, receiptId: resolution.receiptId }]
  const replacement = await f.store.saveArtifact(state.revision, {
    ...f.plan,
    mode: "single",
    batches: [f.plan.batches[1]!],
    modeChange: {
      previousPlan: f.context.batchPlan,
      sourceApprovalId: state.receipts.at(-1)!.id,
      batchId: "B2",
      carriedResolutions: carried,
    },
  })
  state = await renewApproval(f.store, replacement.state, {
    ...state.approvedContext,
    mode: "single",
    batchPlan: { artifactId: replacement.artifact.id, hash: replacement.artifact.hash },
  })
  state = await implement(f.store, state)
  state = await h.run()
  const b2 = await startReview(f.store, state, f.verdict)
  await summarize(f.store, await consume(f.store, b2.state, b2.verdict))
  await h.run()
  const evidence = await resolveShipEvidence(f.project)
  expect(evidence.reason).toBeUndefined()
  expect(evidence.status).toBe("verified")
  expect(evidence.state.batchResolutions?.[0]).toEqual(resolution)
  expect(evidence.skipped).toEqual([])
})

test("correction-preserved items retain qualified original evidence and full current checks", async () => {
  const f = await checkedFixture()
  const h = commandHarness(f.project)
  const b1 = await startReview(f.store, f.state, f.verdict)
  b1.verdict.checks = results(f.project.root, f.spec, "B1")
  await summarize(f.store, await consume(f.store, b1.state, b1.verdict))
  let state = await h.run()
  const resolution = state.batchResolutions![0]!
  const accepted: AcceptedBatchRef = {
    batchId: "B1",
    spec: f.context.spec,
    batchPlan: f.context.batchPlan,
    resolutionReceiptId: resolution.receiptId,
    attemptId: resolution.attemptId!,
  }
  state = await revisitDesign(f.store, state)
  const spec: SpecArtifact = {
    ...f.spec,
    revision: 3,
    items: f.spec.items.map((item) => (item.id === "S2" ? { ...item, description: "Corrected S2" } : item)),
  }
  const savedSpec = await f.store.saveArtifact(state.revision, spec)
  const correction = await f.store.saveArtifact(savedSpec.state.revision, {
    kind: "correction",
    specHash: savedSpec.artifact.hash,
    specRevision: 3,
    batchId: "B2",
    oldDecisionIds: ["D1"],
    newDecisionIds: ["D2"],
    summary: "Correct S2, preserve S1",
    mappings: [
      { oldDecisionId: "D1", newDecisionId: "D2", itemIds: ["S2"], changedFiles: [], acceptedBatches: [] },
    ],
  })
  state = await f.store.dispatch(correction.state.revision, {
    type: "record-correction",
    expectedRevision: correction.state.revision,
    artifact: correction.artifact,
    correction: {
      id: "correct-s2",
      artifactId: correction.artifact.id,
      decisionLinks: [{ oldDecisionId: "D1", newDecisionId: "D2" }],
      affectedSpecItemIds: ["S2"],
      affectedFiles: [],
      changePointers: [],
      acceptedBatches: [],
      impact: "mapped",
    },
  })
  const savedPlan = await f.store.saveArtifact(state.revision, {
    ...f.plan,
    specHash: savedSpec.artifact.hash,
    specRevision: 3,
    batches: [f.plan.batches[1]!],
    preservedItems: [{ itemId: "S1", acceptedBatch: accepted }],
  })
  state = await summarize(f.store, savedPlan.state)
  const context = {
    ...f.context,
    batchId: "B2",
    spec: { artifactId: savedSpec.artifact.id, revision: 3, hash: savedSpec.artifact.hash },
    batchPlan: { artifactId: savedPlan.artifact.id, hash: savedPlan.artifact.hash },
  }
  state = await f.store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "review-correction",
      from: "design",
      to: "accept",
      kind: "skip",
      summaryId: state.summaryId!,
      suggestion: "Review corrected S2",
      skippedStages: ["design", "prototype", "implement"],
      context,
    },
  })
  state = await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "review-correction", "accept"),
  })
  const b2 = await startReview(f.store, state, f.verdict)
  b2.verdict.checks = results(f.project.root, spec, "B2")
  await summarize(f.store, await consume(f.store, b2.state, b2.verdict))
  await h.run()
  const evidence = await resolveShipEvidence(f.project)
  expect(evidence.reason).toBeUndefined()
  expect(evidence.status).toBe("verified")
  expect(evidence.checks.map((check) => check.id)).toEqual(["C1", "C2"])
  expect(evidence.skipped).toEqual([])

  // A carried/preserved historical review is still checked, not silently dropped
  // just because only B2 appears in the current manifest.
  const original = IterationStore.prototype.readArtifact
  const spy = spyOn(IterationStore.prototype, "readArtifact").mockImplementation(async function (
    this: IterationStore,
    ref,
  ) {
    const artifact = await original.call(this, ref)
    return artifact.kind === "acceptance" && artifact.batchId === "B1"
      ? { ...artifact, checks: [] }
      : artifact
  })
  try {
    expect((await resolveShipEvidence(f.project)).status).toBe("unavailable")
  } finally {
    spy.mockRestore()
  }
})
