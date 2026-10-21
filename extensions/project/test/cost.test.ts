import { expect, test } from "bun:test"
import { addUsage } from "@amira/ai"
import { hasUnpricedUsage } from "@amira/ai/accounting"
import type { AccountedUsage, ConversationUsageSnapshot } from "@amira/api"
import {
  type CostLedger,
  type CostPersistence,
  costRollups,
  costText,
  ProjectCosts,
  validateCostLedger,
} from "../src/cost.ts"

const accounted = (cost: number, complete = true, estimated = false): AccountedUsage => ({
  knownCostUsd: cost,
  complete,
  usage: {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    ...(complete ? { cost } : {}),
    ...(estimated ? { pricingUnknown: true } : {}),
  },
})
const usage = (id: string, revision: number, cost: number, complete = true): ConversationUsageSnapshot => ({
  sessionId: id,
  revision,
  own: accounted(cost, complete),
  total: accounted(cost, complete),
  descendants: [],
})
function fixture(saved?: CostLedger) {
  let disk = saved && structuredClone(saved)
  let fail = false
  const stops: string[] = []
  const notices: string[] = []
  const persistence: CostPersistence = {
    read: async () => disk && structuredClone(disk),
    async save(next, expected) {
      if (fail) throw new Error("disk full")
      expect(disk?.revision).toBe(expected)
      disk = structuredClone(next)
    },
  }
  const costs = new ProjectCosts("p", persistence, {
    stop: (reason) => stops.push(reason),
    notify: (text) => notices.push(text),
    unpriced: hasUnpricedUsage,
  })
  return {
    costs,
    stops,
    notices,
    persistence,
    saved: () => disk!,
    fail: (value: boolean) => {
      fail = value
    },
  }
}
async function owner(
  costs: ProjectCosts,
  key = "key",
  iteration = 1,
  stage: "design" | "implement" = "implement",
) {
  await costs.intent(key, { iteration, stage, role: "worker" })
  await costs.bind(key, key)
  await costs.observe(key, usage(key, 0, 0))
}

test("administrative archive accounting defers cap defaults until the next writable initialization", async () => {
  const historical = fixture()
  await historical.costs.load(true, 25, { initializePolicy: false })
  expect(historical.saved().policy.capUsd).toBeUndefined()
  expect(historical.saved().coverage.policyInitialized).toBe(false)
  const writable = fixture(historical.saved())
  await writable.costs.load(true, 25)
  expect(writable.saved().policy.capUsd).toBe(25)
  expect(writable.saved().coverage.policyInitialized).toBe(true)
})

test("pending priced requests retain coverage without becoming unpriced, including across serialization", async () => {
  const f = fixture()
  await f.costs.load(false, 100)
  await owner(f.costs)
  const pending = usage("key", 1, 4)
  pending.own.complete = pending.total.complete = false
  await f.costs.observe("key", pending, { pending: true })
  expect(f.costs.snapshot().policy.latch).toBeUndefined()
  expect(f.stops).toEqual([])
  expect(() => f.costs.assertAdmission()).not.toThrow()
  expect(costText(f.saved())).toContain("pending accounting")
  const saved = JSON.parse(JSON.stringify(f.saved())) as CostLedger
  const restarted = fixture(saved)
  await restarted.costs.load()
  expect(restarted.costs.snapshot().policy.latch).toBeUndefined()
  await f.costs.observe("key", usage("key", 2, 5), { pending: false })
  expect(() => f.costs.assertAdmission()).not.toThrow()
})

test("reported unpriced receipts are preserved while in flight and block at the settled boundary", async () => {
  const f = fixture()
  await f.costs.load(false, 100)
  await owner(f.costs)
  const mixed = usage("key", 1, 2)
  mixed.own = mixed.total = {
    knownCostUsd: 2,
    complete: false,
    usage: addUsage(accounted(2).usage, { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }),
  }
  expect(mixed.total.usage.cost).toBe(2) // A priced subtotal does not prove all receipts are priced.
  await f.costs.observe("key", mixed, { pending: true })
  expect(f.costs.snapshot().policy.latch).toBeUndefined()
  expect(f.costs.snapshot().owners[0]?.coverage?.unpriced).toBe(true)
  expect(costText(f.saved())).toContain("incomplete/unpriced")
  await f.costs.observe("key", mixed, { pending: false }) // Same accounting revision; a new safe boundary.
  expect(f.costs.snapshot().policy.latch?.reason).toBe("unpriced")
})

