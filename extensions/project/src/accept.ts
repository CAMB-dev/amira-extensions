import { randomUUID } from "node:crypto"
import path from "node:path"
import type { CommandContext, ExtensionAPI, OwnedConversation, ToolDefinition } from "@amira/api"
import {
  type AcceptanceCheckout,
  type AcceptanceFreshness,
  acceptanceCheckCwd,
  acceptanceCheckout,
  acceptanceCodeHash,
  verifyAcceptanceCheckout,
} from "./accept-integrity.ts"
import { prepareManualTrial } from "./accept-trial.ts"
import { openAccounted } from "./accounting.ts"
import type { AcceptanceArtifact, BatchPlanArtifact, SpecArtifact } from "./artifacts.ts"
import { validateArtifact } from "./artifacts.ts"
import { ImplementationLifecycle } from "./implementation-lifecycle.ts"
import { inDirectory, type Shell, shellCall } from "./iteration-git.ts"
import { supportsPrototype } from "./prototype-sessions.ts"
import { renderSpec, specInputs } from "./spec.ts"
import { requiredChecks } from "./spec-integrity.ts"
import { type ApprovalContext, reduceStage } from "./stage.ts"
import { IterationStore, type Project } from "./store.ts"

export type { AcceptanceFreshness } from "./accept-integrity.ts"
export { acceptanceCodeHash, acceptanceStaleness } from "./accept-integrity.ts"
export const ACCEPT_RECORD = "project_record_acceptance"
export const ACCEPT_TOOLS = ["read", "grep", "glob"]
interface Running {
  project: Project
  handle: OwnedConversation
  controller: AbortController
  paused: boolean
  started: boolean
  done?: Promise<void>
}

/** Each explicit run consumes one human-approved acceptance route, never a stored
 * conversation. Model observations and deterministic check evidence stay separate. */
export class Acceptances {
  private readonly running = new Map<string, Running>()
  constructor(
    private readonly api: ExtensionAPI,
    private readonly changed: () => void = () => {},
  ) {
    const allowed = async (sessionId: string) => {
      const entry = [...this.running.entries()].find(([, binding]) => binding.handle.id === sessionId)
      if (!entry) return { action: "pass" as const }
      const [attemptId, binding] = entry
      const state = await new IterationStore(binding.project).read()
      return !binding.paused &&
        !binding.controller.signal.aborted &&
        state.stage === "accept" &&
        (binding.started
          ? state.activeAttemptId === attemptId && state.phase === "running"
          : state.phase === "confirmed" && state.status === "idle" && !state.revisit)
        ? { action: "pass" as const }
        : {
            action: "block" as const,
            reason: "Acceptance is paused, finished or obsolete. Return to main and review /project next.",
          }
    }
    api.intercept?.("context.build", (_value, ctx) => allowed(ctx.sessionId))
    api.intercept?.("tool.call.before", (_value, ctx) => allowed(ctx.sessionId))
  }

  async wait(project: Project): Promise<void> {
    await Promise.all(this.bindings(project).map((binding) => binding.done))
  }
  private bindings(project: Project): Running[] {
    return [...this.running.values()].filter(
      (binding) =>
        binding.project.marker.id === project.marker.id &&
        binding.project.marker.currentIteration === project.marker.currentIteration,
    )
  }
  async quiesce(project: Project): Promise<void> {
    const bindings = this.bindings(project).filter((binding) => !binding.paused)
    for (const binding of bindings) {
      binding.paused = true
      binding.controller.abort(new Error("Project stage change"))
    }
    await Promise.all(
      bindings.map(async (binding) => {
        await binding.handle.stop("Project stage change; preserve acceptance history and checkout")
        await binding.done
      }),
    )
  }

