/**
 * The Worker a workflow script runs in. The script sees only the workflow API (agent,
 * parallel, pipeline, phase, log, args, budget, workflow) and an allowlist of plain language
 * builtins (ALLOWED): every other global name, including every alias of the global object
 * (globalThis, self, global) and host objects such as Bun, is shadowed by a parameter of the
 * function the script is compiled into, and deleted where the runtime lets it be. So the
 * script has no files, processes, network, timers or modules. The sources of nondeterminism
 * (the clock, Math.random) throw, so a resumed run takes the same path as the first one.
 */
import type { HostMessage, WorkerMessage } from "./protocol.ts"

// Captured before anything is locked, and out of the script's reach (it cannot see this module).
const host = globalThis as unknown as {
  postMessage(message: WorkerMessage): void
  onmessage: ((e: { data: HostMessage }) => void) | null
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>
const hostPost = host.postMessage.bind(host)
const post = (m: WorkerMessage) => hostPost(m)

/**
 * The only globals a script can name: plain, deterministic language builtins. Everything else
 * on the global object (and its prototype chain) is out of its reach.
 */
const ALLOWED = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "escape",
  "unescape",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "atob",
  "btoa",
  "structuredClone",
  "Object",
  "Array",
  "Boolean",
  "Number",
  "BigInt",
  "String",
  "Symbol",
  "Date",
  "Promise",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Proxy",
  "Reflect",
  "JSON",
  "Math",
  "Intl",
  "Iterator",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "SuppressedError",
  "DisposableStack",
  "AsyncDisposableStack",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
])

/** Not allowed, but kept on the global object: the worker's own messaging needs them. */
const KEPT = new Set([
  "postMessage",
  "onmessage",
  "onerror",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
])

/** Names that cannot be parameters of strict code; they are deleted instead (eval) or harmless. */
const NOT_PARAMS = new Set([
  "eval",
  "arguments",
  "await",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "enum",
])

/** Every name the global object answers to (its own properties and its prototype chain's). */
function globalNames(): string[] {
  const names = new Set<string>()
  for (let o: object | null = globalThis; o; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) names.add(n)
  }
  // Names some runtimes give the global object or module scope, present or not.
  for (const n of ["global", "globalThis", "self", "window", "require", "module", "exports", "Deno"]) {
    names.add(n)
  }
  return [...names]
}

class DeterminismError extends Error {
  override name = "DeterminismError"
}

function forbid(what: string, why = "workflow scripts must be deterministic so a run can be resumed"): never {
  throw new DeterminismError(`${what} is not available: ${why}. Pass values in through args instead.`)
}

/** The global names a script's function shadows with parameters: all but the allowed ones. */
let shadowed: string[] = []