test("a settled descendant integrity gap is not hidden by a busy sibling", async () => {
  const f = fixture()
  await f.costs.load(false, 100)
  await owner(f.costs)
  const snapshot = usage("key", 1, 2)
  const settled = accounted(1)
  settled.complete = false // Fully priced, but its settled accounting integrity is unverified.
  const pending = accounted(3)
  pending.complete = false
  snapshot.descendants = [
    { sessionId: "settled", parentSessionId: "key", usage: settled },
    { sessionId: "busy", parentSessionId: "key", usage: pending },
  ]
  snapshot.total = accounted(6)
  snapshot.total.complete = false
  await f.costs.observe("key", snapshot, { pending: true, pendingSessions: ["busy"] })
  expect(() => f.costs.assertAdmission()).toThrow("unpriced")
  expect(f.saved().policy.latch?.reason).toBe("unpriced")
  expect(costRollups(f.saved()).project.knownCostUsd).toBe(6)
})

test("a priced sibling's start and completion do not invalidate an acknowledged settled gap", async () => {
  const f = fixture()
  await f.costs.load(false, 100)
  await owner(f.costs)
  const snapshot = usage("key", 1, 0)
  const gap = accounted(2)
  gap.complete = false
  snapshot.descendants = [{ sessionId: "A", parentSessionId: "key", usage: gap }]
  snapshot.total = accounted(2)
  snapshot.total.complete = false
  await f.costs.observe("key", snapshot)
  await f.costs.configure("continue")
  const pending = structuredClone(snapshot)
  pending.revision = 2
  const request = accounted(0)
  request.complete = false
  pending.descendants = [...pending.descendants, { sessionId: "B", parentSessionId: "key", usage: request }]
  await f.costs.observe("key", pending, { pendingSessions: ["B"] })
  expect(f.costs.snapshot().policy.latch).toBeUndefined()
  const done = structuredClone(snapshot)
  done.revision = 3
  done.descendants = [...done.descendants, { sessionId: "B", parentSessionId: "key", usage: accounted(3) }]
  done.total = accounted(5)
  done.total.complete = false
  await f.costs.observe("key", done)
  expect(() => f.costs.assertAdmission()).not.toThrow()
  expect(f.costs.snapshot().policy.latch).toBeUndefined()
  expect(costRollups(f.saved()).project.knownCostUsd).toBe(5)
})

test("new-work admission is a safe boundary for positively unpriced pending receipts", async () => {
  const f = fixture()
  await f.costs.load(false, 100)
  await owner(f.costs)
  await f.costs.observe("key", usage("key", 1, 2, false), { pending: true })
  expect(f.costs.snapshot().policy.latch).toBeUndefined()
  expect(() => f.costs.assertAdmission()).toThrow("unpriced")
  await f.costs.flush()
  expect(f.stops).toHaveLength(1)
  expect(f.saved().policy.latch?.reason).toBe("unpriced")
})

test("known USD breaches still stop immediately while a request is pending", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  const pending = usage("key", 1, 10)
  pending.own.complete = pending.total.complete = false
  const update = f.costs.observe("key", pending, { pending: true })
  expect(f.stops).toEqual(["Project cap reached"])
  await update
  expect(f.costs.snapshot().policy.latch?.reason).toBe("cap")
})

test("80% warns once, equality at 100% latches synchronously before IO, corrections do not resume", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  await f.costs.observe("key", usage("key", 1, 8))
  await f.costs.observe("key", usage("key", 2, 9))
  expect(f.notices.filter((text) => text.includes("80%"))).toHaveLength(1)
  const pending = f.costs.observe("key", usage("key", 3, 10))
  expect(f.stops).toHaveLength(1)
  expect(() => f.costs.assertAdmission()).toThrow("stopped")
  await pending
  await f.costs.observe("key", usage("key", 4, 5))
  expect(f.costs.snapshot().owners[0]!.snapshot!.total.knownCostUsd).toBe(5)
  expect(() => f.costs.assertAdmission()).toThrow("stopped")
  await f.costs.observe("key", usage("key", 2, 99))
  expect(costRollups(f.costs.snapshot()).project.knownCostUsd).toBe(5)
})

