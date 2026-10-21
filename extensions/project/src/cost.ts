import { createHash } from "node:crypto"
import type { AccountedUsage, ConversationUsageSnapshot } from "@amira/api"
import { localize } from "./language.ts"

export interface CostAttribution {
  iteration: number
  stage: "design" | "prototype" | "implement" | "accept" | "ship"
  role: string
  attempt?: string
  batch?: string
  variant?: string
}
export interface CostOwner extends CostAttribution {
  key: string
  id?: string
  provenance: "owned" | "recovered"
  groups: string[]
  sessions: string[]
  runs: { kind: "workflow" | "swarm"; id: string }[]
  snapshot?: ConversationUsageSnapshot
  unavailable?: boolean
  /** Capture live pricing provenance before cloning loses host aggregate sidecars. */
  coverage?: {
    pending: boolean
    pendingSessions?: string[]
    settled?: { sessionId: string; evidence: string; fingerprint: string }[]
    unpriced: boolean
    /** Last settled gap; opening a request fence must not invalidate its acknowledgement. */
    unknown?: string
  }
}
export interface CostReceipt {
  sessionId?: string
  action: "cap" | "raise" | "remove" | "continue" | "acknowledge-unpriced"
  at: string
  cap?: number
  knownCostUsd: number
  unknownFingerprint?: string
}
export interface CostLedger {
  schemaVersion: 1
  projectId: string
  revision: number
  coverage: { since: string; legacyIncomplete: boolean; policyInitialized?: boolean }
  owners: CostOwner[]
  policy: {
    capUsd?: number
    warned: boolean
    latch?: { reason: "cap" | "unpriced" | "accounting"; at: string; version: number }
    continuedThroughUsd?: number
    acknowledgedUnknown?: string
  }
  receipts: CostReceipt[]
}
export class CostRevisionConflict extends Error {
  constructor() {
    super(
      "Project cost ledger changed in another writer. Reload the project extension, then run /project cost again. The stale cached revision will not be retried or overwrite ledger evidence.",
    )
    this.name = "CostRevisionConflict"
  }
}

