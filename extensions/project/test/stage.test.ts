import { describe, expect, test } from "bun:test"
import {
  type ApprovalContext,
  type ArtifactRef,
  type HumanReceipt,
  type IterationState,
  initialIteration,
  normalizeIteration,
  reduceStage,
  type Stage,
  type StageEvent,
  type TransitionProposal,
  validateIteration,
} from "../src/stage.ts"

type Event = StageEvent extends infer E ? (E extends StageEvent ? Omit<E, "expectedRevision"> : never) : never
const stages: Stage[] = ["design", "prototype", "implement", "accept"]
let sequence = 0
const id = () => `id-${++sequence}`
function ref(kind: ArtifactRef["kind"]): ArtifactRef {
  const name = id()
  return { id: name, kind, path: `iterations/1/${name}.json`, hash: `hash-${name}` }
}
function apply(state: IterationState, event: Event): IterationState {
  const before = structuredClone(state)
  const input = structuredClone(event)
  const result = reduceStage(state, { ...event, expectedRevision: state.revision })
  expect(state).toEqual(before)
  expect(event).toEqual(input)
  expect(result.revision).toBe(state.revision + 1)
  validateIteration(JSON.parse(JSON.stringify(result)))
  // Revised specs need a new immutable plan, just like store-backed fixtures.
  if (event.type === "record-artifact" && event.artifact.kind === "spec" && state.batchManifests?.length) {
    return publishPlan(result)
  }
  return result
}
function publishPlan(state: IterationState): IterationState {
  const artifact = ref("batch-plan")
  const spec = state.artifacts.findLast((entry) => entry.kind === "spec")!
  return apply(state, {
    type: "record-artifact",
    artifact,
    manifest: {
      batchPlan: { artifactId: artifact.id, hash: artifact.hash },
      spec: { artifactId: spec.id, hash: spec.hash, revision: 1 },
      mode: "single",
      batchIds: ["batch-1"],
    },
  })
}
function receipt(
  state: IterationState,
  subjectId: string,
  choice: string,
  context?: ApprovalContext,
): HumanReceipt {
  return {
    id: id(),
    provenance: "human",
    projectId: state.projectId,
    iteration: state.iteration,
    revision: state.revision,
    subjectId,
    choice,
    reason: "Explicit offline human fixture",
    ...(context ? { context } : {}),
  }
}
function summary(state: IterationState): IterationState {
  return apply(state, { type: "prepare-summary", artifact: ref("stage-summary") })
}
function context(state: IterationState): ApprovalContext {
  const spec = state.artifacts.findLast((a) => a.kind === "spec")!
  const plan = state.artifacts.findLast((a) => a.kind === "batch-plan")!
  return {
    spec: { artifactId: spec.id, revision: 1, hash: spec.hash },
    batchId: "batch-1",
    batchPlan: { artifactId: plan.id, hash: plan.hash },
    mode: "single",
    model: "offline/model",
    changes: ["diff:existing-changes"],
  }
}
function proposal(
  state: IterationState,
  to: Stage | null,
  kind: TransitionProposal["kind"] = "advance",
  approvedContext?: ApprovalContext,
): TransitionProposal {
  if (state.stage === "accept" && ["complete", "skip"].includes(kind))
    approvedContext ??= state.approvedContext
  return {
    id: id(),
    from: state.stage,
    to,
    kind,
    summaryId: state.summaryId!,
    suggestion: "Human decides the next step",
    ...(state.stage === "accept" && kind === "skip"
      ? {
          skippedBatchIds: state.batchManifests!.find(
            (entry) => entry.batchPlan.artifactId === approvedContext?.batchPlan?.artifactId,
          )!.batchIds,
        }
      : {}),
    skippedStages:
      kind === "repair" || kind === "revisit" || kind === "reapprove"
        ? []
        : stages.slice(
            stages.indexOf(state.stage) + (kind === "skip" ? 0 : 1),
            to === null ? 4 : stages.indexOf(to),
          ),
    ...(approvedContext ? { context: approvedContext } : {}),
  }
}
function propose(state: IterationState, next: TransitionProposal): IterationState {
  return apply(state, { type: "propose-transition", proposal: next })
}
function confirm(state: IterationState): IterationState {
  const pending = state.pending!
  return apply(state, {
    type: "confirm-transition",
    receipt: receipt(state, pending.id, pending.to ?? pending.kind, pending.context),
  })
}
function start(state: IterationState): IterationState {
  return apply(state, {
    type: "start-work",
    attemptId: id(),
    ...(state.stage === "accept"
      ? {
          review: {
            attempt: state.attempts.filter((a) => a.stage === "accept").length + 1,
            codeHash: "a".repeat(64),
          },
        }
      : {}),
  })
}
function finish(state: IterationState, verdict: "pass" | "fail" | "blocked" = "pass"): IterationState {
  const artifact = ref("acceptance")
  return apply(state, {
    type: "finish-work",
    attemptId: state.activeAttemptId!,
    changes: ["diff:preserved"],
    ...(state.stage === "accept"
      ? {
          acceptance: {
            verdict,
            failingItemIds: verdict === "fail" ? ["SPEC-2"] : [],
            artifactId: artifact.id,
          },
          artifact,
        }
      : {}),
  })
}
function select(state: IterationState): IterationState {
  const variantId = id()
  return apply(state, {
    type: "select-prototype",
    variantId,
    decisionId: "D-2",
    receipt: receipt(state, variantId, variantId),
  })
}
function ready(stage: Stage): IterationState {
  let state = initialIteration("project-fixture", 1)
  state = apply(state, { type: "record-artifact", artifact: ref("spec") })
  state = publishPlan(state)
  for (const next of stages.slice(1, stages.indexOf(stage) + 1)) {
    state = finish(start(state))
    if (state.stage === "prototype") state = select(state)
    state = summary(state)
    state = confirm(propose(state, proposal(state, next, "advance", context(state))))
  }
  return state
}
function rejects(state: IterationState, event: Event, message?: string): void {
  const before = structuredClone(state)
  expect(() => reduceStage(state, { ...event, expectedRevision: state.revision })).toThrow(message)
  expect(state).toEqual(before)
}

