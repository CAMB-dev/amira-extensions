/**
 * The Worker a workflow script runs in. The script sees only the workflow API (agent,
 * parallel, pipeline, phase, log, args, budget, workflow) as the parameters of the function
 * it is compiled into; the globals that reach files, processes, the network or modules are
 * removed or shadowed, and the sources of nondeterminism (the clock, Math.random) throw, so a
 * resumed run takes the same path as the first one. This keeps honest scripts deterministic;
 * it is not a security boundary (D26: extensions and their scripts are trusted).
 */
import type { HostMessage, WorkerMessage } from "./protocol.ts"

declare const self: {
  postMessage(message: WorkerMessage): void
  onmessage: ((e: { data: HostMessage }) => void) | null
}

// Captured before anything is locked, and out of the script's reach (it cannot see this module).
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>
const post = (m: WorkerMessage) => self.postMessage(m)

/** Globals a script must not reach; shadowed by parameters as well, for the ones that cannot be deleted. */
const SHADOWED = [
  "Bun",
  "process",
  "require",
  "module",
  "exports",
  "fetch",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "EventSource",
  "navigator",
  "Buffer",
  "crypto",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  // eval cannot be a parameter name in strict code; it is deleted instead (REMOVED).
  "Function",
  "globalThis",
  "self",
  "postMessage",
  "onmessage",
  "addEventListener",
  "importScripts",
  "Request",
  "Response",
  "Headers",
  "Blob",
  "File",
  "FormData",
  "URL",
  "BroadcastChannel",
  "MessageChannel",
  "SharedArrayBuffer",
  "Atomics",
  "WebAssembly",
  "Deno",
  "HTMLRewriter",
]

/** Of those, the ones deleted outright; the worker's own messaging and the builtins it needs stay. */
const REMOVED = [
  "process",
  "require",
  "module",
  "exports",
  "fetch",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "EventSource",
  "navigator",
  "Buffer",
  "crypto",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "eval",
  "importScripts",
  "BroadcastChannel",
  "MessageChannel",
  "SharedArrayBuffer",
  "Atomics",
  "WebAssembly",
  "HTMLRewriter",
]

class DeterminismError extends Error {
  override name = "DeterminismError"
}

function forbid(what: string, why = "workflow scripts must be deterministic so a run can be resumed"): never {
  throw new DeterminismError(`${what} is not available: ${why}. Pass values in through args instead.`)
}

