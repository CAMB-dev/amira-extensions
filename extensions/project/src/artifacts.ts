import path from "node:path"
import type { AcceptedBatchRef, ArtifactKind } from "./stage.ts"

export interface PrototypeManifestArtifact {
  kind: "prototype-manifest"
  variants: {
    id: string
    idea: string
    question: string
    /** Canonical absolute directory, bound to this project/iteration by the store. */
    directory: string
    runCommand: string | null
    cwd: string
    prerequisites: string[]
    notes: string
    status: "planned" | "building" | "ready" | "failed"
  }[]
  chosen?: { variantId: string | null; decisionId: string }
}

export interface StageSummaryArtifact {
  kind: "stage-summary"
  stage: "design" | "prototype" | "implement" | "accept"
  language: string
  summary: string
  outputs: string[]
  suggestion: string
}

export interface SpecItem {
  /** Stable across spec revisions; never use an array position as identity. */
  id: string
  description: string
  constraints: string[]
  verification: string[]
  acceptanceCriteria: string[]
  decisionIds: string[]
  checkIds: string[]
  ui: boolean
}
export interface SpecCheck {
  id: string
  command: string
  /** Relative to the mapped project directory; must remain inside the worktree. */
  cwd?: string
}
export interface SpecArtifact {
  kind: "spec"
  revision: number
  language: string
  summary: string
  /** Model-facing English body, separate from the human-language summary. */
  body: string
  decisionIds: string[]
  items: SpecItem[]
  checks: SpecCheck[]
  /** Extension-controlled identity lineage; absent only on legacy artifacts. */
  lineage?: {
    previousSpec: { artifactId: string; revision: number; hash: string } | null
    items: { id: string; previousId: string | null }[]
    retiredItemIds: string[]
  }
}
interface SpecBinding {
  specHash: string
  specRevision: number
}
export interface BatchPlanArtifact extends SpecBinding {
  kind: "batch-plan"
  mode: "single" | "workflow" | "swarm"
  batches: { id: string; itemIds: string[]; decisionIds: string[]; files: string[] }[]
}
interface ReviewBinding extends SpecBinding {
  batchPlan: { artifactId: string; hash: string }
  attemptId: string
  attempt: number
  codeHash: string
}
export interface AcceptanceArtifact extends ReviewBinding {
  kind: "acceptance"
  batchId: string
  reviewerModel: string
  implementerModels: string[]
  sameModelFallback: boolean
  outcome: "pass" | "fail" | "blocked"
  items: {
    itemId: string
    status: "pass" | "fail" | "blocked" | "not-applicable"
    evidence: string[]
    reason: string
  }[]
  checks: {
    checkId: string
    cwd: string
    command: string
    startedAt: string
    finishedAt: string
    status: "passed" | "failed" | "blocked" | "timed-out" | "error"
    exitCode: number | null
    output: string
  }[]
}
export interface ManualTrialArtifact extends ReviewBinding {
  kind: "manual-trial"
  batchId: string
  instructions: string
  observe: string[]
  status: "pending" | "tried" | "problem" | "deferred"
  result?: string
}
export interface CorrectionArtifact extends SpecBinding {
  kind: "correction"
  batchId: string
  oldDecisionIds: string[]
  newDecisionIds: string[]
  summary: string
  mappings: {
    oldDecisionId: string
    newDecisionId: string
    itemIds: string[]
    changedFiles: string[]
    acceptedBatches: AcceptedBatchRef[]
  }[]
}
export interface WorktreeArtifact {
  kind: "iteration-worktree"
  status: "planned" | "ready"
  repository: string
  root: string
  cwd: string
  branch: string
  base: string
  excluded: string
  confirmation: string
  setupKey: string
}
export interface BatchResultArtifact {
  kind: "batch-result"
  attemptId: string
  context: import("./stage.ts").ApprovalContext
  worktree: string
  base: string
  snapshot: string
  diffStat: string
  summary: string
  implementerModels: string[]
  checks: AcceptanceArtifact["checks"]
  error?: string
}
export type IterationArtifact =
  | PrototypeManifestArtifact
  | StageSummaryArtifact
  | SpecArtifact
  | BatchPlanArtifact
  | AcceptanceArtifact
  | ManualTrialArtifact
  | CorrectionArtifact
  | WorktreeArtifact
  | BatchResultArtifact

