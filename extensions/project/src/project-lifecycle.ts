import { randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import type { ExtensionAPI } from "@amira/api"
import { cachedProjectAccounting, reconcileLifecycleCosts } from "./accounting.ts"
import { FileCostPersistence } from "./cost-storage.ts"
import type { LifecycleReceipt } from "./lifecycle.ts"
import { reduceLifecycle } from "./lifecycle.ts"
import { incompleteOwnedArchive, type RecoveredOwner, recoverOwnerInventory } from "./owner-inventory.ts"
import { assertNoPendingOwnerOpenings } from "./owner-openings.ts"
import { prototypeRemoval } from "./project-cleanup.ts"
import { type ApprovalContext, initialIteration } from "./stage.ts"
import {
  HistoricalIterationReader,
  IterationStore,
  LifecycleStore,
  type Project,
  ProjectDocumentStore,
  ProjectStorageError,
  projectLifecycle,
  readProject,
  withProjectClaim,
} from "./store.ts"

type OwnerRef = { id: string } | { key: string }
interface OwnedLifecycle {
  read(ref: OwnerRef): Promise<{ id: string; key: string; archived: boolean } | undefined>
  archive(ref: OwnerRef): Promise<void>
  unarchive(ref: OwnerRef): Promise<void>
}
export interface LifecycleOwnerResult extends RecoveredOwner {
  status: "pending" | "archived" | "continued" | "absent" | "failed"
  error?: string
}
export interface ProjectLifecycleOperation {
  id: string
  action: "close" | "archive" | "continue-conversation"
  iteration: number
  receipt: LifecycleReceipt
  status: "pending" | "failed" | "completed"
  pid: number
  owners: LifecycleOwnerResult[]
  errors: string[]
  /** Exact stage revision pinned by closure or a restore continuation. */
  stageRevision?: number
  context?: ApprovalContext
}
interface Operations {
  schemaVersion: 1
  projectId: string
  operations: ProjectLifecycleOperation[]
}
export interface ProjectLifecycleResult {
  project: Project
  operation: ProjectLifecycleOperation
}
export interface LifecycleRetry {
  /** A second explicit receipt is required; historical reads never retry effects. */
  retry?: boolean
  stageRevision?: number
}
const document = "lifecycle-operations.json"
const active = new Set<string>()
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const text = (error: unknown) => (error instanceof Error ? error.message : String(error))
const identity = (project: Project) => `${project.root}/${project.marker.id}`

/** H3 is capability-detected locally, never supplied by another extension's implementation. */
function ownedLifecycle(api: ExtensionAPI): OwnedLifecycle {
  const value: unknown = api.conversations
  if (
    !object(value) ||
    typeof value.read !== "function" ||
    typeof value.archive !== "function" ||
    typeof value.unarchive !== "function"
  )
    throw new Error("Project lifecycle requires owned conversation read/archive/unarchive support")
  return value as unknown as OwnedLifecycle
}
function operations(value: unknown, project: Project): Operations {
  if (value === undefined) return { schemaVersion: 1, projectId: project.marker.id, operations: [] }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== project.marker.id ||
    !Array.isArray(value.operations)
  )
    throw new Error("Malformed project lifecycle operations; existing evidence was preserved")
  for (const row of value.operations) {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !row.id.trim() ||
      !["close", "archive", "continue-conversation"].includes(row.action as string) ||
      !Number.isSafeInteger(row.iteration) ||
      (row.iteration as number) < 1 ||
      (row.iteration as number) > project.marker.currentIteration ||
      !["pending", "failed", "completed"].includes(row.status as string) ||
      !Number.isSafeInteger(row.pid) ||
      (row.pid as number) <= 0 ||
      !Array.isArray(row.owners) ||
      !row.owners.every(
        (owner) =>
          object(owner) &&
          typeof owner.key === "string" &&
          owner.key.trim() &&
          (owner.id === undefined || (typeof owner.id === "string" && owner.id.trim())) &&
          Number.isSafeInteger(owner.iteration) &&
          (owner.iteration as number) > 0 &&
          (owner.iteration as number) <= project.marker.currentIteration &&
          ["design", "prototype", "implement", "accept", "ship"].includes(owner.stage as string) &&
          typeof owner.role === "string" &&
          owner.role.trim() &&
          ["pending", "archived", "continued", "absent", "failed"].includes(owner.status as string) &&
          [owner.attempt, owner.batch, owner.variant, owner.error].every(
            (field) => field === undefined || typeof field === "string",
          ),
      ) ||
      !Array.isArray(row.errors) ||
      !row.errors.every((error) => typeof error === "string") ||
      (row.stageRevision !== undefined &&
        (!Number.isSafeInteger(row.stageRevision) || Number(row.stageRevision) < 0))
    )
      throw new Error("Malformed project lifecycle operation; existing evidence was preserved")
    validateReceipt(project, row.receipt as LifecycleReceipt)
  }
  return value as unknown as Operations
}