function lockDown() {
  const RealDate = Date
  // new Date(value) and Date.UTC/parse stay; the current time does not.
  const SafeDate = function (this: unknown, ...a: unknown[]) {
    if (!new.target) forbid("Date()")
    if (a.length === 0) forbid("new Date()")
    return Reflect.construct(RealDate, a, new.target)
  } as unknown as DateConstructor
  Object.setPrototypeOf(SafeDate, RealDate)
  Object.defineProperty(SafeDate, "prototype", { value: RealDate.prototype })
  // `new (new Date(0).constructor)()` would reach the real one.
  Object.defineProperty(RealDate.prototype, "constructor", { value: SafeDate })
  Object.defineProperty(SafeDate, "now", { value: () => forbid("Date.now()") })
  ;(globalThis as Record<string, unknown>).Date = SafeDate
  Object.defineProperty(Math, "random", { value: () => forbid("Math.random()"), writable: false, configurable: false })
  for (const name of REMOVED) {
    try {
      delete (globalThis as Record<string, unknown>)[name]
    } catch {}
  }
  // `(function () {}).constructor("...")` would compile code with the real globals.
  const blocked = () => forbid("Compiling code at run time", "workflow scripts cannot create functions from strings")
  for (const proto of [
    Function.prototype,
    Object.getPrototypeOf(async () => {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ]) {
    Object.defineProperty(proto, "constructor", { value: blocked, writable: false, configurable: false })
  }
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

let seq = 0
/** Results handled so far: calls say how many they had seen, for resuming (see Journal). */
let seen = 0
let spent = 0
let total = Number.POSITIVE_INFINITY
const pending = new Map<number, Pending>()

function request<T>(message: WorkerMessage & { id: number }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.set(message.id, { resolve: resolve as (v: unknown) => void, reject })
    try {
      post(message)
    } catch (err) {
      pending.delete(message.id)
      reject(new Error(`could not pass the call on (only plain data can be): ${err instanceof Error ? err.message : err}`))
    }
  })
}

function text(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** The API one script (the run's, or a nested workflow's) is given. */
function makeApi(args: unknown, nest: string | undefined) {
  const agent = (prompt: unknown, opts: Record<string, unknown> = {}) => {
    if (typeof prompt !== "string" || !prompt.trim()) {
      return Promise.reject(new TypeError("agent(prompt, opts): prompt must be a non-empty string"))
    }
    if (opts === null || typeof opts !== "object") {
      return Promise.reject(new TypeError("agent(prompt, opts): opts must be an object"))
    }
    const id = ++seq
    return request({ t: "agent", id, seen, prompt, opts: JSON.parse(JSON.stringify(opts)), ...(nest ? { nest } : {}) })
  }
  const settle = async <T>(thunk: () => T | Promise<T>, what: string): Promise<T | null> => {
    try {
      return await thunk()
    } catch (err) {
      post({ t: "log", msg: `${what} failed: ${err instanceof Error ? err.message : String(err)}`, level: "warning", ...(nest ? { nest } : {}) })
      return null
    }
  }
  const parallel = (thunks: unknown) => {
    if (!Array.isArray(thunks) || !thunks.every((f) => typeof f === "function")) {
      return Promise.reject(new TypeError("parallel(thunks): pass an array of functions, e.g. items.map((x) => () => agent(...))"))
    }
    return Promise.all(thunks.map((f, i) => settle(f as () => unknown, `parallel task ${i + 1}`)))
  }
  const pipeline = (items: unknown, ...stages: unknown[]) => {
    if (!Array.isArray(items)) return Promise.reject(new TypeError("pipeline(items, ...stages): items must be an array"))
    if (!stages.every((s) => typeof s === "function")) {
      return Promise.reject(new TypeError("pipeline(items, ...stages): each stage must be a function"))
    }
    return Promise.all(
      items.map((item, index) =>
        settle(async () => {
          let value: unknown = item
          for (const stage of stages) value = await (stage as (v: unknown, item: unknown, i: number) => unknown)(value, item, index)
          return value
        }, `pipeline item ${index + 1}`),
      ),
    )
  }
  const phase = (title: unknown) => {
    post({ t: "phase", title: String(title), ...(nest ? { nest } : {}) })
  }
  const log = (...parts: unknown[]) => {
    post({ t: "log", msg: parts.map(text).join(" "), level: "info", ...(nest ? { nest } : {}) })
  }
  const budget = Object.freeze({
    get total() {
      return total
    },
    spent: () => spent,
    remaining: () => Math.max(0, total - spent),
  })
  const workflow = nest
    ? () => Promise.reject(new Error("workflow() can only be used one level deep: a nested workflow cannot start another"))
    : (name: unknown, wargs?: unknown) => {
        if (typeof name !== "string" || !name.trim()) return Promise.reject(new TypeError("workflow(name, args): name must be a string"))
        const id = ++seq
        return request<{ code: string; args: unknown; name: string }>({
          t: "workflow",
          id,
          name,
          args: wargs === undefined ? null : JSON.parse(JSON.stringify(wargs)),
        }).then((child) =>
          runScript(child.code, child.args, child.name).then(
            (value) => {
              post({ t: "nestEnd", nest: child.name, ok: true })
              return value
            },
            (err) => {
              post({ t: "nestEnd", nest: child.name, ok: false })
              throw err
            },
          ),
        )
      }
  return { agent, parallel, pipeline, phase, log, args, budget, workflow }
}

function runScript(code: string, args: unknown, nest?: string): Promise<unknown> {
  const api = makeApi(args, nest)
  const names = Object.keys(api)
  const shadow = SHADOWED.filter((n) => !names.includes(n))
  const fn = new AsyncFunction(...names, ...shadow, `"use strict";\n${code}`)
  return fn(...names.map((n) => api[n as keyof typeof api]), ...shadow.map(() => undefined))
}

self.onmessage = (e) => {
  const m = e.data
  switch (m.t) {
    case "run": {
      total = m.budgetTotal ?? Number.POSITIVE_INFINITY
      spent = m.spent
      lockDown()
      runScript(m.code, m.args).then(
        (value) => {
          let out: unknown = null
          try {
            out = value === undefined ? null : JSON.parse(JSON.stringify(value))
          } catch (err) {
            post({ t: "error", message: `the script's result is not plain data: ${err instanceof Error ? err.message : err}` })
            return
          }
          post({ t: "done", value: out })
        },
        (err) => post({ t: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }),
      )
      break
    }
    case "result": {
      seen++
      spent = m.spent
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (!p) break
      if (m.ok) p.resolve(m.value)
      else p.reject(new Error(m.error))
      break
    }
    case "budget":
      spent = m.spent
      break
  }
}
