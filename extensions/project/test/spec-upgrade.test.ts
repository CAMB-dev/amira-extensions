import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { type BatchPlanArtifact, type IterationArtifact, validateArtifact } from "../src/artifacts.ts"
import { runSpec } from "../src/spec.ts"
import { requiredChecks } from "../src/spec-integrity.ts"
import {
  type ApprovalContext,
  type ArtifactRef,
  initialIteration,
  reduceStage,
  type StageEvent,
} from "../src/stage.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { IterationStore } from "../src/store.ts"
import { fixture, specDraft } from "./implement-fixture.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(120_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.implementations.quiesce(f.project)
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
type Event = StageEvent extends infer E ? (E extends StageEvent ? Omit<E, "expectedRevision"> : never) : never

/** Encode artifacts/journals accepted before active check-mapping validation existed.
 * No production validation is mocked or disabled; these are old on-disk bytes. */
async function legacy(corrected = true, approval: "none" | "pending" | "confirmed" = "none") {
  const f = await fixture()
  fixtures.push(f)
  const directory = path.join(f.root, ".amira/project/iterations/1")
  await mkdir(path.join(directory, ".state"), { recursive: true })
  await mkdir(path.join(directory, "artifacts"), { recursive: true })
  let state = initialIteration(f.project.marker.id, 1)
  let previousHash: string | null = null
  const preserved = new Map<string, string>()
  const snapshot = async () => {
    const text = json({ schemaVersion: 1, previousHash, state })
    previousHash = hash(text)
    const name = String(state.revision).padStart(16, "0")
    const journal = path.join(directory, ".state", `${name}.json`)
    await writeFile(journal, text)
    preserved.set(journal, text)
    await writeFile(path.join(directory, ".state", `${name}.projected`), `${previousHash}\n`)
    await writeFile(path.join(directory, "state.json"), json(state))
  }
  const apply = async (event: Event) => {
    state = reduceStage(state, { ...event, expectedRevision: state.revision })
    await snapshot()
  }
  const publish = async (artifact: IterationArtifact) => {
    const id = randomUUID()
    const text = json({ schemaVersion: 1, projectId: f.project.marker.id, iteration: 1, id, artifact })
    const relative = `.amira/project/iterations/1/artifacts/${artifact.kind}-${id}.json`
    const file = path.join(f.root, relative)
    await writeFile(file, text)
    preserved.set(file, text)
    const ref: ArtifactRef = { id, kind: artifact.kind, path: relative, hash: hash(text) }
    if (artifact.kind === "stage-summary") {
      await apply({ type: "prepare-summary", artifact: ref })
      return ref
    }
    await apply({
      type: "record-artifact",
      artifact: ref,
      ...(artifact.kind === "batch-plan"
        ? {
            manifest: {
              batchPlan: { artifactId: id, hash: ref.hash },
              spec: {
                artifactId: state.artifacts.find((a) => a.hash === artifact.specHash)!.id,
                revision: artifact.specRevision,
                hash: artifact.specHash,
              },
              mode: artifact.mode,
              batchIds: artifact.batches.map((batch) => batch.id),
            },
          }
        : {}),
    })
    return ref
  }
  await snapshot()
  const orphan = specDraft().spec
  orphan.items[0]!.checkIds = []
  const oldSpec = await publish(orphan)
  const planFor = (spec: ArtifactRef, revision: number): BatchPlanArtifact => ({
    kind: "batch-plan",
    specHash: spec.hash,
    specRevision: revision,
    mode: "single",
    batches: specDraft().batches,
  })
  const oldPlan = await publish(planFor(oldSpec, 1))
  const context = (spec: ArtifactRef, plan: ArtifactRef, revision: number): ApprovalContext => ({
    spec: { artifactId: spec.id, hash: spec.hash, revision },
    batchPlan: { artifactId: plan.id, hash: plan.hash },
    batchId: "B1",
    mode: "single",
    model: "mock/implementer",
  })
  const oldContext = context(oldSpec, oldPlan, 1)
  let correctedContext: ApprovalContext | undefined
  if (corrected) {
    const spec = await publish(specDraft(2).spec)
    const plan = await publish(planFor(spec, 2))
    correctedContext = context(spec, plan, 2)
  }
  await apply({ type: "start-work", attemptId: "legacy-design" })
  await apply({ type: "finish-work", attemptId: "legacy-design", changes: [] })
  const summary = await publish({
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Legacy review boundary",
    outputs: [],
    suggestion: "Review exact spec and plan",
  })
  if (approval !== "none") {
    await apply({
      type: "propose-transition",
      proposal: {
        id: "legacy-implementation",
        from: "design",
        to: "implement",
        kind: "advance",
        summaryId: summary.id,
        suggestion: "Legacy approval",
        skippedStages: ["prototype"],
        context: oldContext,
      },
    })
    if (approval === "confirmed")
      await apply({ type: "confirm-transition", receipt: human(state, state.pending!.id, "implement") })
  }
  return { ...f, state, preserved, oldSpec, oldContext, correctedContext }
}
async function unchanged(files: Map<string, string>) {
  for (const [file, bytes] of files) expect(await readFile(file, "utf8")).toBe(bytes)
}

