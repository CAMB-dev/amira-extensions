import type {
  AccountedUsage,
  ConversationRuntime,
  ConversationSpec,
  ExtensionAPI,
  OwnedConversation,
  SpawnGroup,
} from "@amira/api"
import { type CostLedger, costRollups, ProjectCosts } from "./cost.ts"
import { FileCostPersistence } from "./cost-storage.ts"
import { recoverOwnerInventory } from "./owner-inventory.ts"
import { publishOwnerOpening } from "./owner-openings.ts"
import {
  assertProjectWritable,
  assertProjectWritableNow,
  type Project,
  projectLifecycle,
  readProject,
} from "./store.ts"

/** Stable attribution is fixed at first binding, never reassigned by a replacement plan. */
export interface OwnerAttribution {
  stage: "design" | "prototype" | "implement" | "accept" | "ship"
  role: string
  attempt?: string
  batch?: string
  variant?: string
}
interface AccountingOptions {
  defaultCapUsd?(): number | undefined
  changed?(project: Project, ledger: CostLedger): void
}
interface ActiveOwner {
  handle: OwnedConversation
  release(): Promise<void>
  stop(reason?: string): Promise<void>
  groups: Set<SpawnGroup>
  released: boolean
  operations: number
  tools: number
  draining: boolean
  releaseDrain?: Promise<void>
  drainFailed?: boolean
  children: Set<string>
}
const options = new WeakMap<ExtensionAPI, AccountingOptions>()
const accounts = new WeakMap<ExtensionAPI, Map<string, Promise<ProjectAccounting>>>()
const tracked = new WeakSet<OwnedConversation>()
const ownerAccounts = new WeakMap<OwnedConversation, ProjectAccounting>()
export interface AccountedRun {
  stop(reason: string): void
  drain(): Promise<void>
}
export function retainAccountedRun(handle: OwnedConversation, run: AccountedRun): () => void {
  return ownerAccounts.get(handle)?.retain(run) ?? (() => {})
}
export async function captureAccountedRun(
  handle: OwnedConversation,
  metadata: { groupId?: string; sessionIds?: string[]; run?: { kind: "workflow" | "swarm"; id: string } },
): Promise<void> {
  await ownerAccounts.get(handle)?.costs.discover(handle.key, metadata)
}
export function configureAccounting(api: ExtensionAPI, value: AccountingOptions): void {
  options.set(api, value)
}

