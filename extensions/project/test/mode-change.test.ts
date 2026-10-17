import { afterEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import { Implementations } from "../src/implement.ts"
import { runModeChange } from "../src/mode-change.ts"
import { batchProgress, reduceStage } from "../src/stage.ts"
import { IterationStore } from "../src/store.ts"
import { commandHarness, consume, implement, startReview, summarize } from "./batch-test-helper.ts"
import { bindingFixture } from "./iteration-binding-helper.ts"

setDefaultTimeout(240_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function acceptedB1(skipped = false) {
  const f = await bindingFixture(roots, true, false, "workflow")
  let state = f.state
  if (skipped) state = await commandHarness(f.project).run("skip", ["batch"])
  else {
    const review = await startReview(f.store, f.state, f.verdict)
    await summarize(f.store, await consume(f.store, review.state, review.verdict))
    state = await commandHarness(f.project).run()
  }
  expect(state.approvedContext?.batchId).toBe("B2")
  expect(batchProgress(state).resolutions.map((entry) => entry.batchId)).toEqual(["B1"])
  const spec = await f.store.readArtifact(state.artifacts.find((ref) => ref.kind === "spec")!)
  const complete = mock(async () => ({
    text: JSON.stringify({ spec: { ...spec, revision: 2 }, batches: f.plan.batches }),
  }))
  const api = {
    apiVersion: "0.1.53",
    conversations: {},
    useService: () => undefined,
    complete,
  } as unknown as ExtensionAPI
  const answers: (string | boolean | undefined)[] = ["Single agent", true]
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main", model: { provider: "offline", model: "coder" } }) },
    focusConversation: () => true,
    print: () => {},
    ui: { select: async () => answers.shift(), confirm: async () => answers.shift() },
  } as unknown as CommandContext
  return { ...f, state, api, ctx, answers, complete }
}

test("accepted B1 and approved workflow B2 survive a service-loss single-agent fallback", async () => {
  const f = await acceptedB1()
  const implementation = new Implementations(f.api)
  const error = await implementation.run(f.project, f.ctx, "en", () => {}).catch((error: unknown) => error)
  expect((error as Error).message).toContain("fallback")
  expect((error as Error).message).toContain("/project mode")
  const state = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.approvedContext?.batchId).toBe("B2")
  expect(state.approvedContext?.mode).toBe("single")
  const plan = await f.store.readArtifact(
    state.artifacts.find((ref) => ref.id === state.approvedContext?.batchPlan?.artifactId)!,
  )
  expect(plan.kind === "batch-plan" && plan.batches.map((batch) => batch.id)).toEqual(["B2"])
  expect(batchProgress(state).remaining).toEqual(["B2"])
  expect(batchProgress(state).resolutions.map((entry) => entry.batchId)).toEqual(["B1"])
  expect(state.batchResolutions).toEqual(f.state.batchResolutions)
  expect(state.approvedContext?.spec).toEqual(f.state.approvedContext?.spec)
  expect(state.approvedContext?.model).toBe(f.state.approvedContext?.model)
  expect(state.receipts.at(-1)?.context).toEqual(state.approvedContext)
  expect(state.receipts.at(-1)?.id).not.toBe(f.state.receipts.at(-1)?.id)
  expect(f.complete).not.toHaveBeenCalled()
  expect(state.artifacts.filter((ref) => ref.kind === "spec")).toHaveLength(1)
  const reopened = await new IterationStore(f.project).read()
  expect(reopened.approvedContext).toEqual(state.approvedContext)
  expect(batchProgress(reopened).remaining).toEqual(["B2"])
  expect(batchProgress(reopened).resolutions[0]?.context.batchPlan).toEqual(
    f.state.batchResolutions![0]!.context.batchPlan,
  )
})

test("Escape at mode choice leaves the approved B2 plan byte-for-byte unchanged", async () => {
  const f = await acceptedB1()
  f.answers.splice(0, f.answers.length, undefined)
  const state = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state).toEqual(f.state)
  expect(await f.store.read()).toEqual(f.state)
  expect(f.complete).not.toHaveBeenCalled()
})

