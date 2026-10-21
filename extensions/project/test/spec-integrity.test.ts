import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { BatchResultArtifact, SpecItem } from "../src/artifacts.ts"
import { runSpec } from "../src/spec.ts"
import {
  bindSpecIdentity,
  requiredChecks,
  type SavedSpec,
  validateSpecIdentity,
} from "../src/spec-integrity.ts"
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
async function setup(git = false) {
  const f = await fixture({ initialized: git })
  fixtures.push(f)
  return f
}
const generate = (f: Awaited<ReturnType<typeof fixture>>) =>
  runSpec(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
async function latest(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.store.read()
  const spec = await f.store.readArtifact(state.artifacts.findLast((entry) => entry.kind === "spec")!)
  if (spec.kind !== "spec") throw new Error("Missing spec")
  return { state, spec }
}

test("orphan exact checks are rejected before spec publication, human approval, or Git setup", async () => {
  const f = await setup()
  f.drafts[0]!.spec.items[0]!.checkIds = []
  f.answers.push("Approve spec and batch plan")
  await expect(generate(f)).rejects.toThrow(/orphan|referenced|required.check/i)
  const state = await f.store.read()
  expect(state.artifacts).toEqual([])
  expect(state.receipts).toEqual([])
  expect(f.commands).toEqual([])
  await expect(
    f.store.saveArtifact(
      state.revision,
      f.drafts[0]?.spec ?? { ...specDraft().spec, items: [{ ...specDraft().spec.items[0]!, checkIds: [] }] },
    ),
  ).rejects.toThrow(/orphan|referenced|required.check/i)
})

test("batch result publication requires the complete approved exact-check set and honest command/cwd/status evidence", async () => {
  const f = await setup(true)
  await f.approve()
  f.answers.push(true)
  let release!: () => void
  f.hold(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  try {
    const state = await f.store.read()
    const worktree = await f.store.readArtifact(
      state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!,
    )
    if (worktree.kind !== "iteration-worktree") throw new Error("No checkout")
    const check = {
      checkId: "C1",
      cwd: worktree.cwd,
      command: "git --version",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "passed" as const,
      exitCode: 0,
      output: "git version fixture",
    }
    const base: BatchResultArtifact = {
      kind: "batch-result",
      attemptId: state.activeAttemptId!,
      context: state.approvedContext!,
      worktree: worktree.root,
      base: "a".repeat(40),
      snapshot: "b".repeat(40),
      diffStat: "fixture",
      summary: "fixture",
      implementerModels: ["mock/fixture"],
      checks: [],
    }
    for (const checks of [
      [],
      [check, check],
      [{ ...check, checkId: "UNKNOWN" }],
      [{ ...check, command: "echo not the approved check" }],
      [{ ...check, cwd: f.root }],
      [{ ...check, exitCode: 1 }],
    ]) {
      await expect(f.store.saveArtifact(state.revision, { ...base, checks })).rejects.toThrow()
    }
  } finally {
    release()
    await f.settled()
  }
})

test("acceptance publication rejects a correct command recorded in a different cwd", async () => {
  const f = await setup(true)
  await f.approve()
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  let state = await f.store.read()
  state = await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, state.pending!.id, "accept"),
  })
  const codeHash = "a".repeat(64)
  state = await f.store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: "cwd-review",
    review: { attempt: 1, codeHash },
  })
  const context = state.approvedContext!
  const check = {
    checkId: "C1",
    cwd: f.root,
    command: "git --version",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "passed" as const,
    exitCode: 0,
    output: "git version fixture",
  }
  await expect(
    f.store.saveArtifact(state.revision, {
      kind: "acceptance",
      specHash: context.spec!.hash,
      specRevision: context.spec!.revision,
      batchPlan: context.batchPlan!,
      batchId: context.batchId!,
      attemptId: "cwd-review",
      attempt: 1,
      codeHash,
      reviewerModel: "mock/reviewer",
      implementerModels: ["mock/fixture"],
      sameModelFallback: false,
      outcome: "pass",
      items: [{ itemId: "S1", status: "pass", evidence: ["Observed"], reason: "Works" }],
      checks: [check],
    }),
  ).rejects.toThrow(/cwd|exact check/i)
})

test("feedback cannot silently renumber an identical requirement", async () => {
  const f = await setup()
  const revised = specDraft(2)
  revised.spec.items[0]!.id = "S2"
  revised.batches[0]!.itemIds = ["S2"]
  f.drafts.push(revised)
  f.answers.push("Request changes", "Keep the same requirement and identity", "Approve spec and batch plan")
  await expect(generate(f)).rejects.toThrow(/predecessor|identity|lineage|existing/i)
  expect((await latest(f)).spec.items.map((item) => item.id)).toEqual(["S1"])
  expect((await f.store.read()).receipts).toEqual([])
})

test("the store independently rejects renamed or reassigned stable IDs in spec revisions", async () => {
  const f = await setup()
  const original = await f.store.saveArtifact(0, specDraft().spec)
  const revised = specDraft(2).spec
  revised.items[0]!.id = "S2"
  await expect(f.store.saveArtifact(original.state.revision, revised)).rejects.toThrow(
    /identity|lineage|stable/i,
  )
})

test("an edited existing requirement cannot invent a new ID without an explicit predecessor", async () => {
  const f = await setup()
  await f.approve()
  const revised = specDraft(2)
  revised.spec.items[0] = { ...revised.spec.items[0]!, id: "S2", description: "The updated requirement" }
  revised.batches[0]!.itemIds = ["S2"]
  f.drafts.push(revised)
  f.answers.push("Approve spec and batch plan")
  await expect(generate(f)).rejects.toThrow(/predecessor|identity|lineage|existing/i)
  expect((await latest(f)).spec.revision).toBe(1)
})