  async run(
    project: Project,
    ctx: CommandContext,
    language: string,
    checkOrigin: () => void,
    reviewerModel?: string,
  ): Promise<void> {
    if (!supportsPrototype(this.api.apiVersion) || !this.api.conversations || !ctx.focusConversation)
      throw new Error("Acceptance requires Amira API 0.1.53, owned runTool and native focus.")
    const store = new IterationStore(project)
    let state = await store.read()
    const live = this.running.get(state.activeAttemptId ?? "")
    if (live && !live.paused) {
      if (!ctx.focusConversation(live.handle)) throw new Error("Unable to focus the running reviewer")
      return
    }
    if (
      state.stage !== "accept" ||
      state.phase !== "confirmed" ||
      state.status !== "idle" ||
      state.pending ||
      state.revisit
    )
      throw new Error(
        "Confirm the exact acceptance batch with /project next first. Interrupted reviews are never replayed.",
      )
    const context = structuredClone(state.approvedContext!)
    const specRef = state.artifacts.find((entry) => entry.id === context.spec?.artifactId)
    const planRef = state.artifacts.find((entry) => entry.id === context.batchPlan?.artifactId)
    if (!specRef || !planRef || state.artifacts.findLast((entry) => entry.kind === "spec")?.id !== specRef.id)
      throw new Error("The latest spec and exact batch plan need fresh human approval")
    const spec = (await store.readArtifact(specRef)) as SpecArtifact
    const plan = (await store.readArtifact(planRef)) as BatchPlanArtifact
    const batch = plan.batches.find((entry) => entry.id === context.batchId)
    if (!batch) throw new Error("Approved batch is missing")
    const checks = requiredChecks(spec, batch.itemIds)
    await store.assertCurrentSpecDecisions(spec)
    const items = spec.items.filter((item) => batch.itemIds.includes(item.id))
    const results = []
    const implementers = new Set<string>()
    for (const ref of state.artifacts.filter((entry) => entry.kind === "batch-result")) {
      const result = await store.readArtifact(ref)
      if (
        result.kind === "batch-result" &&
        result.context.batchId === context.batchId &&
        result.context.spec?.hash === context.spec?.hash &&
        result.context.batchPlan?.hash === context.batchPlan?.hash
      ) {
        results.push({ artifact: ref, result })
        for (const model of result.implementerModels) implementers.add(model)
      }
    }
    const currentModel = ctx.session.info().model
    const fallback =
      [...implementers].at(-1) ?? context.model ?? `${currentModel.provider}/${currentModel.model}`
    if (!implementers.size) implementers.add(context.model ?? fallback)
    if (reviewerModel && !ctx.session.models().includes(reviewerModel))
      throw new Error(`Unknown configured reviewer model: ${reviewerModel}`)
    if (reviewerModel && implementers.has(reviewerModel))
      throw new Error("Configured reviewer must differ from ALL implementer models for this batch")
    const model = reviewerModel ?? fallback
    const attemptId = randomUUID()
    const attempt = state.attempts.filter((entry) => entry.stage === "accept").length + 1
    reduceStage(state, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId,
      review: { attempt, codeHash: "0".repeat(64) },
    })
    const shell: Shell = ctx.session.info().shell === "powershell" ? "powershell" : "bash"
    const checkout = await acceptanceCheckout(project, state)
    const inputs = await specInputs(project, state)
    const relevant = new Set([...batch.decisionIds, ...items.flatMap((item) => item.decisionIds)])
    let observations: AcceptanceArtifact["items"] | undefined
    let handle: OwnedConversation
    let binding: Running
    const record: ToolDefinition = {
      name: ACCEPT_RECORD,
      description:
        "Record the review of every approved item exactly once. Check results are independently executed by the extension; do not claim them here.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: items.length,
            maxItems: items.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["itemId", "status", "evidence", "reason"],
              properties: {
                itemId: { type: "string", enum: batch.itemIds },
                status: { type: "string", enum: ["pass", "fail", "blocked", "not-applicable"] },
                evidence: { type: "array", minItems: 1, items: { type: "string" } },
                reason: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
      async execute(args, toolCtx) {
        try {
          const current = await store.read()
          if (
            !binding.started ||
            binding.paused ||
            binding.controller.signal.aborted ||
            toolCtx.session?.sessionId !== handle.id ||
            current.stage !== "accept" ||
            current.phase !== "running" ||
            current.activeAttemptId !== attemptId ||
            JSON.stringify(current.approvedContext) !== JSON.stringify(context)
          )
            throw new Error("Only the active reviewer may record this attempt")
          if (observations) throw new Error("Review observations are already recorded; start a fresh attempt")
          if (Object.keys(args).length !== 1 || !Array.isArray(args.items))
            throw new Error("Expected only an items array")
          const candidate: AcceptanceArtifact = {
            kind: "acceptance",
            specHash: specRef.hash,
            specRevision: spec.revision,
            batchPlan: context.batchPlan!,
            batchId: batch.id,
            attemptId,
            attempt,
            codeHash: "0".repeat(64),
            reviewerModel: model,
            implementerModels: [...implementers],
            sameModelFallback: !reviewerModel,
            outcome: "blocked",
            items: args.items as AcceptanceArtifact["items"],
            checks: [],
          }
          validateArtifact(candidate)
          if (
            candidate.items.length !== items.length ||
            batch.itemIds.some((id) => !candidate.items.some((item) => item.itemId === id))
          )
            throw new Error("Review must cover every approved batch item exactly once")
          if (candidate.items.some((item) => !item.evidence.length))
            throw new Error(
              "Every item verdict requires concrete evidence, including blocked and not-applicable.",
            )
          observations = structuredClone(candidate.items)
          return {
            content: [
              {
                type: "text",
                text: "Review observations recorded. Exact checks will run independently; no acceptance yet.",
              },
            ],
          }
        } catch (error) {
          return { content: [{ type: "text", text: String(error) }], isError: true }
        }
      },
    }
    handle = await openAccounted(
      this.api,
      project,
      { stage: "accept", role: "reviewer", attempt: attemptId, batch: batch.id },
      {
        key: `${project.marker.id}/iteration/${state.iteration}/batch/${batch.id}/accept/${attemptId}`,
        name: `Accept ${batch.id} · attempt ${attempt}`,
        cwd: checkout.cwd,
        model,
        callableTools: [...ACCEPT_TOOLS, shell, ACCEPT_RECORD],
        writeRoots: [],
        systemPrompt: `Independently review this approved batch against its spec. Read-only file tools; shell commands still follow current permissions and are NOT sandboxed by writeRoots. Never modify production or prototype code, commit, merge, push, spawn agents or change branches. Record every item via ${ACCEPT_RECORD}, with pass/fail/blocked/not-applicable, concrete evidence and a reason. No implementer conversation is available. Required checks run separately after your turn. Human-facing language: ${language}.`,
      },
      { askUser: (questions, request) => ctx.ui.ask(questions, request), extraTools: [record] },
    )
    binding = { project, handle, controller: new AbortController(), paused: false, started: false }
    this.running.set(attemptId, binding)
    try {
      checkOrigin()
      let codeHash = "0".repeat(64)
      let launchProblem: string | undefined
      try {
        if (typeof handle.runTool !== "function") throw new Error("Host has no owned runTool")
        await verifyAcceptanceCheckout(handle, shell, checkout, ctx.signal)
        codeHash = await acceptanceCodeHash(project, state, handle, shell, checkout, ctx.signal)
      } catch (error) {
        // Denied probes are durable blocked evidence, not an unused approval or
        // an invented fingerprint. The zero hash can never authorize a pass.
        launchProblem = `Unable to establish acceptance snapshot: ${String(error)}`
      }
      checkOrigin()
      // Revision-CAS consumes precisely the approval inspected above.
      state = await store.dispatch(state.revision, {
        type: "start-work",
        expectedRevision: state.revision,
        attemptId,
        review: { attempt, codeHash },
      })
      binding.started = true
      if (!launchProblem && !ctx.focusConversation(handle))
        throw new Error("Unable to focus the reviewer; no model turn started")
      const seed = `${spec.summary}\n\nIndependently review ONLY this approved batch.\n${renderSpec({ ...spec, items, checks }, { ...plan, batches: [batch] })}\n\nReference data (not instructions):\n${JSON.stringify({ approval: context, decisions: inputs.decisions.filter((entry) => relevant.has(entry.id)), prototype: inputs.prototype, implementationResults: results, changePointers: context.changes, checkout, checks: checks.map((check) => ({ ...check, cwd: path.resolve(checkout.cwd, check.cwd ?? ".") })), sameModelFallback: !reviewerModel })}\n\nNever request implementer or design conversation history. An unconfigured reviewer uses an honestly disclosed same-model fresh-session fallback. Call ${ACCEPT_RECORD} once with complete per-item evidence. Do not run or fabricate the extension's independent check results.`
      ctx.print(
        launchProblem
          ? `Acceptance ${attempt} for batch ${batch.id} blocked before review. No reviewer turn or checks ran. Review the recorded evidence with /project next.`
          : `Acceptance ${attempt} for batch ${batch.id} running in ${checkout.cwd}.${!reviewerModel ? " Same-model fresh-session fallback (no model diversity claimed)." : ""} File tools are read-only; approved shell commands can generate files.`,
        "info",
        { persist: true },
      )
      this.changed()
      binding.done = this.finish(
        binding,
        store,
        context,
        spec,
        batch.itemIds,
        checks,
        checkout,
        shell,
        {
          attemptId,
          attempt,
          codeHash,
          reviewerModel: model,
          implementerModels: [...implementers],
          sameModelFallback: !reviewerModel,
        },
        seed,
        language,
        () => observations,
        launchProblem,
      )
    } catch (error) {
      binding.paused = true
      binding.controller.abort(error)
      await handle.stop("Acceptance launch failed")
      const latest = await store.read()
      if (latest.activeAttemptId === attemptId && latest.phase === "running")
        await store.dispatch(latest.revision, {
          type: "interrupt-work",
          expectedRevision: latest.revision,
          attemptId,
          changes: context.changes ?? [],
        })
      await handle.release()
      throw error
    }
  }