test("Escape at reapproval is inert, old approval cannot authorise the new mode, and next can freshly approve it", async () => {
  const f = await acceptedB1()
  const old = f.state.receipts.at(-1)!
  let pending: typeof f.state | undefined
  f.ctx.ui.confirm = async () => {
    pending = await f.store.read()
    expect(pending.approvedContext).toBeUndefined()
    expect(pending.pending?.context?.batchId).toBe("B2")
    expect(() =>
      reduceStage(pending!, {
        type: "start-work",
        expectedRevision: pending!.revision,
        attemptId: "unapproved-mode",
      }),
    ).toThrow()
    const error = await f.store
      .dispatch(pending.revision, {
        type: "confirm-transition",
        expectedRevision: pending.revision,
        receipt: { ...old, id: "reuse-old-mode", revision: pending.revision, subjectId: pending.pending!.id },
      })
      .catch((error: unknown) => error)
    expect((error as Error).message).toContain("context mismatch")
    const wrongModel = await f.store
      .dispatch(pending.revision, {
        type: "confirm-transition",
        expectedRevision: pending.revision,
        receipt: {
          ...old,
          id: "changed-model",
          revision: pending.revision,
          subjectId: pending.pending!.id,
          context: { ...pending.pending!.context, model: "offline/other" },
        },
      })
      .catch((error: unknown) => error)
    expect((wrongModel as Error).message).toContain("retain the source implementation model")
    return false
  }
  const state = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state).toEqual(pending!)
  expect(state.receipts).toEqual(f.state.receipts)
  const approved = await commandHarness(f.project).run()
  expect(approved.approvedContext?.mode).toBe("single")
  expect(approved.approvedContext?.batchId).toBe("B2")
  expect(approved.receipts.at(-1)?.context?.batchPlan).not.toEqual(old.context?.batchPlan)
  expect(approved.receipts.at(-1)?.context?.spec).toEqual(old.context?.spec)
})

test("a stale mode approval cannot authorise a replacement plan", async () => {
  const f = await acceptedB1()
  f.ctx.ui.confirm = async () => {
    const current = await f.store.read()
    await f.store.saveArtifact(current.revision, {
      kind: "stage-summary",
      stage: "implement",
      language: "en",
      summary: "Concurrent change",
      outputs: [],
      suggestion: "Reload",
    })
    return true
  }
  const error = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  ).catch((error: unknown) => error)
  expect((error as Error).message).toContain("Stale iteration writer")
  const state = await f.store.read()
  expect(state.approvedContext).toBeUndefined()
  expect(state.receipts).toEqual(f.state.receipts)
})

test("mode-only publication rejects invented completion, replayed B1 and changed unresolved work", async () => {
  const f = await acceptedB1()
  const plan = {
    ...f.plan,
    mode: "single" as const,
    batches: [f.plan.batches[1]!],
    modeChange: {
      previousPlan: f.state.approvedContext!.batchPlan!,
      sourceApprovalId: f.state.receipts.at(-1)!.id,
      batchId: "B2",
      carriedResolutions: f.state.batchResolutions!.map(({ batchId, receiptId }) => ({ batchId, receiptId })),
    },
  }
  for (const changed of [
    { ...plan, modeChange: { ...plan.modeChange, carriedResolutions: [] } },
    { ...plan, modeChange: { ...plan.modeChange, sourceApprovalId: f.state.receipts[0]!.id } },
    {
      ...plan,
      modeChange: { ...plan.modeChange, carriedResolutions: [{ batchId: "B1", receiptId: "invented-pass" }] },
    },
    { ...plan, batches: f.plan.batches },
    { ...plan, batches: [{ ...plan.batches[0]!, files: ["other.txt"] }] },
    { ...plan, modeChange: { ...plan.modeChange, batchId: "B1" } },
  ]) {
    const error = await f.store.saveArtifact(f.state.revision, changed).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((await f.store.read()).revision).toBe(f.state.revision)
  }
})

