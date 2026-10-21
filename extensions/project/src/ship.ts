import { randomUUID } from "node:crypto"
import path from "node:path"
import { localize } from "./language.ts"
import type { ShipCandidate } from "./ship-git.ts"

/** Issued only by the deterministic outward adapter before handing a mutation to
 * runTool. Remote absence, tool prose and post-dispatch errors are not this proof. */
export class ShipPreflightError extends Error {
  constructor(
    readonly operation: "push" | "pr",
    cause: unknown,
  ) {
    super(`${operation} preflight failed; effect not started: ${String(cause)}`, { cause })
    this.name = "ShipPreflightError"
  }
}

export interface ShipCheck {
  id: string
  command: string
  cwd: string
}
export interface ShipCheckResult extends ShipCheck {
  phase: "source" | "integrated"
  /** Successful evidence is bound to the exact checked Git tree and approved checkout. */
  tree?: string
  checkoutRoot?: string
  output: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  ok: boolean
}
export interface ShipPreference {
  repository: string
  strategy: "local-merge" | "pr"
  target: string
  merge: "ff-only" | "merge"
}
export interface ShipOperation {
  id: string
  kind: "commit" | "merge" | "push" | "pr"
  inputs: string
  status: "requested" | "declined" | "succeeded" | "failed" | "uncertain" | "skipped"
  approval?: { sessionId: string; date: string }
  result?: string
  /** Live adapter proof: preflight failed before any outward mutation request. */
  effectNotStarted?: true
}
export interface ShipPlan {
  schemaVersion: 1
  id: string
  projectId: string
  iteration: number
  stageRevision: number
  revision: number
  approval?: { sessionId: string; date: string }
  status: "pending" | "running" | "blocked" | "awaiting-merge" | "shipped" | "skipped" | "superseded"
  outcome?: "local-only" | "pushed" | "pr-merged" | "ship-skipped"
  completion?: { sessionId: string; date: string; choice: NonNullable<ShipPlan["outcome"]> }
  preference: ShipPreference
  /** Git pins are validated by the deterministic adapter before every effect. */
  source: { root: string; branch: string; head: string; tree: string; common: string }
  target: { root: string; branch: string; head: string; common: string }
  files: string[]
  candidate?: ShipCandidate
  checks: ShipCheck[]
  /** Absolute isolated source-check root, pinned when the plan is approved. */
  checkRoot?: string
  notes: { language: string; text: string; location: string }
  evidence: string
  contentAcceptance?: "verified-before-notes" | "waived-unavailable"
  skipped: string[]
  message: string
  remote?: { name: string; url: string; branch: string }
  pr?: { repository: string; base: string; title: string; body: string; url?: string }
  commit?: string
  /** A previously created exact candidate can be rechecked without inventing another commit. */
  existingCommit?: true
  integrated?: string
  /** Adapter-probed tree of integrated; published before integrated checks. */
  integratedTree?: string
  results: ShipCheckResult[]
  operations: ShipOperation[]
  error?: string
}
export interface ShipPorts {
  /** CAS publication: durable intent precedes tools; failures stop execution. */
  save(plan: ShipPlan): Promise<void>
  confirm(title: string, exactInputs: string): Promise<boolean>
  guard(plan: ShipPlan, phase: "source" | "integrated"): Promise<void>
  check(
    check: ShipCheck,
    phase: "source" | "integrated",
  ): Promise<
    Omit<ShipCheckResult, keyof ShipCheck | "phase"> & Partial<Pick<ShipCheckResult, "cwd" | "command">>
  >
  commit(plan: ShipPlan): Promise<string>
  merge(plan: ShipPlan): Promise<string>
  push(plan: ShipPlan): Promise<string>
  createPr(plan: ShipPlan): Promise<string>
  /** Read-only reconciliation. undefined is unavailable, never evidence of failure. */
  reconcile(
    plan: ShipPlan,
    operation: ShipOperation,
  ): Promise<string | { notApplied: boolean; evidence: string } | undefined>
  mergedPr(plan: ShipPlan): Promise<string | undefined>
}
const describe = (plan: ShipPlan, kind: ShipOperation["kind"]) =>
  JSON.stringify(
    {
      candidate: plan.source,
      commit: plan.commit,
      target: plan.target,
      ...(kind === "commit"
        ? { files: plan.files, message: plan.message, checks: plan.checks, notes: plan.notes }
        : {}),
      ...(kind === "merge" ? { strategy: plan.preference.merge } : {}),
      ...(kind === "push" ? { remote: plan.remote, delivered: plan.integrated ?? plan.commit } : {}),
      ...(kind === "pr" ? { pr: plan.pr, remote: plan.remote } : {}),
    },
    null,
    2,
  )