export class ProjectAccounting {
  readonly costs: ProjectCosts
  private readonly active = new Map<string, ActiveOwner>()
  private readonly bindings = new Map<string, ActiveOwner>()
  private readonly runs = new Set<AccountedRun>()
  private readonly openings = new Set<Promise<void>>()
  private lifecycleStopped = false
  retain(run: AccountedRun): () => void {
    this.assertAdmission()
    this.runs.add(run)
    return () => this.runs.delete(run)
  }
  private stopping: Promise<void> = Promise.resolve()
  private drainFailure?: unknown
  private timer?: ReturnType<typeof setInterval>
  private refreshTask?: Promise<void>
  private disposed = false
  private lastError?: string
  private priceUnknown?: (usage: AccountedUsage["usage"]) => boolean
  constructor(
    private readonly api: ExtensionAPI,
    public project: Project,
  ) {
    this.costs = new ProjectCosts(project.marker.id, new FileCostPersistence(() => this.project), {
      stop: (reason) => this.stop(reason),
      notify: (text) => api.notify?.(text, "warning"),
      unpriced: (usage) => {
        if (!this.priceUnknown) throw new Error("Owned accounting pricing evidence has not initialized")
        return this.priceUnknown(usage)
      },
    })
  }
  async initialize(): Promise<void> {
    // Historical/storage display remains runtime-free. Load the host receipt
    // helper only when accounting starts, before any owned work is admitted.
    this.priceUnknown = (await import("@amira/ai/accounting")).hasUnpricedUsage
    // Prior main-bound side calls cannot be reconstructed or priced from token totals.
    const lifecycle = projectLifecycle(this.project)
    const writable =
      lifecycle.status === "active" &&
      lifecycle.iterations[this.project.marker.currentIteration]?.status === "open" &&
      !lifecycle.iterations[this.project.marker.currentIteration]?.continuationRequired
    await this.costs.load(true, writable ? options.get(this.api)?.defaultCapUsd?.() : undefined, {
      initializePolicy: writable,
    })
    for (const owner of await recoverOwnerInventory(this.api, this.project, this.costs.snapshot())) {
      const { key, id, ...attribution } = owner
      await this.costs.intent(key, attribution, "recovered")
      if (id) await this.costs.bind(key, id)
    }
    await this.reconcile()
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => this.report(error))
    }, 5000)
    this.timer.unref?.()
  }
  private report(error: unknown): void {
    const text = `Project accounting unavailable: ${error instanceof Error ? error.message : String(error)}`
    if (text === this.lastError) return
    this.lastError = text
    this.api.notify?.(text, "warning")
  }
  private changed(): void {
    options.get(this.api)?.changed?.(this.project, this.costs.snapshot())
    this.api.requestRender?.()
  }
  private stop(reason: string): void {
    // This path runs synchronously from usage invalidation, before ledger IO.
    const pending: Promise<unknown>[] = []
    for (const run of this.runs) {
      try {
        run.stop(reason)
      } catch (error) {
        pending.push(Promise.reject(error))
      }
      try {
        pending.push(run.drain())
      } catch (error) {
        pending.push(Promise.reject(error))
      }
    }
    for (const [key, owner] of this.active) {
      if (owner.released && !owner.drainFailed) continue
      const previouslyReleased = owner.released
      owner.released = true
      owner.drainFailed = false
      const drainage: Promise<unknown>[] = []
      for (const group of owner.groups) {
        try {
          group.end(reason)
          drainage.push(group.ended())
        } catch (error) {
          drainage.push(Promise.reject(error))
        }
      }
      if (!previouslyReleased) {
        try {
          drainage.push(owner.stop(reason))
        } catch (error) {
          drainage.push(Promise.reject(error))
        }
      }
      // Cancellation/release never waits for ledger reads or writes, and one failure
      // cannot interrupt cancellation of subsequent project owners.
      try {
        drainage.push(owner.release())
      } catch (error) {
        drainage.push(Promise.reject(error))
      }
      pending.push(
        Promise.allSettled(drainage).then((results) => {
          const failure = results.find((result) => result.status === "rejected")
          if (failure?.status === "rejected") {
            owner.drainFailed = true
            throw failure.reason
          }
          if (this.active.get(key) === owner) this.active.delete(key)
        }),
      )
    }
    this.drainFailure = undefined
    this.stopping = Promise.allSettled(pending).then(async (results) => {
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") {
        this.drainFailure = failure.reason
        throw failure.reason
      }
      await this.reconcile()
      this.changed()
    })
    void this.stopping.catch((error) => this.report(error))
  }
  assertAdmission(): void {
    if (this.disposed) throw new Error("Project accounting has unloaded")
    if (this.lifecycleStopped) throw new Error("Project work was stopped for lifecycle settlement")
    this.costs.assertAdmission()
  }
  async intent(key: string, attribution: OwnerAttribution): Promise<void> {
    await assertProjectWritable(this.project)
    const current = await readProject(this.project.root, this.project.marker.id)
    if (current.marker.currentIteration !== this.project.marker.currentIteration)
      throw new Error("Project iteration changed before opening work")
    this.assertAdmission()
    await this.costs.intent(key, { ...attribution, iteration: this.project.marker.currentIteration })
    this.assertAdmission()
  }
  async inventory(attribution: OwnerAttribution, ref: { id: string; key: string }): Promise<void> {
    await this.costs.intent(
      ref.key,
      { ...attribution, iteration: this.project.marker.currentIteration },
      "recovered",
    )
    await this.costs.bind(ref.key, ref.id)
    await this.refresh(ref.key)
  }
  private pending(key: string): { pending: boolean; pendingSessions: string[]; draining?: boolean } {
    const owner = this.bindings.get(key)
    const none = { pending: false, pendingSessions: [] }
    if (!owner) return none
    if (owner.draining) return { ...none, pending: true, draining: true }
    if (owner.released) return none
    const pendingSessions = new Set(owner.children)
    for (const group of owner.groups) {
      try {
        if (typeof group.children === "function")
          for (const child of group.children()) {
            if (child.state === "queued" || child.state === "working") pendingSessions.add(child.id)
            else pendingSessions.delete(child.id)
          }
      } catch {
        /* Released groups do not provide live request authority. */
      }
    }
    return {
      pending: owner.operations > 0 || (owner.tools === 0 && owner.handle.status().busy),
      pendingSessions: [...pendingSessions],
    }
  }
  async refresh(key: string, handle?: OwnedConversation): Promise<void> {
    try {
      const pending = this.pending(key)
      if (handle && typeof handle.usage === "function") await this.costs.observe(key, handle.usage(), pending)
      else if (typeof this.api.conversations?.read === "function") {
        const snapshot = await this.api.conversations.read({ key })
        if (snapshot) {
          await this.costs.bind(key, snapshot.id)
          await this.costs.observe(key, snapshot.usage, pending)
        } else {
          const owner = this.costs.snapshot().owners.find((owner) => owner.key === key)
          if (owner?.id || owner?.provenance === "recovered") await this.costs.unavailable(key)
        }
      } else await this.costs.unavailable(key)
    } catch (error) {
      await this.costs.unavailable(key)
      throw error
    } finally {
      this.changed()
    }
  }
  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.refreshTask) return this.refreshTask
    const task = (async () => {
      for (const owner of this.costs.snapshot().owners) {
        const active = this.active.get(owner.key)
        await this.refresh(owner.key, active && !active.released ? active.handle : undefined)
      }
      await this.costs.flush()
      this.lastError = undefined
    })()
    this.refreshTask = task
    const clear = () => {
      if (this.refreshTask === task) this.refreshTask = undefined
    }
    void task.then(clear, clear)
    return task
  }
  async track(handle: OwnedConversation): Promise<OwnedConversation> {
    if (tracked.has(handle)) return handle
    await this.costs.bind(handle.key, handle.id)
    const originalRelease = handle.release.bind(handle)
    const originalStop = handle.stop.bind(handle)
    const originalSend = handle.send.bind(handle)
    const originalTool = handle.runTool?.bind(handle)
    const originalComplete = handle.complete?.bind(handle)
    const originalGroup = handle.createGroup?.bind(handle)
    const owner: ActiveOwner = {
      handle,
      release: () => {
        if (!owner.releaseDrain) {
          owner.draining = true
          try {
            owner.releaseDrain = Promise.resolve(originalRelease())
          } catch (error) {
            owner.releaseDrain = Promise.reject(error)
          }
          owner.releaseDrain = owner.releaseDrain
            .catch((error) => {
              owner.releaseDrain = undefined
              throw error
            })
            .finally(() => {
              owner.draining = false
              owner.children.clear()
            })
        }
        return owner.releaseDrain
      },
      stop: originalStop,
      groups: new Set(),
      released: false,
      operations: 0,
      tools: 0,
      draining: false,
      children: new Set(),
    }
    this.active.set(handle.key, owner)
    this.bindings.set(handle.key, owner)
    const capturedProject = structuredClone(this.project)
    const guard = () => {
      this.assertAdmission()
      if (owner.released) throw new Error("Project owner was released; explicitly reopen after continuation")
      assertProjectWritableNow(capturedProject)
    }
    const admission = async () => {
      guard()
      await assertProjectWritable(capturedProject)
      guard()
    }
    const finish = async () => {
      await this.refresh(handle.key, owner.released ? undefined : handle)
      await this.costs.flush()
    }
    // Keep the host object identity (native focus has identity-bound capabilities).
    handle.send = async (...args) => {
      await admission()
      owner.operations++
      try {
        return await originalSend(...args)
      } finally {
        owner.operations--
        await finish()
      }
    }
    if (originalTool)
      handle.runTool = async (...args) => {
        await admission()
        owner.tools++
        try {
          return await originalTool(...args)
        } finally {
          owner.tools--
          await finish()
        }
      }
    if (originalComplete)
      handle.complete = async (...args) => {
        await admission()
        owner.operations++
        try {
          return await originalComplete(...args)
        } finally {
          owner.operations--
          await finish()
        }
      }
    if (originalGroup)
      handle.createGroup = (groupOptions) => {
        guard()
        const ledger = this.costs.snapshot()
        const cap = ledger.policy.capUsd
        const remaining =
          cap === undefined || ledger.policy.continuedThroughUsd !== undefined
            ? undefined
            : Math.max(0, cap - costRollups(ledger).project.knownCostUsd)
        const group = originalGroup(
          remaining === undefined
            ? groupOptions
            : {
                ...groupOptions,
                budget: {
                  ...groupOptions.budget,
                  costUsd: Math.min(groupOptions.budget?.costUsd ?? Infinity, remaining),
                },
              },
        )
        owner.groups.add(group)
        void group
          .ended()
          .then(() => this.refresh(handle.key, owner.released ? undefined : handle))
          .catch((error) => this.report(error))
        void this.costs.discover(handle.key, { groupId: group.id }).catch((error) => this.report(error))
        const spawn = group.spawn.bind(group)
        group.spawn = (...args) => {
          guard()
          const child = spawn(...args)
          void this.costs
            .discover(handle.key, { sessionIds: [child.id] })
            .catch((error) => this.report(error))
          return child
        }
        return group
      }
    handle.stop = async (reason) => {
      if (owner.released) {
        await owner.releaseDrain
        return
      }
      try {
        await originalStop(reason)
      } finally {
        await finish()
      }
    }
    handle.release = async () => {
      if (owner.released) {
        await owner.releaseDrain
        return
      }
      owner.released = true
      if (this.active.get(handle.key) === owner) this.active.delete(handle.key)
      // Fence first; host release must run even when accounting is unavailable.
      try {
        await owner.release()
      } finally {
        await this.refresh(handle.key)
        await this.costs.flush()
      }
    }
    tracked.add(handle)
    ownerAccounts.set(handle, this)
    if (handle.events?.[Symbol.asyncIterator]) {
      void (async () => {
        try {
          for await (const event of handle.events) {
            // Lost start/end observations cannot certify a child's live state.
            // Retained groups are re-snapshotted below instead of trusting stale IDs.
            if (event.type === "events.lost") owner.children.clear()
            if (event.type === "subagent.start") owner.children.add(event.data.childSessionId)
            if (event.type === "subagent.state") {
              if (event.data.state === "idle") owner.children.delete(event.data.childSessionId)
              else owner.children.add(event.data.childSessionId)
            }
            if (event.type === "subagent.end") owner.children.delete(event.data.childSessionId)
            // Shared budget payloads are invalidations only, never project spend.
            if (
              ["budget.update", "events.lost", "subagent.end", "subagent.state", "turn.end"].includes(
                event.type,
              )
            )
              await this.refresh(handle.key, owner.released ? undefined : handle)
          }
        } catch (error) {
          if (!this.disposed) this.report(error)
        }
      })()
    }
    await this.refresh(handle.key, handle)
    guard()
    return handle
  }
  /** Track an admitted open through binding/release so closure cannot miss an in-flight key. */
  async openOwner(open: () => Promise<OwnedConversation>): Promise<OwnedConversation> {
    this.assertAdmission()
    assertProjectWritableNow(this.project)
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const drain = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    this.openings.add(drain)
    void drain.catch(() => {})
    let handle: OwnedConversation | undefined
    try {
      handle = await open()
      this.assertAdmission()
      assertProjectWritableNow(this.project)
      return await this.track(handle)
    } catch (error) {
      try {
        await handle?.release()
      } catch (releaseError) {
        reject(releaseError)
        throw releaseError
      }
      throw error
    } finally {
      resolve()
      this.openings.delete(drain)
    }
  }
  /** Fences synchronously, cancels providers/owners, drains openings, then reconciles H1. */
  async stopAndDrain(reason = "Project lifecycle settlement"): Promise<void> {
    this.lifecycleStopped = true
    if (this.timer) clearInterval(this.timer)
    // A preceding budget stop may still own an in-flight release. Wait for that
    // attempt before retrying it, rather than overwriting its drainage promise.
    await this.stopping.catch(() => {})
    this.stop(reason)
    const results = await Promise.allSettled([this.settled(), ...this.openings])
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
    this.disposed = true
    accounts.get(this.api)?.delete(`${this.project.root}/${this.project.marker.id}`)
  }
  async settled(): Promise<void> {
    try {
      await this.stopping
    } catch (error) {
      if (this.drainFailure) throw error
      // A prior accounting failure is recoverable once storage returns. Host
      // drainage failures are not silently waived by an accounting retry.
    }
    await this.reconcile()
    this.stopping = Promise.resolve()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.timer) clearInterval(this.timer)
    this.stop("Project extension unloaded")
    await this.stopping
    this.disposed = true
  }
}
export async function projectAccounting(api: ExtensionAPI, project: Project): Promise<ProjectAccounting> {
  let map = accounts.get(api)
  if (!map) {
    map = new Map()
    accounts.set(api, map)
  }
  const identity = `${project.root}/${project.marker.id}`
  let entry = map.get(identity)
  if (!entry) {
    const accounting = new ProjectAccounting(api, project)
    entry = accounting.initialize().then(() => accounting)
    map.set(identity, entry)
    void entry.catch(() => {
      if (map!.get(identity) === entry) map!.delete(identity)
    })
  }
  const accounting = await entry
  accounting.project = project
  return accounting
}
/** An inert lookup: never initializes accounting or creates a ledger for historical inspection. */
export async function cachedProjectAccounting(
  api: ExtensionAPI,
  project: Project,
): Promise<ProjectAccounting | undefined> {
  return accounts.get(api)?.get(`${project.root}/${project.marker.id}`)
}
/** Explicit lifecycle administration: runtime-free H1 reconciliation after H3 has drained owners.
 * No timer, defaults, owner open, model resolution or execution admission is introduced. */
