import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CompleteRequest,
  ConversationSpec,
  ExtensionAPI,
  OwnedConversation,
  OwnedConversationRef,
} from "@amira/api"
import { disposeAccounting } from "../src/accounting.ts"
import {
  type AcceptanceArtifact,
  type BatchResultArtifact,
  type SpecArtifact,
  sameSpecItem,
  validateArtifact,
} from "../src/artifacts.ts"
import {
  type CorrectionInputs,
  correctionArtifact,
  correctionBatches,
  correctionInputs,
  preservedCorrectionItems,
} from "../src/correction.ts"
import { runSpec } from "../src/spec.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { createProject, DecisionStore, IterationStore } from "../src/store.ts"
import { commandHarness, consume, startReview, summarize } from "./batch-test-helper.ts"
import { human } from "./iteration-binding-helper.ts"
import { ownedFixture, zeroUsage } from "./owned-fixture.ts"

setDefaultTimeout(240_000)
const roots: string[] = []
const apis: ExtensionAPI[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await disposeAccounting(api)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(carryForward = false) {
  const root = await mkdtemp(path.join(tmpdir(), "project-correction-generation-"))
  roots.push(root)
  const project = await createProject(root, "Corrections", { language: "en" })
  const decisions = new DecisionStore(project)
  const question = {
    question: "Which result?",
    header: "Result",
    options: [
      { label: "Original", description: "Original requirement" },
      { label: "Revised", description: "Replacement requirement" },
    ],
  }
  await decisions.record([question], [{ selected: ["Original"] }], {
    sessionId: "design",
    askId: "old",
    language: "en",
  })
  const spec: SpecArtifact = {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "Original result",
    body: "## Goal\nProduce the approved result.\n\n## Constraints\nOffline only.",
    decisionIds: ["D1"],
    checks: [],
    items: [
      {
        id: "S1",
        description: "Original result",
        constraints: ["Offline only"],
        verification: ["Inspect the result"],
        acceptanceCriteria: ["Original result is visible"],
        decisionIds: ["D1"],
        checkIds: [],
        ui: true,
      },
    ],
  }
  if (carryForward) {
    spec.items.push({
      ...spec.items[0]!,
      id: "S2",
      description: "Keep accepted output",
      decisionIds: [],
      checkIds: ["C2"],
      ui: false,
    })
    spec.checks.push({ id: "C2", command: "git --version", cwd: "." })
  }
  const batches = carryForward
    ? [
        { id: "B1", itemIds: ["S2"], decisionIds: [], files: ["accepted.txt"] },
        { id: "B2", itemIds: ["S1"], decisionIds: ["D1"], files: ["result.txt"] },
      ]
    : [{ id: "B1", itemIds: ["S1"], decisionIds: ["D1"], files: ["result.txt"] }]
  const drafts: unknown[] = [{ spec, batches }]
  const complete = mock(async (_request: Omit<CompleteRequest, "model">) => {
    const text = JSON.stringify(drafts.shift())
    return {
      text,
      message: {
        role: "assistant" as const,
        model: { provider: "mock", model: "coder" },
        content: [{ type: "text" as const, text }],
      },
    }
  })
  const handles = new Map<string, OwnedConversation>()
  const api = {
    dataDir: path.join(root, "extension-data"),
    complete: mock(async () => {
      throw new Error("Main-bound completion must never run")
    }),
    conversations: {
      openOrCreate: async (spec: ConversationSpec) => {
        const id = `generation-${handles.size + 1}`
        let revision = 0
        const handle: OwnedConversation = {
          ...ownedFixture(spec, id),
          complete: async (request) => {
            revision++
            return complete(request)
          },
          usage: () => {
            const snapshot = zeroUsage(id)
            const cost = revision * 0.25
            const value = {
              usage: { ...snapshot.own.usage, cost },
              knownCostUsd: cost,
              complete: true,
            }
            return { ...snapshot, revision, own: value, total: value }
          },
        }
        handles.set(spec.key, handle)
        return handle
      },
      read: async (ref: OwnedConversationRef) => {
        const handle =
          "key" in ref ? handles.get(ref.key) : [...handles.values()].find((entry) => entry.id === ref.id)
        return (
          handle && {
            id: handle.id,
            key: handle.key,
            name: handle.name,
            cwd: handle.cwd,
            archived: false,
            history: handle.history(),
            usage: handle.usage(),
          }
        )
      },
    },
  } as unknown as ExtensionAPI
  apis.push(api)
  const prints: string[] = []
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main", model: { provider: "mock", model: "coder" } }) },
    print: (text: string) => prints.push(text),
    ui: { select: async () => "Approve spec and batch plan" },
  } as unknown as CommandContext
  const store = new IterationStore(project)
  const generate = () =>
    runSpec(
      api,
      project,
      ctx,
      "en",
      () => {},
      async () => {},
    )
  let state = await generate()
  // Mock immutable local worktree/result records: spec generation must never operate on Git.
  const worktree = await store.saveArtifact(state.revision, {
    kind: "iteration-worktree",
    status: "ready",
    repository: root,
    root,
    cwd: root,
    branch: "fixture/accepted-work",
    base: "fixture-base",
    excluded: "",
    confirmation: "fixture-only",
    setupKey: "fixture",
  })
  state = await store.dispatch(worktree.state.revision, {
    type: "start-work",
    expectedRevision: worktree.state.revision,
    attemptId: "original-implementation",
  })
  const originalResult = await store.saveArtifact(state.revision, {
    kind: "batch-result",
    attemptId: "original-implementation",
    context: state.approvedContext!,
    worktree: root,
    base: "fixture-base",
    snapshot: "a".repeat(64),
    diffStat: " src/abbreviated...name.ts | 1 +",
    changedFiles: [carryForward ? "accepted.txt" : "src/exact | 7.ts"],
    summary: "Existing implementation",
    implementerModels: ["mock/coder"],
    checks: carryForward
      ? [
          {
            checkId: "C2",
            cwd: root,
            command: "git --version",
            startedAt: "2026-01-01T00:00:00Z",
            finishedAt: "2026-01-01T00:00:01Z",
            status: "passed",
            exitCode: 0,
            output: "git fixture",
          },
        ]
      : [],
  })
  state = originalResult.state
  state = await store.dispatch(state.revision, {
    type: "finish-work",
    expectedRevision: state.revision,
    attemptId: "original-implementation",
    changes: ["diff:original"],
  })
  state = await summarize(store, state)
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "review-original",
      from: "implement",
      to: "accept",
      kind: "advance",
      summaryId: state.summaryId!,
      suggestion: "Review original result",
      skippedStages: [],
      context: { ...state.approvedContext, changes: ["diff:original"] },
    },
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "review-original", "accept"),
  })
  if (carryForward) {
    const review = await startReview(store, state, {
      kind: "acceptance",
      specHash: state.approvedContext!.spec!.hash,
      specRevision: 1,
      batchId: "B1",
      batchPlan: state.approvedContext!.batchPlan!,
      attemptId: "unused",
      attempt: 1,
      codeHash: "a".repeat(64),
      reviewerModel: "mock/reviewer",
      implementerModels: ["mock/coder"],
      sameModelFallback: false,
      outcome: "pass",
      items: [],
      checks: [
        {
          checkId: "C2",
          cwd: root,
          command: "git --version",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:01Z",
          status: "passed",
          exitCode: 0,
          output: "git fixture",
        },
      ],
    } satisfies AcceptanceArtifact)
    review.verdict.items[0]!.itemId = "S2"
    state = await consume(store, review.state, review.verdict)
    state = await summarize(store, state)
    state = await store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: {
        id: "accept-b1",
        from: "accept",
        to: "implement",
        kind: "next-batch",
        summaryId: state.summaryId!,
        suggestion: "Preserve accepted B1",
        skippedStages: [],
        context: { ...state.approvedContext, batchId: "B2", changes: undefined },
      },
    })
    state = await store.dispatch(state.revision, {
      type: "confirm-transition",
      expectedRevision: state.revision,
      receipt: human(state, "accept-b1", "implement"),
    })
  }
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
      id: "return-design",
      from: state.stage,
      to: "design",
      kind: "revisit",
      summaryId: state.summaryId!,
      suggestion: "Revise the result",
      skippedStages: [],
    },
  })
  state = await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: { ...human(state, "return-design", "design"), context: undefined },
  })
  await decisions.record([question], [{ selected: ["Revised"] }], {
    sessionId: "design",
    askId: "new",
    language: "en",
    supersedes: ["D1"],
  })
  drafts.push({
    spec: {
      ...spec,
      revision: 2,
      summary: "Revised result",
      decisionIds: ["D2"],
      items: [
        {
          ...spec.items[0],
          previousItemId: "S1",
          description: "Revised result",
          decisionIds: ["D2"],
          acceptanceCriteria: ["Revised result is visible"],
        },
        ...spec.items.slice(1).map((item) => ({ ...item, previousItemId: item.id })),
      ],
    },
    batches: [{ id: "B1", itemIds: ["S1"], decisionIds: ["D2"], files: ["result.txt"] }],
  })
  return { project, store, state, spec, drafts, generate, complete, prints, ctx }
}