/** Never infer a passing check from ok alone, relative cwd, or an unbound legacy receipt. */
export function shipCheckPassed(
  plan: ShipPlan,
  check: ShipCheck,
  phase: ShipCheckResult["phase"],
  result: ShipCheckResult | undefined,
): boolean {
  if (plan.candidate && plan.candidate.tree !== plan.source.tree) return false
  const root = phase === "source" ? plan.checkRoot : plan.target.root
  const tree = phase === "source" ? (plan.candidate?.tree ?? plan.source.tree) : plan.integratedTree
  if (!root || path.isAbsolute(check.cwd)) return false
  const inside = (base: string, file: string) => {
    const relative = path.relative(path.resolve(base), path.resolve(file))
    return (
      !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    )
  }
  if (!inside(root, path.resolve(root, check.cwd))) return false
  if (
    phase === "source" &&
    [plan.source.root, plan.target.root].some((userRoot) => inside(userRoot, root) || inside(root, userRoot))
  )
    return false
  return !!(
    root &&
    path.isAbsolute(root) &&
    tree &&
    /^[a-f0-9]{40,64}$/.test(tree) &&
    result &&
    result.phase === phase &&
    result.id === check.id &&
    result.command === check.command &&
    path.isAbsolute(result.cwd) &&
    path.resolve(result.cwd) === path.resolve(root, check.cwd) &&
    (result.checkoutRoot === undefined ||
      (path.isAbsolute(result.checkoutRoot) && path.resolve(result.checkoutRoot) === path.resolve(root))) &&
    result.tree === tree &&
    result.ok &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted
  )
}

export function shipChecksPassed(plan: ShipPlan, phase: ShipCheckResult["phase"]): boolean {
  return (
    plan.checks.length > 0 &&
    plan.checks.every((check) =>
      shipCheckPassed(
        plan,
        check,
        phase,
        plan.results.findLast((row) => row.id === check.id && row.phase === phase),
      ),
    )
  )
}

