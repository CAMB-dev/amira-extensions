import { createHash } from "node:crypto"
import path from "node:path"
import {
  type ShipCheckResult,
  type ShipPlan,
  type ShipPreference,
  shipCheckPassed,
  shipChecksPassed,
} from "./ship.ts"
import { shipPathAllowed } from "./ship-delta.ts"
import { type Project, ProjectDocumentStore } from "./store.ts"

interface ShipDocument {
  schemaVersion: 1
  projectId: string
  preferences: ShipPreference[]
  plans: ShipPlan[]
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
export const shipHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const oid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value)
const receipt = (value: unknown) =>
  object(value) && text(value.sessionId) && text(value.date) && Number.isFinite(Date.parse(value.date))
const preference = (value: unknown) =>
  object(value) &&
  text(value.repository) &&
  text(value.target) &&
  ["local-merge", "pr"].includes(String(value.strategy)) &&
  ["ff-only", "merge"].includes(String(value.merge))
function validate(value: unknown, projectId: string): asserts value is ShipDocument {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== projectId ||
    !Array.isArray(value.preferences) ||
    !Array.isArray(value.plans)
  )
    throw new Error("Malformed ship document; existing evidence was preserved")
  if (!value.preferences.every(preference)) throw new Error("Malformed remembered ship preference")
  const ids = new Set<string>()
  for (const plan of value.plans) {
    if (
      !object(plan) ||
      plan.schemaVersion !== 1 ||
      plan.projectId !== projectId ||
      typeof plan.id !== "string" ||
      !Number.isSafeInteger(plan.iteration) ||
      !Number.isSafeInteger(plan.revision) ||
      !["pending", "running", "blocked", "awaiting-merge", "shipped", "skipped", "superseded"].includes(
        String(plan.status),
      ) ||
      !object(plan.source) ||
      !object(plan.target) ||
      !object(plan.preference) ||
      !Array.isArray(plan.checks) ||
      !Array.isArray(plan.results) ||
      !Array.isArray(plan.operations) ||
      !Array.isArray(plan.skipped) ||
      !Array.isArray(plan.files) ||
      !object(plan.notes)
    )
      throw new Error("Malformed ship plan; no operation can be replayed")
    if (
      !text(plan.id) ||
      ids.has(plan.id) ||
      !receipt(plan.approval) ||
      !preference(plan.preference) ||
      !Number.isSafeInteger(plan.stageRevision) ||
      (plan.stageRevision as number) < 0 ||
      (plan.revision as number) < 0 ||
      (plan.iteration as number) < 1 ||
      !text(plan.message) ||
      !text(plan.evidence) ||
      !text(plan.notes.language) ||
      !text(plan.notes.text) ||
      !text(plan.notes.location) ||
      !plan.files.every(text) ||
      !plan.skipped.every(text)
    )
      throw new Error("Malformed ship approval/inputs")
    ids.add(plan.id)
    for (const checkout of [plan.source, plan.target]) {
      if (!text(checkout.root) || !text(checkout.branch) || !text(checkout.common) || !oid(checkout.head))
        throw new Error("Malformed ship checkout pin")
    }
    if (
      !oid(plan.source.tree) ||
      (plan.commit !== undefined && !oid(plan.commit)) ||
      (plan.integrated !== undefined && !oid(plan.integrated)) ||
      (plan.integratedTree !== undefined && !oid(plan.integratedTree)) ||
      (plan.checkRoot !== undefined && (!text(plan.checkRoot) || !path.isAbsolute(plan.checkRoot)))
    )
      throw new Error("Malformed ship candidate commit/tree")
    if (plan.candidate !== undefined) {
      const candidate = plan.candidate
      const reviewedFiles = plan.files
      const samePin = (left: unknown, right: unknown) =>
        object(left) &&
        object(right) &&
        ["root", "branch", "head", "common"].every((field) => left[field] === right[field])
      if (
        !object(candidate) ||
        candidate.tree !== plan.source.tree ||
        !Array.isArray(candidate.paths) ||
        JSON.stringify(candidate.paths) !== JSON.stringify(plan.files) ||
        !object(candidate.pin) ||
        !samePin(candidate.pin.source, plan.source) ||
        !samePin(candidate.pin.target, plan.target) ||
        !object(candidate.incoming) ||
        !oid(candidate.incoming.base) ||
        !Array.isArray(candidate.incoming.paths) ||
        candidate.incoming.paths.some(
          (name: unknown) => !text(name) || !shipPathAllowed(name) || !reviewedFiles.includes(name),
        )
      )
        throw new Error(
          "Ship candidate tree, reviewed delta or checkout pins contradict the approved source/target",
        )
    }
    if (
      !plan.checks.length ||
      plan.checks.some(
        (check: unknown) => !object(check) || !text(check.id) || !text(check.command) || !text(check.cwd),
      )
    )
      throw new Error("Malformed full ship checks")
    const operationIds = new Set<string>(),
      operationKinds = new Set<string>()
    for (const operation of plan.operations) {
      if (
        !object(operation) ||
        !text(operation.id) ||
        !["commit", "merge", "push", "pr"].includes(String(operation.kind)) ||
        !text(operation.inputs) ||
        !["requested", "declined", "succeeded", "failed", "uncertain", "skipped"].includes(
          String(operation.status),
        ) ||
        (!["declined", "skipped"].includes(String(operation.status)) && !receipt(operation.approval)) ||
        (operation.result !== undefined && typeof operation.result !== "string") ||
        (operation.effectNotStarted !== undefined &&
          (operation.effectNotStarted !== true ||
            operation.status !== "failed" ||
            !["push", "pr"].includes(String(operation.kind)) ||
            !text(operation.result))) ||
        operationIds.has(String(operation.id)) ||
        operationKinds.has(String(operation.kind)) ||
        (operation.status === "succeeded" &&
          (operation.kind === "pr" ? !text(operation.result) : !oid(operation.result)))
      )
        throw new Error("Malformed ship operation receipt")
      operationIds.add(operation.id)
      operationKinds.add(String(operation.kind))
      if (operation.status === "succeeded") {
        const delivered =
          operation.kind === "commit"
            ? plan.commit
            : operation.kind === "merge"
              ? plan.integrated
              : operation.kind === "push"
                ? plan.preference.strategy === "pr"
                  ? plan.commit
                  : plan.integrated
                : object(plan.pr)
                  ? plan.pr.url
                  : undefined
        if (delivered !== undefined && delivered !== operation.result)
          throw new Error("Ship operation result differs from its exact delivery pin")
        if (operation.kind === "push" && (!object(plan.remote) || !oid(delivered)))
          throw new Error("A successful push requires an exact approved remote and delivery pin")
      }
    }
    const pushed = plan.operations.some((op) => op.kind === "push" && op.status === "succeeded")
    if (
      pushed &&
      (plan.outcome === "local-only" ||
        plan.skipped.includes("push") ||
        (plan.preference.strategy === "local-merge" &&
          (plan.outcome === "ship-skipped" || plan.status === "skipped" || plan.skipped.includes("ship"))))
    )
      throw new Error("A successful push cannot be recorded as local-only or skipped")
    if (
      ["shipped", "skipped"].includes(String(plan.status)) &&
      (!receipt(plan.completion) || !object(plan.completion) || plan.completion.choice !== plan.outcome)
    )
      throw new Error("Settled ship requires an explicit completion receipt")
    if (plan.status === "skipped" && plan.outcome !== "ship-skipped")
      throw new Error("Ship skip is not a passing outcome")
    if (plan.status === "shipped") {
      if (
        !oid(plan.commit) ||
        !oid(plan.integrated) ||
        !["local-only", "pushed", "pr-merged"].includes(String(plan.outcome))
      )
        throw new Error("Shipped outcome requires exact delivery commits")
      const operations = plan.operations
      const successful = (kind: string) =>
        operations.some((op: unknown) => object(op) && op.kind === kind && op.status === "succeeded")
      if (
        plan.preference.strategy === "pr"
          ? plan.outcome !== "pr-merged" || !successful("pr") || !successful("push")
          : !successful("merge") || (plan.outcome === "pushed" && !successful("push"))
      )
        throw new Error("Shipped outcome requires settled integration/outward receipts")
      if (plan.operations.some((op) => ["requested", "uncertain"].includes(op.status)))
        throw new Error("Shipped outcome cannot contain uncertain operations")
      if (
        !shipChecksPassed(plan as unknown as ShipPlan, "source") ||
        !shipChecksPassed(plan as unknown as ShipPlan, "integrated")
      )
        throw new Error("Shipped outcome requires every full tree-bound source and integrated check")
    }
    for (const result of plan.results) {
      if (
        !object(result) ||
        !text(result.id) ||
        !text(result.command) ||
        !text(result.cwd) ||
        !["source", "integrated"].includes(String(result.phase)) ||
        typeof result.output !== "string" ||
        typeof result.ok !== "boolean" ||
        typeof result.timedOut !== "boolean" ||
        typeof result.aborted !== "boolean" ||
        !(result.exitCode === null || Number.isInteger(result.exitCode)) ||
        (result.tree !== undefined && !oid(result.tree)) ||
        (result.checkoutRoot !== undefined &&
          (!text(result.checkoutRoot) || !path.isAbsolute(result.checkoutRoot)))
      )
        throw new Error("Malformed ship check evidence")
      if (result.ok) {
        const approved = plan.checks.find((check) => check.id === result.id)
        const checked = result as unknown as ShipCheckResult
        if (!approved || !shipCheckPassed(plan as unknown as ShipPlan, approved, checked.phase, checked))
          throw new Error(
            "Successful ship check evidence differs from its approved cwd/tree or process result",
          )
      }
    }
    // Old effects retain their genuine evidence even if a later recheck fails.
    // CAS publication below separately requires the latest passes for new intent.
    const checkedPlan = plan as unknown as ShipPlan
    const recordedChecks = (phase: ShipCheckResult["phase"]) =>
      checkedPlan.checks.every((check) =>
        checkedPlan.results.some((result) => shipCheckPassed(checkedPlan, check, phase, result)),
      )
    if (
      plan.operations.some(
        (op) =>
          ["commit", "merge", "push", "pr"].includes(op.kind) &&
          ["requested", "uncertain", "succeeded"].includes(op.status),
      ) &&
      !recordedChecks("source")
    )
      throw new Error("Ship operations require every full tree-bound source check")
    if (
      plan.preference.strategy === "local-merge" &&
      plan.operations.some(
        (op) => op.kind === "push" && ["requested", "uncertain", "succeeded"].includes(op.status),
      ) &&
      !recordedChecks("integrated")
    )
      throw new Error("Push requires every full tree-bound integrated check")
  }
}
/** Separate from acceptance journals; immutable plan inputs and append-only result history. */
export class ShipStore {
  private readonly documents: ProjectDocumentStore
  constructor(private readonly project: Project) {
    this.documents = new ProjectDocumentStore(project)
  }
  async read(): Promise<ShipDocument> {
    const value = await this.documents.read("ship.json")
    if (value === undefined)
      return { schemaVersion: 1, projectId: this.project.marker.id, preferences: [], plans: [] }
    validate(value, this.project.marker.id)
    return value
  }
  async latest(): Promise<ShipPlan | undefined> {
    return (await this.read()).plans.findLast(
      (plan) => plan.iteration === this.project.marker.currentIteration,
    )
  }
  async preference(repository: string): Promise<ShipPreference | undefined> {
    return (await this.read()).preferences.find((entry) => entry.repository === repository)
  }
  async supersede(plan: ShipPlan): Promise<void> {
    if (plan.operations.some((op) => ["requested", "uncertain"].includes(op.status)))
      throw new Error("Reconcile uncertain effects before revising the ship plan")
    if (["shipped", "skipped"].includes(plan.status))
      throw new Error("A settled ship outcome cannot be replaced")
    plan.status = "superseded"
    plan.revision++
    await this.save(plan)
  }
  async create(plan: ShipPlan): Promise<void> {
    await this.documents.update("ship.json", (value) => {
      const doc: ShipDocument =
        value === undefined
          ? { schemaVersion: 1, projectId: this.project.marker.id, preferences: [], plans: [] }
          : (value as ShipDocument)
      validate(doc, this.project.marker.id)
      if (
        doc.plans.some(
          (entry) =>
            entry.iteration === plan.iteration &&
            !["shipped", "skipped", "superseded"].includes(entry.status),
        )
      )
        throw new Error("An unsettled ship plan exists. Reconcile it; no plan was replaced.")
      doc.plans.push(structuredClone(plan))
      doc.preferences = [
        ...doc.preferences.filter((entry) => entry.repository !== plan.preference.repository),
        structuredClone(plan.preference),
      ]
      validate(doc, this.project.marker.id)
      return doc
    })
  }
  async save(plan: ShipPlan): Promise<void> {
    await this.documents.update("ship.json", (value) => {
      validate(value, this.project.marker.id)
      const index = value.plans.findIndex((entry) => entry.id === plan.id)
      const old = value.plans[index]
      if (!old || old.revision + 1 !== plan.revision)
        throw new Error("Ship revision changed. Reload and reconcile; no effect was started.")
      const inputs = (row: ShipPlan) => ({
        ...row,
        revision: 0,
        status: "pending",
        operations: [],
        results: [],
        skipped: [],
        commit: undefined,
        integrated: undefined,
        integratedTree: undefined,
        error: undefined,
        outcome: undefined,
        completion: undefined,
        pr: row.pr ? { ...row.pr, url: undefined } : undefined,
      })
      if (shipHash(inputs(old)) !== shipHash(inputs(plan)))
        throw new Error("Ship plan inputs are immutable; review a new plan.")
      for (const field of ["commit", "integrated", "integratedTree"] as const) {
        if (old[field] !== undefined && old[field] !== plan[field])
          throw new Error("Ship delivery commit/tree pins cannot be rewritten")
      }
      if (["shipped", "skipped", "superseded"].includes(old.status))
        throw new Error("Settled ship evidence is immutable")
      if (
        plan.results.length < old.results.length ||
        shipHash(plan.results.slice(0, old.results.length)) !== shipHash(old.results) ||
        !old.skipped.every((entry) => plan.skipped.includes(entry)) ||
        plan.operations.length < old.operations.length
      )
        throw new Error("Ship result history cannot be removed or rewritten")
      for (const operation of plan.operations.slice(old.operations.length)) {
        if (!["requested", "uncertain", "succeeded"].includes(operation.status)) continue
        if (!shipChecksPassed(plan, "source"))
          throw new Error("New ship operations require every latest full tree-bound source check")
        if (
          operation.kind === "push" &&
          plan.preference.strategy === "local-merge" &&
          !shipChecksPassed(plan, "integrated")
        )
          throw new Error("New push requires every latest full tree-bound integrated check")
      }
      for (const [position, operation] of old.operations.entries()) {
        const next = plan.operations[position]!
        if (
          (operation.effectNotStarted && shipHash(operation) !== shipHash(next)) ||
          (next.effectNotStarted && !operation.effectNotStarted && operation.status !== "requested")
        )
          throw new Error(
            "A preflight not-started receipt cannot be invented from uncertain history or rewritten",
          )
        if (
          operation.id !== next.id ||
          operation.kind !== next.kind ||
          operation.inputs !== next.inputs ||
          shipHash(operation.approval) !== shipHash(next.approval) ||
          (operation.status === "succeeded" && shipHash(operation) !== shipHash(next))
        )
          throw new Error("Ship operation approval/result history cannot be rewritten")
      }
      value.plans[index] = structuredClone(plan)
      validate(value, this.project.marker.id)
      return value
    })
  }
}
