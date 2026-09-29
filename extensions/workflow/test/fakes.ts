import type {
  AnyEvent,
  ChildSession,
  SpawnGroup,
  SpawnGroupInfo,
  SpawnGroupOptions,
  SpawnOptions,
  SubagentResult,
} from "@amira/api"

/** What a fake sub-agent answers: its text (and value, with a schema), or an error. */
export type Answer = { text?: string; value?: unknown; error?: string; tokens?: number }

export interface FakeGroup extends SpawnGroup {
  readonly options: SpawnGroupOptions
  /** Every spawn, in order. */
  readonly spawned: SpawnOptions[]
  readonly statuses: string[]
  endReason: string | undefined
  /** Most children that ran at once. */
  peak: number
}

/**
 * A spawn group whose children answer with `answer(opts)` after a tick, honouring
 * maxConcurrent and maxAgents the way core does (queueing, and refusing past the cap).
 */
export function fakeGroup(
  options: SpawnGroupOptions,
  answer: (o: SpawnOptions) => Answer | Promise<Answer>,
): FakeGroup {
  let running = 0
  const waiting: (() => void)[] = []
  let n = 0
  const live = new Set<ChildSession>()
  let settle!: (i: SpawnGroupInfo) => void
  const ended = new Promise<SpawnGroupInfo>((r) => {
    settle = r
  })
  const g: FakeGroup = {
    id: "g1",
    name: options.name,
    options,
    spawned: [],
    statuses: [],
    endReason: undefined,
    peak: 0,
    spawn(opts) {
      if (g.endReason !== undefined) throw new Error(`the group "${options.name}" has ended`)
      if (options.maxAgents !== undefined && g.spawned.length >= options.maxAgents) {
        throw new Error(`the group "${options.name}" may start at most ${options.maxAgents} agents`)
      }
      g.spawned.push(opts)
      const id = `s_child${++n}`
      const events: AnyEvent[] = []
      const listeners = new Set<() => void>()
      let done = false
      const push = (e: AnyEvent) => {
        events.push(e)
        for (const l of listeners) l()
      }
      let abortWith: ((r: SubagentResult) => void) | undefined
      const base = {
        sessionId: id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        steps: 1,
        durationMs: 5,
      }
      const result = new Promise<SubagentResult>((resolve) => {
        abortWith = resolve
        const go = async () => {
          running++
          g.peak = Math.max(g.peak, running)
          push({ type: "session.start", sessionId: id, ts: 1, data: {} } as unknown as AnyEvent)
          await Bun.sleep(2)
          let a: Answer
          try {
            a = await answer(opts)
          } catch (err) {
            a = { error: String(err) }
          }
          const tokens = a.tokens ?? 100
          push({
            type: "message.end",
            sessionId: id,
            ts: 2,
            data: { message: { usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } } },
          } as unknown as AnyEvent)
          running--
          waiting.shift()?.()
          const usage = { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }
          resolve(
            a.error !== undefined
              ? { ...base, usage, status: "error", text: "", error: a.error }
              : {
                  ...base,
                  usage,
                  status: "done",
                  text: a.text ?? JSON.stringify(a.value),
                  ...(a.value !== undefined ? { value: a.value } : {}),
                },
          )
        }
        if (options.maxConcurrent === undefined || running < options.maxConcurrent) void go()
        else waiting.push(() => void go())
      }).then((r) => {
        done = true
        live.delete(child)
        for (const l of listeners) l()
        return r
      })
      const child = {
        id,
        parentSessionId: "s_root",
        depth: 1,
        cwd: opts.cwd ?? "/work",
        title: opts.title ?? "",
        persistent: false,
        state: "working",
        turns: 1,
        groupId: "g1",
        model: { provider: "x", id: "y" },
        events: {
          async *[Symbol.asyncIterator]() {
            let i = 0
            for (;;) {
              while (i < events.length) yield events[i++]!
              if (done) return
              await new Promise<void>((r) => listeners.add(r))
            }
          },
        },
        result: () => result,
        abort: (reason?: string) =>
          abortWith?.({ ...base, status: "aborted", text: "", error: reason ?? "aborted" }),
        stop() {},
        send: () => false,
        expectNotice() {
          throw new Error("not persistent")
        },
      } as unknown as ChildSession
      live.add(child)
      return child
    },
    info() {
      return { id: "g1", name: options.name } as SpawnGroupInfo
    },
    setStatus(text) {
      g.statuses.push(text)
    },
    children: () => [...live],
    end(reason) {
      if (g.endReason !== undefined) return
      g.endReason = reason ?? "ended"
      for (const c of live) c.abort(reason)
      settle(g.info())
    },
    ended: () => ended,
  }
  return g
}