describe("stage lifecycle and explicit human gates", () => {
  test("initial state is validated, inert, independent and versioned", () => {
    const state = initialIteration("p", 3)
    expect(state).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      projectId: "p",
      iteration: 3,
      stage: "design",
      status: "idle",
      phase: "ready",
    })
    expect(state.attempts).toEqual([])
    state.artifacts.push(ref("spec"))
    expect(initialIteration("p", 3).artifacts).toEqual([])
  })

  for (const stage of stages) {
    test(`${stage}: finish, summary, proposal, confirmation and start are separate`, () => {
      let state = start(ready(stage))
      const attemptId = state.activeAttemptId!
      const before = state.attempts.length
      state = finish(state)
      expect(state).toMatchObject({ stage, phase: "finished", status: "idle", activeAttemptId: attemptId })
      rejects(state, { type: "start-work", attemptId: id() })
      rejects(state, { type: "propose-transition", proposal: proposal(state, stage) })
      if (stage === "prototype") state = select(state)
      state = summary(state)
      expect(state).toMatchObject({ stage, phase: "summarized" })
      rejects(state, { type: "start-work", attemptId: id() })
      const next = stages[stages.indexOf(stage) + 1] ?? null
      state = propose(state, proposal(state, next, next === null ? "complete" : "advance", context(state)))
      expect(state).toMatchObject({ stage, status: "awaiting-confirmation", phase: "proposed" })
      rejects(state, { type: "start-work", attemptId: id() })
      state = confirm(state)
      expect(state.status).toBe("idle")
      expect(state.attempts).toHaveLength(before)
      if (next) {
        expect(state).toMatchObject({ stage: next, phase: "confirmed" })
        state = start(state)
        expect(state).toMatchObject({ stage: next, status: "working", phase: "running" })
        expect(state.attempts).toHaveLength(before + 1)
        expect(state.activeAttemptId).not.toBe(attemptId)
      } else {
        expect(state).toMatchObject({ stage: "accept", phase: "complete", completion: "accepted" })
        rejects(state, { type: "start-work", attemptId: id() })
      }
    })
  }

  // Every possible forward edge, including every combination of skipped intermediate stages.
  for (const from of stages) {
    for (const to of stages.filter((s) => stages.indexOf(s) > stages.indexOf(from))) {
      test(`human forward choice ${from} -> ${to} records exact skipped stages`, () => {
        let state = finish(start(ready(from)))
        if (from === "prototype") state = select(state)
        state = summary(state)
        const next = proposal(state, to, "advance", context(state))
        state = confirm(propose(state, next))
        expect(state.skips.map((s) => s.stage)).toEqual(next.skippedStages)
        expect(state.stage).toBe(to)
        expect(state.status).toBe("idle")
      })
    }
  }

  for (const stage of stages) {
    const destinations: (Stage | null)[] =
      stage === "accept" ? [null] : stages.slice(stages.indexOf(stage) + 1)
    for (const to of destinations) {
      test(`explicit skip ${stage} -> ${to ?? "complete"} never fabricates work`, () => {
        let state = summary(ready(stage))
        const attempts = structuredClone(state.attempts)
        const next = proposal(state, to, "skip", context(state))
        state = confirm(propose(state, next))
        expect(state.attempts).toEqual(attempts)
        expect(state.skips.slice(-next.skippedStages.length).map((s) => s.stage)).toEqual(next.skippedStages)
        if (next.skippedStages.includes("prototype")) expect(state.prototypeChoice).toBeUndefined()
        if (stage === "accept") expect(state.completion).toBe("skipped")
        expect(state.receipts.at(-1)?.choice).toBe(to ?? "skip")
      })
    }
  }

  for (const from of stages) {
    for (const to of stages.filter((s) => stages.indexOf(s) <= stages.indexOf(from))) {
      test(`ordinary advancement cannot route ${from} -> ${to}`, () => {
        let state = finish(start(ready(from)))
        if (from === "prototype") state = select(state)
        state = summary(state)
        rejects(state, {
          type: "propose-transition",
          proposal: proposal(state, to, "advance", context(state)),
        })
      })
    }
  }

  test("cancelled proposal neither moves nor approves; re-proposal uses a fresh revision", () => {
    let state = summary(finish(start(ready("design"))))
    const next = proposal(state, "prototype")
    state = propose(state, next)
    const stale = receipt(state, next.id, "prototype")
    state = apply(state, { type: "cancel-transition" })
    expect(state).toMatchObject({ stage: "design", phase: "summarized", status: "idle" })
    expect(state.receipts).toEqual([])
    state = propose(state, { ...next, id: id() })
    rejects(state, { type: "confirm-transition", receipt: stale }, "revision")
    state = confirm(state)
    expect(state.stage).toBe("prototype")
  })
})

describe("root authorization binding regressions", () => {
  for (const destination of ["implement", "accept"] as const) {
    test(`${destination} authorization requires a batch plan binding`, () => {
      const state = summary(finish(start(ready("design"))))
      const inputs = context(state)
      delete inputs.batchPlan
      rejects(state, {
        type: "propose-transition",
        proposal: proposal(state, destination, "advance", inputs),
      })
    })
  }
  test("every acceptance start requires a fresh review ordinal and code hash", () => {
    const state = ready("accept")
    rejects(state, { type: "start-work", attemptId: id() })
  })
  test("review bindings are acceptance-only, ordinally fresh, and require SHA256", () => {
    for (const stage of ["design", "prototype", "implement"] as const) {
      rejects(ready(stage), {
        type: "start-work",
        attemptId: id(),
        review: { attempt: 1, codeHash: "a".repeat(64) },
      })
    }
    let state = ready("accept")
    for (const review of [
      { attempt: 2, codeHash: "a".repeat(64) },
      { attempt: 1, codeHash: "short" },
      { attempt: 1, codeHash: "g".repeat(64) },
      { attempt: 0, codeHash: "a".repeat(64) },
    ]) {
      rejects(state, { type: "start-work", attemptId: id(), review })
    }
    state = start(state)
    const first = structuredClone(state.attempts.at(-1))
    state = apply(state, { type: "interrupt-work", attemptId: state.activeAttemptId!, changes: ["diff:old"] })
    state = apply(state, {
      type: "confirm-continuation",
      receipt: receipt(state, state.activeAttemptId!, "resume", state.approvedContext),
    })
    rejects(state, { type: "start-work", attemptId: id(), review: first!.review })
    state = apply(state, {
      type: "start-work",
      attemptId: id(),
      review: { attempt: 2, codeHash: "b".repeat(64) },
    })
    expect(state.attempts.at(-1)?.review).toEqual({ attempt: 2, codeHash: "b".repeat(64) })
    expect(state.attempts.at(-2)?.review).toEqual(first?.review)
    const invalid = structuredClone(state)
    invalid.attempts.at(-1)!.review!.attempt = 1
    expect(() => validateIteration(invalid)).toThrow("ordinal")
  })
  for (const destination of ["implement", "accept"] as const) {
    for (const mutation of ["unknown", "wrong-kind", "wrong-hash"] as const) {
      test(`${destination} rejects ${mutation} batch plan bindings`, () => {
        const state = summary(finish(start(ready("design"))))
        const inputs = context(state)
        if (mutation === "unknown") inputs.batchPlan!.artifactId = "unknown"
        if (mutation === "wrong-kind")
          inputs.batchPlan = { artifactId: inputs.spec!.artifactId, hash: inputs.spec!.hash }
        if (mutation === "wrong-hash") inputs.batchPlan!.hash = "wrong-hash"
        rejects(state, {
          type: "propose-transition",
          proposal: proposal(state, destination, "advance", inputs),
        })
      })
    }
  }
  for (const destination of ["implement", "accept"] as const) {
    test(`summarized idle ${destination} can obtain same-stage reauthorization`, () => {
      let state = ready(destination)
      const inputs = { ...context(state), model: "offline/new-model" }
      state = summary(state)
      const next = proposal(state, destination, "reapprove", inputs)
      state = confirm(propose(state, next))
      expect(state).toMatchObject({
        stage: destination,
        status: "idle",
        phase: "confirmed",
        approvedContext: inputs,
      })
      expect(start(state).stage).toBe(destination)
    })
    test(`${destination} reauthorization cannot reuse an active attempt or skip stages`, () => {
      const active = summary(finish(start(ready(destination))))
      rejects(active, {
        type: "propose-transition",
        proposal: proposal(active, destination, "reapprove", context(active)),
      })
      const idle = summary(ready(destination))
      rejects(idle, {
        type: "propose-transition",
        proposal: {
          ...proposal(idle, destination, "reapprove", context(idle)),
          skippedStages: [destination],
        },
      })
    })
  }
})