export interface CostPersistence {
  read(): Promise<CostLedger | undefined>
  /** Compare-and-swap; a competing writer must fail, not overwrite evidence. */
  save(ledger: CostLedger, expectedRevision: number | undefined, administrative?: boolean): Promise<void>
}
export interface CostRollup {
  knownCostUsd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  complete: boolean
  estimated: boolean
  pending: boolean
  unknown: boolean
}
const emptyRollup = (): CostRollup => ({
  knownCostUsd: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  complete: true,
  estimated: false,
  pending: false,
  unknown: false,
})
function add(to: CostRollup, value: AccountedUsage): void {
  to.knownCostUsd += value.knownCostUsd
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) to[field] += value.usage[field]
  to.complete &&= value.complete
  to.estimated ||= value.usage.pricingUnknown === true
}
export function costRollups(ledger: CostLedger) {
  const project = emptyRollup()
  project.complete = !ledger.coverage.legacyIncomplete
  project.unknown = ledger.coverage.legacyIncomplete
  const iterations: Record<string, CostRollup> = {}
  const stages: Record<string, CostRollup> = {}
  const sessions: Record<string, CostRollup> = {}
  // The host's own + descendant rows are disjoint. Never add total/group/provider totals.
  const seen = new Set<string>()
  for (const owner of ledger.owners) {
    iterations[owner.iteration] ??= emptyRollup()
    stages[`${owner.iteration}/${owner.stage}`] ??= emptyRollup()
    const iteration = iterations[owner.iteration]!
    const stage = stages[`${owner.iteration}/${owner.stage}`]!
    const pending = owner.coverage?.pending ?? false
    const unknown =
      owner.unavailable === true || owner.coverage?.unpriced === true || ownerUnknown(owner) !== undefined
    for (const rollup of [project, iteration, stage]) {
      rollup.pending ||= pending
      rollup.unknown ||= unknown
    }
    if (!owner.snapshot || owner.unavailable) {
      // An intended owner cannot spend before its first usage read and admission.
      if (!owner.snapshot && owner.provenance === "owned" && !owner.unavailable) continue
      project.complete = iteration.complete = stage.complete = false
      if (!owner.snapshot) continue
    }
    const snapshot = owner.snapshot!
    for (const row of [{ sessionId: snapshot.sessionId, usage: snapshot.own }, ...snapshot.descendants]) {
      if (seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      const session = emptyRollup()
      session.pending =
        !row.usage.complete && (owner.coverage?.pendingSessions?.includes(row.sessionId) ?? pending)
      session.unknown =
        row.usage.usage.pricingUnknown === true ||
        (!row.usage.complete && (!session.pending || owner.coverage?.unpriced === true))
      sessions[row.sessionId] = session
      for (const rollup of [project, iteration, stage, session]) add(rollup, row.usage)
    }
    if (!snapshot.total.complete) project.complete = iteration.complete = stage.complete = false
  }
  return { project, iterations, stages, sessions }
}
const fingerprintOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const usageRows = (snapshot: ConversationUsageSnapshot) => [
  snapshot.total,
  snapshot.own,
  ...snapshot.descendants.map((child) => child.usage),
]
function ownerUnknown(owner: CostOwner): string | undefined {
  if (owner.unavailable) return fingerprintOf(["unavailable", owner.key, owner.snapshot])
  if (owner.coverage) return owner.coverage.unknown
  // Legacy ledgers have no captured pricing provenance. Reconcile them rather
  // than certifying incomplete, serialized evidence as fully priced.
  if (
    (!owner.snapshot && owner.provenance === "recovered") ||
    (owner.snapshot &&
      usageRows(owner.snapshot).some((row) => !row.complete || row.usage.pricingUnknown === true))
  )
    return fingerprintOf([owner.key, owner.snapshot])
  return undefined
}
function unknownFingerprint(ledger: CostLedger): string | undefined {
  const unknown = ledger.owners.flatMap((owner) => {
    const gap = ownerUnknown(owner)
    return gap ? [[owner.key, gap]] : []
  })
  if (!ledger.coverage.legacyIncomplete && !unknown.length) return undefined
  return fingerprintOf([ledger.coverage.legacyIncomplete, unknown])
}
function validUsage(value: unknown): value is AccountedUsage {
  if (!value || typeof value !== "object") return false
  const row = value as AccountedUsage
  return (
    typeof row.complete === "boolean" &&
    Number.isFinite(row.knownCostUsd) &&
    !!row.usage &&
    [row.usage.input, row.usage.output, row.usage.cacheRead, row.usage.cacheWrite].every(Number.isFinite)
  )
}
export function validateCostLedger(value: unknown, projectId: string): asserts value is CostLedger {
  const row = value as CostLedger | undefined
  if (
    row?.schemaVersion !== 1 ||
    row.projectId !== projectId ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    !row.coverage ||
    typeof row.coverage.since !== "string" ||
    typeof row.coverage.legacyIncomplete !== "boolean" ||
    (row.coverage.policyInitialized !== undefined && typeof row.coverage.policyInitialized !== "boolean") ||
    !row.policy ||
    typeof row.policy.warned !== "boolean" ||
    !Array.isArray(row.owners) ||
    !Array.isArray(row.receipts)
  )
    throw new Error("Unsupported or malformed project cost ledger; evidence was not changed.")
  if (row.policy.capUsd !== undefined && (!Number.isFinite(row.policy.capUsd) || row.policy.capUsd <= 0))
    throw new Error("Invalid project cap in cost ledger.")
  const policy = row.policy
  const finite = (number: unknown) => typeof number === "number" && Number.isFinite(number)
  const fingerprint = (text: unknown) => typeof text === "string" && /^[a-f0-9]{64}$/.test(text)
  const date = (text: unknown) => typeof text === "string" && Number.isFinite(Date.parse(text))
  if (
    !date(row.coverage.since) ||
    (policy.continuedThroughUsd !== undefined && !finite(policy.continuedThroughUsd)) ||
    (policy.acknowledgedUnknown !== undefined && !fingerprint(policy.acknowledgedUnknown)) ||
    (policy.latch !== undefined &&
      (!policy.latch ||
        !["cap", "unpriced", "accounting"].includes(policy.latch.reason) ||
        !date(policy.latch.at) ||
        !Number.isSafeInteger(policy.latch.version) ||
        policy.latch.version < 0)) ||
    row.receipts.some(
      (receipt) =>
        !receipt ||
        !["cap", "raise", "remove", "continue", "acknowledge-unpriced"].includes(receipt.action) ||
        !date(receipt.at) ||
        (receipt.sessionId !== undefined && (typeof receipt.sessionId !== "string" || !receipt.sessionId)) ||
        !finite(receipt.knownCostUsd) ||
        (receipt.cap !== undefined && (!finite(receipt.cap) || receipt.cap <= 0)) ||
        (receipt.unknownFingerprint !== undefined && !fingerprint(receipt.unknownFingerprint)),
    )
  )
    throw new Error("Malformed project cost policy or continuation receipt; evidence was not changed.")
  const keys = new Set<string>()
  const ids = new Set<string>()
  for (const owner of row.owners) {
    if (
      typeof owner.key !== "string" ||
      !owner.key ||
      keys.has(owner.key) ||
      (owner.id !== undefined && (typeof owner.id !== "string" || !owner.id || ids.has(owner.id))) ||
      !["owned", "recovered"].includes(owner.provenance) ||
      !Number.isSafeInteger(owner.iteration) ||
      owner.iteration < 1 ||
      !["design", "prototype", "implement", "accept", "ship"].includes(owner.stage) ||
      typeof owner.role !== "string" ||
      !owner.role ||
      [owner.attempt, owner.batch, owner.variant].some(
        (value) => value !== undefined && (typeof value !== "string" || !value),
      ) ||
      !Array.isArray(owner.groups) ||
      owner.groups.some((id) => typeof id !== "string" || !id) ||
      !Array.isArray(owner.sessions) ||
      owner.sessions.some((id) => typeof id !== "string" || !id) ||
      !Array.isArray(owner.runs) ||
      owner.runs.some(
        (run) => !run || !["workflow", "swarm"].includes(run.kind) || typeof run.id !== "string" || !run.id,
      )
    )
      throw new Error("Malformed or duplicate cost owner binding.")
    keys.add(owner.key)
    if (owner.id) ids.add(owner.id)
    if (
      owner.coverage &&
      (typeof owner.coverage.pending !== "boolean" ||
        (owner.coverage.pendingSessions !== undefined &&
          (!Array.isArray(owner.coverage.pendingSessions) ||
            owner.coverage.pendingSessions.some((id) => typeof id !== "string" || !id))) ||
        (owner.coverage.settled !== undefined &&
          (!Array.isArray(owner.coverage.settled) ||
            owner.coverage.settled.some(
              (gap) =>
                !gap ||
                typeof gap.sessionId !== "string" ||
                !gap.sessionId ||
                !fingerprint(gap.evidence) ||
                !fingerprint(gap.fingerprint),
            ))) ||
        typeof owner.coverage.unpriced !== "boolean" ||
        (owner.coverage.unknown !== undefined && !fingerprint(owner.coverage.unknown)))
    )
      throw new Error("Malformed project coverage evidence.")
    if (
      owner.snapshot &&
      (!Number.isSafeInteger(owner.snapshot.revision) ||
        owner.snapshot.revision < 0 ||
        !owner.snapshot.sessionId ||
        !validUsage(owner.snapshot.own) ||
        !validUsage(owner.snapshot.total) ||
        !Array.isArray(owner.snapshot.descendants) ||
        owner.snapshot.descendants.some((child) => !child.sessionId || !validUsage(child.usage)))
    )
      throw new Error("Malformed project usage snapshot.")
  }
}

export function initialCostLedger(projectId: string, since: string, legacyIncomplete = false): CostLedger {
  return {
    schemaVersion: 1,
    projectId,
    revision: 0,
    coverage: { since, legacyIncomplete, policyInitialized: false },
    owners: [],
    policy: { warned: false },
    receipts: [],
  }
}

/** Durable project policy, independent of stage approval revisions and UI subscriptions. */
export class ProjectCosts {
  private ledger?: CostLedger
  private persistedRevision?: number
  private queue: Promise<void> = Promise.resolve()
  private failed?: unknown
  private generation = 0
  private persistedGeneration = 0
  private stopping = false
  private policyChanging = false
  constructor(
    private readonly projectId: string,
    private readonly persistence: CostPersistence,
    private readonly hooks: {
      stop(reason: string): void
      notify(message: string): void
      unpriced?(usage: AccountedUsage["usage"]): boolean
    },
  ) {}
  private unpriced(row: AccountedUsage): boolean {
    return row.usage.pricingUnknown === true || this.hooks.unpriced?.(row.usage) === true
  }
  async load(
    legacyIncomplete = false,
    defaultCapUsd?: number,
    options: { initializePolicy?: boolean } = {},
  ): Promise<void> {
    if (this.ledger) return
    if (options.initializePolicy === false) defaultCapUsd = undefined
    const saved = await this.persistence.read()
    if (saved) {
      validateCostLedger(saved, this.projectId)
      this.ledger = structuredClone(saved)
      this.persistedRevision = saved.revision
    } else {
      this.ledger = {
        schemaVersion: 1,
        projectId: this.projectId,
        revision: 0,
        coverage: {
          since: new Date().toISOString(),
          legacyIncomplete,
          ...(options.initializePolicy === false ? { policyInitialized: false } : {}),
        },
        owners: [],
        policy: { warned: false, ...(defaultCapUsd ? { capUsd: defaultCapUsd } : {}) },
        receipts: [],
      }
    }
    const initializePolicy =
      this.state.coverage.policyInitialized === false && options.initializePolicy !== false
    if (initializePolicy) {
      this.state.coverage.policyInitialized = true
      if (defaultCapUsd !== undefined) this.state.policy.capUsd = defaultCapUsd
    }
    const before = JSON.stringify(this.state.policy)
    this.evaluate()
    if (!saved || initializePolicy || before !== JSON.stringify(this.state.policy))
      await this.persist(defaultCapUsd === undefined || (!!saved && !initializePolicy))
  }
  snapshot(): CostLedger {
    if (!this.ledger) throw new Error("Project accounting has not loaded.")
    return structuredClone(this.ledger)
  }
  private get state(): CostLedger {
    if (!this.ledger) throw new Error("Project accounting has not loaded.")
    return this.ledger
  }
  assertAdmission(): void {
    if (this.failed instanceof CostRevisionConflict) throw this.failed
    if (this.policyChanging) throw new Error("Project cost policy is being saved; retry after it settles.")
    if (this.failed)
      throw new Error(
        "Project accounting could not be saved or reconciled. Retry /project cost before starting work.",
      )
    // Starting another owned operation/group is itself a safe boundary. Do not
    // admit new work over positively unpriced receipts merely because a sibling
    // request is still pending; pending-only fences never enter this path.
    if (
      this.state.policy.capUsd !== undefined &&
      this.state.owners.some((owner) => owner.coverage?.pending && owner.coverage.unpriced)
    ) {
      let changed = false
      for (const owner of this.state.owners) {
        if (!owner.coverage?.pending || !owner.coverage.unpriced || owner.coverage.unknown) continue
        const gap = fingerprintOf([owner.snapshot, true])
        if (owner.coverage.unknown !== gap) {
          owner.coverage.unknown = gap
          changed = true
        }
      }
      this.evaluate()
      if (changed) void this.persist().catch(() => {}) // Persistence failures retain their admission fence.
    }
    if (this.state.policy.latch)
      throw new Error(
        `Project work stopped (${this.state.policy.latch.reason}). Use /project cost continue, raise <USD>, or remove.`,
      )
  }
  private evaluate(): void {
    const ledger = this.state
    const policy = ledger.policy
    const cap = policy.capUsd
    if (cap === undefined) return
    const cost = costRollups(ledger).project.knownCostUsd
    let reason: "cap" | "unpriced" | undefined
    if (cost >= cap && (policy.continuedThroughUsd === undefined || cost > policy.continuedThroughUsd))
      reason = "cap"
    const fingerprint = unknownFingerprint(ledger)
    if (!reason && fingerprint && fingerprint !== policy.acknowledgedUnknown) reason = "unpriced"
    if (reason && !policy.latch) {
      policy.latch = { reason, at: new Date().toISOString(), version: ledger.revision + 1 }
      // Fence and abort immediately, before any durable write or prompt.
      if (!this.stopping) {
        this.stopping = true
        this.hooks.stop(reason === "cap" ? "Project cap reached" : "Project pricing is incomplete")
      }
      this.hooks.notify(
        reason === "cap"
          ? "Project cap reached. Work stopped; use /project cost to review and explicitly continue, raise, or remove the cap."
          : "Project costs include unpriced or incomplete usage. Work stopped; configure pricing or explicitly acknowledge it with /project cost continue.",
      )
    }
    if (!policy.warned && cost >= cap * 0.8) {
      policy.warned = true
      this.hooks.notify(`Project spend reached 80% of the $${cap.toFixed(2)} cap.`)
    }
  }
  private persist(administrative = true): Promise<void> {
    if (this.failed instanceof CostRevisionConflict) return Promise.reject(this.failed)
    const generation = ++this.generation
    const next = this.snapshot()
    const write = this.queue
      .then(async () => {
        if (this.failed instanceof CostRevisionConflict) throw this.failed
        next.revision = (this.persistedRevision ?? -1) + 1
        await this.persistence.save(next, this.persistedRevision, administrative)
        this.persistedRevision = next.revision
        this.state.revision = next.revision
        this.persistedGeneration = generation
        if (this.generation === generation) this.failed = undefined
      })
      .catch((error: unknown) => {
        this.failed = error
        this.generation++
        if (this.state.policy.capUsd !== undefined && !this.stopping) {
          this.state.policy.latch ??= {
            reason: "accounting",
            at: new Date().toISOString(),
            version: this.state.revision + 1,
          }
          this.stopping = true
          this.hooks.stop("Project accounting persistence failed")
        }
        throw error
      })
    this.queue = write.catch(() => {})
    return write
  }
  async intent(
    key: string,
    attribution: CostAttribution,
    provenance: CostOwner["provenance"] = "owned",
    options: { administrative?: boolean } = {},
  ): Promise<void> {
    if (this.state.owners.some((owner) => owner.key === key)) {
      await this.flush()
      return
    }
    this.state.owners.push({ key, ...attribution, provenance, groups: [], sessions: [], runs: [] })
    // Do not treat a newly intended, never-opened owner as an unpriced request.
    await this.persist(provenance === "recovered" || options.administrative === true)
  }
  async bind(key: string, id: string): Promise<void> {
    const owner = this.owner(key)
    if (
      (owner.id && owner.id !== id) ||
      this.state.owners.some((other) => other.key !== key && other.id === id)
    )
      throw new Error("Project conversation identity changed or is already bound.")
    if (owner.id === id) return
    owner.id = id
    await this.persist()
  }
  private owner(key: string): CostOwner {
    const owner = this.state.owners.find((entry) => entry.key === key)
    if (!owner) throw new Error("Conversation key must be inventoried before opening.")
    return owner
  }
  observe(
    key: string,
    snapshot: ConversationUsageSnapshot,
    context: { pending?: boolean; pendingSessions?: readonly string[]; draining?: boolean } = {},
  ): Promise<void> {
    const owner = this.owner(key)
    if (owner.id && owner.id !== snapshot.sessionId)
      return Promise.reject(new Error("Usage belongs to a different owner."))
    try {
      validateCostLedger({ ...this.state, owners: [{ ...owner, snapshot }] }, this.projectId)
    } catch (error) {
      return Promise.reject(error)
    }
    if (owner.snapshot && snapshot.revision < owner.snapshot.revision) return Promise.resolve()
    const rows = usageRows(snapshot)
    const entries = [{ sessionId: snapshot.sessionId, usage: snapshot.own }, ...snapshot.descendants]
    const pendingSessions = new Set(context.pendingSessions ?? [])
    if (context.pending) pendingSessions.add(snapshot.sessionId)
    if (context.draining) for (const row of entries) pendingSessions.add(row.sessionId)
    const pending = pendingSessions.size > 0
    const complete = rows.every((row) => row.complete)
    // Price coverage is separate from request fences. Pending is per-session:
    // a working sibling cannot hide a settled child's integrity/reporting gap.
    const unpriced =
      rows.some((row) => this.unpriced(row)) || (pending && owner.coverage?.unpriced === true && !complete)
    const previous = new Map((owner.coverage?.settled ?? []).map((gap) => [gap.sessionId, gap]))
    const settled: NonNullable<NonNullable<CostOwner["coverage"]>["settled"]> = []
    const remember = (sessionId: string, usage: AccountedUsage, isPending: boolean) => {
      if (usage.complete && !this.unpriced(usage)) return
      const old = previous.get(sessionId)
      if (isPending) {
        if (old) settled.push(old)
        return
      }
      const evidence = fingerprintOf([usage, this.unpriced(usage)])
      const wasPending = owner.coverage?.pendingSessions?.includes(sessionId) ?? owner.coverage?.pending
      // A sibling's request fence changes the tree revision, not this settled
      // row's evidence. Preserve its acknowledged scope until it changes or
      // this row itself reaches a new settled boundary.
      const ownRevisionChanged =
        sessionId === snapshot.sessionId &&
        snapshot.descendants.length === 0 &&
        owner.snapshot?.revision !== snapshot.revision
      const sameGap = old?.evidence === evidence && !wasPending && !ownRevisionChanged
      settled.push({
        sessionId,
        evidence,
        fingerprint: sameGap ? old.fingerprint : fingerprintOf([sessionId, evidence, snapshot.revision]),
      })
    }
    for (const row of entries) remember(row.sessionId, row.usage, pendingSessions.has(row.sessionId))
    // Traversal/integrity requirements can affect total without an own row.
    if (!snapshot.total.complete && entries.every((row) => row.usage.complete))
      remember("@total", snapshot.total, false)
    settled.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    const coverage: NonNullable<CostOwner["coverage"]> = {
      pending,
      pendingSessions: [...pendingSessions].sort(),
      settled,
      unpriced,
      unknown: settled.length
        ? fingerprintOf(settled.map((gap) => [gap.sessionId, gap.fingerprint]))
        : (!complete || unpriced) && pending
          ? ownerUnknown(owner)
          : undefined,
    }
    const coverageChanged = JSON.stringify(owner.coverage) !== JSON.stringify(coverage)
    if (owner.snapshot && snapshot.revision === owner.snapshot.revision) {
      // Writer leases and durability coverage can change without an accounting
      // revision. Refresh integrity flags, never replace equal-revision amounts.
      const previous = owner.snapshot
      const covered = structuredClone(previous)
      const coverage = (target: AccountedUsage, next: AccountedUsage | undefined) => {
        target.complete = next?.complete ?? false
        if (next?.usage.pricingUnknown) target.usage.pricingUnknown = true
        else delete target.usage.pricingUnknown
      }
      coverage(covered.own, snapshot.own)
      coverage(covered.total, snapshot.total)
      for (const child of covered.descendants)
        coverage(child.usage, snapshot.descendants.find((next) => next.sessionId === child.sessionId)?.usage)
      if (JSON.stringify(covered) === JSON.stringify(previous) && !owner.unavailable && !coverageChanged)
        return Promise.resolve()
      owner.snapshot = covered
    } else owner.snapshot = structuredClone(snapshot)
    owner.coverage = coverage
    owner.unavailable = false
    for (const child of owner.snapshot.descendants) {
      if (!owner.sessions.includes(child.sessionId)) owner.sessions.push(child.sessionId)
      if (child.groupId && !owner.groups.includes(child.groupId)) owner.groups.push(child.groupId)
    }
    // Signed corrections replace snapshots, but never clear a latched stop.
    this.evaluate()
    return this.persist()
  }
  async unavailable(key: string): Promise<void> {
    const owner = this.owner(key)
    owner.unavailable = true
    if (owner.coverage) {
      owner.coverage.pending = false
      owner.coverage.pendingSessions = []
    }
    this.evaluate()
    await this.persist()
  }
  async discover(
    key: string,
    metadata: { groupId?: string; sessionIds?: string[]; run?: { kind: "workflow" | "swarm"; id: string } },
  ): Promise<void> {
    const owner = this.owner(key)
    if (metadata.groupId && !owner.groups.includes(metadata.groupId)) owner.groups.push(metadata.groupId)
    for (const id of metadata.sessionIds ?? []) if (!owner.sessions.includes(id)) owner.sessions.push(id)
    if (
      metadata.run &&
      !owner.runs.some((run) => run.kind === metadata.run!.kind && run.id === metadata.run!.id)
    )
      owner.runs.push(metadata.run)
    await this.persist()
  }
  async configure(
    action: "cap" | "raise" | "remove" | "continue",
    capUsd?: number,
    sessionId?: string,
  ): Promise<void> {
    if (this.policyChanging) throw new Error("Project cost policy is already being saved.")
    if (action === "cap" && this.state.policy.latch)
      throw new Error("Project work is stopped; use continue, raise, or remove before setting another cap.")
    const ledger = this.state
    const previousPolicy = structuredClone(ledger.policy)
    const previousReceiptCount = ledger.receipts.length
    this.policyChanging = true
    try {
      const policy = ledger.policy
      const cost = costRollups(ledger).project.knownCostUsd
      if (action === "cap" || action === "raise") {
        if (
          !capUsd ||
          !Number.isFinite(capUsd) ||
          capUsd <= 0 ||
          (action === "raise" && capUsd <= (policy.capUsd ?? 0))
        )
          throw new Error("Enter a positive USD cap; raise must exceed the current cap.")
        policy.capUsd = capUsd
        policy.warned = false
        delete policy.continuedThroughUsd
      } else if (action === "remove") {
        delete policy.capUsd
        delete policy.continuedThroughUsd
      } else {
        policy.continuedThroughUsd = cost
        policy.acknowledgedUnknown = unknownFingerprint(ledger)
      }
      delete policy.latch
      this.stopping = false
      ledger.receipts.push({
        sessionId,
        action,
        at: new Date().toISOString(),
        cap: policy.capUsd,
        knownCostUsd: cost,
        unknownFingerprint: action === "continue" ? policy.acknowledgedUnknown : undefined,
      })
      if (action === "continue" && policy.acknowledgedUnknown)
        ledger.receipts.push({
          sessionId,
          action: "acknowledge-unpriced",
          at: new Date().toISOString(),
          cap: policy.capUsd,
          knownCostUsd: cost,
          unknownFingerprint: policy.acknowledgedUnknown,
        })
      this.evaluate()
      await this.persist(false)
    } catch (error) {
      ledger.policy = previousPolicy
      ledger.receipts.length = previousReceiptCount
      this.generation++
      if (this.failed && previousPolicy.capUsd !== undefined) {
        previousPolicy.latch ??= {
          reason: "accounting",
          at: new Date().toISOString(),
          version: ledger.revision + 1,
        }
        if (!this.stopping) {
          this.stopping = true
          this.hooks.stop("Project accounting persistence failed")
        }
      }
      throw error
    } finally {
      this.policyChanging = false
    }
  }
  async flush(): Promise<void> {
    await this.queue
    if (this.failed || this.persistedGeneration < this.generation) await this.persist()
  }
}

export function costText(ledger: CostLedger, language = "en"): string {
  const t = (en: string, zh: string, ja: string) => localize(language, en, zh, ja)
  const totals = costRollups(ledger)
  const price = (row: CostRollup) => {
    const usd = `$${row.knownCostUsd.toFixed(4)}`
    return (
      t(`${usd} reported`, `已报告 ${usd}`, `報告済み ${usd}`) +
      (row.unknown || (!row.complete && !row.pending)
        ? t(" + incomplete/unpriced", " + 不完整／未定价", " + 不完全／料金不明")
        : row.pending
          ? t(" + pending accounting", " + 记账进行中", " + 集計待ち")
          : "") +
      (row.estimated ? t(" (estimated)", "（估算）", "（推定）") : "")
    )
  }
  const policy = ledger.policy
  const cap = policy.capUsd === undefined ? t("none", "无", "なし") : `$${policy.capUsd.toFixed(2)}`
  const stop = policy.latch
    ? t(
        ` · STOPPED (${policy.latch.reason})`,
        ` · 已停止（${policy.latch.reason}）`,
        ` · 停止中（${policy.latch.reason}）`,
      )
    : ""
  return [
    t(
      `Project cost: ${price(totals.project)} · ${totals.project.input} input / ${totals.project.output} output tokens`,
      `项目花费：${price(totals.project)} · 输入 ${totals.project.input}／输出 ${totals.project.output} token`,
      `プロジェクト費用：${price(totals.project)} · 入力 ${totals.project.input}／出力 ${totals.project.output} トークン`,
    ),
    t(`Cap: ${cap}${stop}`, `上限：${cap}${stop}`, `上限：${cap}${stop}`),
    t(
      `Coverage since ${ledger.coverage.since}`,
      `记账起点：${ledger.coverage.since}`,
      `記録開始：${ledger.coverage.since}`,
    ) +
      (ledger.coverage.legacyIncomplete
        ? t(
            "; earlier main-bound calls are unavailable, not zero",
            "；早期主会话调用费用不可查，不代表零花费",
            "；以前のメイン会話呼び出しの費用は不明で、ゼロではありません",
          )
        : ""),
    ...Object.entries(totals.iterations).map(([id, total]) =>
      t(
        `Iteration ${id}: ${price(total)}`,
        `迭代 ${id}：${price(total)}`,
        `イテレーション ${id}：${price(total)}`,
      ),
    ),
    ...Object.entries(totals.stages).map(([id, total]) =>
      t(`Stage ${id}: ${price(total)}`, `阶段 ${id}：${price(total)}`, `段階 ${id}：${price(total)}`),
    ),
    ...Object.entries(totals.sessions).map(([id, total]) =>
      t(
        `Session/child ${id}: ${price(total)}`,
        `会话／子 agent ${id}：${price(total)}`,
        `会話／子エージェント ${id}：${price(total)}`,
      ),
    ),
    policy.acknowledgedUnknown
      ? t(
          "Incomplete/estimated pricing explicitly acknowledged for the recorded scope.",
          "已明确确认当前记账范围内的不完整／估算定价。",
          "記録した範囲の不完全／推定料金を明示的に了承済みです。",
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}