test("revisited human decisions produce a revised identity-bound spec and an approved correction batch", async () => {
  const f = await fixture()
  const state = await f.generate()
  expect(state.approvedContext?.spec?.revision).toBe(2)
  expect(state.approvedContext?.batchId).not.toBe("B1")
  expect(state.corrections).toHaveLength(1)
  const record = state.corrections[0]!
  expect(record.decisionLinks).toEqual([{ oldDecisionId: "D1", newDecisionId: "D2" }])
  expect(record.affectedSpecItemIds).toEqual(["S1"])
  expect(record.impact).toBe("mapped")
  expect(record.affectedFiles).toEqual(["src/exact | 7.ts"])
  expect(state.correctionObligations?.[0]?.correctionId).toBe(record.id)
  const correction = await f.store.readArtifact(
    state.artifacts.find((entry) => entry.id === record.artifactId)!,
  )
  expect(correction.kind === "correction" && correction.specRevision).toBe(2)
  const spec = await f.store.readArtifact(state.artifacts.findLast((entry) => entry.kind === "spec")!)
  expect(spec.kind === "spec" && spec.items[0]?.ui).toBe(true)
  expect(spec.kind === "spec" && spec.lineage?.items).toEqual([{ id: "S1", previousId: "S1" }])
  expect(state.attempts.find((entry) => entry.id === "original-implementation")?.changes).toEqual([
    "diff:original",
  ])
  const request = JSON.stringify(f.complete.mock.calls.at(-1))
  expect(request).toContain("correction")
  expect(request).toContain("diff:original")
  expect(f.prints.join("\n")).toContain("D1 → D2")
})