describe("approvals and implementation inputs", () => {
  function pendingImplementation(): IterationState {
    const state = summary(finish(start(ready("design"))))
    return propose(state, proposal(state, "implement", "advance", context(state)))
  }
  const mutations: [string, (r: HumanReceipt) => void][] = [
    [
      "project",
      (r) => {
        r.projectId = "other"
      },
    ],
    [
      "iteration",
      (r) => {
        r.iteration += 1
      },
    ],
    [
      "stale revision",
      (r) => {
        r.revision -= 1
      },
    ],
    [
      "future revision",
      (r) => {
        r.revision += 1
      },
    ],
    [
      "subject",
      (r) => {
        r.subjectId = "other"
      },
    ],
    [
      "choice",
      (r) => {
        r.choice = "accept"
      },
    ],
    [
      "provenance",
      (r) => {
        Object.assign(r, { provenance: "model" })
      },
    ],
    [
      "missing context",
      (r) => {
        delete r.context
      },
    ],
    [
      "spec hash",
      (r) => {
        r.context!.spec!.hash = "different"
      },
    ],
    [
      "spec revision",
      (r) => {
        r.context!.spec!.revision += 1
      },
    ],
    [
      "spec identity",
      (r) => {
        r.context!.spec!.artifactId = "other"
      },
    ],
    [
      "batch plan hash",
      (r) => {
        r.context!.batchPlan!.hash = "other"
      },
    ],
    [
      "batch plan identity",
      (r) => {
        r.context!.batchPlan!.artifactId = "other"
      },
    ],
    [
      "batch",
      (r) => {
        r.context!.batchId = "other"
      },
    ],
    [
      "mode",
      (r) => {
        r.context!.mode = "swarm"
      },
    ],
    [
      "model",
      (r) => {
        r.context!.model = "other"
      },
    ],
    [
      "changes",
      (r) => {
        r.context!.changes = ["other"]
      },
    ],
    [
      "reason",
      (r) => {
        r.reason = " "
      },
    ],
  ]
  for (const [name, mutate] of mutations) {
    test(`approval rejects mismatched ${name}`, () => {
      const state = pendingImplementation()
      const answer = receipt(state, state.pending!.id, "implement", structuredClone(state.pending!.context))
      mutate(answer)
      rejects(state, { type: "confirm-transition", receipt: answer })
    })
  }
  for (const missing of ["spec", "batchPlan", "batchId", "mode", "model"] as const) {
    test(`skipped design cannot waive ${missing} approval`, () => {
      const state = summary(ready("design"))
      const inputs = context(state)
      delete inputs[missing]
      rejects(state, { type: "propose-transition", proposal: proposal(state, "implement", "skip", inputs) })
    })
  }
  test("context object key order is irrelevant, exact values are retained", () => {
    const state = pendingImplementation()
    const inputs = state.pending!.context!
    const reordered = {
      changes: inputs.changes,
      model: inputs.model,
      mode: inputs.mode,
      batchId: inputs.batchId,
      batchPlan: inputs.batchPlan,
      spec: { hash: inputs.spec!.hash, revision: 1, artifactId: inputs.spec!.artifactId },
    }
    const result = apply(state, {
      type: "confirm-transition",
      receipt: receipt(state, state.pending!.id, "implement", reordered),
    })
    expect(result.approvedContext).toEqual(inputs)
    expect(result.status).toBe("idle")
  })
  test("an optional context cannot be added to a context-free approval", () => {
    const state = summary(finish(start(ready("design"))))
    const pending = propose(state, proposal(state, "prototype"))
    rejects(pending, {
      type: "confirm-transition",
      receipt: receipt(pending, pending.pending!.id, "prototype", context(pending)),
    })
  })
  test("stale event revisions and duplicate late results fail without changing state", () => {
    const working = start(ready("implement"))
    expect(() =>
      reduceStage(working, {
        type: "finish-work",
        attemptId: working.activeAttemptId!,
        changes: [],
        expectedRevision: working.revision - 1,
      }),
    ).toThrow("revision")
    const finished = finish(working)
    rejects(finished, { type: "finish-work", attemptId: working.activeAttemptId!, changes: [] })
    rejects(working, { type: "finish-work", attemptId: "another-session", changes: [] })
  })
  test("acceptance-only route must identify the spec and actual changes", () => {
    const state = summary(ready("design"))
    for (const inputs of [undefined, { spec: context(state).spec }, { changes: ["diff"] }]) {
      rejects(state, { type: "propose-transition", proposal: proposal(state, "accept", "skip", inputs) })
    }
    const accepted = confirm(propose(state, proposal(state, "accept", "skip", context(state))))
    expect(start(accepted).attempts).toHaveLength(1)
    expect(accepted.skips.map((s) => s.stage)).toEqual(["design", "prototype", "implement"])
  })
})