type DraftItem = SpecItem & { previousItemId?: string | null }
function withItems(revision: number, items: DraftItem[]) {
  const draft = specDraft(revision)
  draft.spec.items = items
  draft.batches[0]!.itemIds = items.map((item) => item.id)
  return draft
}

test("explicit edits retain predecessors, additions get extension IDs, and retired IDs cannot be recycled", async () => {
  const f = await setup()
  await f.approve()
  const original = (await latest(f)).spec.items[0]!
  const edited = {
    ...original,
    id: "model-update",
    previousItemId: "S1",
    description: "Updated local result",
  }
  const added = {
    ...original,
    id: "model-addition",
    previousItemId: null,
    description: "A genuinely additional requirement",
  }
  f.drafts.push(withItems(2, [edited, added]))
  f.answers.push("Approve spec and batch plan")
  await generate(f)
  const second = (await latest(f)).spec
  expect(second.items.map((item) => item.id)).toEqual(["S1", "S2"])
  expect(second.lineage?.items).toEqual([
    { id: "S1", previousId: "S1" },
    { id: "S2", previousId: null },
  ])

  const removed = { ...withItems(3, [{ ...second.items[0]!, previousItemId: "S1" }]), retiredItemIds: ["S2"] }
  f.drafts.push(removed)
  f.answers.push("Approve spec and batch plan")
  await generate(f)
  f.drafts.push(
    withItems(4, [
      { ...second.items[0]!, previousItemId: "S1" },
      { ...added, id: "model-reuse", description: "Another new requirement" },
    ]),
  )
  f.answers.push("Approve spec and batch plan")
  await generate(f)
  expect((await latest(f)).spec.items.map((item) => item.id)).toEqual(["S1", "S3"])
})

function priorSpecs(): SavedSpec[] {
  return [
    {
      spec: specDraft().spec,
      ref: { id: "prior-spec", kind: "spec", path: "fixed-prior-spec.json", hash: "a".repeat(64) },
    },
  ]
}
for (const corruption of ["source", "predecessor", "allocator", "retirement", "reassignment"] as const) {
  test(`store-side lineage validation refuses forged ${corruption} metadata`, () => {
    const history = priorSpecs()
    const draft = specDraft(2)
    const bound = bindSpecIdentity(draft.spec, ["S1"], draft.batches, [], history).spec
    if (corruption === "source") bound.lineage!.previousSpec!.hash = "b".repeat(64)
    if (corruption === "predecessor") bound.lineage!.items[0]!.previousId = "UNKNOWN"
    if (corruption === "retirement") bound.lineage!.retiredItemIds = ["S1"]
    if (corruption === "reassignment") {
      bound.items[0]!.id = "S2"
      bound.lineage!.items[0] = { id: "S2", previousId: null }
    }
    if (corruption === "allocator") {
      bound.items.push({ ...bound.items[0]!, id: "S99", description: "Additional requirement" })
      bound.lineage!.items.push({ id: "S99", previousId: null })
    }
    expect(() => validateSpecIdentity(bound, history)).toThrow()
  })
}
test("renumbering cannot be disguised as an unchanged addition plus retirement", () => {
  const history = priorSpecs()
  const draft = specDraft(2)
  draft.spec.items[0]!.id = "S2"
  expect(() => bindSpecIdentity(draft.spec, [null], draft.batches, ["S1"], history)).toThrow(
    "unchanged existing",
  )
})
test("unannounced removal of a prior stable ID is rejected", () => {
  const history = priorSpecs()
  history[0]!.spec.items.push({
    ...history[0]!.spec.items[0]!,
    id: "S2",
    description: "A second requirement",
  })
  const draft = specDraft(2)
  expect(() => bindSpecIdentity(draft.spec, ["S1"], draft.batches, [], history)).toThrow("retirement")
})
test("explicit predecessor labels are reconciled in the spec and batch mapping", () => {
  const history = priorSpecs()
  const draft = specDraft(2)
  draft.spec.items[0]!.id = "model-label"
  draft.batches[0]!.itemIds = ["model-label"]
  const bound = bindSpecIdentity(draft.spec, ["S1"], draft.batches, [], history)
  expect(bound.spec.items[0]!.id).toBe("S1")
  expect(bound.batches[0]!.itemIds).toEqual(["S1"])
})
test("required checks include shared checks once and never include another batch's exclusive check", () => {
  const spec = specDraft().spec
  spec.items.push({ ...spec.items[0]!, id: "S2", description: "Another requirement", checkIds: ["C1", "C2"] })
  spec.checks.push({ id: "C2", command: "git --version --build-options", cwd: "." })
  expect(requiredChecks(spec, ["S1"]).map((entry) => entry.id)).toEqual(["C1"])
  expect(requiredChecks(spec, ["S1", "S2"]).map((entry) => entry.id)).toEqual(["C1", "C2"])
})

test("reordering requirements never makes array positions their identities", () => {
  const history = priorSpecs()
  const first = history[0]!.spec.items[0]!
  const second = { ...first, id: "S2", description: "A second requirement" }
  history[0]!.spec.items.push(second)
  const draft = specDraft(2)
  draft.spec.items = [second, first]
  draft.batches[0]!.itemIds = ["S2", "S1"]
  const bound = bindSpecIdentity(draft.spec, [undefined, undefined], draft.batches, [], history)
  expect(bound.spec.items.map((item) => item.id)).toEqual(["S2", "S1"])
  expect(bound.spec.lineage!.items).toEqual([
    { id: "S2", previousId: "S2" },
    { id: "S1", previousId: "S1" },
  ])
})
