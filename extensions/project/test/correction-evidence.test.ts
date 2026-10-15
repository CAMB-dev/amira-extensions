import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CorrectionArtifact, IterationArtifact } from "../src/artifacts.ts"
import type { AcceptedBatchRef, ArtifactRef, CorrectionRecord, IterationState } from "../src/stage.ts"
import type { IterationStore, Project } from "../src/store.ts"
import { commandHarness, consume, startReview, summarize, trial } from "./batch-test-helper.ts"
import { bindingFixture, human } from "./iteration-binding-helper.ts"

setDefaultTimeout(120_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("a published-only pass cannot authorize a bare-label accepted correction claim", async () => {
  const f = await bindingFixture(roots, true)
  const review = await startReview(f.store, f.state, f.verdict)
  const saved = await f.store.saveArtifact(review.state.revision, review.verdict)
  await expect(
    f.store.saveArtifact(saved.state.revision, {
      kind: "correction",
      specHash: f.context.spec.hash,
      specRevision: 1,
      batchId: "B2",
      oldDecisionIds: ["D1"],
      newDecisionIds: ["D2"],
      summary: "Revise an allegedly accepted batch",
      mappings: [
        {
          oldDecisionId: "D1",
          newDecisionId: "D2",
          itemIds: ["S1"],
          changedFiles: ["src/feature.ts"],
          acceptedBatchIds: ["B1"],
        },
      ],
    } as unknown as IterationArtifact),
  ).rejects.toThrow(/accepted|qualified|unexpected/i)
})

function correction(state: IterationState, acceptedBatches: AcceptedBatchRef[]): CorrectionArtifact {
  const spec = state.artifacts.findLast((entry) => entry.kind === "spec")!
  return {
    kind: "correction",
    specHash: spec.hash,
    specRevision: state.artifacts.filter((entry) => entry.kind === "spec").length,
    batchId: "B2",
    oldDecisionIds: ["D1"],
    newDecisionIds: ["D2"],
    summary: "Revise feature with explicit acceptance owners",
    mappings: [
      {
        oldDecisionId: "D1",
        newDecisionId: "D2",
        itemIds: ["S1"],
        changedFiles: ["src/feature.ts"],
        acceptedBatches,
      },
    ],
  }
}

function record(artifact: ArtifactRef, acceptedBatches: AcceptedBatchRef[]): CorrectionRecord {
  return {
    id: "correction-record",
    artifactId: artifact.id,
    decisionLinks: [{ oldDecisionId: "D1", newDecisionId: "D2" }],
    affectedSpecItemIds: ["S1"],
    affectedFiles: ["src/feature.ts"],
    changePointers: ["diff:correction"],
    acceptedBatches,
    impact: "mapped",
  }
}

async function confirmB1(store: IterationStore, state: IterationState) {
  state = await summarize(store, state)
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "resolve-b1",
      from: "accept",
      to: "implement",
      kind: "next-batch",
      summaryId: state.summaryId!,
      suggestion: "Resolve B1 and prepare B2",
      skippedStages: [],
      context: { ...state.approvedContext, batchId: "B2", changes: undefined },
    },
  })
  return store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "resolve-b1", "implement"),
  })
}

async function reopenDesign(store: IterationStore, state: IterationState) {
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
      id: "revisit-design",
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
    receipt: { ...human(state, "revisit-design", "design"), context: undefined },
  })
}

async function acceptedFixture(ui = false) {
  const f = await bindingFixture(roots, true, ui)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await consume(f.store, review.state, review.verdict, ui)
  if (ui) {
    state = await trial(f.store, state, review.verdict, "pending")
    state = await trial(f.store, state, review.verdict, "deferred")
  }
  state = await confirmB1(f.store, state)
  const resolution = state.batchResolutions![0]!
  const accepted: AcceptedBatchRef = {
    batchId: "B1",
    spec: f.context.spec,
    batchPlan: f.context.batchPlan,
    resolutionReceiptId: resolution.receiptId,
    attemptId: review.verdict.attemptId,
  }
  return { ...f, state, accepted }
}