describe("revisit lifecycle regressions", () => {
  function request(state: IterationState, target: "design" | "prototype"): IterationState {
    return apply(state, {
      type: "request-revisit",
      target,
      policy: "interrupt",
      changes: ["diff:interrupt"].filter(() => !!state.activeAttemptId),
      ...(state.activeAttemptId ? { attemptId: state.activeAttemptId } : {}),
      receipt: receipt(state, state.activeAttemptId ?? `revisit:${state.stage}`, target),
    })
  }
  function mapped(
    state: IterationState,
    impact: "mapped" | "needs-review",
    revisitReceiptId?: string,
  ): IterationState {
    const artifact = ref("correction")
    return apply(state, {
      type: "record-correction",
      artifact,
      ...(revisitReceiptId ? { revisitReceiptId } : {}),
      correction: {
        id: id(),
        artifactId: artifact.id,
        decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-2" }],
        affectedSpecItemIds: [],
        affectedFiles: [],
        changePointers: ["diff:interrupt"],
        acceptedBatches: [],
        impact,
      },
    })
  }
  for (const completion of ["accepted", "skipped"] as const) {
    test(`${completion} acceptance can revisit while iteration stays open and historical evidence remains`, () => {
      let state = ready("accept")
      if (completion === "accepted") state = finish(start(state))
      state = summary(state)
      state = confirm(propose(state, proposal(state, null, completion === "accepted" ? "complete" : "skip")))
      const evidence = structuredClone({
        attempts: state.attempts,
        skips: state.skips,
        transitions: state.transitions,
      })
      const identity = { projectId: state.projectId, iteration: state.iteration }
      state = request(state, "design")
      expect(state.completion).toBe(completion)
      state = summary(state)
      state = propose(state, proposal(state, "design", "revisit"))
      expect(state.completion).toBe(completion)
      const cancelled = apply(state, {
        type: "cancel-revisit",
        receipt: receipt(state, state.revisit!.receiptId, "cancel-revisit"),
      })
      expect(cancelled).toMatchObject({ completion, phase: "complete", ...identity, ...evidence })
      state = confirm(state)
      expect(state).toMatchObject({ stage: "design", phase: "confirmed", ...identity })
      expect(state.completion).toBeUndefined()
      expect(state.attempts).toEqual(evidence.attempts)
      expect(state.skips).toEqual(evidence.skips)
      expect(state.transitions.slice(0, -1)).toEqual(evidence.transitions)
    })
  }
  test("later mapped revisit cannot bypass an earlier unmapped impact", () => {
    let state = request(start(ready("implement")), "prototype")
    state = summary(state)
    state = confirm(propose(state, proposal(state, "prototype", "revisit")))
    state = finish(start(state))
    state = mapped(state, "needs-review")
    const first = state.revisitHistory![0]!.receiptId
    state = request(state, "design")
    state = summary(state)
    state = confirm(propose(state, proposal(state, "design", "revisit")))
    state = summary(finish(start(state)))
    state = mapped(state, "mapped")
    state = apply(state, { type: "record-artifact", artifact: ref("spec") })
    expect(state.correctionObligations).toHaveLength(2)
    const legacy = structuredClone(state)
    delete legacy.correctionObligations
    rejects(
      legacy,
      { type: "propose-transition", proposal: proposal(legacy, "implement", "advance", context(legacy)) },
      "mapped correction",
    )
    rejects(
      state,
      { type: "propose-transition", proposal: proposal(state, "implement", "advance", context(state)) },
      "mapped correction",
    )
    rejects(
      state,
      {
        type: "record-correction",
        artifact: ref("correction"),
        revisitReceiptId: first,
        correction: {
          id: id(),
          artifactId: "absent",
          decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-2" }],
          affectedSpecItemIds: [],
          affectedFiles: [],
          changePointers: [],
          acceptedBatches: [],
          impact: "mapped",
        },
      },
      "reopened stage",
    )
    state = confirm(propose(state, proposal(state, "prototype")))
    state = select(finish(start(state)))
    state = mapped(state, "mapped", first)
    state = summary(state)
    state = confirm(propose(state, proposal(state, "implement", "advance", context(state))))
    expect(start(state).stage).toBe("implement")
    expect(state.correctionObligations).toHaveLength(2)
  })
  test("an unentered cancelled revisit adds no correction duty to a later confirmed visit", () => {
    let state = request(start(ready("implement")), "design")
    const cancelledRequest = state.revisit!.receiptId
    state = apply(state, {
      type: "cancel-revisit",
      receipt: receipt(state, cancelledRequest, "cancel-revisit"),
    })
    state = request(state, "design")
    state = summary(state)
    state = confirm(propose(state, proposal(state, "design", "revisit")))
    state = summary(finish(start(state)))
    state = mapped(state, "mapped")
    expect(() => mapped(state, "mapped", cancelledRequest)).toThrow("reopened stage")
    state = apply(state, { type: "record-artifact", artifact: ref("spec") })
    state = confirm(propose(state, proposal(state, "implement", "advance", context(state))))
    expect(start(state).stage).toBe("implement")
    expect(state.correctionObligations).toHaveLength(1)
  })
  test("legacy returned singleton normalizes inertly without losing evidence or its correction gate", () => {
    let state = request(start(ready("implement")), "prototype")
    state = summary(state)
    state = confirm(propose(state, proposal(state, "prototype", "revisit")))
    state = finish(start(state))
    state = mapped(state, "needs-review")
    const latest = state.revisitHistory!.at(-1)!
    const legacy = structuredClone(state)
    legacy.revisit = {
      target: latest.target,
      policy: latest.policy,
      attemptId: latest.attemptId,
      receiptId: latest.receiptId,
      correctionId: latest.correctionId,
    }
    delete legacy.revisitHistory
    delete legacy.correctionObligations
    const before = structuredClone(legacy)
    const normalized = normalizeIteration(legacy)
    expect(legacy).toEqual(before)
    expect(normalized.revision).toBe(legacy.revision)
    expect(normalized.revisit).toBeUndefined()
    expect(normalized.revisitHistory).toHaveLength(1)
    expect(normalized.correctionObligations).toHaveLength(1)
    expect(normalized.attempts).toEqual(state.attempts)
    expect(normalized.receipts).toEqual(state.receipts)
    state = request(normalized, "design")
    expect(state.revisit?.target).toBe("design")
    expect(state.correctionObligations).toHaveLength(2)
  })
  test("human cancellation keeps interrupted changes and earlier returned-visit obligations", () => {
    let state = request(start(ready("implement")), "prototype")
    state = summary(state)
    state = confirm(propose(state, proposal(state, "prototype", "revisit")))
    state = finish(start(state))
    const obligations = structuredClone(state.correctionObligations)
    state = request(state, "design")
    const attempt = structuredClone(state.attempts.at(-1))
    const requestId = state.revisit!.receiptId
    rejects(state, { type: "cancel-revisit", receipt: receipt(state, "wrong", "cancel-revisit") })
    state = apply(state, { type: "cancel-revisit", receipt: receipt(state, requestId, "cancel-revisit") })
    expect(state.revisit).toBeUndefined()
    expect(state.attempts.at(-1)).toEqual(attempt)
    expect(state.attempts.at(-1)?.changes).toContain("diff:interrupt")
    expect(state.correctionObligations).toEqual(obligations)
    expect(state.revisitHistory!.at(-1)?.cancelReceiptId).toBe(state.receipts.at(-1)?.id)
  })
})