test("project cap sums concurrent owners across iterations and stages, not main or provider totals", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs, "a", 1, "design")
  await owner(f.costs, "b", 2)
  await Promise.all([f.costs.observe("a", usage("a", 1, 4)), f.costs.observe("b", usage("b", 1, 6))])
  const totals = costRollups(f.saved())
  expect(totals.project.knownCostUsd).toBe(10)
  expect(totals.iterations["1"]!.knownCostUsd).toBe(4)
  expect(totals.stages["2/implement"]!.knownCostUsd).toBe(6)
  expect(totals.sessions.main).toBeUndefined()
  expect(f.stops).toHaveLength(1)
})

test("nested sibling groups and repeated snapshots count each root/private descendant exactly once", async () => {
  const f = fixture()
  await f.costs.load()
  await owner(f.costs)
  const snapshot = usage("key", 1, 1)
  snapshot.descendants = [
    { sessionId: "child", parentSessionId: "key", groupId: "g1", usage: accounted(2) },
    { sessionId: "private", parentSessionId: "child", groupId: "g2", ephemeral: true, usage: accounted(3) },
  ]
  snapshot.total = accounted(6)
  await f.costs.observe("key", snapshot)
  await f.costs.discover("key", { groupId: "g1", sessionIds: ["child"], run: { kind: "swarm", id: "run" } })
  await f.costs.discover("key", { groupId: "g2", sessionIds: ["child", "private"] })
  await f.costs.observe("key", snapshot)
  const ledger = JSON.parse(JSON.stringify(f.saved())) as CostLedger
  expect(costRollups(ledger).project.knownCostUsd).toBe(6)
  expect(ledger.owners[0]!.groups).toEqual(["g1", "g2"])
  expect(ledger.owners[0]!.sessions).toEqual(["child", "private"])
  expect(ledger.owners[0]!.runs).toEqual([{ kind: "swarm", id: "run" }])
})

test("uncapped missing price preserves known subtotal and tokens; capped unknown blocks until scoped acknowledgement", async () => {
  const f = fixture()
  await f.costs.load()
  await owner(f.costs)
  await f.costs.observe("key", usage("key", 1, 2, false))
  expect(() => f.costs.assertAdmission()).not.toThrow()
  expect(costText(f.saved())).toContain("$2.0000 reported + incomplete/unpriced")
  await f.costs.configure("cap", 10)
  expect(() => f.costs.assertAdmission()).toThrow("unpriced")
  await f.costs.configure("continue")
  expect(() => f.costs.assertAdmission()).not.toThrow()
  expect(f.saved().receipts.at(-1)?.action).toBe("acknowledge-unpriced")
  await f.costs.observe("key", usage("key", 2, 2, false))
  expect(() => f.costs.assertAdmission()).toThrow("unpriced")
})

test("estimated price remains visible and requires acknowledgement under a cap", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  const snapshot = usage("key", 1, 3)
  snapshot.total = snapshot.own = accounted(3, true, true)
  await f.costs.observe("key", snapshot)
  expect(costText(f.saved())).toContain("(estimated)")
  expect(f.saved().policy.latch?.reason).toBe("unpriced")
})

test("raise/remove/continue are explicit durable receipts; restart never clears a stop", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  await f.costs.observe("key", usage("key", 1, 11))
  const restart = fixture(f.saved())
  await restart.costs.load()
  expect(() => restart.costs.assertAdmission()).toThrow("stopped")
  await restart.costs.configure("continue")
  expect(() => restart.costs.assertAdmission()).not.toThrow()
  await restart.costs.observe("key", usage("key", 2, 11.01))
  expect(() => restart.costs.assertAdmission()).toThrow("stopped")
  await restart.costs.configure("raise", 20)
  expect(() => restart.costs.assertAdmission()).not.toThrow()
  await restart.costs.configure("remove")
  expect(restart.saved().policy.capUsd).toBeUndefined()
  expect(restart.saved().receipts.map((receipt) => receipt.action)).toEqual(["continue", "raise", "remove"])
  expect(restart.notices.filter((text) => text.includes("reached. Work stopped"))).toHaveLength(1)
})