test("qualified correction refs require human-confirmed resolutions, not published, consumed or interrupted passes", async () => {
  const f = await bindingFixture(roots, true, true)
  const review = await startReview(f.store, f.state, f.verdict)
  const saved = await f.store.saveArtifact(review.state.revision, review.verdict)
  let state = saved.state
  const ref: AcceptedBatchRef = {
    batchId: "B1",
    spec: f.context.spec,
    batchPlan: f.context.batchPlan,
    resolutionReceiptId: "no-resolution",
    attemptId: review.verdict.attemptId,
  }
  const reject = () =>
    expect(f.store.saveArtifact(state.revision, correction(state, [ref]))).rejects.toThrow(
      /confirmed accepted/i,
    )
  await reject()
  state = await f.store.dispatch(state.revision, {
    type: "finish-work",
    expectedRevision: state.revision,
    attemptId: review.verdict.attemptId,
    changes: [],
    artifact: saved.artifact,
    acceptance: {
      verdict: "pass",
      failingItemIds: [],
      artifactId: saved.artifact.id,
      manualTrialRequired: true,
    },
  })
  await reject()
  state = await trial(f.store, state, review.verdict, "pending")
  await reject()
  // A resolved UI trial alone still is not a confirmed batch acceptance.
  state = await trial(f.store, state, review.verdict, "deferred")
  await reject()
})

test("interrupted reviews cannot supply qualified accepted correction evidence", async () => {
  const f = await bindingFixture(roots, true)
  const review = await startReview(f.store, f.state, f.verdict)
  const saved = await f.store.saveArtifact(review.state.revision, review.verdict)
  const state = await f.store.dispatch(saved.state.revision, {
    type: "interrupt-work",
    expectedRevision: saved.state.revision,
    attemptId: review.verdict.attemptId,
    changes: [],
  })
  await expect(
    f.store.saveArtifact(
      state.revision,
      correction(state, [
        {
          batchId: "B1",
          spec: f.context.spec,
          batchPlan: f.context.batchPlan,
          resolutionReceiptId: "no-resolution",
          attemptId: review.verdict.attemptId,
        },
      ]),
    ),
  ).rejects.toThrow(/confirmed accepted/i)
})

test("genuinely accepted original plan evidence can authorize a correction targeting a revised spec and plan", async () => {
  const f = await acceptedFixture(true)
  let state = await reopenDesign(f.store, f.state)
  const original = await f.store.readArtifact(state.artifacts.find((entry) => entry.kind === "spec")!)
  if (original.kind !== "spec") throw new Error("Expected fixture spec")
  const spec = await f.store.saveArtifact(state.revision, {
    ...original,
    revision: 2,
    summary: "Revised feature",
  })
  const plan = await f.store.saveArtifact(spec.state.revision, {
    ...f.plan,
    specHash: spec.artifact.hash,
    specRevision: 2,
  })
  state = await f.store.dispatch(plan.state.revision, {
    type: "start-work",
    expectedRevision: plan.state.revision,
    attemptId: "correct-design",
  })
  for (const bad of [
    { ...f.accepted, spec: { artifactId: spec.artifact.id, revision: 2, hash: spec.artifact.hash } },
    { ...f.accepted, batchPlan: { artifactId: plan.artifact.id, hash: plan.artifact.hash } },
    { ...f.accepted, resolutionReceiptId: state.receipts[0]!.id },
    { ...f.accepted, attemptId: "another-review" },
  ]) {
    await expect(f.store.saveArtifact(state.revision, correction(state, [bad]))).rejects.toThrow(
      /confirmed accepted/i,
    )
  }
  const payload = correction(state, [f.accepted])
  const saved = await f.store.saveArtifact(state.revision, payload)
  state = saved.state
  const dispatch = (acceptedBatches: AcceptedBatchRef[]) =>
    f.store.dispatch(state.revision, {
      type: "record-correction",
      expectedRevision: state.revision,
      artifact: saved.artifact,
      correction: record(saved.artifact, acceptedBatches),
    })
  await expect(dispatch([])).rejects.toThrow(/immutable artifact/i)
  await expect(dispatch([f.accepted, f.accepted])).rejects.toThrow(/immutable artifact/i)
  await expect(dispatch([{ ...f.accepted, resolutionReceiptId: "different-receipt" }])).rejects.toThrow(
    /immutable artifact/i,
  )
  state = await dispatch([f.accepted])
  expect(state.corrections[0]?.acceptedBatches).toEqual([f.accepted])
  expect(await f.store.readArtifact(saved.artifact)).toEqual(payload)
})