describe("review regression gates", () => {
  function reopenFromWork(stage: "implement" | "accept"): IterationState {
    let state = start(ready(stage))
    const attemptId = state.activeAttemptId!
    state = apply(state, {
      type: "request-revisit",
      target: "design",
      policy: "interrupt",
      attemptId,
      changes: ["diff:partial"],
      receipt: receipt(state, attemptId, "design"),
    })
    state = summary(state)
    state = confirm(propose(state, proposal(state, "design", "revisit")))
    return summary(finish(start(state)))
  }
  function correction(state: IterationState, impact: "mapped" | "needs-review"): IterationState {
    const artifact = ref("correction")
    return apply(state, {
      type: "record-correction",
      artifact,
      correction: {
        id: id(),
        artifactId: artifact.id,
        decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-2" }],
        affectedSpecItemIds: [],
        affectedFiles: [],
        changePointers: ["diff:partial"],
        acceptedBatches: [],
        impact,
      },
    })
  }
  for (const status of ["tried", "deferred"] as const) {
    test(`required UI trial cannot be omitted and can be ${status}`, () => {
      let state = start(ready("accept"))
      const artifact = ref("acceptance")
      state = apply(state, {
        type: "finish-work",
        attemptId: state.activeAttemptId!,
        changes: [],
        artifact,
        acceptance: {
          verdict: "pass",
          failingItemIds: [],
          artifactId: artifact.id,
          manualTrialRequired: true,
        },
      })
      expect(state.manualTrialRequired).toBe(true)
      state = summary(state)
      rejects(state, { type: "propose-transition", proposal: proposal(state, null, "complete") }, "manual")
      state = apply(state, { type: "record-manual-trial", status: "pending", artifact: ref("manual-trial") })
      rejects(state, { type: "propose-transition", proposal: proposal(state, null, "complete") }, "manual")
      const trial = ref("manual-trial")
      state = apply(state, {
        type: "record-manual-trial",
        status,
        artifact: trial,
        receipt: receipt(state, trial.id, status),
      })
      const completed = confirm(propose(state, proposal(state, null, "complete")))
      expect(completed.completion).toBe("accepted")
      const missing = structuredClone(completed)
      delete missing.manualTrial
      expect(() => validateIteration(missing)).toThrow("manual")
      delete missing.manualTrialRequired
      // Per-batch consumed evidence now retains the trial independently of the UI pointer.
      for (const resolution of missing.batchResolutions ?? []) delete resolution.manualTrial
      for (const attempt of missing.attempts) delete attempt.manualTrial
      expect(() => validateIteration(missing)).toThrow("manual")
    })
  }
  for (const source of ["implement", "accept"] as const) {
    for (const destination of ["implement", "accept"] as const) {
      test(`${source} revisit protects ${destination} with mapped correction and revised spec`, () => {
        let state = reopenFromWork(source)
        rejects(
          state,
          {
            type: "propose-transition",
            proposal: proposal(state, destination, "advance", context(state)),
          },
          "correction",
        )
        state = correction(state, "needs-review")
        rejects(
          state,
          {
            type: "propose-transition",
            proposal: proposal(state, destination, "advance", context(state)),
          },
          "mapped correction",
        )
        state = correction(state, "mapped")
        rejects(
          state,
          {
            type: "propose-transition",
            proposal: proposal(state, destination, "advance", context(state)),
          },
          "revised spec",
        )
        state = apply(state, { type: "record-artifact", artifact: ref("spec") })
        state = confirm(propose(state, proposal(state, destination, "advance", context(state))))
        // Use the original, still-published spec to check the start boundary too.
        const stale = {
          ...state,
          approvedContext: {
            ...context(state),
            spec: state.attempts.findLast((a) => a.stage === source)!.context!.spec,
          },
        }
        rejects(stale, { type: "start-work", attemptId: id() }, "revised spec")
        state = start(state)
        expect(state.revisit).toBeUndefined()
      })
    }
  }
  test("design can reopen after cancelling a proposal without deleting evidence", () => {
    let state = summary(finish(start(ready("design"))))
    const evidence = structuredClone({ attempts: state.attempts, artifacts: state.artifacts })
    state = propose(state, proposal(state, "prototype", "advance", context(state)))
    rejects(state, { type: "reopen-design" })
    state = apply(state, { type: "cancel-transition" })
    state = apply(state, { type: "reopen-design" })
    expect(state).toMatchObject({ stage: "design", phase: "ready", status: "idle", ...evidence })
    expect(state.activeAttemptId).toBeUndefined()
    expect(state.summaryId).toBeUndefined()
    expect(state.approvedContext).toBeUndefined()
    state = start(state)
    expect(state.attempts).toHaveLength(evidence.attempts.length + 1)
    rejects(state, { type: "reopen-design" })
  })
  for (const stage of ["prototype", "implement", "accept"] as const) {
    for (const boundary of ["idle", "finished", "summarized"] as const) {
      test(`${stage} can revisit design when ${boundary} without starting new work`, () => {
        let state = ready(stage)
        if (boundary !== "idle") state = finish(start(state))
        if (boundary === "summarized") state = summary(state)
        const attemptId = state.activeAttemptId
        const attempts = structuredClone(state.attempts)
        const subject = attemptId ?? `revisit:${stage}`
        const request = {
          type: "request-revisit" as const,
          target: "design" as const,
          policy: "interrupt" as const,
          ...(attemptId ? { attemptId } : {}),
          changes: [],
          receipt: receipt(state, subject, "design"),
        }
        rejects(state, { ...request, policy: "boundary" })
        rejects(state, { ...request, attemptId: "missing" })
        state = apply(state, request)
        expect(state.attempts).toEqual(attempts)
        expect(state.revisit?.attemptId).toBe(attemptId)
        expect(state.stage).toBe(stage)
        rejects(state, { type: "confirm-transition", receipt: receipt(state, subject, "design") })
        state = summary(state)
        state = confirm(propose(state, proposal(state, "design", "revisit")))
        expect(state).toMatchObject({ stage: "design", status: "idle", phase: "confirmed" })
      })
    }
  }
  test("fresh acceptance resets the required-trial flag and previous trial evidence", () => {
    let state = start(ready("accept"))
    const artifact = ref("acceptance")
    state = apply(state, {
      type: "finish-work",
      attemptId: state.activeAttemptId!,
      changes: [],
      artifact,
      acceptance: {
        verdict: "blocked",
        failingItemIds: [],
        artifactId: artifact.id,
        manualTrialRequired: true,
      },
    })
    state = apply(state, { type: "record-manual-trial", status: "pending", artifact: ref("manual-trial") })
    const trial = ref("manual-trial")
    state = apply(state, {
      type: "record-manual-trial",
      status: "deferred",
      artifact: trial,
      receipt: receipt(state, trial.id, "deferred"),
    })
    state = apply(state, {
      type: "confirm-continuation",
      receipt: receipt(state, state.activeAttemptId!, "resume", state.approvedContext),
    })
    state = start(state)
    expect(state.manualTrialRequired).toBeUndefined()
    expect(state.manualTrial).toBeUndefined()
    expect(state.artifacts).toContainEqual(trial)
    expect(state.attempts.at(-2)?.acceptance?.manualTrialRequired).toBe(true)
    state = summary(finish(state))
    expect(confirm(propose(state, proposal(state, null, "complete"))).completion).toBe("accepted")
  })
  for (const policy of ["interrupt", "boundary"] as const) {
    test(`prototype work revisits design via ${policy} with exact attempt validation`, () => {
      let state = start(ready("prototype"))
      const attemptId = state.activeAttemptId!
      const request = {
        type: "request-revisit" as const,
        target: "design" as const,
        policy,
        attemptId,
        changes: ["diff:prototype"],
        receipt: receipt(state, attemptId, "design"),
      }
      rejects(state, {
        ...request,
        attemptId: undefined,
        receipt: receipt(state, "revisit:prototype", "design"),
      })
      rejects(state, { ...request, attemptId: state.attempts[0]!.id })
      rejects(state, { ...request, target: "prototype" })
      state = apply(state, request)
      if (policy === "boundary") {
        expect(state.phase).toBe("running")
        rejects(state, { type: "prepare-summary", artifact: ref("stage-summary") })
        state = finish(state)
      }
      state = summary(state)
      rejects(state, {
        type: "propose-transition",
        proposal: proposal(state, "accept", "advance", context(state)),
      })
      state = confirm(propose(state, proposal(state, "design", "revisit")))
      expect(state.attempts.at(-1)?.changes).toContain("diff:prototype")
      state = apply(state, { type: "reopen-design" })
      expect(start(state).stage).toBe("design")
    })
  }
  test("attempt-free revisit receipts name the source and cannot refer to unrelated attempts", () => {
    const state = ready("accept")
    const request = {
      type: "request-revisit" as const,
      target: "prototype" as const,
      policy: "interrupt" as const,
      changes: [],
      receipt: receipt(state, "revisit:accept", "prototype"),
    }
    rejects(state, { ...request, attemptId: state.attempts[0]!.id })
    rejects(state, { ...request, receipt: receipt(state, "revisit:implement", "prototype") })
    const revisiting = apply(state, request)
    const invalid = structuredClone(revisiting)
    invalid.receipts.at(-1)!.subjectId = "revisit:design"
    expect(() => validateIteration(invalid)).toThrow("provenance")
    invalid.receipts.at(-1)!.subjectId = "revisit:accept"
    invalid.revisit!.attemptId = "absent"
    expect(() => validateIteration(invalid)).toThrow("revisit attempt")
  })
  test("acceptance-only work also requires a revised spec after a revisit", () => {
    let state = summary(ready("design"))
    state = confirm(propose(state, proposal(state, "accept", "skip", context(state))))
    state = start(state)
    const attemptId = state.activeAttemptId!
    state = apply(state, {
      type: "request-revisit",
      target: "design",
      policy: "interrupt",
      attemptId,
      changes: [],
      receipt: receipt(state, attemptId, "design"),
    })
    state = summary(state)
    state = confirm(propose(state, proposal(state, "design", "revisit")))
    state = summary(finish(start(state)))
    state = correction(state, "mapped")
    rejects(
      state,
      {
        type: "propose-transition",
        proposal: proposal(state, "accept", "advance", context(state)),
      },
      "revised spec",
    )
    expect(state.attempts.some((a) => a.stage === "implement")).toBe(false)
  })
  test("skipped design reenters from prototype without a variant or implementation correction", () => {
    let state = summary(ready("design"))
    state = confirm(propose(state, proposal(state, "prototype", "skip")))
    state = finish(start(state))
    const attemptId = state.activeAttemptId!
    state = apply(state, {
      type: "request-revisit",
      target: "design",
      policy: "interrupt",
      attemptId,
      changes: [],
      receipt: receipt(state, attemptId, "design"),
    })
    state = summary(state)
    state = confirm(propose(state, proposal(state, "design", "revisit")))
    state = summary(finish(start(state)))
    state = confirm(propose(state, proposal(state, "accept", "advance", context(state))))
    expect(state.corrections).toEqual([])
    expect(state.prototypeChoice).toBeUndefined()
    expect(start(state).stage).toBe("accept")
  })
})

