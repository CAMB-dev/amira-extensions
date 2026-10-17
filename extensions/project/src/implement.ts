import { randomUUID } from "node:crypto"
import type {
  CommandContext,
  ExtensionAPI,
  OwnedConversation,
  SubagentResult,
  ToolDefinition,
} from "@amira/api"
import type { BatchPlanArtifact, BatchResultArtifact, SpecArtifact, WorktreeArtifact } from "./artifacts.ts"
import { BoundRunError, boundRunner, runBound } from "./execution-modes.ts"
import { ImplementationLifecycle } from "./implementation-lifecycle.ts"
import {
  checkCwd,
  checked,
  inDirectory,
  prepareWorktree,
  quote,
  type Shell,
  shellCall,
  snapshot,
  verifiedCheckCwd,
  verifyWorktree,
} from "./iteration-git.ts"
import { localize } from "./language.ts"
import { supportsPrototype } from "./prototype-sessions.ts"
import { validateAskQuestions } from "./questions.ts"
import { renderSpec, specInputs } from "./spec.ts"
import { requiredChecks } from "./spec-integrity.ts"
import { type ApprovalContext, batchProgress, type IterationState, reduceStage } from "./stage.ts"
import { IterationStore, type Project } from "./store.ts"

export const IMPLEMENT_TOOLS = [
  "read",
  "grep",
  "glob",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "powershell",
  "ask_user",
]
// Private tools supplied by swarm to its members still pass through the inherited
// host callable-tool ceiling. These are names, not provider implementation imports.
export const SWARM_COORDINATION_TOOLS = [
  "send_message",
  "list_agents",
  "blackboard_read",
  "blackboard_write",
  "finish",
]
export const IMPLEMENT_SPAWN = "project_implement"
interface Running {
  project: Project
  handle: OwnedConversation
  paused: boolean
  childIds: Set<string>
  lifecycle?: ImplementationLifecycle
  done?: Promise<void>
  progress?: string
  execution?: BatchResultArtifact["execution"]
}
export function implementationStatus(state: IterationState): string {
  const spec = state.artifacts.findLast((entry) => entry.kind === "spec")
  const worktree = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
  const progress = batchProgress(state)
  const batch = progress.manifest
    ? ` · batch ${state.approvedContext?.batchId ?? "—"} · resolved ${progress.resolutions.length}/${progress.manifest.batchIds.length + (progress.manifest.carriedResolutions?.length ?? 0)}`
    : ""
  return `Spec: ${spec ? (state.approvedContext?.spec?.artifactId === spec.id ? "approved" : "review required") : "not generated"}${spec ? ` (${spec.hash.slice(0, 12)})` : ""}${batch}${state.approvedContext?.mode ? ` · mode ${state.approvedContext.mode}` : ""}${worktree ? ` · worktree recorded` : ""}`
}