function lockDown() {
  const RealDate = Date
  // new Date(value) and Date.UTC/parse stay; the current time does not. SafeDate is not
  // chained to the real Date (Object.getPrototypeOf(Date) would hand it out): it is a plain
  // function with UTC and parse copied over.
  const SafeDate = function SafeDate(this: unknown, ...a: unknown[]) {
    if (!new.target) forbid("Date()")
    if (a.length === 0) forbid("new Date()")
    return Reflect.construct(RealDate, a, new.target)
  } as unknown as DateConstructor
  Object.defineProperty(SafeDate, "length", { value: RealDate.length })
  Object.defineProperty(SafeDate, "name", { value: "Date" })
  Object.defineProperty(SafeDate, "prototype", { value: RealDate.prototype, writable: false })
  // `new (new Date(0).constructor)()` would reach the real one.
  Object.defineProperty(RealDate.prototype, "constructor", {
    value: SafeDate,
    writable: false,
    configurable: false,
  })
  for (const key of ["UTC", "parse"] as const) {
    Object.defineProperty(SafeDate, key, { value: RealDate[key].bind(RealDate), writable: false })
  }
  Object.defineProperty(SafeDate, "now", { value: () => forbid("Date.now()"), writable: false })
  ;(globalThis as Record<string, unknown>).Date = SafeDate
  Object.defineProperty(Math, "random", {
    value: () => forbid("Math.random()"),
    writable: false,
    configurable: false,
  })
  // Intl formats the current time when it is given no date.
  const dtf = Intl.DateTimeFormat.prototype
  const formatGetter = Object.getOwnPropertyDescriptor(dtf, "format")?.get
  if (formatGetter) {
    Object.defineProperty(dtf, "format", {
      get(this: Intl.DateTimeFormat) {
        const format = formatGetter.call(this) as (d?: unknown) => string
        return (d?: unknown) => (d === undefined ? forbid("Formatting the current time") : format(d))
      },
      configurable: false,
    })
  }
  const formatToParts = dtf.formatToParts
  Object.defineProperty(dtf, "formatToParts", {
    value(this: Intl.DateTimeFormat, d?: unknown) {
      if (d === undefined) forbid("Formatting the current time")
      return formatToParts.call(this, d as Date)
    },
    writable: false,
    configurable: false,
  })
  // Everything not allowed is shadowed; what the runtime lets go of is deleted too.
  const names = globalNames().filter((n) => !ALLOWED.has(n))
  shadowed = names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && !NOT_PARAMS.has(n))
  const g = globalThis as Record<string, unknown>
  for (const name of names) {
    if (KEPT.has(name) || !Object.hasOwn(g, name)) continue
    try {
      delete g[name]
    } catch {}
  }
  // `(function () {}).constructor("...")` would compile code with the real globals.
  const blocked = () =>
    forbid("Compiling code at run time", "workflow scripts cannot create functions from strings")
  for (const proto of [
    Object.getPrototypeOf(() => {}),
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
      reject(
        new Error(
          `could not pass the call on (only plain data can be): ${err instanceof Error ? err.message : err}`,
        ),
      )
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
    return request({
      t: "agent",
      id,
      seen,
      prompt,
      opts: JSON.parse(JSON.stringify(opts)),
      ...(nest ? { nest } : {}),
    })
  }
  const settle = async <T>(thunk: () => T | Promise<T>, what: string): Promise<T | null> => {
    try {
      return await thunk()
    } catch (err) {
      post({
        t: "log",
        msg: `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
        level: "warning",
        ...(nest ? { nest } : {}),
      })
      return null
    }
  }
  const parallel = (thunks: unknown) => {
    if (!Array.isArray(thunks) || !thunks.every((f) => typeof f === "function")) {
      return Promise.reject(
        new TypeError(
          "parallel(thunks): pass an array of functions, e.g. items.map((x) => () => agent(...))",
        ),
      )
    }
    return Promise.all(thunks.map((f, i) => settle(f as () => unknown, `parallel task ${i + 1}`)))
  }
  const pipeline = (items: unknown, ...stages: unknown[]) => {
    if (!Array.isArray(items))
      return Promise.reject(new TypeError("pipeline(items, ...stages): items must be an array"))
    if (!stages.every((s) => typeof s === "function")) {
      return Promise.reject(new TypeError("pipeline(items, ...stages): each stage must be a function"))
    }
    return Promise.all(
      items.map((item, index) =>
        settle(
          async () => {
            let value: unknown = item
            for (const stage of stages)
              value = await (stage as (v: unknown, item: unknown, i: number) => unknown)(value, item, index)
            return value
          },
          `pipeline item ${index + 1}`,
        ),
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
    ? () =>
        Promise.reject(
          new Error("workflow() can only be used one level deep: a nested workflow cannot start another"),
        )
    : (name: unknown, wargs?: unknown) => {
        if (typeof name !== "string" || !name.trim())
          return Promise.reject(new TypeError("workflow(name, args): name must be a string"))
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
  const warn = (...parts: unknown[]) => {
    post({ t: "log", msg: parts.map(text).join(" "), level: "warning", ...(nest ? { nest } : {}) })
  }
  // console would write over the terminal; in a script it goes to the run's log.
  const scriptConsole = Object.freeze({ log, info: log, debug: log, warn, error: warn })
  return { agent, parallel, pipeline, phase, log, args, budget, workflow, console: scriptConsole }
}

function runScript(code: string, args: unknown, nest?: string): Promise<unknown> {
  const api = makeApi(args, nest)
  const names = Object.keys(api)
  const shadow = shadowed.filter((n) => !names.includes(n))
  const fn = new AsyncFunction(...names, ...shadow, `"use strict";\n${code}`)
  return fn(...names.map((n) => api[n as keyof typeof api]), ...shadow.map(() => undefined))
}

host.onmessage = (e) => {
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
            post({
              t: "error",
              message: `the script's result is not plain data: ${err instanceof Error ? err.message : err}`,
            })
            return
          }
          post({ t: "done", value: out })
        },
        (err) =>
          post({ t: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }),
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