describe("acceptance and manual trial evidence", () => {
  for (const verdict of ["pass", "fail", "blocked"] as const) {
    test(`${verdict} verdict is evidence, never automatic advancement`, () => {
      const state = finish(start(ready("accept")), verdict)
      expect(state.stage).toBe("accept")
      expect(state.phase).toBe("finished")
      expect(state.status).toBe(verdict === "blocked" ? "blocked" : "idle")
      expect(state.attempts.at(-1)?.acceptance?.verdict).toBe(verdict)
      rejects(state, { type: "start-work", attemptId: id() })
    })
  }
  test("failure preserves item IDs, gates repair, and retains the old failing attempt", () => {
    let state = summary(finish(start(ready("accept")), "fail"))
    const failed = structuredClone(state.attempts.at(-1))
    rejects(state, { type: "propose-transition", proposal: proposal(state, null, "complete") }, "not a pass")
    state = propose(state, proposal(state, "implement", "repair", context(state)))
    expect(state.stage).toBe("accept")
    state = confirm(state)
    expect(state).toMatchObject({ stage: "implement", phase: "confirmed", status: "idle" })
    state = start(state)
    expect(state.attempts.at(-2)).toEqual(failed)
    expect(state.attempts.at(-2)?.acceptance?.failingItemIds).toEqual(["SPEC-2"])
    expect(state.attempts.at(-1)?.id).not.toBe(failed?.id)
  })
  for (const verdict of ["pass", "blocked"] as const) {
    test(`${verdict} cannot claim a failing repair route`, () => {
      const state = summary(finish(start(ready("accept")), verdict))
      rejects(state, {
        type: "propose-transition",
        proposal: proposal(state, "implement", "repair", context(state)),
      })
    })
  }
  for (const [verdict, failingItemIds] of [
    ["fail", []],
    ["pass", ["SPEC-1"]],
    ["blocked", ["SPEC-1"]],
    ["fail", ["SPEC-1", "SPEC-1"]],
  ] as const) {
    test(`inconsistent ${verdict} failing-item list ${failingItemIds} is rejected`, () => {
      const state = start(ready("accept"))
      const artifact = ref("acceptance")
      rejects(state, {
        type: "finish-work",
        attemptId: state.activeAttemptId!,
        changes: [],
        acceptance: { verdict, failingItemIds: [...failingItemIds], artifactId: artifact.id },
        artifact,
      })
    })
  }
  for (const status of ["tried", "problem", "deferred"] as const) {
    test(`manual ${status} requires a prompt and a separate revision-bound human receipt`, () => {
      let state = finish(start(ready("accept")))
      let artifact = ref("manual-trial")
      rejects(state, {
        type: "record-manual-trial",
        status,
        artifact,
        receipt: receipt(state, artifact.id, status),
      })
      state = apply(state, { type: "record-manual-trial", status: "pending", artifact: ref("manual-trial") })
      expect(state.manualTrial?.status).toBe("pending")
      state = summary(state)
      rejects(state, { type: "propose-transition", proposal: proposal(state, null, "complete") }, "manual")
      artifact = ref("manual-trial")
      rejects(state, { type: "record-manual-trial", status, artifact })
      state = apply(state, {
        type: "record-manual-trial",
        status,
        artifact,
        receipt: receipt(state, artifact.id, status),
      })
      expect(state.manualTrial?.status).toBe(status)
      expect(state.artifacts.filter((a) => a.kind === "manual-trial")).toHaveLength(2)
      const next = proposal(state, null, "complete")
      if (status === "problem") rejects(state, { type: "propose-transition", proposal: next })
      else expect(confirm(propose(state, next)).completion).toBe("accepted")
    })
  }
})

describe("interruptions, revisits and correction batches", () => {
  for (const stage of ["implement", "accept"] as const) {
    for (const target of ["design", "prototype"] as const) {
      for (const policy of ["interrupt", "boundary"] as const) {
        test(`${stage} revisits ${target} at ${policy}, preserving work and requiring correction approval`, () => {
          let state = start(ready(stage))
          const oldAttemptId = state.activeAttemptId!
          state = apply(state, {
            type: "request-revisit",
            target,
            policy,
            attemptId: oldAttemptId,
            changes: ["diff:partial"],
            receipt: receipt(state, oldAttemptId, target),
          })
          expect(state.stage).toBe(stage)
          expect(state.status).toBe(policy === "interrupt" ? "interrupted" : "working")
          expect(state.attempts.at(-1)?.changes).toContain("diff:partial")
          if (policy === "boundary") state = finish(state)
          state = summary(state)
          rejects(state, {
            type: "propose-transition",
            proposal: proposal(
              state,
              stage === "accept" ? null : "accept",
              stage === "accept" ? "complete" : "advance",
              context(state),
            ),
          })
          state = confirm(propose(state, proposal(state, target, "revisit")))
          expect(state.stage).toBe(target)
          state = finish(start(state))
          if (target === "prototype") state = select(state)
          state = summary(state)
          rejects(
            state,
            { type: "propose-transition", proposal: proposal(state, "implement", "advance", context(state)) },
            "revisit",
          )
          const artifact = ref("correction")
          const correction = {
            id: id(),
            artifactId: artifact.id,
            decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-3" }],
            affectedSpecItemIds: ["SPEC-2"],
            affectedFiles: ["src/example.ts"],
            changePointers: ["diff:partial"],
            acceptedBatches: [],
            impact: "mapped" as const,
          }
          state = apply(state, { type: "record-correction", artifact, correction })
          rejects(
            state,
            { type: "propose-transition", proposal: proposal(state, "implement", "advance", context(state)) },
            "revised spec",
          )
          state = apply(state, { type: "record-artifact", artifact: ref("spec") })
          state = confirm(propose(state, proposal(state, "implement", "advance", context(state))))
          expect(state.attempts.find((a) => a.id === oldAttemptId)?.changes).toContain("diff:partial")
          expect(state.corrections).toEqual([correction])
          expect(state.status).toBe("idle")
          state = start(state)
          expect(state.revisit).toBeUndefined()
          expect(state.attempts.at(-1)?.id).not.toBe(oldAttemptId)
        })
      }
    }
  }
  test("crash/interruption never replays work; explicit continuation precedes a fresh attempt", () => {
    let state = start(ready("implement"))
    const oldId = state.activeAttemptId!
    const oldContext = state.approvedContext
    state = apply(state, { type: "interrupt-work", attemptId: oldId, changes: ["diff:uncommitted"] })
    const restored = JSON.parse(JSON.stringify(state)) as unknown
    validateIteration(restored)
    expect(restored.status).toBe("interrupted")
    rejects(restored, { type: "start-work", attemptId: id() })
    state = apply(restored, {
      type: "confirm-continuation",
      receipt: receipt(restored, oldId, "resume", oldContext),
    })
    expect(state).toMatchObject({ status: "idle", phase: "confirmed" })
    state = start(state)
    expect(state.attempts.find((a) => a.id === oldId)).toMatchObject({
      status: "interrupted",
      changes: ["diff:uncommitted"],
    })
    rejects(state, { type: "start-work", attemptId: oldId })
  })
})

