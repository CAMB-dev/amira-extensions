import type { RunCommandOptions, RunCommandResult } from "@amira/api"
import type { Fetch, RunCommand } from "../src/channels.ts"

/** A runCommand that records each call and answers with `result` (or what it returns). */
export function fakeRun(
  result: Partial<RunCommandResult> | ((argv: string[]) => Partial<RunCommandResult>) = {},
) {
  const calls: { argv: string[]; opts: RunCommandOptions }[] = []
  const run: RunCommand = async (argv, opts) => {
    calls.push({ argv, opts })
    const r = typeof result === "function" ? result(argv) : result
    return {
      output: "",
      exitCode: 0,
      signalCode: null,
      timedOut: false,
      aborted: false,
      settled: true,
      contained: true,
      ...r,
    }
  }
  return { run, calls }
}

export interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

/** A fetch that records each request and answers with `reply` (status and JSON body). */
export function fakeFetch(reply: (call: FetchCall) => { status?: number; body?: unknown } = () => ({})) {
  const calls: FetchCall[] = []
  const fetch: Fetch = async (url, init) => {
    const call: FetchCall = {
      url,
      method: String(init.method),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)),
    }
    calls.push(call)
    const r = reply(call)
    const body = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body)
    return new Response(body || null, { status: r.status ?? 200 })
  }
  return { fetch, calls }
}

/** Timers run by hand: `advance(ms)` fires every timer due by then, in order. */
export function fakeTimers() {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    },
  }
}
