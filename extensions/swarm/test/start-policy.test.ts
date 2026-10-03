import { afterEach, expect, test } from "bun:test"
import type {
  AnyEvent,
  ChildSession,
  ExtensionAPI,
  PermissionMode,
  SpawnGroup,
  SubagentResult,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@amira/api"
import { createSwarmExtension } from "../src/index.ts"
import { readSettings } from "../src/limits.ts"

const members = [
  { name: "writer", role: "writer", brief: "Write the proposal" },
  { name: "reviewer", role: "reviewer", brief: "Review the proposal" },
]
const textOf = (result: ToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Public API fake: members keep working until stopped; no model or core host is needed. */
async function harness(
  opts: {
    mode?: PermissionMode
    enabled?: string
    answer?: boolean
    session?: "missing" | "unavailable"
  } = {},
) {
  let mode = opts.mode
  let tool!: ToolDefinition
  const confirmations: string[] = []
  const notices: string[] = []
  const handlers = new Map<string, (event: AnyEvent) => void>()
  const groups: Promise<void>[] = []
  let spawned = 0
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const createGroup = (): SpawnGroup => {
    let end!: () => void
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    groups.push(ended)
    return {
      spawn: () => {
        const id = `child-${++spawned}`
        let finish!: (result: SubagentResult) => void
        let stopped = false
        const result = new Promise<SubagentResult>((resolve) => {
          finish = resolve
        })
        const stop = () => {
          stopped = true
          finish({ sessionId: id, status: "done", text: "Done", usage, steps: 1, durationMs: 0 })
        }
        return {
          id,
          get state() {
            return stopped ? "ended" : "working"
          },
          turns: 1,
          pendingNotices: 0,
          events: {
            [Symbol.asyncIterator]: () => ({
              next: async (): Promise<IteratorResult<AnyEvent>> => {
                await result
                return { done: true, value: undefined }
              },
            }),
          },
          result: () => result,
          stop,
          abort: stop,
        } as ChildSession
      },
      info: () => ({ tokens: 0 }),
      end: () => end(),
      ended: async () => {
        await ended
        return { tokens: 0 }
      },
    } as unknown as SpawnGroup
  }
  const api = {
    cwd: process.cwd(),
    settings: { extensions: { swarm: opts.enabled === undefined ? {} : { enabled: opts.enabled } } },
    ...(opts.session === "missing"
      ? {}
      : {
          session: () =>
            opts.session === "unavailable"
              ? undefined
              : { info: () => ({ id: "root", ...(mode ? { permissions: { mode, rules: 0 } } : {}) }) },
        }),
    ui: {
      confirm: async (_title: string, message: string) => {
        confirmations.push(message)
        return opts.answer
      },
    },
    notify: (text: string) => {
      notices.push(text)
    },
    reportError: (problem: string) => {
      throw new Error(problem)
    },
    requestRender: () => {},
    registerCommand: () => {},
    registerInputHandler: () => {},
    registerView: () => {},
    registerStatusItem: () => {},
    registerTool: (registered: ToolDefinition) => {
      tool = registered
    },
    on: (name: string, handler: (event: AnyEvent) => void) => {
      handlers.set(name, handler)
    },
  } as unknown as ExtensionAPI
  await createSwarmExtension()(api)
  const ctx = {
    cwd: process.cwd(),
    toolCallId: "start",
    signal: new AbortController().signal,
    update: () => {},
    session: { sessionId: "root", depth: 0, createGroup },
  } as unknown as ToolContext
  const stop = async () => {
    await tool.execute({ action: "stop" }, ctx)
    await Promise.all(groups)
  }
  cleanups.push(stop)
  return {
    confirmations,
    notices,
    get spawned() {
      return spawned
    },
    setMode: (value: PermissionMode) => {
      mode = value
    },
    start: (goal = "Compare options") => tool.execute({ action: "start", goal, members }, ctx),
    stop,
    prompt: (text: string) =>
      handlers.get("turn.start")?.({
        type: "turn.start",
        sessionId: "root",
        seq: 1,
        ts: 0,
        data: { prompt: { role: "user", content: [{ type: "text", text }] } },
      }),
  }
}

test("settings default to mode, accept explicit mode, and preserve legacy mappings", () => {
  expect(readSettings(undefined).enabled).toBe("mode")
  expect(readSettings({ enabled: "mode" }).enabled).toBe("mode")
  expect(readSettings({ enabled: "mode", confirm: false }).enabled).toBe("mode")
  expect(readSettings({ confirm: false }).enabled).toBe("always")
  expect(readSettings({ confirm: true }).enabled).toBe("ask")
  expect(readSettings({ enabled: "explicit" }).enabled).toBe("ask")
})

for (const enabled of [undefined, "mode"]) {
  for (const mode of ["auto", "edits", "plan"] as const) {
    test(`${enabled ?? "default"} in ${mode} follows the permission mode`, async () => {
      const h = await harness({ enabled, mode, answer: true })
      expect(textOf(await h.start())).toContain("Started swarm")
      expect(h.confirmations).toHaveLength(mode === "auto" ? 0 : 1)
      expect(h.spawned).toBe(2)
      if (mode === "auto") {
        expect(h.notices).toHaveLength(1)
        expect(h.notices[0]).toContain("started without asking: permission mode is auto")
      } else expect(h.notices).toEqual([])
    })
  }
}

test("permission mode is read again for each start, not cached when the extension loads", async () => {
  const h = await harness({ mode: "edits", answer: true })
  h.setMode("auto")
  await h.start()
  expect(h.confirmations).toHaveLength(0)
  await h.stop()
  h.setMode("edits")
  await h.start()
  expect(h.confirmations).toHaveLength(1)
  await h.stop()
  h.setMode("auto")
  await h.start()
  expect(h.confirmations).toHaveLength(1)
  expect(h.notices).toHaveLength(2)
})

for (const session of [undefined, "missing", "unavailable"] as const) {
  test(`missing ${session ?? "permission info"} falls back to asking`, async () => {
    const h = await harness({ session, answer: false })
    expect(textOf(await h.start())).toContain("The user declined")
    expect(h.confirmations).toHaveLength(1)
    expect(h.spawned).toBe(0)
    expect(h.notices.join("\n")).not.toContain("permission mode is auto")
  })
}

for (const mode of ["auto", "edits", "plan"] as const) {
  for (const enabled of ["ask", "always", "never"] as const) {
    test(`explicit ${enabled} overrides permission mode ${mode}`, async () => {
      const h = await harness({ enabled, mode, answer: false })
      const result = await h.start()
      expect(h.confirmations).toHaveLength(enabled === "ask" ? 1 : 0)
      expect(h.spawned).toBe(enabled === "always" ? 2 : 0)
      expect(textOf(result)).toContain(
        enabled === "always" ? "Started swarm" : enabled === "never" ? "turned off" : "The user declined",
      )
      expect(h.notices.join("\n")).not.toContain("permission mode is auto")
    })
  }
}

for (const mode of ["auto", "edits", "plan"] as const) {
  test(`print mode with no dialog answer ${mode === "auto" ? "starts" : "refuses"} in ${mode}`, async () => {
    const h = await harness({ mode })
    const result = await h.start()
    expect(h.confirmations).toHaveLength(mode === "auto" ? 0 : 1)
    expect(h.spawned).toBe(mode === "auto" ? 2 : 0)
    expect(textOf(result)).toContain(mode === "auto" ? "Started swarm" : "Nobody confirmed the swarm")
  })
}

for (const mode of ["auto", "edits", "plan"] as const) {
  test(`a user-requested swarm follows the same start policy in ${mode}`, async () => {
    const h = await harness({ mode, answer: false })
    h.prompt("Use a swarm to compare options")
    const result = await h.start()
    expect(h.spawned).toBe(mode === "auto" ? 2 : 0)
    expect(h.confirmations).toHaveLength(mode === "auto" ? 0 : 1)
    if (mode !== "auto") {
      expect(h.confirmations[0]).toContain("You asked for this swarm.")
      expect(textOf(result)).toContain("The user declined")
    }
  })
}

test("switching to auto does not bypass a previous decline for the same goal", async () => {
  const h = await harness({ mode: "edits", answer: false })
  await h.start()
  h.setMode("auto")
  expect(textOf(await h.start())).toContain("already declined")
  expect(h.spawned).toBe(0)
  h.prompt("Use a swarm to compare options")
  expect(textOf(await h.start())).toContain("Started swarm")
  expect(h.spawned).toBe(2)
  expect(h.confirmations).toHaveLength(1)
})