function validateReceipt(project: Project, receipt: LifecycleReceipt): void {
  // The reducer validates the receipt before the transition. Use a synthetic archived
  // snapshot so validation neither depends on the live status nor changes evidence.
  const lifecycle = projectLifecycle(project)
  lifecycle.status = "archived"
  reduceLifecycle(lifecycle, project.marker.currentIteration, { type: "restore", receipt })
}
export async function readContinuationState(project: Project) {
  try {
    return await new HistoricalIterationReader(project, project.marker.currentIteration).read()
  } catch (error) {
    if (error instanceof ProjectStorageError && error.code === "missing")
      return initialIteration(project.marker.id, project.marker.currentIteration)
    throw error
  }
}
function assertRevision(project: Project, captured: Project, expectedRevision: number): void {
  if (
    project.marker.currentIteration !== captured.marker.currentIteration ||
    !Number.isSafeInteger(expectedRevision) ||
    projectLifecycle(project).revision !== expectedRevision
  )
    throw new Error("Stale lifecycle receipt; reload the project before continuing")
}
function assertNotRunning(project: Project, previous: ProjectLifecycleOperation | undefined): void {
  if (active.has(identity(project))) throw new Error("Project lifecycle operation is already running")
  if (previous?.status === "pending" && previous.pid !== process.pid) {
    try {
      process.kill(previous.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return
      throw error
    }
    throw new Error("Project lifecycle operation is in use by a live writer")
  }
}

/**
 * Owns the ordering between durable admission fences, runtime drainage and H3.
 * It never creates/opens a runtime, launches a provider, cleans files or changes Git.
 * Commands supply an explicit identity-bound receipt after their confirmation dialog.
 */
export class ProjectLifecycleController {
  private readonly project: Project
  constructor(
    private readonly api: ExtensionAPI,
    project: Project,
    private readonly options: { quiesce?(): Promise<void> } = {},
  ) {
    this.project = structuredClone(project)
  }
  /** Historical inspection: no recovery, accounting initialization or runtime attachment. */
  async read(): Promise<ProjectLifecycleOperation[]> {
    const project = await readProject(this.project.root, this.project.marker.id)
    return structuredClone(
      operations(await new ProjectDocumentStore(project).read(document), project).operations,
    )
  }
  close(
    expectedRevision: number,
    receipt: LifecycleReceipt,
    options: LifecycleRetry = {},
  ): Promise<ProjectLifecycleResult> {
    return this.settle("close", expectedRevision, receipt, options)
  }
  archive(
    expectedRevision: number,
    receipt: LifecycleReceipt,
    options: LifecycleRetry = {},
  ): Promise<ProjectLifecycleResult> {
    return this.settle("archive", expectedRevision, receipt, options)
  }
  private async publish(project: Project, operation: ProjectLifecycleOperation): Promise<void> {
    await new ProjectDocumentStore(project).update(
      document,
      (value) => {
        const saved = operations(value, project)
        const index = saved.operations.findIndex((row) => row.id === operation.id)
        if (index < 0) saved.operations.push(structuredClone(operation))
        else saved.operations[index] = structuredClone(operation)
        return saved
      },
      { administrative: true },
    )
  }
  private async settle(
    action: "close" | "archive",
    expectedRevision: number,
    receipt: LifecycleReceipt,
    options: LifecycleRetry,
  ): Promise<ProjectLifecycleResult> {
    let operation!: ProjectLifecycleOperation
    let project = await withProjectClaim(
      this.project,
      async (current) => {
        assertRevision(current, this.project, expectedRevision)
        validateReceipt(current, receipt)
        if (options.retry) {
          // Explicit retries may finish a local marker intent, never replay runtime work.
          current = await new LifecycleStore(current).recover()
          if (current.marker.currentIteration !== this.project.marker.currentIteration)
            throw new Error("Project iteration changed during lifecycle recovery")
          expectedRevision = projectLifecycle(current).revision
        }
        if (
          action === "close" &&
          options.stageRevision !== undefined &&
          (await readContinuationState(current)).revision !== options.stageRevision
        )
          throw new Error("Stage changed during closure confirmation; review and confirm again")
        const saved = operations(await new ProjectDocumentStore(current).read(document), current)
        const previous = saved.operations.at(-1)
        assertNotRunning(current, previous)
        const lifecycle = projectLifecycle(current)
        const pending =
          action === "archive"
            ? lifecycle.status === "archive-pending"
            : lifecycle.iterations[current.marker.currentIteration]?.status === "close-pending"
        if (pending && !options.retry)
          throw new Error("Lifecycle operation is unfinished; explicitly confirm a retry")
        if (previous && previous.status !== "completed" && previous.action !== action)
          throw new Error("Settle the unfinished lifecycle operation before another action")
        if (options.retry && !pending) {
          const settled =
            action === "archive"
              ? lifecycle.status === "archived" && lifecycle.receipt
              : lifecycle.iterations[current.marker.currentIteration]?.status === "closed" &&
                lifecycle.iterations[current.marker.currentIteration]?.receipt
          if (
            !settled ||
            previous?.action !== action ||
            previous.status !== "pending" ||
            JSON.stringify(settled) !== JSON.stringify(previous.receipt)
          )
            throw new Error("There is no pending lifecycle operation to retry")
          // A crash can occur after marker publication but before its result record.
          // Explicit recovery settles only that local result; no host effect is replayed.
          operation = { ...previous, status: "completed" }
          await this.publish(current, operation)
          return current
        }
        // Validate both the settled outcome and its fence before any host effects.
        if (!pending) {
          reduceLifecycle(lifecycle, current.marker.currentIteration, {
            type: action === "close" ? "close-pending" : "archive-pending",
            receipt,
          })
          current = await new LifecycleStore(current).transition(expectedRevision, {
            type: action === "close" ? "close-pending" : "archive-pending",
            receipt,
          })
        }
        operation = {
          id: randomUUID(),
          action,
          iteration: current.marker.currentIteration,
          receipt: structuredClone(receipt),
          status: "pending",
          pid: process.pid,
          owners: [],
          errors: [],
          ...(action === "close" && options.stageRevision !== undefined
            ? { stageRevision: options.stageRevision }
            : {}),
        }
        await this.publish(current, operation)
        active.add(identity(current))
        return current
      },
      { administrative: true },
    )
    if (operation.status === "completed") return { project, operation: structuredClone(operation) }
    try {
      let host: OwnedLifecycle | undefined
      try {
        host = ownedLifecycle(this.api)
      } catch (error) {
        operation.errors.push(text(error))
      }
      try {
        // Pause publication finalizers after the durable fence and before accounting cancellation.
        await this.options.quiesce?.()
      } catch (error) {
        operation.errors.push(`Quiesce failed: ${text(error)}`)
      }
      try {
        // In particular, do not initialize accounting when archiving historical work.
        await (await cachedProjectAccounting(this.api, project))?.stopAndDrain(`Project ${action}`)
      } catch (error) {
        operation.errors.push(`Drain failed: ${text(error)}`)
      }
      try {
        await assertNoPendingOwnerOpenings(
          project,
          async (key) => !!(host && (await host.read({ key }))?.archived),
        )
      } catch (error) {
        operation.errors.push(`Owner opening remains unverified: ${text(error)}`)
      }
      try {
        const ledger = await new FileCostPersistence(project).read()
        const inventory = new Map<string, RecoveredOwner>()
        for (const owner of [
          ...(ledger?.owners ?? []),
          ...(await recoverOwnerInventory(this.api, project, ledger)),
        ]) {
          if (!owner.key.startsWith(`${project.marker.id}/`))
            throw new Error("Saved lifecycle owner key escapes this project")
          const previous = inventory.get(owner.key)
          if (previous?.id && owner.id && previous.id !== owner.id)
            throw new Error("Conflicting saved project owner identities")
          inventory.set(owner.key, {
            key: owner.key,
            id: owner.id ?? previous?.id,
            iteration: owner.iteration,
            stage: owner.stage,
            role: owner.role,
            ...(owner.attempt ? { attempt: owner.attempt } : {}),
            ...(owner.batch ? { batch: owner.batch } : {}),
            ...(owner.variant ? { variant: owner.variant } : {}),
          })
        }
        operation.owners = [...inventory.values()]
          .filter((owner) => action === "archive" || owner.iteration === operation.iteration)
          .map((owner) => ({ ...owner, status: "pending" }))
        await this.publish(project, operation)
        for (const owner of operation.owners) {
          try {
            if (!host) throw new Error("Owned conversation lifecycle is unavailable")
            let byKey: Awaited<ReturnType<OwnedLifecycle["read"]>>
            try {
              byKey = await host.read({ key: owner.key })
            } catch (error) {
              if (!options.retry || !incompleteOwnedArchive(error)) throw error
              // H3 intentionally refuses read() while its durable archive is
              // incomplete. Retry the intended project-scoped key, never a guessed
              // ID, then validate the returned immutable ID/key before settlement.
              await host.archive({ key: owner.key })
              byKey = await host.read({ key: owner.key })
            }
            if (!byKey && !owner.id) {
              // An intended key can legitimately have crashed before its first open.
              owner.status = "absent"
            } else {
              if (!byKey || byKey.key !== owner.key || (owner.id && byKey.id !== owner.id))
                throw new Error("Saved owner ID/key cannot be resolved safely")
              if (owner.id) {
                const byId = await host.read({ id: owner.id })
                if (!byId || byId.id !== byKey.id || byId.key !== owner.key)
                  throw new Error("Saved owner ID/key disagree")
              }
              owner.id = byKey.id
              await host.archive({ id: byKey.id })
              owner.status = "archived"
            }
          } catch (error) {
            owner.status = "failed"
            owner.error = text(error)
            operation.errors.push(`${owner.key}: ${owner.error}`)
          }
          await this.publish(project, operation)
        }
      } catch (error) {
        operation.errors.push(`Inventory/archive failed: ${text(error)}`)
      }
      if (host) {
        try {
          // H3 can settle late receipts after the pre-archive drain. Always replace
          // cumulative H1 snapshots, including after restart without a live account.
          await reconcileLifecycleCosts(this.api, project, operation.owners)
        } catch (error) {
          operation.errors.push(`Final accounting failed: ${text(error)}`)
        }
      }
      if (operation.errors.length) {
        operation.status = "failed"
        await this.publish(project, operation)
        return { project, operation: structuredClone(operation) }
      }
      // The settled receipt is published only after every drain/archive succeeded.
      project = await new LifecycleStore(project).transition(projectLifecycle(project).revision, {
        type: action === "close" ? "close" : "archived",
        receipt,
      })
      operation.status = "completed"
      await this.publish(project, operation)
      return { project, operation: structuredClone(operation) }
    } finally {
      active.delete(identity(project))
    }
  }
  /** Metadata only. All host owners, workers and historical approvals remain archived. */
  async restore(expectedRevision: number, receipt: LifecycleReceipt): Promise<Project> {
    return withProjectClaim(
      this.project,
      async (current) => {
        assertRevision(current, this.project, expectedRevision)
        validateReceipt(current, receipt)
        const previous = operations(
          await new ProjectDocumentStore(current).read(document),
          current,
        ).operations.at(-1)
        assertNotRunning(current, previous)
        if (previous && previous.status !== "completed")
          throw new Error("Settle the pending archive before restoring the project")
        return new LifecycleStore(current).transition(expectedRevision, { type: "restore", receipt })
      },
      { administrative: true },
    )
  }
  /** Local storage initialization only; never resumes an approval or starts an owner. */
  async nextIteration(expectedRevision: number, receipt: LifecycleReceipt): Promise<Project> {
    return withProjectClaim(
      this.project,
      async (current) => {
        assertRevision(current, this.project, expectedRevision)
        const previous = operations(
          await new ProjectDocumentStore(current).read(document),
          current,
        ).operations.at(-1)
        assertNotRunning(current, previous)
        if (previous && previous.status !== "completed")
          throw new Error("Settle the pending lifecycle operation before starting another iteration")
        return new LifecycleStore(current).transition(expectedRevision, { type: "next-iteration", receipt })
      },
      { administrative: true },
    )
  }
  /** Fresh approval of exact interrupted stage inputs; only eligible design/prototype may be unarchived, never workers. */
  async continueConversation(
    expectedRevision: number,
    receipt: LifecycleReceipt,
    options: LifecycleRetry = {},
  ): Promise<Project> {
    return withProjectClaim(
      this.project,
      async (current) => {
        assertRevision(current, this.project, expectedRevision)
        validateReceipt(current, receipt)
        if (options.retry) {
          current = await new LifecycleStore(current).recover()
          if (current.marker.currentIteration !== this.project.marker.currentIteration)
            throw new Error("Project iteration changed during continuation recovery")
          expectedRevision = projectLifecycle(current).revision
        }
        const lifecycle = projectLifecycle(current)
        if (
          lifecycle.status !== "active" ||
          lifecycle.iterations[current.marker.currentIteration]?.status !== "open"
        )
          throw new Error("Only a restored open iteration needs explicit continuation")
        const previous = operations(
          await new ProjectDocumentStore(current).read(document),
          current,
        ).operations.at(-1)
        assertNotRunning(current, previous)
        const retry =
          options.retry && previous?.action === "continue-conversation" && previous.status !== "completed"
        if (previous && previous.status !== "completed" && !retry)
          throw new Error(
            "Settle the pending lifecycle operation before continuing; explicitly confirm a retry",
          )
        if (
          retry &&
          !lifecycle.iterations[current.marker.currentIteration]?.continuationRequired &&
          JSON.stringify(lifecycle.receipt) === JSON.stringify(previous.receipt)
        ) {
          // The marker is the durable acknowledgement that all continuation effects
          // settled. Repair only the lost result record; do not repeat host work,
          // mutate stage evidence, or require a now-ineligible old worker.
          await this.publish(current, {
            ...previous,
            status: "completed",
            owners: previous.owners.map((owner) => ({ ...owner, status: "continued" })),
          })
          return current
        }
        const state = await readContinuationState(current)
        if (options.stageRevision !== undefined && state.revision !== options.stageRevision)
          throw new Error("Saved stage inputs changed during continuation confirmation")
        const host = ownedLifecycle(this.api)
        const eligible: RecoveredOwner[] = []
        if (state.stage === "design")
          eligible.push({
            key: `${current.marker.id}/design/${current.marker.currentIteration}`,
            iteration: current.marker.currentIteration,
            stage: "design",
            role: "conversation",
          })
        if (state.stage === "prototype" && !state.prototypeChoice && !state.pending) {
          const ref = state.artifacts.findLast((entry) => entry.kind === "prototype-manifest")
          const manifest = ref
            ? await new HistoricalIterationReader(current, current.marker.currentIteration).readArtifact(ref)
            : undefined
          if (manifest?.kind === "prototype-manifest") {
            const ledger = await new FileCostPersistence(current).read()
            const inventory = await recoverOwnerInventory(this.api, current, ledger, {
              includePredecessors: false,
            })
            for (const variant of manifest.variants) {
              if (await prototypeRemoval(current, current.marker.currentIteration, variant.directory))
                continue
              try {
                if (
                  !(await lstat(variant.directory)).isDirectory() ||
                  path.relative(variant.directory, await realpath(variant.directory))
                )
                  continue
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
                throw error
              }
              const saved = inventory.find(
                (owner) =>
                  owner.iteration === current.marker.currentIteration &&
                  owner.stage === "prototype" &&
                  owner.role === "variant" &&
                  owner.variant === variant.id,
              )
              eligible.push(
                saved ?? {
                  key: `${current.marker.id}/iteration/${current.marker.currentIteration}/prototype/${variant.id}`,
                  iteration: current.marker.currentIteration,
                  stage: "prototype",
                  role: "variant",
                  variant: variant.id,
                },
              )
            }
          }
        }
        const owners: LifecycleOwnerResult[] = []
        for (const candidate of eligible) {
          const saved = await host.read({ key: candidate.key })
          if (!saved) continue
          if (saved.key !== candidate.key || (candidate.id && saved.id !== candidate.id))
            throw new Error("Saved continuation conversation identity changed")
          if (saved.archived || retry) owners.push({ ...candidate, id: saved.id, status: "pending" })
        }
        if (!lifecycle.iterations[current.marker.currentIteration]?.continuationRequired && !owners.length)
          throw new Error("No archived conversation is eligible for continuation")
        const operation: ProjectLifecycleOperation = {
          id: randomUUID(),
          action: "continue-conversation",
          iteration: current.marker.currentIteration,
          receipt: structuredClone(receipt),
          status: "pending",
          pid: process.pid,
          owners,
          errors: [],
          stageRevision: state.revision,
          ...(state.approvedContext ? { context: structuredClone(state.approvedContext) } : {}),
        }
        await this.publish(current, operation)
        try {
          // Archive deliberately rejected late finalizer writes. Record a fresh
          // interruption under the still-closed restore fence before ordinary
          // writers reopen, so /project next can obtain normal fresh approval.
          if (
            lifecycle.iterations[current.marker.currentIteration]?.continuationRequired &&
            state.status === "working" &&
            state.phase === "running"
          )
            await new IterationStore(current).retireArchivedAttempt(state.revision)
          for (const owner of operation.owners) {
            await host.unarchive({ id: owner.id! })
            owner.status = "continued"
          }
          current = await new LifecycleStore(current).transition(expectedRevision, {
            type: "continue",
            receipt,
          })
          operation.status = "completed"
        } catch (error) {
          operation.status = "failed"
          operation.errors.push(text(error))
          await this.publish(current, operation)
          throw error
        }
        await this.publish(current, operation)
        return current
      },
      { administrative: true },
    )
  }
}