test("failed writes stop active capped scopes and block admission, retry saves without losing evidence", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  f.fail(true)
  await expect(f.costs.observe("key", usage("key", 1, 3))).rejects.toThrow("disk full")
  expect(f.stops).toContain("Project accounting persistence failed")
  expect(() => f.costs.assertAdmission()).toThrow("could not be saved")
  f.fail(false)
  await f.costs.configure("raise", 20)
  expect(costRollups(f.saved()).project.knownCostUsd).toBe(3)
  expect(() => f.costs.assertAdmission()).not.toThrow()
})

test("failed cap removal retains the old policy and stop until an explicit successful choice", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  f.fail(true)
  await expect(f.costs.configure("remove")).rejects.toThrow("disk full")
  expect(f.costs.snapshot().policy.capUsd).toBe(10)
  expect(f.stops).toContain("Project accounting persistence failed")
  f.fail(false)
  await f.costs.flush()
  expect(f.saved().policy.capUsd).toBe(10)
  expect(f.saved().receipts).toHaveLength(0)
  expect(() => f.costs.assertAdmission()).toThrow("stopped")
  await f.costs.configure("continue")
  expect(() => f.costs.assertAdmission()).not.toThrow()
})

test("absent provider and owner retains last known costs, marked incomplete rather than zero", async () => {
  const f = fixture()
  await f.costs.load()
  await owner(f.costs)
  await f.costs.observe("key", usage("key", 1, 5))
  await f.costs.unavailable("key")
  const restart = fixture(f.saved())
  await restart.costs.load()
  expect(costRollups(restart.saved()).project).toMatchObject({ knownCostUsd: 5, complete: false })
  await restart.costs.observe("key", usage("key", 1, 5))
  expect(costRollups(restart.saved()).project.complete).toBe(true)
})

test("legacy coverage blocks configured caps; new intended keys are durable before open and not guessed charges", async () => {
  const f = fixture()
  await f.costs.load(true, 10)
  expect(() => f.costs.assertAdmission()).toThrow("unpriced")
  await f.costs.configure("continue")
  await f.costs.intent("intended", { iteration: 1, stage: "design", role: "conversation" })
  expect(f.saved().owners[0]).toMatchObject({ key: "intended", provenance: "owned" })
  expect(f.saved().owners[0]!.id).toBeUndefined()
  expect(costText(f.saved())).toContain("earlier main-bound calls are unavailable, not zero")
})

test("mode-only changes cannot reassign an existing owner's stage, attempt or iteration", async () => {
  const f = fixture()
  await f.costs.load()
  await f.costs.intent("stable", { iteration: 1, stage: "implement", role: "worker", attempt: "old" })
  await f.costs.intent("stable", { iteration: 2, stage: "design", role: "worker", attempt: "new" })
  expect(f.saved().owners[0]).toMatchObject({ iteration: 1, stage: "implement", attempt: "old" })
})

test("unsupported ledger and duplicate bindings fail without reinterpretation", async () => {
  const f = fixture()
  await f.costs.load()
  await owner(f.costs)
  const ledger = f.saved()
  expect(() => validateCostLedger({ ...ledger, schemaVersion: 99 }, "p")).toThrow("Unsupported")
  expect(() => validateCostLedger({ ...ledger, owners: [...ledger.owners, ledger.owners[0]] }, "p")).toThrow(
    "duplicate",
  )
  await expect(f.costs.bind("key", "foreign")).rejects.toThrow("identity changed")
  await expect(f.costs.configure("raise", -1)).rejects.toThrow("positive USD")
  for (const corrupt of [
    { continuedThroughUsd: "oops" },
    { acknowledgedUnknown: true },
    { latch: { reason: "other", at: "bad", version: -1 } },
  ])
    expect(() => validateCostLedger({ ...ledger, policy: { ...ledger.policy, ...corrupt } }, "p")).toThrow(
      "policy",
    )
})

test("equal-revision integrity changes update coverage without replacing accounted amounts", async () => {
  const f = fixture()
  await f.costs.load(false, 10)
  await owner(f.costs)
  await f.costs.observe("key", usage("key", 1, 3))
  await f.costs.observe("key", usage("key", 1, 99, false))
  expect(costRollups(f.saved()).project).toMatchObject({ knownCostUsd: 3, complete: false })
  expect(() => f.costs.assertAdmission()).toThrow("unpriced")
  await f.costs.observe("key", usage("key", 1, 0, true))
  expect(costRollups(f.saved()).project).toMatchObject({ knownCostUsd: 3, complete: true })
  expect(() => f.costs.assertAdmission()).toThrow("stopped")
})