test("superseding decisions survive skip design and skip prototype before correction spec approval", async () => {
  const f = await fixture()
  const commands = commandHarness(f.project)
  await commands.run("skip", ["design"])
  const planning = await commands.run("skip", ["prototype"])
  expect(planning).toMatchObject({ stage: "implement", phase: "confirmed", status: "idle" })
  expect(planning.activeAttemptId).toBeUndefined()
  const originalAttempts = structuredClone(planning.attempts)
  const worktreeRefs = planning.artifacts.filter((entry) => entry.kind === "iteration-worktree")
  const state = await f.generate()
  const request = f.complete.mock.calls.at(-1)![0] as { messages: { content: { text: string }[] }[] }
  expect(JSON.parse(request.messages[0]!.content[0]!.text).correction).toMatchObject({
    revisitReceiptId: planning.correctionObligations![0]!.receiptId,
  })
  expect(state.approvedContext).toMatchObject({ spec: { revision: 2 }, batchId: "R2-B1" })
  expect(state.attempts).toEqual(originalAttempts)
  expect(state.corrections[0]).toMatchObject({
    decisionLinks: [{ oldDecisionId: "D1", newDecisionId: "D2" }],
    affectedSpecItemIds: ["S1"],
    affectedFiles: ["src/exact | 7.ts"],
    impact: "mapped",
  })
  expect(state.correctionObligations?.[0]?.correctionId).toBe(state.corrections[0]!.id)
  expect(state.artifacts.filter((entry) => entry.kind === "iteration-worktree")).toEqual(worktreeRefs)
  expect(await f.store.read()).toEqual(state)
  // The fulfilled obligation is not another pending correction once implementation is approved.
  expect(await correctionInputs(f.project, state)).toBeNull()
})