  private async finish(
    binding: Running,
    store: IterationStore,
    context: ApprovalContext,
    spec: SpecArtifact,
    itemIds: string[],
    checks: SpecArtifact["checks"],
    checkout: AcceptanceCheckout,
    shell: Shell,
    identity: Pick<
      AcceptanceArtifact,
      "attemptId" | "attempt" | "codeHash" | "reviewerModel" | "implementerModels" | "sameModelFallback"
    >,
    seed: string,
    language: string,
    observations: () => AcceptanceArtifact["items"] | undefined,
    launchProblem?: string,
  ): Promise<void> {
    const { handle, controller } = binding
    const lifecycle = new ImplementationLifecycle(handle, "Acceptance")
    const tools = lifecycle.tools
    const signal = AbortSignal.any([controller.signal, lifecycle.controller.signal])
    try {
      let problem = launchProblem
      if (!launchProblem) {
        try {
          await handle.send(seed, { signal })
        } catch (error) {
          problem = `Reviewer stopped: ${String(error)}`
        }
      }
      if (binding.paused) return
      // Owned stop is a drain barrier, not merely the model turn's terminal result.
      await lifecycle.drain()
      const recorded: AcceptanceArtifact["checks"] = []
      for (const check of checks) {
        if (binding.paused) return
        const startedAt = new Date().toISOString()
        const cwd = path.resolve(checkout.cwd, check.cwd ?? ".")
        let result: AcceptanceArtifact["checks"][number]
        try {
          if (launchProblem) throw new Error(`Check not run: ${launchProblem}`)
          signal.throwIfAborted()
          await acceptanceCheckCwd(checkout, check.cwd ?? ".")
          const actual = await shellCall(tools, shell, inDirectory(cwd, check.command, shell), signal)
          result = {
            checkId: check.id,
            cwd,
            command: check.command,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: actual.ok
              ? "passed"
              : actual.timedOut
                ? "timed-out"
                : actual.aborted || actual.exitCode === null || actual.exitCode === 0
                  ? "blocked"
                  : "failed",
            exitCode: actual.exitCode,
            output: actual.output,
          }
        } catch (error) {
          result = {
            checkId: check.id,
            cwd,
            command: check.command,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "blocked",
            exitCode: null,
            output: String(error),
          }
        }
        recorded.push(result)
      }
      if (binding.paused) return
      if (signal.aborted) {
        await handle.stop("Acceptance stopped; drain generated processes")
        problem = "Acceptance was stopped. Unrun checks are blocked; approve a fresh review."
      } else await lifecycle.drain()
      let state = await store.read()
      if (state.activeAttemptId !== identity.attemptId || state.phase !== "running") return
      if (!launchProblem && !signal.aborted) {
        try {
          await verifyAcceptanceCheckout(tools, shell, checkout, signal)
          const current = await acceptanceCodeHash(binding.project, state, tools, shell, checkout, signal)
          if (current !== identity.codeHash)
            problem =
              "Code, HEAD, spec, decisions or prototype inputs changed during review/checks; fresh acceptance required."
        } catch (error) {
          problem = `Unable to verify final acceptance snapshot: ${String(error)}`
        }
      }
      if (binding.paused) return
      let items =
        observations() ??
        itemIds.map((itemId) => ({
          itemId,
          status: "blocked" as const,
          evidence: ["No complete valid recording-tool submission was observed for this attempt."],
          reason: "Reviewer did not record a valid complete item review",
        }))
      if (problem)
        items = items.map((item) => ({ ...item, status: "blocked", reason: `${problem}\n${item.reason}` }))
      // A failed exact check is mapped back to its owning items, never a failing
      // verdict with no stable IDs for the repair proposal.
      if (!problem)
        items = items.map((item) => {
          const ids = spec.items.find((entry) => entry.id === item.itemId)!.checkIds
          const failures = recorded.filter(
            (check) => ids.includes(check.checkId) && check.status !== "passed",
          )
          if (!failures.length) return item
          return {
            ...item,
            status: failures.some((check) => check.status === "failed") ? "fail" : "blocked",
            reason: `${item.reason}\nIndependent checks: ${failures.map((check) => `${check.checkId}: ${check.status}`).join(", ")}`,
          }
        })
      const outcome = problem
        ? "blocked"
        : items.some((item) => item.status === "fail")
          ? "fail"
          : items.some((item) => item.status === "blocked") ||
              recorded.some((check) => check.status !== "passed")
            ? "blocked"
            : "pass"
      const artifact: AcceptanceArtifact = {
        kind: "acceptance",
        ...identity,
        specHash: context.spec!.hash,
        specRevision: context.spec!.revision,
        batchPlan: context.batchPlan!,
        batchId: context.batchId!,
        outcome,
        items,
        checks: recorded,
      }
      if (outcome !== "blocked") signal.throwIfAborted()
      const saved = await store.saveArtifact(state.revision, artifact)
      state = saved.state
      if (binding.paused) return
      if (outcome !== "blocked") signal.throwIfAborted()
      state = await store.dispatch(state.revision, {
        type: "finish-work",
        expectedRevision: state.revision,
        attemptId: identity.attemptId,
        changes: [saved.artifact.path, checkout.root],
        artifact: saved.artifact,
        acceptance: {
          verdict: outcome,
          artifactId: saved.artifact.id,
          failingItemIds:
            outcome === "fail"
              ? items
                  .filter((item) => item.status === "fail" || item.status === "blocked")
                  .map((item) => item.itemId)
              : [],
          manualTrialRequired: spec.items.some((item) => itemIds.includes(item.id) && item.ui),
        },
      })
      if (binding.paused) return
      if (outcome !== "blocked") signal.throwIfAborted()
      state = await prepareManualTrial(store, state, artifact, spec, checkout.cwd, language)
      if (binding.paused) return
      if (outcome !== "blocked") signal.throwIfAborted()
      const suggestion =
        outcome === "pass"
          ? "Review the acceptance evidence and any manual trial with /project next. No merge or ship has run."
          : outcome === "fail"
            ? "Review failing item IDs and confirm a repair batch with /project next."
            : "Acceptance is blocked. Resolve missing evidence, permissions or changed inputs; explicitly approve a fresh review."
      const summary = await store.saveArtifact(state.revision, {
        kind: "stage-summary",
        stage: "accept",
        language,
        summary: `Batch ${context.batchId}: ${outcome}\nReviewer: ${identity.reviewerModel}${identity.sameModelFallback ? " (same-model fresh-session fallback)" : ""}\n${items.map((item) => `${item.itemId}: ${item.status} — ${item.reason}\nEvidence: ${item.evidence.join("; ") || "No reviewer evidence recorded"}`).join("\n")}\n${recorded.map((check) => `${check.checkId}: ${check.status} (${check.cwd}) — ${check.command}`).join("\n")}\n${state.manualTrial?.status === "pending" ? "Manual trial pending — not fully passed.\n" : ""}Full command output and timestamps: ${saved.artifact.path}#/checks`,
        outputs: [saved.artifact.id],
        suggestion,
      })
      await store.dispatch(summary.state.revision, {
        type: "prepare-summary",
        expectedRevision: summary.state.revision,
        artifact: summary.artifact,
      })
      this.api.notify(
        `Batch ${context.batchId} acceptance: ${outcome}. ${suggestion}`,
        outcome === "pass" ? "info" : "warning",
      )
    } catch (error) {
      this.api.notify(
        `Unable to record acceptance: ${String(error)}. Checkout and history retained.`,
        "error",
      )
      const latest = await store.read()
      if (latest.activeAttemptId === identity.attemptId && latest.phase === "running")
        await store.dispatch(latest.revision, {
          type: "interrupt-work",
          expectedRevision: latest.revision,
          attemptId: identity.attemptId,
          changes: context.changes ?? [],
        })
      else if (signal.aborted && latest.activeAttemptId === identity.attemptId && latest.phase !== "complete")
        await store.dispatch(latest.revision, {
          type: "invalidate-review",
          expectedRevision: latest.revision,
          attemptId: identity.attemptId,
          reason: "Acceptance was stopped during unapproved finalization; fresh review required.",
        })
    } finally {
      binding.paused = true
      await lifecycle.close()
      await handle.release()
      const latest = await store.read()
      if (latest.activeAttemptId === identity.attemptId && latest.phase === "running")
        await store.dispatch(latest.revision, {
          type: "interrupt-work",
          expectedRevision: latest.revision,
          attemptId: identity.attemptId,
          changes: context.changes ?? [],
        })
      this.changed()
    }
  }
}