test("repeated mode changes preserve original B1 ownership and never duplicate it", async () => {
  const f = await acceptedB1()
  await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  f.api.useService = () =>
    ({
      available: () => true,
      capabilities: { cwd: true, freshRun: true, models: true, ownedLifetime: true, progress: true },
      startBound: async () => {
        throw new Error("Mode review must not launch")
      },
      status: () => undefined,
      stop: () => false,
      onProgress: () => () => {},
      onResult: () => () => {},
    }) as never
  f.answers.push("Workflow", true)
  const state = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.approvedContext?.mode).toBe("workflow")
  expect(state.approvedContext?.batchId).toBe("B2")
  expect(batchProgress(state).remaining).toEqual(["B2"])
  expect(batchProgress(state).resolutions).toEqual(f.state.batchResolutions!)
  expect(state.batchResolutions).toEqual(f.state.batchResolutions)
  expect(await new IterationStore(f.project).read()).toEqual(state)
})

for (const skipped of [false, true]) {
  test(`B2 acceptance after mode change preserves ${skipped ? "skipped" : "accepted"} B1 completion semantics`, async () => {
    const f = await acceptedB1(skipped)
    let state = await runModeChange(
      f.api,
      f.project,
      f.ctx,
      "en",
      () => {},
      async () => {},
    )
    await implement(f.store, state)
    state = await commandHarness(f.project).run()
    const review = await startReview(f.store, state, f.verdict)
    await summarize(f.store, await consume(f.store, review.state, review.verdict))
    state = await commandHarness(f.project).run()
    expect(state.completion).toBe(skipped ? "skipped" : "accepted")
    expect(batchProgress(state).remaining).toEqual([])
    expect(batchProgress(state).resolutions.map(({ batchId, status }) => ({ batchId, status }))).toEqual([
      { batchId: "B1", status: skipped ? "skipped" : "accepted" },
      { batchId: "B2", status: "accepted" },
    ])
  })
}

test("withdrawing a mode proposal keeps a recoverable draft, not an old launch authorization", async () => {
  const f = await acceptedB1()
  f.answers.splice(0, f.answers.length, "Single agent", false)
  await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  const h = commandHarness(f.project)
  h.control.pick = async () => "Continue current stage"
  const cancelled = await h.run()
  expect(cancelled.approvedContext).toBeUndefined()
  expect(cancelled.pending).toBeUndefined()
  f.answers.push(true)
  const resumed = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  ).catch((error: unknown) => error)
  expect(resumed).not.toBeInstanceOf(Error)
  if (resumed instanceof Error) throw resumed
  expect((resumed as typeof f.state).approvedContext?.mode).toBe("single")
  expect((resumed as typeof f.state).approvedContext?.batchId).toBe("B2")
  expect(f.complete).not.toHaveBeenCalled()
})

test("a stopped review after replacement publication recovers the same plan without regenerating requirements", async () => {
  const f = await acceptedB1()
  const original = IterationStore.prototype.saveArtifact
  let published = false
  const spy = spyOn(IterationStore.prototype, "saveArtifact").mockImplementation(async function (
    this: IterationStore,
    revision,
    artifact,
  ) {
    if (published && artifact.kind === "stage-summary") throw new Error("Stopped after mode plan publication")
    const saved = await original.call(this, revision, artifact)
    if (artifact.kind === "batch-plan" && artifact.modeChange) published = true
    return saved
  })
  try {
    const error = await runModeChange(
      f.api,
      f.project,
      f.ctx,
      "en",
      () => {},
      async () => {},
    ).catch((error: unknown) => error)
    expect((error as Error).message).toContain("Stopped after mode plan publication")
  } finally {
    spy.mockRestore()
  }
  const draft = await f.store.read()
  expect(draft.approvedContext).toBeUndefined()
  expect(draft.pending).toBeUndefined()
  expect(draft.phase).toBe("ready")
  const ref = draft.artifacts.findLast((entry) => entry.kind === "batch-plan")!
  expect(() =>
    reduceStage(draft, { type: "start-work", expectedRevision: draft.revision, attemptId: "no-replay" }),
  ).toThrow()
  const resumed = await runModeChange(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(resumed.approvedContext?.mode).toBe("single")
  expect(resumed.approvedContext?.batchId).toBe("B2")
  expect(resumed.approvedContext?.batchPlan).toEqual({ artifactId: ref.id, hash: ref.hash })
  expect(resumed.batchResolutions).toEqual(f.state.batchResolutions)
  expect(resumed.artifacts.filter((entry) => entry.kind === "batch-plan")).toHaveLength(2)
  expect(f.complete).not.toHaveBeenCalled()
})