test("upgrade reads superseded orphan specs unchanged, then approves and executes the corrected revision", async () => {
  const f = await legacy()
  const store = new IterationStore(f.project)
  let state = await store.read()
  expect(state).toEqual(f.state)
  await unchanged(f.preserved)
  const proposal = {
    id: "corrected-approval",
    from: "design" as const,
    to: "implement" as const,
    kind: "advance" as const,
    summaryId: state.summaryId!,
    suggestion: "Approve corrected spec",
    skippedStages: ["prototype"] as ("design" | "prototype")[],
    context: f.correctedContext!,
  }
  await expect(
    store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: { ...proposal, id: "refuse-orphan", context: f.oldContext },
    }),
  ).rejects.toThrow(/orphan|referenced/)
  expect(await store.read()).toEqual(state)
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal,
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, state.pending!.id, "implement"),
  })
  expect(state.approvedContext?.spec?.revision).toBe(2)
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const finished = await new IterationStore(f.project).read()
  expect(finished.pending?.to).toBe("accept")
  const result = await store.readArtifact(
    finished.artifacts.findLast((entry) => entry.kind === "batch-result")!,
  )
  expect(
    result.kind === "batch-result" && result.checks.map((check) => [check.checkId, check.status]),
  ).toEqual([["C1", "passed"]])
  expect(f.commands.some((command) => command.command.endsWith("git --version"))).toBe(true)
  await unchanged(f.preserved)
})

test("upgrade can inspect a legacy pending orphan approval but cannot confirm it", async () => {
  const f = await legacy(true, "pending")
  const store = new IterationStore(f.project)
  const state = await store.read()
  expect(state.pending?.context?.spec?.revision).toBe(1)
  await expect(
    store.saveArtifact(state.revision, {
      kind: "batch-plan",
      specRevision: 1,
      specHash: f.oldSpec.hash,
      mode: "single",
      batches: specDraft().batches,
    }),
  ).rejects.toThrow(/orphan|referenced/)
  await expect(
    store.dispatch(state.revision, {
      type: "confirm-transition",
      expectedRevision: state.revision,
      receipt: human(state, state.pending!.id, "implement"),
    }),
  ).rejects.toThrow(/orphan|referenced/)
  expect(await store.read()).toEqual(state)
  await unchanged(f.preserved)
})

test("a previously approved latest orphan spec is readable but cannot start work or run Git", async () => {
  const f = await legacy(false, "confirmed")
  const store = new IterationStore(f.project)
  const state = await store.read()
  expect(state.phase).toBe("confirmed")
  await expect(
    store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId: "refuse-orphan-start",
    }),
  ).rejects.toThrow(/orphan|referenced/)
  f.answers.push(true)
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(/orphan|referenced/)
  expect(f.commands).toEqual([])
  expect(f.specs).toEqual([])
  expect(await store.read()).toEqual(state)
  await unchanged(f.preserved)
})

test("generating a corrected spec may read orphan history without re-publishing it", async () => {
  const f = await legacy()
  f.drafts.splice(0, f.drafts.length, specDraft(3))
  f.answers.push("Approve spec and batch plan")
  const state = await runSpec(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.approvedContext?.spec?.revision).toBe(3)
  expect((await new IterationStore(f.project).read()).revision).toBe(state.revision)
  await unchanged(f.preserved)
  expect(f.commands).toEqual([])
})

test("a latest legacy orphan approval can be replaced with a newly published corrected spec", async () => {
  const f = await legacy(false, "confirmed")
  f.drafts.splice(0, f.drafts.length, specDraft(2))
  f.answers.push("Approve spec and batch plan")
  const state = await runSpec(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.approvedContext?.spec?.revision).toBe(2)
  expect(state.receipts).toHaveLength(2)
  expect(state.phase).toBe("confirmed")
  expect(f.commands).toEqual([])
  await unchanged(f.preserved)
})

test("historical schema validation is separate from current check-use policy", () => {
  const orphan = specDraft().spec
  orphan.items[0]!.checkIds = []
  expect(() => validateArtifact(orphan)).not.toThrow()
  expect(() => requiredChecks(orphan)).toThrow(/orphan|referenced/)
  const malformed = structuredClone(orphan)
  malformed.items[0]!.checkIds = ["UNKNOWN"]
  expect(() => validateArtifact(malformed)).toThrow("unknown check ID")
})

test("a legacy orphan plan may be explicitly skipped as bookkeeping, never passed or executed", async () => {
  const f = await legacy(false, "confirmed")
  f.answers.push(true)
  const state = await runStageCommand(
    "skip",
    ["batch"],
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.completion).toBe("skipped")
  expect(state.batchResolutions?.[0]?.status).toBe("skipped")
  expect(f.commands).toEqual([])
  expect(f.complete.mock.calls).toEqual([])
  await unchanged(f.preserved)
})
