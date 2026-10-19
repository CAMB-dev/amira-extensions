/** Lifecycle is deliberately separate from the acceptance/stage journal (schema 1). */
export type ShipStatus = "not-started" | "pending" | "running" | "blocked" | "shipped" | "skipped"
export interface LifecycleReceipt {
  id: string
  sessionId: string
  date: string
}
export interface IterationLifecycle {
  status: "open" | "closed"
  ship: ShipStatus
  receipt?: LifecycleReceipt
}
export interface ProjectLifecycle {
  schemaVersion: 1
  revision: number
  status: "active" | "archive-pending" | "archived"
  iterations: Record<string, IterationLifecycle>
  receipt?: LifecycleReceipt
}
export type LifecycleEvent =
  | { type: "ship"; status: Exclude<ShipStatus, "not-started">; receipt: LifecycleReceipt }
  | { type: "close"; receipt: LifecycleReceipt }
  | { type: "next-iteration"; receipt: LifecycleReceipt }
  | { type: "archive-pending" | "archived" | "restore"; receipt: LifecycleReceipt }

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

function receipt(value: unknown): asserts value is LifecycleReceipt {
  if (
    !object(value) ||
    !keys(value, ["id", "sessionId", "date"]) ||
    !text(value.id) ||
    !text(value.sessionId) ||
    !text(value.date) ||
    !Number.isFinite(Date.parse(value.date))
  )
    throw new Error("Lifecycle publication requires an explicit identity-bound receipt")
}

export function initialLifecycle(iteration: number): ProjectLifecycle {
  return {
    schemaVersion: 1,
    revision: 0,
    status: "active",
    iterations: { [iteration]: { status: "open", ship: "not-started" } },
  }
}

export function validateLifecycle(
  value: unknown,
  currentIteration: number,
): asserts value is ProjectLifecycle {
  if (
    !object(value) ||
    !keys(value, ["schemaVersion", "revision", "status", "iterations", "receipt"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !["active", "archive-pending", "archived"].includes(value.status as string) ||
    !object(value.iterations) ||
    !value.iterations[String(currentIteration)]
  )
    throw new Error("Malformed project lifecycle")
  if (value.receipt !== undefined) receipt(value.receipt)
  if (value.status !== "active" && !value.receipt) throw new Error("Archive state requires a receipt")
  for (const [number, entry] of Object.entries(value.iterations)) {
    if (
      !/^[1-9][0-9]*$/.test(number) ||
      !Number.isSafeInteger(Number(number)) ||
      Number(number) > currentIteration ||
      !object(entry) ||
      !keys(entry, ["status", "ship", "receipt"]) ||
      !["open", "closed"].includes(entry.status as string) ||
      !["not-started", "pending", "running", "blocked", "shipped", "skipped"].includes(entry.ship as string)
    )
      throw new Error("Malformed iteration lifecycle")
    if (entry.receipt !== undefined) receipt(entry.receipt)
    if (
      entry.status === "closed" &&
      (!["shipped", "skipped"].includes(entry.ship as string) || !entry.receipt)
    )
      throw new Error("Closed iteration requires shipped or explicitly skipped evidence")
    if (entry.ship !== "not-started" && !entry.receipt) throw new Error("Ship state requires a receipt")
  }
}

/** No stage phase (including legacy complete) can imply ship or closure. */
export function reduceLifecycle(
  previous: ProjectLifecycle,
  currentIteration: number,
  event: LifecycleEvent,
): { lifecycle: ProjectLifecycle; currentIteration: number } {
  receipt(event.receipt)
  const lifecycle = structuredClone(previous)
  const iteration = lifecycle.iterations[String(currentIteration)]!
  if (event.type === "restore") {
    if (lifecycle.status === "active") throw new Error("Project is already active")
    lifecycle.status = "active"
    lifecycle.receipt = event.receipt
  } else if (event.type === "archived") {
    if (lifecycle.status !== "archive-pending") throw new Error("Archive requires a pending admission fence")
    lifecycle.status = "archived"
    lifecycle.receipt = event.receipt
  } else {
    if (lifecycle.status !== "active") throw new Error("Project lifecycle is read-only")
    if (event.type === "archive-pending") {
      lifecycle.status = "archive-pending"
      lifecycle.receipt = event.receipt
    } else if (event.type === "next-iteration") {
      if (iteration.status !== "closed")
        throw new Error("Close the current iteration before starting another")
      currentIteration++
      if (!Number.isSafeInteger(currentIteration)) throw new Error("Invalid next iteration")
      lifecycle.iterations[String(currentIteration)] = { status: "open", ship: "not-started" }
      lifecycle.receipt = event.receipt
    } else if (event.type === "close") {
      if (iteration.status !== "open" || !["shipped", "skipped"].includes(iteration.ship))
        throw new Error("Closure requires a shipped or explicitly ship-skipped open iteration")
      iteration.status = "closed"
      iteration.receipt = event.receipt
    } else if (event.type === "ship") {
      if (iteration.status !== "open" || ["shipped", "skipped"].includes(iteration.ship))
        throw new Error("Ship outcome is already settled or the iteration is closed")
      if (!["pending", "running", "blocked", "shipped", "skipped"].includes(event.status))
        throw new Error("Invalid ship status")
      iteration.ship = event.status
      iteration.receipt = event.receipt
    } else {
      throw new Error("Unsupported lifecycle event")
    }
  }
  lifecycle.revision++
  validateLifecycle(lifecycle, currentIteration)
  return { lifecycle, currentIteration }
}