/** Simulate a coherently committed claim from an older/unchecked producer, not a hash mismatch. */
async function replaceCommittedCorrection(
  project: Project,
  state: IterationState,
  ref: ArtifactRef,
  payload: unknown,
) {
  const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const digest = (text: string) => createHash("sha256").update(text).digest("hex")
  const file = path.join(project.root, ref.path)
  const wrapper = JSON.parse(await readFile(file, "utf8"))
  wrapper.artifact = payload
  const content = encode(wrapper)
  await writeFile(file, content)
  const updated = { ...ref, hash: digest(content) }
  state = structuredClone(state)
  state.artifacts = state.artifacts.map((entry) => (entry.id === ref.id ? updated : entry))
  const directory = path.dirname(path.dirname(file))
  const journal = path.join(directory, ".state", `${String(state.revision).padStart(16, "0")}.json`)
  const snapshot = JSON.parse(await readFile(journal, "utf8"))
  snapshot.state = state
  const text = encode(snapshot)
  await writeFile(journal, text)
  await writeFile(journal.replace(/\.json$/, ".projected"), `${digest(text)}\n`)
  await writeFile(path.join(directory, "state.json"), encode(state))
  return { state, artifact: updated }
}

test("consumption revalidates qualified committed claims even when artifact and journal hashes are coherent", async () => {
  const f = await acceptedFixture()
  let state = await reopenDesign(f.store, f.state)
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "correct-design",
  })
  const saved = await f.store.saveArtifact(state.revision, correction(state, []))
  const bad = { ...f.accepted, batchId: "B2" }
  const forged = await replaceCommittedCorrection(
    f.project,
    saved.state,
    saved.artifact,
    correction(state, [bad]),
  )
  // This is a readable committed artifact, so rejection must occur at correction consumption.
  expect((await f.store.read()).revision).toBe(forged.state.revision)
  await expect(
    f.store.dispatch(forged.state.revision, {
      type: "record-correction",
      expectedRevision: forged.state.revision,
      artifact: forged.artifact,
      correction: record(forged.artifact, [bad]),
    }),
  ).rejects.toThrow(/confirmed accepted/i)
})

test("legacy committed bare-label claims fail closed without rewriting immutable artifact bytes", async () => {
  const f = await acceptedFixture()
  let state = await reopenDesign(f.store, f.state)
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "correct-design",
  })
  const payload = correction(state, [])
  const saved = await f.store.saveArtifact(state.revision, payload)
  const { acceptedBatches: _removed, ...mapping } = payload.mappings[0]!
  const legacy = { ...payload, mappings: [{ ...mapping, acceptedBatchIds: ["B1"] }] }
  const forged = await replaceCommittedCorrection(f.project, saved.state, saved.artifact, legacy)
  const file = path.join(f.project.root, forged.artifact.path)
  const before = await readFile(file, "utf8")
  await expect(
    f.store.dispatch(forged.state.revision, {
      type: "record-correction",
      expectedRevision: forged.state.revision,
      artifact: forged.artifact,
      correction: record(forged.artifact, []),
    }),
  ).rejects.toThrow(/unexpected|qualified|artifact/i)
  expect(await readFile(file, "utf8")).toBe(before)
})

test("a human-confirmed skipped batch is not accepted correction evidence", async () => {
  const f = await bindingFixture(roots, true)
  const state = await commandHarness(f.project).run("skip", ["batch"])
  const resolution = state.batchResolutions![0]!
  expect(resolution.status).toBe("skipped")
  await expect(
    f.store.saveArtifact(
      state.revision,
      correction(state, [
        {
          batchId: "B1",
          spec: f.context.spec,
          batchPlan: f.context.batchPlan,
          resolutionReceiptId: resolution.receiptId,
          attemptId: "no-consumed-review",
        },
      ]),
    ),
  ).rejects.toThrow(/confirmed accepted/i)
})