test("cancelled correction approval retains context and accepted-item preservation for the next spec invocation", async () => {
  const f = await fixture(true)
  const commands = commandHarness(f.project)
  await commands.run("skip", ["design"])
  const planning = await commands.run("skip", ["prototype"])
  const next = structuredClone(f.drafts[0]) as {
    spec: { revision: number }
    batches: { id: string; itemIds: string[]; decisionIds: string[]; files: string[] }[]
  }
  f.ctx.ui.select = async () => "Cancel"
  const cancelled = await f.generate()
  expect(cancelled.stage).toBe("implement")
  expect(cancelled.approvedContext).toBeUndefined()
  expect(cancelled.attempts).toEqual(planning.attempts)
  expect(await correctionInputs(f.project, cancelled)).not.toBeNull()
  const cancelledRef = cancelled.artifacts.findLast((entry) => entry.kind === "correction")!
  const cancelledMapping = await f.store.readArtifact(cancelledRef)
  next.spec.revision = 3
  next.batches.push({ id: "B2", itemIds: ["S2"], decisionIds: [], files: ["accepted.txt"] })
  f.drafts.push(next)
  f.ctx.ui.select = async () => "Approve spec and batch plan"
  const approved = await f.generate()
  const request = f.complete.mock.calls.at(-1)![0] as { messages: { content: { text: string }[] }[] }
  expect(JSON.parse(request.messages[0]!.content[0]!.text).correction).toMatchObject({
    revisitReceiptId: planning.correctionObligations![0]!.receiptId,
  })
  const plan = await f.store.readArtifact(
    approved.artifacts.findLast((entry) => entry.kind === "batch-plan")!,
  )
  expect(plan.kind === "batch-plan" && plan.batches.flatMap((entry) => entry.itemIds)).toEqual(["S1"])
  expect(plan.kind === "batch-plan" && plan.preservedItems?.map((entry) => entry.itemId)).toEqual(["S2"])
  expect(approved.batchResolutions).toEqual(planning.batchResolutions)
  expect(approved.attempts).toEqual(planning.attempts)
  expect(approved.approvedContext).toMatchObject({ spec: { revision: 3 }, batchId: "R3-B1" })
  expect(await f.store.readArtifact(cancelledRef)).toEqual(cancelledMapping)
})

test("idle design correction bookkeeping needs no synthetic implementation attempt", async () => {
  const f = await fixture()
  const ready = await f.store.dispatch(f.state.revision, {
    type: "reopen-design",
    expectedRevision: f.state.revision,
  })
  expect(ready.phase).toBe("ready")
  const state = await f.generate()
  expect(state.approvedContext?.batchId).toBe("R2-B1")
  expect(state.attempts.filter((entry) => entry.stage === "implement")).toEqual(
    ready.attempts.filter((entry) => entry.stage === "implement"),
  )
  expect(state.correctionObligations?.[0]?.correctionId).toBe(state.corrections[0]!.id)
})

test("all outstanding confirmed revisit receipts are mapped before planning authorization", async () => {
  const f = await fixture()
  const commands = commandHarness(f.project)
  await commands.run("skip", ["design"])
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main" }) },
    print: () => {},
    ui: { select: async (_title: string, options: string[]) => options[0], confirm: async () => true },
  } as unknown as CommandContext
  await runStageCommand(
    "revisit",
    ["design"],
    f.project,
    ctx,
    "en",
    () => {},
    async () => {},
  )
  await commands.run("skip", ["design"])
  const planning = await commands.run("skip", ["prototype"])
  expect(planning.correctionObligations).toHaveLength(2)
  const inputs = await correctionInputs(f.project, planning)
  expect(inputs?.revisitReceiptIds).toEqual(planning.correctionObligations!.map((entry) => entry.receiptId))
  const state = await f.generate()
  expect(state.corrections).toHaveLength(2)
  expect(
    state.correctionObligations!.every((entry) =>
      state.corrections.some((record) => record.id === entry.correctionId),
    ),
  ).toBe(true)
  expect(state.attempts).toEqual(planning.attempts)
  expect(state.approvedContext?.batchId).toBe("R2-B1")
})