export async function reconcileLifecycleCosts(
  api: ExtensionAPI,
  project: Project,
  owners: readonly import("./owner-inventory.ts").RecoveredOwner[],
): Promise<void> {
  const costs = new ProjectCosts(project.marker.id, new FileCostPersistence(project), {
    stop() {},
    notify() {},
  })
  await costs.load(true, undefined, { initializePolicy: false })
  for (const owner of owners) {
    const { key, id, iteration, stage, role, attempt, batch, variant } = owner
    await costs.intent(
      key,
      {
        iteration,
        stage,
        role,
        ...(attempt ? { attempt } : {}),
        ...(batch ? { batch } : {}),
        ...(variant ? { variant } : {}),
      },
      "recovered",
    )
    const snapshot = await api.conversations!.read({ key })
    if (!snapshot) {
      if (id) await costs.unavailable(key)
      continue
    }
    if (snapshot.key !== key || (id && snapshot.id !== id))
      throw new Error("Lifecycle accounting owner identity changed")
    await costs.bind(key, snapshot.id)
    await costs.observe(key, snapshot.usage, { pending: false, pendingSessions: [] })
  }
  await costs.flush()
}

export async function disposeAccounting(api: ExtensionAPI): Promise<void> {
  const all = accounts.get(api)
  accounts.delete(api)
  if (all) await Promise.allSettled([...all.values()].map(async (entry) => (await entry).dispose()))
}
export async function inventoryAccounted(
  api: ExtensionAPI,
  project: Project,
  attribution: OwnerAttribution,
  ref: { id: string; key: string },
): Promise<void> {
  await (await projectAccounting(api, project)).inventory(attribution, ref)
}
export async function openAccounted(
  api: ExtensionAPI,
  project: Project,
  attribution: OwnerAttribution,
  spec: ConversationSpec,
  runtime: ConversationRuntime,
): Promise<OwnedConversation> {
  const accounting = await projectAccounting(api, project)
  await accounting.intent(spec.key, attribution)
  return accounting.openOwner(() =>
    publishOwnerOpening(project, spec.key, () => api.conversations!.openOrCreate(spec, runtime)),
  )
}
export async function reopenAccounted(
  api: ExtensionAPI,
  project: Project,
  attribution: OwnerAttribution,
  ref: { id: string; key: string },
  runtime: ConversationRuntime,
): Promise<OwnedConversation> {
  const accounting = await projectAccounting(api, project)
  await accounting.inventory(attribution, ref)
  await accounting.intent(ref.key, attribution)
  return accounting.openOwner(() =>
    publishOwnerOpening(project, ref.key, () => api.conversations!.open(ref.id, runtime)),
  )
}