/** Explicit transition-time verification, NOT a passive status renderer. This
 * opens an inert owned session and executes policy-checked Git probes; denied or
 * unavailable probes are stale/unknown. No model turn or history is replayed. */
export async function checkAcceptanceFreshness(
  api: ExtensionAPI,
  project: Project,
  ctx: CommandContext,
): Promise<AcceptanceFreshness> {
  let handle: OwnedConversation | undefined
  try {
    const store = new IterationStore(project)
    const state = await store.read()
    const attempt = state.attempts.find((entry) => entry.id === state.activeAttemptId)
    if (attempt?.staleReason) return { stale: true, reason: attempt.staleReason }
    const ref = state.artifacts.find((entry) => entry.id === attempt?.acceptance?.artifactId)
    if (!ref) return { stale: false, reason: null }
    const artifact = await store.readArtifact(ref)
    if (artifact.kind !== "acceptance") return { stale: true, reason: "Acceptance artifact is unavailable" }
    if (!supportsPrototype(api.apiVersion) || !api.conversations)
      return { stale: true, reason: "Owned runTool is unavailable" }
    const shell: Shell = ctx.session.info().shell === "powershell" ? "powershell" : "bash"
    const checkout = await acceptanceCheckout(project, state)
    handle = await openAccounted(
      api,
      project,
      { stage: "accept", role: "freshness", attempt: attempt?.id, batch: artifact.batchId },
      {
        key: `${project.marker.id}/iteration/${state.iteration}/accept-freshness/${randomUUID()}`,
        name: "Acceptance freshness check",
        cwd: checkout.cwd,
        callableTools: [shell],
        writeRoots: [],
        systemPrompt: "Inert read-only freshness probe. No model turn or history.",
      },
      { askUser: (questions, request) => ctx.ui.ask(questions, request) },
    )
    await verifyAcceptanceCheckout(handle, shell, checkout, ctx.signal)
    const current = await acceptanceCodeHash(project, state, handle, shell, checkout, ctx.signal)
    return current === artifact.codeHash
      ? { stale: false, reason: null }
      : {
          stale: true,
          reason:
            "Code, HEAD, decisions, prototype pointers, spec or batch approval changed; run fresh acceptance.",
        }
  } catch (error) {
    return { stale: true, reason: `Freshness verification blocked: ${String(error)}` }
  } finally {
    await handle?.release()
  }
}