test("correction plans carry forward unchanged qualified accepted items without replay", async () => {
  const f = await fixture(true)
  const priorResolutions = structuredClone(f.state.batchResolutions)
  const state = await f.generate()
  const ref = state.artifacts.findLast((entry) => entry.kind === "batch-plan")!
  const plan = await f.store.readArtifact(ref)
  expect(plan.kind).toBe("batch-plan")
  if (plan.kind !== "batch-plan") throw new Error("Expected plan")
  expect(plan.batches.flatMap((batch) => batch.itemIds)).toEqual(["S1"])
  const resolution = priorResolutions![0]!
  expect(plan.preservedItems).toEqual([
    {
      itemId: "S2",
      acceptedBatch: {
        batchId: resolution.batchId,
        spec: resolution.context.spec!,
        batchPlan: resolution.context.batchPlan!,
        resolutionReceiptId: resolution.receiptId,
        attemptId: resolution.attemptId!,
      },
    },
  ])
  expect(state.batchResolutions).toEqual(priorResolutions)
  expect(state.corrections[0]!.affectedFiles).toEqual([])
  expect(state.corrections[0]!.acceptedBatches).toEqual([])
  expect(state.artifacts.filter((entry) => entry.kind === "iteration-worktree")).toEqual(
    f.state.artifacts.filter((entry) => entry.kind === "iteration-worktree"),
  )
  const worktree = await f.store.readArtifact(
    state.artifacts.find((entry) => entry.kind === "iteration-worktree")!,
  )
  expect(worktree.kind === "iteration-worktree" && worktree.branch).toBe("fixture/accepted-work")
  expect((await f.store.read()).revision).toBe(state.revision)
  for (const bad of [
    { ...plan, preservedItems: [] },
    { ...plan, preservedItems: [...plan.preservedItems!, ...plan.preservedItems!] },
    { ...plan, preservedItems: [{ ...plan.preservedItems![0]!, itemId: "S9" }] },
    {
      ...plan,
      preservedItems: [
        {
          itemId: "S2",
          acceptedBatch: { ...plan.preservedItems![0]!.acceptedBatch, resolutionReceiptId: "forged" },
        },
      ],
    },
    {
      ...plan,
      batches: [{ ...plan.batches[0]!, itemIds: ["S2"] }],
      preservedItems: [{ ...plan.preservedItems![0]!, itemId: "S1" }],
    },
  ])
    await expect(f.store.saveArtifact(state.revision, bad)).rejects.toThrow(
      /cover|duplicate|confirmed accepted|affected/i,
    )
  // Simulate a coherent legacy producer, not a corrupt hash: history is readable,
  // but a new execution must independently revalidate the carried acceptance.
  const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const digest = (text: string) => createHash("sha256").update(text).digest("hex")
  const file = path.join(f.project.root, ref.path)
  const wrapper = JSON.parse(await readFile(file, "utf8"))
  wrapper.artifact.preservedItems[0].acceptedBatch.resolutionReceiptId = "forged-history"
  const content = encode(wrapper)
  await writeFile(file, content)
  const rewritten = JSON.parse(JSON.stringify(state).replaceAll(ref.hash, digest(content)))
  const directory = path.dirname(path.dirname(file))
  const journal = path.join(directory, ".state", `${String(state.revision).padStart(16, "0")}.json`)
  const snapshot = JSON.parse(await readFile(journal, "utf8"))
  snapshot.state = rewritten
  const text = encode(snapshot)
  await writeFile(journal, text)
  await writeFile(journal.replace(/\.json$/, ".projected"), `${digest(text)}\n`)
  await writeFile(path.join(directory, "state.json"), encode(rewritten))
  expect((await f.store.read()).revision).toBe(state.revision)
  await expect(
    f.store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId: "must-revalidate",
    }),
  ).rejects.toThrow(/confirmed accepted/i)
})

function mappingFixture() {
  const original: SpecArtifact = {
    kind: "spec",
    revision: 1,
    language: "en",
    summary: "Original",
    body: "Original requirements",
    decisionIds: ["D1", "Dstable"],
    checks: [{ id: "C2", command: "git --version", cwd: "." }],
    items: ["S1", "S2"].map((id) => ({
      id,
      description: id,
      constraints: ["Offline"],
      verification: ["Inspect output"],
      acceptanceCriteria: ["Works"],
      decisionIds: [id === "S1" ? "D1" : "Dstable"],
      checkIds: id === "S2" ? ["C2"] : [],
      ui: id === "S2",
    })),
  }
  const revised: SpecArtifact = {
    ...original,
    revision: 2,
    decisionIds: ["D2", "Dstable"],
    items: original.items.map((item) =>
      item.id === "S1" ? { ...item, description: "Revised", decisionIds: ["D2"] } : { ...item },
    ),
  }
  const acceptedBatch = {
    batchId: "B1",
    spec: { artifactId: "old-spec", revision: 1, hash: "a".repeat(64) },
    batchPlan: { artifactId: "old-plan", hash: "b".repeat(64) },
    resolutionReceiptId: "confirmed-human",
    attemptId: "review-original",
  }
  const context: CorrectionInputs = {
    revisitReceiptId: "revisit",
    previousSpec: original,
    decisionLinks: [{ oldDecisionId: "D1", newDecisionId: "D2" }],
    affectedSpecItemIds: ["S1"],
    changes: ["diff:original"],
    worktree: null,
    implemented: [
      { itemIds: ["S1"], changedFiles: ["src/real long filename.ts"], pointer: "result-1" },
      { itemIds: ["S2"], changedFiles: ["unrelated.txt"], pointer: "result-2" },
    ],
    accepted: [{ ref: acceptedBatch, spec: original, itemIds: ["S1", "S2"] }],
  }
  return { original, revised, context, acceptedBatch }
}