/** Business approvals are independent of host tool permission. Never model-send a ship command. */
export class ShipSequence {
  constructor(
    private readonly ports: ShipPorts,
    private readonly sessionId: string,
  ) {}
  private async publish(plan: ShipPlan): Promise<void> {
    plan.revision++
    await this.ports.save(structuredClone(plan))
  }
  private async operation(
    plan: ShipPlan,
    kind: ShipOperation["kind"],
    effect: () => Promise<string>,
  ): Promise<string> {
    const prior = plan.operations.find((entry) => entry.kind === kind)
    if (prior) {
      if (prior.status === "succeeded" && prior.result) return prior.result
      throw new Error(
        `${kind} has a ${prior.status} receipt. Reconcile or explicitly revise the plan; no operation was replayed.`,
      )
    }
    const inputs = describe(plan, kind)
    const approved = await this.ports.confirm(`Confirm ${kind}`, inputs)
    await this.ports.guard(plan, plan.integrated ? "integrated" : "source")
    if (describe(plan, kind) !== inputs)
      throw new Error("Ship inputs changed during confirmation; review a new plan.")
    const operation: ShipOperation = {
      id: randomUUID(),
      kind,
      inputs,
      status: approved ? "requested" : "declined",
      ...(approved ? { approval: { sessionId: this.sessionId, date: new Date().toISOString() } } : {}),
    }
    plan.operations.push(operation)
    await this.publish(plan)
    if (!approved)
      throw new Error(
        `${kind} declined. Nothing was inferred as passed; choose local-only or skip explicitly where applicable.`,
      )
    let effectReturned = false
    try {
      // Persisted requested intent is never automatically replayed after a crash.
      operation.result = await effect()
      effectReturned = true
      operation.status = "succeeded"
      await this.publish(plan)
      return operation.result
    } catch (error) {
      // Only a live adapter's pre-dispatch fence proves no outward request began.
      // All dispatched errors/timeouts and unknown errors remain uncertain.
      if (!effectReturned && error instanceof ShipPreflightError && error.operation === kind) {
        operation.status = "failed"
        operation.effectNotStarted = true
      } else operation.status = "uncertain"
      operation.result = String(error)
      await this.publish(plan)
      throw error
    }
  }
  private async checks(plan: ShipPlan, phase: "source" | "integrated"): Promise<void> {
    if (!plan.checks.length)
      throw new Error("No full checks approved. Use an explicit document-only ship skip instead.")
    for (const check of plan.checks) {
      await this.ports.guard(plan, phase)
      let result: Awaited<ReturnType<ShipPorts["check"]>>
      try {
        result = await this.ports.check(check, phase)
      } catch (error) {
        result = { ok: false, output: String(error), exitCode: null, aborted: false, timedOut: false }
      }
      const receipt = { ...check, ...result, id: check.id, phase }
      // Invalid provenance remains visible as a failed attempt, never as a passing receipt.
      receipt.ok = shipCheckPassed(plan, check, phase, receipt)
      plan.results.push(receipt)
      await this.publish(plan)
      if (!receipt.ok)
        throw new Error(
          `Full check ${check.id} stopped in ${check.cwd}. Inspect its recorded output; no later effect was started.`,
        )
    }
    await this.ports.guard(plan, phase)
  }
  async run(plan: ShipPlan): Promise<ShipPlan> {
    if (["shipped", "skipped"].includes(plan.status)) return plan
    if (plan.status === "awaiting-merge")
      throw new Error("PR is awaiting merge. Use /project ship reconcile; creating a PR is not shipping.")
    try {
      await this.ports.guard(plan, plan.integrated ? "integrated" : "source")
      plan.status = "running"
      await this.publish(plan)
      if (await this.finishPushed(plan)) return plan
      // A precommitted candidate still needs its first isolated checks, but a
      // preserved integration must reuse those exact tree-bound source receipts.
      if (!shipChecksPassed(plan, "source")) await this.checks(plan, "source")
      if (!plan.commit) {
        plan.commit = await this.operation(plan, "commit", () => this.ports.commit(plan))
        await this.publish(plan)
      }
      if (plan.preference.strategy === "pr") {
        if (!plan.remote || !plan.pr)
          throw new Error(
            "PR mode requires an exact remote and hosting repository; no defaults were guessed.",
          )
        await this.operation(plan, "push", () => this.ports.push(plan))
        plan.pr.url = await this.operation(plan, "pr", () => this.ports.createPr(plan))
        plan.status = "awaiting-merge"
        await this.publish(plan)
        return plan
      }
      if (!plan.integrated) {
        plan.integrated = await this.operation(plan, "merge", () => this.ports.merge(plan))
        await this.publish(plan)
      }
      await this.checks(plan, "integrated")
      if (plan.remote) {
        await this.operation(plan, "push", () => this.ports.push(plan))
        await this.ports.guard(plan, "integrated")
        plan.outcome = "pushed"
      } else {
        if (
          !(await this.ports.confirm(
            "Finish local-only ship",
            describe(plan, "merge") +
              "\nNo remote push or publication. Skipped external operations remain skipped.",
          ))
        )
          throw new Error("Local integration is preserved. Confirm local-only delivery explicitly to finish.")
        await this.ports.guard(plan, "integrated")
        plan.outcome = "local-only"
        if (!plan.skipped.includes("push")) plan.skipped.push("push")
      }
      plan.completion = { sessionId: this.sessionId, date: new Date().toISOString(), choice: plan.outcome! }
      plan.status = "shipped"
      delete plan.error
      await this.publish(plan)
    } catch (error) {
      plan.status = "blocked"
      plan.error = String(error)
      await this.publish(plan)
    }
    return plan
  }
  /** Complete from durable delivery evidence without replaying effects or replacing check history. */
  private async finishPushed(plan: ShipPlan): Promise<boolean> {
    const push = plan.operations.find((op) => op.kind === "push" && op.status === "succeeded")
    if (!push || plan.preference.strategy !== "local-merge") return false
    if (
      !plan.remote ||
      !plan.integrated ||
      push.result !== plan.integrated ||
      !shipChecksPassed(plan, "source") ||
      !shipChecksPassed(plan, "integrated")
    )
      throw new Error(
        "A successful push requires exact delivery and full tree-bound check receipts; reconcile the evidence.",
      )
    await this.ports.guard(plan, "integrated")
    plan.outcome = "pushed"
    plan.completion = { sessionId: this.sessionId, date: new Date().toISOString(), choice: "pushed" }
    plan.status = "shipped"
    delete plan.error
    await this.publish(plan)
    return true
  }
  async reconcile(plan: ShipPlan): Promise<ShipPlan> {
    if (["shipped", "skipped", "superseded"].includes(plan.status)) return plan
    try {
      return await this.reconcileObserved(plan)
    } catch (error) {
      plan.status = "blocked"
      plan.error = `Reconciliation stopped: ${String(error)}. No mutation was replayed.`
      await this.publish(plan)
      return plan
    }
  }
  private async reconcileObserved(plan: ShipPlan): Promise<ShipPlan> {
    for (const operation of plan.operations) {
      if (operation.effectNotStarted) {
        plan.status = "blocked"
        plan.error = `${operation.kind} was not started. ${operation.result} Explicitly revise the plan, finish local-only delivery where applicable, or skip/abandon ship; no mutation was replayed.`
        await this.publish(plan)
        return plan
      }
      // The effect receipt can be durable even when publication of the derived
      // plan field was interrupted. Restore it without replaying the effect.
      if (operation.status === "succeeded" && operation.result) {
        if (operation.kind === "commit") plan.commit = operation.result
        if (operation.kind === "merge") plan.integrated = operation.result
        if (operation.kind === "pr" && plan.pr) plan.pr.url = operation.result
        continue
      }
      if (!["requested", "uncertain"].includes(operation.status)) continue
      const result = await this.ports.reconcile(plan, operation)
      if (!result) {
        plan.status = "blocked"
        plan.error = `${operation.kind} outcome is unavailable. Inspect exact refs/hosting state; no replay or rollback was attempted.`
        await this.publish(plan)
        return plan
      }
      if (typeof result !== "string") {
        operation.status = "failed"
        operation.result = result.evidence
        plan.status = "blocked"
        plan.error = `${operation.kind}: ${result.notApplied ? "verified not applied" : "observed a different, unapproved result"}. Repair/recheck and explicitly revise or skip this plan; no retry or further integration was started.`
        await this.publish(plan)
        return plan
      }
      operation.status = "succeeded"
      operation.result = result
      if (operation.kind === "commit") plan.commit = result
      if (operation.kind === "merge") plan.integrated = result
      if (operation.kind === "pr" && plan.pr) plan.pr.url = result
      await this.publish(plan)
    }
    if (await this.finishPushed(plan)) return plan
    if (
      plan.preference.strategy === "pr" &&
      plan.operations.some((op) => op.kind === "pr" && op.status === "succeeded")
    ) {
      const merged = await this.ports.mergedPr(plan)
      if (!merged) {
        plan.status = "awaiting-merge"
        await this.publish(plan)
        return plan
      }
      plan.integrated = merged
      await this.publish(plan)
      // Adapter verifies the exact merged commit in the explicitly chosen checkout.
      // Squash/conflict resolutions require complete integrated checks too.
      await this.checks(plan, "integrated")
      if (!(await this.ports.confirm("Finish merged PR ship", describe(plan, "pr")))) return plan
      await this.ports.guard(plan, "integrated")
      plan.outcome = "pr-merged"
      plan.completion = { sessionId: this.sessionId, date: new Date().toISOString(), choice: plan.outcome! }
      plan.status = "shipped"
    } else {
      plan.status = "pending"
    }
    delete plan.error
    await this.publish(plan)
    return plan
  }
  async localOnly(plan: ShipPlan): Promise<ShipPlan> {
    if (plan.operations.some((op) => op.kind === "push" && op.status === "succeeded"))
      throw new Error(
        "A successful push cannot be relabeled local-only. Reconcile its truthful delivery outcome.",
      )
    if (["shipped", "skipped", "superseded"].includes(plan.status))
      throw new Error("A settled ship outcome cannot be replaced")
    if (plan.preference.strategy !== "local-merge" || !plan.integrated)
      throw new Error(
        "Local-only completion requires verified local integration. PR handoff can be explicitly ship-skipped, not marked delivered.",
      )
    if (plan.operations.some((op) => ["requested", "uncertain"].includes(op.status)))
      throw new Error("Reconcile uncertain effects before revising external steps.")
    if (!(await this.ports.confirm("Skip push and finish local-only", describe(plan, "push")))) return plan
    await this.ports.guard(plan, "integrated")
    await this.checks(plan, "integrated")
    if (!shipChecksPassed(plan, "source"))
      throw new Error("Local-only completion requires full tree-bound source check receipts")
    if (!plan.skipped.includes("push")) plan.skipped.push("push")
    plan.outcome = "local-only"
    plan.completion = { sessionId: this.sessionId, date: new Date().toISOString(), choice: plan.outcome! }
    plan.status = "shipped"
    await this.publish(plan)
    return plan
  }
  async skip(plan: ShipPlan): Promise<ShipPlan> {
    // A preparatory PR source-branch push is not delivered target integration.
    // Explicit PR abandonment can skip ship, but never relabel that push itself.
    if (
      plan.preference.strategy === "local-merge" &&
      plan.operations.some((op) => op.kind === "push" && op.status === "succeeded")
    )
      throw new Error(
        "A successful push cannot be relabeled skipped. Reconcile its truthful delivery outcome.",
      )
    if (["shipped", "skipped", "superseded"].includes(plan.status))
      throw new Error("A settled ship outcome cannot be replaced")
    if (plan.operations.some((op) => ["requested", "uncertain"].includes(op.status)))
      throw new Error("Reconcile uncertain effects before skipping ship.")
    if (!(await this.ports.confirm("Skip ship — not a pass", JSON.stringify(plan, null, 2)))) return plan
    plan.status = "skipped"
    plan.outcome = "ship-skipped"
    plan.completion = { sessionId: this.sessionId, date: new Date().toISOString(), choice: "ship-skipped" }
    plan.skipped.push("ship")
    await this.publish(plan)
    return plan
  }
}