// Exhaustive event/phase rejection matrix for a design attempt. Specialized stage events
// have their valid paths above; here they must never accidentally become generic commands.
describe("illegal event/phase matrix", () => {
  const initial = ready("design")
  const working = start(initial)
  const finished = finish(working)
  const summarized = summary(finished)
  const pending = propose(summarized, proposal(summarized, "prototype"))
  const confirmed = confirm(pending)
  const interrupted = apply(working, {
    type: "interrupt-work",
    attemptId: working.activeAttemptId!,
    changes: [],
  })
  const blocked = finish(start(ready("accept")), "blocked")
  const finalSummary = summary(finish(start(ready("accept"))))
  const complete = confirm(propose(finalSummary, proposal(finalSummary, null, "complete")))
  const fixtures = {
    ready: initial,
    running: working,
    finished,
    summarized,
    proposed: pending,
    confirmed,
    interrupted,
    blocked,
    complete,
  }
  const factories: { [K in StageEvent["type"]]: (s: IterationState) => Extract<Event, { type: K }> } = {
    "start-work": () => ({ type: "start-work", attemptId: id() }),
    "finish-work": (s) => ({ type: "finish-work", attemptId: s.activeAttemptId ?? "absent", changes: [] }),
    "prepare-summary": () => ({ type: "prepare-summary", artifact: ref("stage-summary") }),
    "propose-transition": (s) => ({ type: "propose-transition", proposal: proposal(s, "prototype") }),
    "confirm-transition": (s) => ({
      type: "confirm-transition",
      receipt: receipt(s, s.pending?.id ?? "absent", "prototype"),
    }),
    "cancel-transition": () => ({ type: "cancel-transition" }),
    "cancel-revisit": (s) => ({ type: "cancel-revisit", receipt: receipt(s, "absent", "cancel-revisit") }),
    "reopen-design": () => ({ type: "reopen-design" }),
    "record-artifact": () => ({ type: "record-artifact", artifact: ref("batch-plan") }),
    "select-prototype": (s) => ({
      type: "select-prototype",
      variantId: "v",
      decisionId: "D",
      receipt: receipt(s, "v", "v"),
    }),
    "request-revisit": (s) => ({
      type: "request-revisit",
      target: "design",
      policy: "interrupt",
      attemptId: s.activeAttemptId ?? "absent",
      changes: [],
      receipt: receipt(s, s.activeAttemptId ?? "absent", "design"),
    }),
    "record-correction": () => {
      const artifact = ref("correction")
      return {
        type: "record-correction",
        artifact,
        correction: {
          id: id(),
          artifactId: artifact.id,
          decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-2" }],
          affectedSpecItemIds: [],
          affectedFiles: [],
          changePointers: [],
          acceptedBatches: [],
          impact: "mapped",
        },
      }
    },
    "record-manual-trial": () => ({
      type: "record-manual-trial",
      status: "pending",
      artifact: ref("manual-trial"),
    }),
    "interrupt-work": (s) => ({
      type: "interrupt-work",
      attemptId: s.activeAttemptId ?? "absent",
      changes: [],
    }),
    "confirm-continuation": (s) => ({
      type: "confirm-continuation",
      receipt: receipt(s, s.activeAttemptId ?? "absent", "resume", s.approvedContext),
    }),
  }
  const allowed: Record<StageEvent["type"], string[]> = {
    "start-work": ["ready", "confirmed"],
    "finish-work": ["running"],
    "prepare-summary": ["ready", "finished", "confirmed", "interrupted", "blocked"],
    "propose-transition": ["summarized"],
    "confirm-transition": ["proposed"],
    "cancel-transition": ["proposed"],
    "cancel-revisit": [],
    "reopen-design": ["ready", "finished", "summarized"],
    "record-artifact": ["ready", "running", "finished", "summarized", "confirmed", "interrupted", "blocked"],
    "select-prototype": [],
    "request-revisit": ["blocked"],
    "record-correction": [],
    "record-manual-trial": ["blocked"],
    "interrupt-work": ["running"],
    "confirm-continuation": ["interrupted", "blocked"],
  }
  for (const [phase, state] of Object.entries(fixtures)) {
    for (const type of Object.keys(factories) as StageEvent["type"][]) {
      test(`${phase}: ${type} ${allowed[type].includes(phase) ? "allowed" : "rejected"}`, () => {
        const event = factories[type](state)
        if (allowed[type].includes(phase)) apply(state, event)
        else rejects(state, event)
      })
    }
  }
})

describe("specialized event guards", () => {
  test("prototype completion needs a human variant choice, not a model result", () => {
    const state = summary(finish(start(ready("prototype"))))
    rejects(
      state,
      {
        type: "propose-transition",
        proposal: proposal(state, "implement", "advance", context(state)),
      },
      "human-selected variant",
    )
    const chosen = select(state)
    expect(propose(chosen, proposal(chosen, "implement", "advance", context(chosen))).phase).toBe("proposed")
  })
  test("acceptance requires a verdict and matching acceptance artifact", () => {
    const state = start(ready("accept"))
    const artifact = ref("acceptance")
    rejects(state, { type: "finish-work", attemptId: state.activeAttemptId!, changes: [] })
    rejects(state, {
      type: "finish-work",
      attemptId: state.activeAttemptId!,
      changes: [],
      acceptance: { verdict: "pass", failingItemIds: [], artifactId: "different" },
      artifact,
    })
    const design = start(ready("design"))
    rejects(design, {
      type: "finish-work",
      attemptId: design.activeAttemptId!,
      changes: [],
      acceptance: { verdict: "pass", failingItemIds: [], artifactId: artifact.id },
      artifact,
    })
  })
  test("queued revisit cannot be duplicated or resumed around", () => {
    let state = start(ready("implement"))
    const attemptId = state.activeAttemptId!
    const event = {
      type: "request-revisit" as const,
      target: "prototype" as const,
      policy: "boundary" as const,
      attemptId,
      changes: ["diff:partial"],
      receipt: receipt(state, attemptId, "prototype"),
    }
    state = apply(state, event)
    rejects(state, { ...event, receipt: receipt(state, attemptId, "prototype") })
    rejects(state, { type: "prepare-summary", artifact: ref("stage-summary") })
    state = apply(state, { type: "interrupt-work", attemptId, changes: ["diff:remaining"] })
    rejects(state, {
      type: "confirm-continuation",
      receipt: receipt(state, attemptId, "resume", state.approvedContext),
    })
    expect(state.attempts.at(-1)?.changes).toEqual(["diff:partial", "diff:remaining"])
  })
  test("unmapped corrections cannot authorize implementation", () => {
    let state = start(ready("implement"))
    const attemptId = state.activeAttemptId!
    state = apply(state, {
      type: "request-revisit",
      target: "design",
      policy: "interrupt",
      attemptId,
      changes: ["diff:partial"],
      receipt: receipt(state, attemptId, "design"),
    })
    state = summary(state)
    state = confirm(propose(state, proposal(state, "design", "revisit")))
    state = summary(finish(start(state)))
    const artifact = ref("correction")
    const correction = {
      id: id(),
      artifactId: artifact.id,
      decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-2" }],
      affectedSpecItemIds: [],
      affectedFiles: [],
      changePointers: ["diff:partial"],
      acceptedBatches: [],
      impact: "needs-review" as const,
    }
    rejects(
      state,
      { type: "record-correction", artifact, correction: { ...correction, decisionLinks: [] } },
      "traceability",
    )
    rejects(
      state,
      {
        type: "record-correction",
        artifact,
        correction: { ...correction, decisionLinks: [{ oldDecisionId: "D-1", newDecisionId: "D-1" }] },
      },
      "self-superseding",
    )
    state = apply(state, { type: "record-correction", artifact, correction })
    state = apply(state, { type: "record-artifact", artifact: ref("spec") })
    rejects(
      state,
      { type: "propose-transition", proposal: proposal(state, "implement", "advance", context(state)) },
      "mapped correction",
    )
  })
})