export class Implementations {
  private readonly running = new Map<string, Running>()
  constructor(
    private readonly api: ExtensionAPI,
    private readonly changed: () => void = () => {},
  ) {
    const allowed = async (sessionId: string) => {
      const entry = [...this.running.entries()].find(
        ([, binding]) => binding.handle.id === sessionId || binding.childIds.has(sessionId),
      )
      if (!entry) return { action: "pass" as const }
      const [attemptId, binding] = entry
      const state = await new IterationStore(binding.project).read()
      return !binding.paused &&
        !binding.lifecycle?.controller.signal.aborted &&
        state.activeAttemptId === attemptId &&
        state.phase === "running"
        ? { action: "pass" as const }
        : {
            action: "block" as const,
            reason:
              "Implementation is paused or finished. F6 returns to main; review /project next before further work.",
          }
    }
    api.intercept?.("context.build", (_value, context) => allowed(context.sessionId))
    api.intercept?.("tool.call.before", (_value, context) => allowed(context.sessionId))
  }
  progress(project: Project): string | undefined {
    return [...this.running.values()].find(
      (binding) =>
        binding.project.marker.id === project.marker.id &&
        binding.project.marker.currentIteration === project.marker.currentIteration &&
        !binding.paused,
    )?.progress
  }
  async quiesce(project: Project): Promise<void> {
    const bindings = [...this.running.values()].filter(
      (binding) =>
        binding.project.marker.id === project.marker.id &&
        binding.project.marker.currentIteration === project.marker.currentIteration,
    )
    for (const binding of bindings) {
      binding.paused = true
      binding.lifecycle?.cancel("Project stage change")
    }
    await Promise.all(
      bindings.map(async (binding) => {
        await binding.handle.stop("Project stage change; preserve worktree changes")
        await binding.done
      }),
    )
  }
  async run(project: Project, ctx: CommandContext, language: string, checkOrigin: () => void): Promise<void> {
    if (!supportsPrototype(this.api.apiVersion) || !this.api.conversations || !ctx.focusConversation)
      throw new Error(
        "Implementation requires Amira API 0.1.53, owned runTool, inherited descendants and native focus.",
      )
    const store = new IterationStore(project)
    let state = await store.read()
    const live = this.running.get(state.activeAttemptId ?? "")
    if (live && !live.paused) {
      if (!ctx.focusConversation(live.handle)) throw new Error("Unable to focus the running coordinator")
      return
    }
    if (
      state.stage !== "implement" ||
      state.phase !== "confirmed" ||
      state.status !== "idle" ||
      state.pending ||
      state.revisit ||
      !state.approvedContext?.mode
    )
      throw new Error(
        "Review /project spec and approve the exact spec, mode and batch first. Interrupted/restarted work is never replayed; /project next offers explicit continuation.",
      )
    const context = structuredClone(state.approvedContext)
    if (context.mode !== "single") {
      try {
        boundRunner(this.api, context.mode!)
      } catch (cause) {
        const reason = `${String(cause)}. No mode or cwd was changed. Single-agent fallback is available: use /project mode, choose Single agent and approve the mode-only replacement before /project implement. Completed batches and the selected unresolved batch are retained; no spec regeneration.`
        await store.saveArtifact(state.revision, {
          kind: "stage-summary",
          stage: "implement",
          language,
          summary: `Approved ${context.mode} execution blocked: ${reason}`,
          outputs: [],
          suggestion: "Review and approve single-agent fallback, or restore the approved provider.",
        })
        this.changed()
        throw new Error(reason)
      }
    }
    const attemptId = randomUUID()
    // Prove all store/reducer launch gates before any Git mutation.
    reduceStage(state, { type: "start-work", expectedRevision: state.revision, attemptId })
    const specRef = state.artifacts.find((entry) => entry.id === context.spec?.artifactId)!
    if (state.artifacts.findLast((entry) => entry.kind === "spec")?.id !== specRef.id)
      throw new Error("A newer spec draft requires fresh review and approval before implementation.")
    const planRef = state.artifacts.find((entry) => entry.id === context.batchPlan?.artifactId)!
    const spec = (await store.readArtifact(specRef)) as SpecArtifact
    const plan = (await store.readArtifact(planRef)) as BatchPlanArtifact
    const batch = plan.batches.find((entry) => entry.id === context.batchId)!
    // Old schemas stay readable, but an old approval cannot authorize incomplete checks.
    const checks = requiredChecks(spec, batch.itemIds)
    await store.assertCurrentSpecDecisions(spec)
    const shell: Shell = ctx.session.info().shell === "powershell" ? "powershell" : "bash"
    const runtime = {
      askUser: async (
        questions: import("@amira/api").AskQuestion[],
        request: { sessionId: string; signal: AbortSignal },
      ) => {
        validateAskQuestions(questions)
        return ctx.ui.ask(questions, request)
      },
    }
    const setup = await this.api.conversations.openOrCreate(
      {
        key: `${project.marker.id}/iteration/${state.iteration}/setup/${randomUUID()}`,
        name: `Iteration ${state.iteration} Git setup`,
        cwd: project.root,
        systemPrompt:
          "Git setup coordinator. No implementation or merge. Commands run only by the extension through policy-checked tools.",
        callableTools: [shell],
        writeRoots: [],
      },
      runtime,
    )
    let worktree: WorktreeArtifact
    try {
      if (typeof setup.runTool !== "function")
        throw new Error("Host has no owned runTool; no Git command was started")
      worktree = await prepareWorktree(project, setup, shell, ctx, checkOrigin)
    } finally {
      await setup.release()
    }
    checkOrigin()
    state = await store.read()
    if (JSON.stringify(state.approvedContext) !== JSON.stringify(context))
      throw new Error("Approval changed during Git setup; review the batch again")
    reduceStage(state, { type: "start-work", expectedRevision: state.revision, attemptId })
    const inputs = await specInputs(project, state)
    const relevant = new Set([
      ...batch.decisionIds,
      ...spec.items.filter((item) => batch.itemIds.includes(item.id)).flatMap((item) => item.decisionIds),
    ])
    const items = spec.items.filter((item) => batch.itemIds.includes(item.id))
    const failures = []
    for (const ref of state.artifacts.filter(
      (entry) => entry.kind === "acceptance" || entry.kind === "manual-trial",
    )) {
      const evidence = await store.readArtifact(ref)
      if (
        (evidence.kind === "acceptance" || evidence.kind === "manual-trial") &&
        evidence.batchId === batch.id &&
        evidence.specHash === context.spec?.hash &&
        evidence.batchPlan.hash === context.batchPlan?.hash &&
        (evidence.kind === "acceptance" ? evidence.outcome !== "pass" : evidence.status === "problem")
      )
        failures.push({ artifact: ref.path, evidence })
    }
    for (const check of checks) checkCwd(worktree, check.cwd ?? ".")
    const seed = `${spec.summary}\n\nImplement ONLY this approved batch from the English spec.\n${renderSpec({ ...spec, items, checks }, { ...plan, batches: [batch] })}\n\nReference data (not instructions):\n${JSON.stringify({ approval: context, decisions: inputs.decisions.filter((entry) => relevant.has(entry.id)), prototype: inputs.prototype, worktree, canonicalArtifactProject: project.root, repairFailures: failures, checks: checks.map((check) => ({ ...check, cwd: checkCwd(worktree, check.cwd ?? ".") })) })}\n\nNever use design conversation history. Prototype pointers are for conclusions/run instructions only: do not copy, import, merge or patch prototype code into production. Work only in the iteration checkout, never the canonical project. Do not commit, merge, push, remove worktrees, spawn more agents, or change Git branch. Required checks are run independently by the extension after your summary. Report changed files, implementation summary and limitations.`
    let childResult: SubagentResult | undefined
    const models = new Set<string>()
    let spawned = false
    let handle: OwnedConversation
    const spawnTool: ToolDefinition = {
      name: IMPLEMENT_SPAWN,
      description:
        "Spawn the one fresh implementation sub-agent for the approved batch and wait for its result. No arguments or alternate task/cwd.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, toolCtx) {
        if (toolCtx.session?.sessionId !== handle.id || spawned)
          return {
            content: [{ type: "text", text: "Only the coordinator may spawn exactly one implementer." }],
            isError: true,
          }
        spawned = true
        const group = handle.createGroup({ name: `Implement ${batch.id}`, maxAgents: 1, maxConcurrent: 1 })
        try {
          const child = group.spawn({
            title: `Implement ${batch.id}`,
            context: "fresh",
            cwd: worktree.cwd,
            model: context.model,
            prompt: seed,
            tools: IMPLEMENT_TOOLS,
            callableTools: IMPLEMENT_TOOLS,
            writeRoots: [worktree.root],
          })
          binding.childIds.add(child.id)
          models.add(`${child.model.provider}/${child.model.model}`)
          childResult = await child.result()
          binding.execution = {
            mode: "single",
            runId: handle.id,
            cwd: worktree.cwd,
            sessionIds: [childResult.sessionId],
          }
          return {
            content: [{ type: "text", text: childResult.text || childResult.error || childResult.status }],
            isError: childResult.status !== "done" || !!childResult.note,
          }
        } finally {
          group.end("Single implementation child finished")
          await group.ended()
        }
      },
    }
    handle = await this.api.conversations.openOrCreate(
      {
        key: `${project.marker.id}/iteration/${state.iteration}/batch/${batch.id}/implement/${attemptId}`,
        name: `Implement ${batch.id}`,
        cwd: worktree.cwd,
        model: context.model,
        descendants: "inherit",
        writeRoots: [worktree.root],
        callableTools: [
          ...IMPLEMENT_TOOLS,
          IMPLEMENT_SPAWN,
          ...(context.mode === "swarm" ? SWARM_COORDINATION_TOOLS : []),
        ],
        systemPrompt:
          context.mode !== "single"
            ? `You own the approved ${context.mode} batch. The extension starts its provider through your bound groups. Do not launch tools or implement independently. Human-facing language: ${language}.`
            : `You coordinate exactly one implementation child. Call ${IMPLEMENT_SPAWN} once with {}. It receives the approved task from the extension. Do not implement instead of the child. Do not merge, commit, push, remove worktrees or run acceptance. After the tool returns, summarize its result. Human-facing language: ${language}.`,
      },
      { ...runtime, extraTools: [spawnTool] },
    )
    if (typeof handle.runTool !== "function") {
      await handle.release()
      throw new Error("Host has no owned runTool")
    }
    const binding: Running = { project, handle, paused: false, childIds: new Set() }
    try {
      await verifyWorktree(handle, shell, worktree, ctx.signal)
      const base = await snapshot(handle, shell, worktree, ctx.signal)
      state = await store.dispatch(state.revision, {
        type: "start-work",
        expectedRevision: state.revision,
        attemptId,
      })
      this.running.set(attemptId, binding)
      if (!ctx.focusConversation(handle))
        throw new Error("Unable to focus implementation coordinator; no model turn started")
      ctx.print(
        localize(
          language,
          `Batch ${batch.id} running in ${worktree.cwd}. F6 returns to main. Acceptance: /project next, then /project accept.`,
          `批次 ${batch.id} 正在 ${worktree.cwd} 运行。F6 返回主会话。验收：/project next 确认后用 /project accept。`,
          `バッチ ${batch.id} を ${worktree.cwd} で実行中。F6 でメインに戻ります。受け入れ確認は /project next で承認後 /project accept。`,
        ),
        "info",
        { persist: true },
      )
      this.changed()
      // Lifetime belongs to the owner, not the originating command/session's signal.
      binding.done = this.finish(
        binding,
        store,
        context,
        attemptId,
        worktree,
        shell,
        base,
        checks,
        language,
        () => childResult,
        models,
        seed,
        items,
      )
    } catch (error) {
      await handle.stop("Implementation launch failed")
      binding.paused = true
      const latest = await store.read()
      if (latest.activeAttemptId === attemptId && latest.phase === "running")
        await store.dispatch(latest.revision, {
          type: "interrupt-work",
          expectedRevision: latest.revision,
          attemptId,
          changes: [worktree.root],
        })
      await handle.release()
      this.running.delete(attemptId)
      throw error
    }
  }

  private async finish(
    binding: Running,
    store: IterationStore,
    context: ApprovalContext,
    attemptId: string,
    worktree: WorktreeArtifact,
    shell: Shell,
    base: string,
    checks: SpecArtifact["checks"],
    language: string,
    child: () => SubagentResult | undefined,
    models: Set<string>,
    seed: string,
    items: SpecArtifact["items"],
  ): Promise<void> {
    const { handle } = binding
    const lifecycle = new ImplementationLifecycle(handle)
    binding.lifecycle = lifecycle
    const tools = lifecycle.tools
    try {
      const results: BatchResultArtifact["checks"] = []
      let error: string | undefined
      let providerText: string | undefined
      let end = base
      let diffStat = ""
      let changedFiles: string[] = []
      let advisory = "Advisory: prototype-directory reference scan unavailable; inspect changes manually."
      try {
        if (context.mode === "single") {
          await handle.send(
            `Start approved batch ${context.batchId}. Call ${IMPLEMENT_SPAWN} now.\nWorktree: ${worktree.cwd}`,
            { signal: lifecycle.controller.signal },
          )
          const outcome = child()
          if (outcome?.status !== "done" || outcome.note)
            throw new Error(outcome?.error || "The coordinator did not complete its one implementation child")
        } else {
          const outcome = await runBound({
            api: this.api,
            mode: context.mode!,
            handle,
            signal: lifecycle.controller.signal,
            cwd: worktree.cwd,
            model: context.model,
            batchId: context.batchId!,
            seed,
            items,
            onProgress: (progress) => {
              for (const model of progress.models) models.add(model)
              for (const child of progress.children)
                if (child.sessionId) binding.childIds.add(child.sessionId)
              binding.execution = {
                mode: context.mode!,
                runId: progress.runId,
                ...(progress.cwd ? { cwd: progress.cwd } : {}),
                sessionIds: [...binding.childIds],
                ...(progress.groupId ? { groupId: progress.groupId } : {}),
              }
              binding.progress = `${context.mode} · ${progress.phase} · children ${progress.children.map((child) => `${child.label}: ${child.state}`).join(", ") || "pending"} · models ${[...models].join(", ") || "pending"}`
              // Live progress is not a stage mutation. Refreshing durable evidence
              // on every provider update can starve the fail-closed tool interceptors.
              this.api.requestRender?.()
            },
          })
          for (const model of outcome.models) models.add(model)
          binding.execution = {
            mode: context.mode!,
            runId: outcome.runId,
            cwd: outcome.cwd,
            sessionIds: outcome.sessionIds,
            ...(outcome.groupId ? { groupId: outcome.groupId } : {}),
          }
          providerText = outcome.text
        }
        if (binding.paused) return
        lifecycle.check()
        // Drain descendants before independent exact checks and snapshotting.
        await lifecycle.drain()
        await verifyWorktree(tools, shell, worktree)
        for (const check of checks) {
          if (binding.paused) return
          lifecycle.check()
          const cwd = checkCwd(worktree, check.cwd ?? ".")
          const startedAt = new Date().toISOString()
          let result: Awaited<ReturnType<typeof shellCall>>
          try {
            await verifiedCheckCwd(worktree, check.cwd ?? ".")
            result = await shellCall(tools, shell, inDirectory(cwd, check.command, shell))
          } catch (cause) {
            result = {
              output: String(cause),
              exitCode: null,
              ok: false,
              timedOut: false,
              aborted: lifecycle.controller.signal.aborted,
            }
          }
          results.push({
            checkId: check.id,
            cwd,
            command: check.command,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: result.ok
              ? "passed"
              : result.timedOut
                ? "timed-out"
                : result.aborted || result.exitCode === null
                  ? "blocked"
                  : "failed",
            exitCode: result.exitCode,
            output: result.output,
          })
          lifecycle.check()
        }
        await verifyWorktree(tools, shell, worktree)
        end = await snapshot(tools, shell, worktree)
        const patch = await checked(
          tools,
          shell,
          worktree.root,
          `git diff --no-ext-diff --no-textconv --unified=0 ${quote(base, shell)} ${quote(end, shell)}`,
        )
        const matches = patch
          .split("\n")
          .filter(
            (line) =>
              line.startsWith("+") &&
              !line.startsWith("+++") &&
              /[.]amira[/\\]project[/\\]prototypes/i.test(line),
          )
        advisory = `Advisory: references to the prototype directory in added diff lines\n${matches.join("\n") || "No literal references found in added lines."}\nComments and strings may match; inspect imports/build inputs and copied code manually. This is not semantic proof and never blocks implementation or acceptance.`
        const names = await shellCall(
          tools,
          shell,
          inDirectory(
            worktree.root,
            `git diff --name-only -z ${quote(base, shell)} ${quote(end, shell)}`,
            shell,
          ),
        )
        if (!names.ok) throw new Error(`Unable to record changed files: ${names.output}`)
        if (names.output && !names.output.endsWith("\0"))
          throw new Error("Incomplete Git changed-file list; no partial list was recorded")
        changedFiles = names.output.split("\0").filter(Boolean)
        diffStat = await checked(
          tools,
          shell,
          worktree.root,
          `git diff --stat ${quote(base, shell)} ${quote(end, shell)}`,
        )
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        if (context.mode !== "single") {
          if (cause instanceof BoundRunError) {
            for (const model of cause.models) models.add(model)
            if (cause.runId)
              binding.execution = {
                mode: context.mode!,
                runId: cause.runId,
                ...(cause.cwd ? { cwd: cause.cwd } : {}),
                sessionIds: cause.sessionIds,
                ...(cause.groupId ? { groupId: cause.groupId } : {}),
              }
          }
          error +=
            ". No mode or cwd was changed. Single-agent fallback requires fresh approval: /project next to review continuation, then /project mode and choose Single agent. Completed batches and the selected unresolved batch are retained; no spec regeneration."
          lifecycle.cancel(error)
          await handle.stop("Provider execution stopped; retain iteration changes")
        }
      }
      if (binding.paused) return
      // Cancellation does not turn an unrun command into success or omit an approved
      // check from the durable result. Explicit blocked records distinguish not-run.
      if (error)
        for (const check of checks) {
          if (!results.some((entry) => entry.checkId === check.id)) {
            const now = new Date().toISOString()
            results.push({
              checkId: check.id,
              cwd: checkCwd(worktree, check.cwd ?? "."),
              command: check.command,
              startedAt: now,
              finishedAt: now,
              status: "blocked",
              exitCode: null,
              output: `Not run because implementation was interrupted: ${error}`,
            })
          }
        }
      try {
        let state = await store.read()
        if (state.activeAttemptId !== attemptId || state.phase !== "running") return
        if (!error) lifecycle.check()
        const result = await store.saveArtifact(state.revision, {
          kind: "batch-result",
          attemptId,
          context,
          worktree: worktree.root,
          base,
          snapshot: end,
          diffStat,
          changedFiles,
          summary: `${providerText || child()?.text || "Implementation did not finish"}\n\n${advisory}`,
          ...(binding.execution ? { execution: binding.execution } : {}),
          implementerModels: [...models],
          checks: results,
          ...(error ? { error } : {}),
        })
        if (!error) lifecycle.check()
        state = result.state
        if (error) {
          await store.dispatch(state.revision, {
            type: "interrupt-batch",
            expectedRevision: state.revision,
            attemptId,
            changes: [result.artifact.path, worktree.root],
          })
          this.api.notify(`Implementation stopped; changes retained in ${worktree.cwd}. ${error}`, "error")
          return
        }
        state = await store.dispatch(state.revision, {
          type: "finish-work",
          expectedRevision: state.revision,
          attemptId,
          changes: [result.artifact.path, worktree.root],
        })
        lifecycle.check()
        const summary = await store.saveArtifact(state.revision, {
          kind: "stage-summary",
          stage: "implement",
          language,
          summary: `${providerText || child()?.text || "Implementation completed"}\n\n${advisory}\n\n${diffStat || "No file changes"}\n\n${results.map((check) => `${check.checkId}: ${check.status} (${check.cwd}) — ${check.command}`).join("\n")}`,
          outputs: [result.artifact.id],
          suggestion:
            "Implementation finished. Propose acceptance with /project next. Acceptance: /project next, then /project accept; no review or merge has run.",
        })
        lifecycle.check()
        state = await store.dispatch(summary.state.revision, {
          type: "prepare-summary",
          expectedRevision: summary.state.revision,
          artifact: summary.artifact,
        })
        lifecycle.check()
        // Queued revisit takes precedence; the step-one engine prepares its correction route.
        if (!state.revisit)
          await store.dispatch(state.revision, {
            type: "propose-transition",
            expectedRevision: state.revision,
            proposal: {
              id: randomUUID(),
              from: "implement",
              to: "accept",
              kind: "advance",
              summaryId: summary.artifact.id,
              skippedStages: [],
              context: { ...context, changes: [result.artifact.path, worktree.root] },
              suggestion:
                "Review implementation summary and propose acceptance. Acceptance: /project next, then /project accept.",
            },
          })
        lifecycle.check()
        this.api.notify(
          `Batch ${context.batchId} implementation finished. Acceptance: /project next, then /project accept.`,
          "info",
        )
      } catch (cause) {
        if (lifecycle.controller.signal.aborted) {
          const latest = await store.read()
          if (
            latest.stage === "implement" &&
            latest.activeAttemptId === attemptId &&
            latest.status !== "interrupted"
          )
            await store.dispatch(latest.revision, {
              type: "interrupt-batch",
              expectedRevision: latest.revision,
              attemptId,
              changes: [worktree.root],
            })
        }
        this.api.notify(
          `Unable to record implementation result: ${String(cause)}. Worktree retained: ${worktree.cwd}`,
          "error",
        )
      } finally {
        this.changed()
      }
    } finally {
      binding.paused = true
      await lifecycle.close()
      this.changed()
    }
  }
}