test("decision-to-item correction mapping includes only recorded impacted files and qualified owners", () => {
  const { revised, context, acceptedBatch } = mappingFixture()
  const mapping = correctionArtifact(
    context,
    revised,
    { id: "spec", kind: "spec", path: "spec.json", hash: "c".repeat(64) },
    "R2-B1",
  )
  expect(mapping.mappings).toEqual([
    {
      oldDecisionId: "D1",
      newDecisionId: "D2",
      itemIds: ["S1"],
      changedFiles: ["src/real long filename.ts"],
      acceptedBatches: [acceptedBatch],
    },
  ])
  expect(preservedCorrectionItems(revised, context)).toEqual(["S2"])
  expect(
    correctionBatches(context, revised, [
      {
        id: "draft",
        itemIds: ["S2", "S1"],
        decisionIds: ["Dstable", "D2"],
        files: ["src/real long filename.ts"],
      },
    ]),
  ).toEqual([{ id: "R2-B1", itemIds: ["S1"], decisionIds: ["D2"], files: ["src/real long filename.ts"] }])
  expect(() =>
    correctionBatches({ ...context, accepted: [] }, revised, [
      { id: "draft", itemIds: ["S1"], decisionIds: ["D2"], files: [] },
    ]),
  ).toThrow(/every changed or unresolved/)
  const retired = {
    ...revised,
    items: revised.items.map((item) => (item.id === "S1" ? { ...item, id: "S3" } : item)),
  }
  expect(
    correctionArtifact(
      context,
      retired,
      { id: "spec", kind: "spec", path: "spec.json", hash: "c".repeat(64) },
      "R2-B1",
    ).mappings[0]?.itemIds,
  ).toEqual(["S3"])
  expect(() =>
    correctionArtifact(
      context,
      { ...revised, items: revised.items.filter((item) => item.id !== "S1") },
      { id: "spec", kind: "spec", path: "spec.json", hash: "c".repeat(64) },
      "R2-B1",
    ),
  ).toThrow(/explicit correction item/)
})

test("accepted carry-forward requires unchanged identity, UI, semantics, check command and check cwd", () => {
  const { original, revised, context } = mappingFixture()
  expect(sameSpecItem(original, revised, "S2")).toBe(true)
  const mutations = [
    { ...revised, items: revised.items.map((item) => (item.id === "S2" ? { ...item, id: "S9" } : item)) },
    ...[
      { ui: false },
      { description: "Changed" },
      { constraints: ["Online"] },
      { verification: ["Another check"] },
      { acceptanceCriteria: ["New acceptance"] },
      { decisionIds: ["D2"] },
      { checkIds: [] },
    ].map((patch) => ({
      ...revised,
      items: revised.items.map((item) => (item.id === "S2" ? { ...item, ...patch } : item)),
    })),
    { ...revised, checks: [{ ...revised.checks[0]!, command: "git status" }] },
    { ...revised, checks: [{ ...revised.checks[0]!, cwd: "nested" }] },
  ]
  for (const changed of mutations) {
    expect(sameSpecItem(original, changed, "S2")).toBe(false)
    expect(preservedCorrectionItems(changed, context)).toEqual([])
  }
  expect(preservedCorrectionItems(revised, { ...context, affectedSpecItemIds: ["S1", "S2"] })).toEqual([])
})

test("exact batch-result paths are optional for legacy history and reject unsafe paths", () => {
  const result: BatchResultArtifact = {
    kind: "batch-result",
    attemptId: "implementation",
    context: { batchId: "B1" },
    worktree: "fixture",
    base: "base",
    snapshot: "snapshot",
    diffStat: " src/abbreviated...file.ts | 1 +",
    summary: "Legacy result",
    implementerModels: [],
    checks: [],
  }
  expect(() => validateArtifact(result)).not.toThrow()
  expect(() =>
    validateArtifact({ ...result, changedFiles: ["src/exact | 7.ts", "src/a long file.ts"] }),
  ).not.toThrow()
  for (const changedFiles of [
    ["../escape"],
    ["/absolute"],
    ["C:/absolute"],
    ["src\\quoted"],
    ["duplicate", "duplicate"],
  ])
    expect(() => validateArtifact({ ...result, changedFiles })).toThrow(/relative|distinct/)
})