describe("untrusted state/event validation and immutability", () => {
  const changes: [string, (v: Record<string, unknown>) => void][] = [
    [
      "schema version",
      (v) => {
        v.schemaVersion = 2
      },
    ],
    [
      "unknown stage",
      (v) => {
        v.stage = "ship"
      },
    ],
    [
      "unknown status",
      (v) => {
        v.status = "passed"
      },
    ],
    [
      "negative revision",
      (v) => {
        v.revision = -1
      },
    ],
    [
      "fractional revision",
      (v) => {
        v.revision = 1.5
      },
    ],
    [
      "infinite revision",
      (v) => {
        v.revision = Infinity
      },
    ],
    [
      "unsafe revision",
      (v) => {
        v.revision = Number.MAX_SAFE_INTEGER + 1
      },
    ],
    [
      "zero iteration",
      (v) => {
        v.iteration = 0
      },
    ],
    [
      "empty identity",
      (v) => {
        v.projectId = " "
      },
    ],
    [
      "unknown field",
      (v) => {
        v.execute = true
      },
    ],
    [
      "missing collection",
      (v) => {
        delete v.artifacts
      },
    ],
    [
      "unknown artifact kind",
      (v) => {
        v.artifacts = [{ ...ref("spec"), kind: "script" }]
      },
    ],
    [
      "malformed artifact",
      (v) => {
        v.artifacts = [{ ...ref("spec"), hash: 123 }]
      },
    ],
    [
      "duplicate artifact",
      (v) => {
        const a = ref("spec")
        v.artifacts = [a, a]
      },
    ],
    [
      "missing active attempt",
      (v) => {
        v.activeAttemptId = "missing"
      },
    ],
    [
      "false working",
      (v) => {
        v.status = "working"
        v.phase = "running"
      },
    ],
    [
      "false interrupted",
      (v) => {
        v.status = "interrupted"
      },
    ],
    [
      "false blocked",
      (v) => {
        v.status = "blocked"
      },
    ],
    [
      "missing pending",
      (v) => {
        v.status = "awaiting-confirmation"
        v.phase = "proposed"
      },
    ],
    [
      "missing summary",
      (v) => {
        v.phase = "summarized"
      },
    ],
    [
      "false completion",
      (v) => {
        v.phase = "complete"
        v.completion = "accepted"
      },
    ],
    [
      "missing skip receipt",
      (v) => {
        v.skips = [{ stage: "prototype", receiptId: "absent" }]
      },
    ],
  ]
  for (const [name, mutate] of changes) {
    test(`state validator rejects ${name}`, () => {
      const state = { ...initialIteration("p", 1) } as Record<string, unknown>
      mutate(state)
      expect(() => validateIteration(state)).toThrow()
    })
  }
  for (const input of [null, undefined, [], "state", 1]) {
    test(`state validator rejects ${JSON.stringify(input)}`, () =>
      expect(() => validateIteration(input)).toThrow())
  }
  test("unknown/forged events and exhausted revisions are rejected", () => {
    const state = initialIteration("p", 1)
    for (const event of [
      null,
      { type: "ship", expectedRevision: 0 },
      { type: "start-work", expectedRevision: 0, attemptId: "a", auto: true },
      { type: "start-work", expectedRevision: 0, attemptId: "" },
    ]) {
      expect(() => reduceStage(state, event as StageEvent)).toThrow()
    }
    expect(() =>
      reduceStage(
        { ...state, revision: Number.MAX_SAFE_INTEGER },
        { type: "start-work", expectedRevision: Number.MAX_SAFE_INTEGER, attemptId: "a" },
      ),
    ).toThrow("exhausted")
  })
  test("duplicate IDs, paths, wrong artifact kinds, omitted skips and spec hash substitutions fail", () => {
    let state = ready("design")
    const spec = state.artifacts[0]!
    rejects(state, { type: "record-artifact", artifact: spec })
    rejects(state, { type: "record-artifact", artifact: { ...spec, id: id() } })
    rejects(state, { type: "record-artifact", artifact: ref("acceptance") })
    rejects(state, { type: "prepare-summary", artifact: ref("spec") })
    state = summary(finish(start(state)))
    rejects(state, {
      type: "propose-transition",
      proposal: { ...proposal(state, "implement", "advance", context(state)), skippedStages: [] },
    })
    const inputs = context(state)
    inputs.spec!.hash = "substituted"
    rejects(state, { type: "propose-transition", proposal: proposal(state, "implement", "advance", inputs) })
  })
  test("dedicated events consume exact immutable artifacts already published by the store", () => {
    const artifact = ref("stage-summary")
    const published = { ...initialIteration("p", 1), revision: 1, artifacts: [artifact] }
    const consumed = apply(published, { type: "prepare-summary", artifact })
    expect(consumed.artifacts).toEqual([artifact])
    expect(consumed.summaryId).toBe(artifact.id)
    for (const changed of [
      { ...artifact, hash: "different" },
      { ...artifact, path: "different" },
      { ...artifact, id: "different" },
    ]) {
      rejects(published, { type: "prepare-summary", artifact: changed })
    }
    const acceptance = ref("acceptance")
    const working = start(ready("accept"))
    const saved = {
      ...working,
      revision: working.revision + 1,
      artifacts: [...working.artifacts, acceptance],
    }
    const result = apply(saved, {
      type: "finish-work",
      attemptId: saved.activeAttemptId!,
      changes: [],
      artifact: acceptance,
      acceptance: { verdict: "pass", failingItemIds: [], artifactId: acceptance.id },
    })
    expect(result.artifacts.filter((a) => a.id === acceptance.id)).toHaveLength(1)
  })
  test("published objects and returned snapshots do not alias event or input objects", () => {
    const state = initialIteration("p", 1)
    const artifact = ref("spec")
    const next = apply(state, { type: "record-artifact", artifact })
    artifact.hash = "mutated"
    expect(next.artifacts[0]?.hash).not.toBe("mutated")
    next.artifacts[0]!.path = "mutated"
    expect(state.artifacts).toEqual([])
  })
})