export function shipSummary(plan: ShipPlan): string {
  const t = (en: string, zh: string, ja: string) => localize(plan.notes.language, en, zh, ja)
  const status = `${plan.status}${plan.outcome ? ` (${plan.outcome})` : ""}`
  const target = `${plan.target.branch} @ ${plan.integrated ?? plan.target.head}`
  const skipped = plan.skipped.join(", ") || t("none", "无", "なし")
  const passes = `${plan.results.filter((r) => r.ok).length}/${plan.results.length}`
  return [
    plan.notes.text,
    "",
    t(`Ship: ${status}`, `发布：${status}`, `リリース：${status}`),
    t(
      `Candidate: ${plan.commit ?? plan.source.tree}`,
      `候选提交：${plan.commit ?? plan.source.tree}`,
      `候補：${plan.commit ?? plan.source.tree}`,
    ),
    t(`Target: ${target}`, `目标：${target}`, `統合先：${target}`),
    t(
      `Notes: ${plan.notes.location}`,
      `发布说明：${plan.notes.location}`,
      `リリースノート：${plan.notes.location}`,
    ),
    t(
      `Skipped (not passed): ${skipped}`,
      `已跳过（不代表通过）：${skipped}`,
      `スキップ（合格ではありません）：${skipped}`,
    ),
    t(`Checks: ${passes} recorded passes`, `检查：${passes} 条通过记录`, `チェック：${passes} 件の合格記録`),
    ...plan.operations.map((op) => `${op.kind}: ${op.status}${op.result ? ` — ${op.result}` : ""}`),
    ...plan.results.map(
      (check) =>
        `${check.phase} / ${check.id}: ${check.ok ? t("passed", "通过", "合格") : t("not passed", "未通过", "不合格")}; cwd=${check.cwd}; command=${check.command}; exit=${check.exitCode ?? "unknown"}; timedOut=${check.timedOut}; aborted=${check.aborted}\n${check.output}`,
    ),
    ...(plan.error ? [t(`Stopped: ${plan.error}`, `已停止：${plan.error}`, `停止：${plan.error}`)] : []),
    t(
      "Iteration remains open; no iteration-resource cleanup, release creation or package publishing was performed.",
      "迭代仍开放；未清理迭代资源，也未创建发版或发布包。",
      "イテレーションは未終了です。イテレーションのリソース削除・リリース作成・パッケージ公開は実行していません。",
    ),
  ].join("\n")
}