const fail = (message: string): never => {
  throw new Error(`Invalid iteration artifact: ${message}`)
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((field) => !fields.includes(field))) fail("unexpected field")
  return record
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail("expected nonempty text")
}
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("expected a positive integer")
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("expected an array")
  return value as unknown[]
}
function texts(value: unknown, nonempty = false): asserts value is string[] {
  const values = list(value)
  values.forEach(text)
  if ((nonempty && !values.length) || new Set(values).size !== values.length)
    fail("expected distinct text values")
}
function ids(value: unknown, nonempty = false): asserts value is string[] {
  texts(value, nonempty)
  if (value.some((id) => !/^[A-Za-z][A-Za-z0-9._-]*$/.test(id))) fail("invalid stable ID")
}
function oneOf(value: unknown, choices: readonly string[]): void {
  if (typeof value !== "string" || !choices.includes(value)) fail("unsupported value")
}
function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid SHA-256 hash")
}
function unique(values: unknown[]): void {
  if (new Set(values).size !== values.length) fail("duplicate ID")
}
function files(value: unknown): void {
  texts(value)
  if (
    value.some(
      (file) =>
        file.includes("\\") ||
        file.includes(":") ||
        file.startsWith("/") ||
        file.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    fail("changed files must be repository-relative paths")
}
const bindings = ["specHash", "specRevision"]
function binding(value: Record<string, unknown>): void {
  digest(value.specHash)
  integer(value.specRevision)
}
const reviewBindings = ["batchPlan", "attemptId", "attempt", "codeHash"]
function reviewBinding(value: Record<string, unknown>): void {
  const plan = object(value.batchPlan, ["artifactId", "hash"])
  text(plan.artifactId)
  digest(plan.hash)
  text(value.attemptId)
  integer(value.attempt)
  digest(value.codeHash)
}

/** Historical payload schema only. Current spec-use policy is checked separately at
 * publication, approval and execution; it must not make valid old history unreadable.
 * Identity, filenames and hashes are store-owned. */
export function validateArtifact(value: unknown): asserts value is IterationArtifact {
  if (value && typeof value === "object" && "kind" in value) {
    if (value.kind === "iteration-worktree") {
      const a = object(value, [
        "kind",
        "status",
        "repository",
        "root",
        "cwd",
        "branch",
        "base",
        "excluded",
        "confirmation",
        "setupKey",
      ])
      oneOf(a.status, ["planned", "ready"])
      for (const key of ["repository", "root", "cwd", "branch", "base", "confirmation", "setupKey"])
        text(a[key])
      if (typeof a.excluded !== "string") fail("invalid excluded input preview")
      for (const key of ["repository", "root", "cwd"])
        if (!path.isAbsolute(String(a[key]))) fail("expected absolute Git path")
      return
    }
    if (value.kind === "batch-result") {
      const a = object(value, [
        "kind",
        "attemptId",
        "context",
        "worktree",
        "base",
        "snapshot",
        "diffStat",
        "summary",
        "implementerModels",
        "checks",
        "error",
      ])
      for (const key of ["attemptId", "worktree", "base", "snapshot", "summary"]) text(a[key])
      if (typeof a.diffStat !== "string") fail("invalid diff stat")
      texts(a.implementerModels)
      const context = object(a.context, ["spec", "batchPlan", "batchId", "mode", "model", "changes"])
      text(context.batchId)
      if (!Array.isArray(a.checks)) fail("invalid check results")
      for (const entry of list(a.checks)) {
        const check = object(entry, [
          "checkId",
          "cwd",
          "command",
          "startedAt",
          "finishedAt",
          "status",
          "exitCode",
          "output",
        ])
        for (const key of ["checkId", "cwd", "command", "startedAt", "finishedAt"]) text(check[key])
        oneOf(check.status, ["passed", "failed", "blocked", "timed-out", "error"])
        if (
          typeof check.output !== "string" ||
          (check.exitCode !== null && !Number.isInteger(check.exitCode))
        )
          fail("invalid check result")
      }
      unique(list(a.checks).map((entry) => (entry as Record<string, unknown>).checkId))
      for (const entry of list(a.checks)) {
        const check = entry as Record<string, unknown>
        if (
          !Number.isFinite(Date.parse(String(check.startedAt))) ||
          !Number.isFinite(Date.parse(String(check.finishedAt))) ||
          Date.parse(String(check.finishedAt)) < Date.parse(String(check.startedAt))
        )
          fail("invalid check timestamps")
        if (check.status === "passed" && check.exitCode !== 0) fail("a passed check requires exit code zero")
      }
      if (a.error !== undefined) text(a.error)
      return
    }
  }
  const head = object(value, [
    "kind",
    "stage",
    "language",
    "summary",
    "outputs",
    "suggestion",
    "revision",
    "body",
    "decisionIds",
    "items",
    "checks",
    "lineage",
    ...bindings,
    "mode",
    "batches",
    "batchId",
    ...reviewBindings,
    "reviewerModel",
    "implementerModels",
    "sameModelFallback",
    "outcome",
    "instructions",
    "observe",
    "status",
    "result",
    "oldDecisionIds",
    "newDecisionIds",
    "mappings",
    "variants",
    "chosen",
  ])
  const kind = head.kind as ArtifactKind
  switch (kind) {
    case "prototype-manifest": {
      const a = object(value, ["kind", "variants", "chosen"])
      const variants = list(a.variants)
      if (variants.length < 1 || variants.length > 3) fail("prototype requires one to three variants")
      const variantIds = variants.map((entry) => {
        const variant = object(entry, [
          "id",
          "idea",
          "question",
          "directory",
          "runCommand",
          "cwd",
          "prerequisites",
          "notes",
          "status",
        ])
        ids([variant.id], true)
        if (variant.id === "none" || /[.]$/.test(String(variant.id))) fail("invalid prototype variant ID")
        text(variant.idea)
        text(variant.question)
        text(variant.directory)
        text(variant.cwd)
        for (const directory of [variant.directory, variant.cwd]) {
          if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
            fail("prototype paths must be canonical absolute paths")
        }
        const relative = path.relative(variant.directory, variant.cwd)
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          fail("prototype command cwd must be inside its variant directory")
        if (variant.runCommand !== null) text(variant.runCommand)
        texts(variant.prerequisites)
        if (typeof variant.notes !== "string") fail("invalid prototype notes")
        oneOf(variant.status, ["planned", "building", "ready", "failed"])
        if (variant.status === "ready" && variant.runCommand === null)
          fail("ready prototype requires a run command")
        return variant.id
      })
      unique(variantIds.map((id) => String(id).toLowerCase()))
      if (a.chosen !== undefined) {
        const chosen = object(a.chosen, ["variantId", "decisionId"])
        if (chosen.variantId !== null && !variantIds.includes(chosen.variantId))
          fail("unknown chosen prototype variant")
        ids([chosen.decisionId], true)
      }
      break
    }
    case "stage-summary": {
      const a = object(value, ["kind", "stage", "language", "summary", "outputs", "suggestion"])
      oneOf(a.stage, ["design", "prototype", "implement", "accept"])
      text(a.language)
      text(a.summary)
      texts(a.outputs)
      text(a.suggestion)
      break
    }
    case "spec": {
      const a = object(value, [
        "kind",
        "revision",
        "language",
        "summary",
        "body",
        "decisionIds",
        "items",
        "checks",
        "lineage",
      ])
      integer(a.revision)
      text(a.language)
      text(a.summary)
      text(a.body)
      ids(a.decisionIds)
      const decisionIds = a.decisionIds
      const checks = list(a.checks).map((entry) => {
        const check = object(entry, ["id", "command", "cwd"])
        if (check.cwd !== undefined) text(check.cwd)
        ids([check.id], true)
        text(check.command)
        return check.id
      })
      unique(checks)
      const items = list(a.items).map((entry) => {
        const item = object(entry, [
          "id",
          "description",
          "constraints",
          "verification",
          "acceptanceCriteria",
          "decisionIds",
          "checkIds",
          "ui",
        ])
        ids([item.id], true)
        text(item.description)
        texts(item.constraints)
        texts(item.verification, true)
        texts(item.acceptanceCriteria, true)
        ids(item.decisionIds)
        ids(item.checkIds)
        if (typeof item.ui !== "boolean") fail("invalid UI flag")
        if (item.checkIds.some((id) => !checks.includes(id))) fail("unknown check ID")
        if (item.decisionIds.some((id) => !decisionIds.includes(id))) fail("unknown decision ID")
        return item.id
      })
      if (!items.length) fail("spec requires stable items")
      unique(items)
      if (a.lineage !== undefined) {
        const lineage = object(a.lineage, ["previousSpec", "items", "retiredItemIds"])
        if (lineage.previousSpec !== null) {
          const previous = object(lineage.previousSpec, ["artifactId", "revision", "hash"])
          text(previous.artifactId)
          integer(previous.revision)
          digest(previous.hash)
        }
        ids(lineage.retiredItemIds)
        const origins = list(lineage.items).map((entry) => {
          const origin = object(entry, ["id", "previousId"])
          ids([origin.id], true)
          if (origin.previousId !== null) ids([origin.previousId], true)
          return origin.id
        })
        unique(origins)
        if (origins.length !== items.length || origins.some((id) => !items.includes(id)))
          fail("lineage must cover every spec item")
      }
      break
    }
    case "batch-plan": {
      const a = object(value, ["kind", ...bindings, "mode", "batches"])
      binding(a)
      oneOf(a.mode, ["single", "workflow", "swarm"])
      const batches = list(a.batches).map((entry) => {
        const batch = object(entry, ["id", "itemIds", "decisionIds", "files"])
        ids([batch.id], true)
        ids(batch.itemIds, true)
        ids(batch.decisionIds)
        files(batch.files)
        return batch.id
      })
      if (!batches.length) fail("plan requires batches")
      unique(batches)
      break
    }
    case "acceptance": {
      const a = object(value, [
        "kind",
        ...bindings,
        "batchId",
        ...reviewBindings,
        "reviewerModel",
        "implementerModels",
        "sameModelFallback",
        "outcome",
        "items",
        "checks",
      ])
      binding(a)
      ids([a.batchId], true)
      reviewBinding(a)
      text(a.reviewerModel)
      texts(a.implementerModels, true)
      if (typeof a.sameModelFallback !== "boolean") fail("invalid reviewer fallback flag")
      if (!a.sameModelFallback && a.implementerModels.includes(a.reviewerModel))
        fail("reviewer matches an implementer without disclosed fallback")
      oneOf(a.outcome, ["pass", "fail", "blocked"])
      const itemIds = list(a.items).map((entry) => {
        const item = object(entry, ["itemId", "status", "evidence", "reason"])
        ids([item.itemId], true)
        oneOf(item.status, ["pass", "fail", "blocked", "not-applicable"])
        texts(item.evidence, item.status === "pass")
        text(item.reason)
        if (a.outcome === "pass" && !["pass", "not-applicable"].includes(String(item.status)))
          fail("passing verdict has a nonpassing item")
        return item.itemId
      })
      if (!itemIds.length) fail("acceptance requires per-item evidence")
      unique(itemIds)
      unique(
        list(a.checks).map((entry) => {
          const check = object(entry, [
            "checkId",
            "cwd",
            "command",
            "startedAt",
            "finishedAt",
            "status",
            "exitCode",
            "output",
          ])
          ids([check.checkId], true)
          text(check.cwd)
          text(check.command)
          text(check.startedAt)
          text(check.finishedAt)
          if (
            !Number.isFinite(Date.parse(check.startedAt)) ||
            !Number.isFinite(Date.parse(check.finishedAt)) ||
            Date.parse(check.finishedAt) < Date.parse(check.startedAt)
          )
            fail("invalid check timestamps")
          oneOf(check.status, ["passed", "failed", "blocked", "timed-out", "error"])
          if (check.exitCode !== null && !Number.isSafeInteger(check.exitCode))
            fail("invalid check exit code")
          if (typeof check.output !== "string") fail("invalid check output")
          if (check.status === "passed" && check.exitCode !== 0)
            fail("successful check must have exit code zero")
          if (a.outcome === "pass" && check.status !== "passed")
            fail("passing verdict has an unsuccessful check")
          return check.checkId
        }),
      )
      break
    }
    case "manual-trial": {
      const a = object(value, [
        "kind",
        ...bindings,
        "batchId",
        ...reviewBindings,
        "instructions",
        "observe",
        "status",
        "result",
      ])
      binding(a)
      ids([a.batchId], true)
      reviewBinding(a)
      text(a.instructions)
      texts(a.observe, true)
      oneOf(a.status, ["pending", "tried", "problem", "deferred"])
      if (a.status !== "pending" || a.result !== undefined) text(a.result)
      break
    }
    case "correction": {
      const a = object(value, [
        "kind",
        ...bindings,
        "batchId",
        "oldDecisionIds",
        "newDecisionIds",
        "summary",
        "mappings",
      ])
      binding(a)
      ids([a.batchId], true)
      ids(a.oldDecisionIds, true)
      ids(a.newDecisionIds, true)
      const newDecisionIds = a.newDecisionIds
      if (a.oldDecisionIds.some((id) => newDecisionIds.includes(id)))
        fail("correction must link different old/new decisions")
      text(a.summary)
      const mappedOld: string[] = []
      const mappedNew: string[] = []
      for (const entry of list(a.mappings)) {
        const edge = object(entry, [
          "oldDecisionId",
          "newDecisionId",
          "itemIds",
          "changedFiles",
          "acceptedBatches",
        ])
        text(edge.oldDecisionId)
        text(edge.newDecisionId)
        if (!a.oldDecisionIds.includes(edge.oldDecisionId) || !a.newDecisionIds.includes(edge.newDecisionId))
          fail("unknown correction decision")
        ids(edge.itemIds, true)
        files(edge.changedFiles)
        const accepted = list(edge.acceptedBatches).map((entry) => {
          const ref = object(entry, ["batchId", "spec", "batchPlan", "resolutionReceiptId", "attemptId"])
          ids([ref.batchId], true)
          const spec = object(ref.spec, ["artifactId", "revision", "hash"])
          text(spec.artifactId)
          integer(spec.revision)
          digest(spec.hash)
          const plan = object(ref.batchPlan, ["artifactId", "hash"])
          text(plan.artifactId)
          digest(plan.hash)
          text(ref.resolutionReceiptId)
          text(ref.attemptId)
          return JSON.stringify([plan.artifactId, ref.batchId])
        })
        unique(accepted)
        mappedOld.push(edge.oldDecisionId)
        mappedNew.push(edge.newDecisionId)
      }
      if (
        a.oldDecisionIds.some((id) => !mappedOld.includes(id)) ||
        a.newDecisionIds.some((id) => !mappedNew.includes(id))
      )
        fail("correction requires complete impact mappings")
      break
    }
    default:
      fail("unsupported kind")
  }
}
