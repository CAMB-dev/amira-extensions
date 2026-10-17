import { afterEach, expect, test } from "bun:test"
import type {
  AnyEvent,
  ChildSession,
  ExtensionAPI,
  SpawnGroup,
  SpawnOptions,
  SubagentResult,
  ToolContext,
  ToolDefinition,
  ToolResult,
  UiRequestOptions,
} from "@amira/api"
import { createSwarmExtension } from "../src/index.ts"
import {
  RUNNER_CAPABILITIES,
  type RunnerOwner,
  type SwarmRunner,
  type SwarmRunReport,
  type SwarmStartRequest,
} from "../src/runner.ts"
import { BOUND_WORKFLOW_UNAVAILABLE, type WorkflowRunner } from "../src/workflows.ts"
import { deferred, workflowRunner } from "./workflow-fake.ts"

const members = [
  { name: "writer", role: "writer", brief: "Write", model: "fake/writer" },
  { name: "reviewer", role: "reviewer", brief: "Review", model: "fake/reviewer" },
]
const textOf = (result: ToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function harness(
  options: {
    enabled?: string
    workflow?: unknown
    memberWorkflows?: boolean
    holdGroup?: boolean
    ended?: boolean
    failSpawn?: number
  } = {},
) {
  let runner!: SwarmRunner
  let tool!: ToolDefinition
  let unload = () => {}
  let root = "root-a"
  let workflow = options.workflow
  let failSpawn = options.failSpawn
  const notices = { expected: 0, cancelled: 0, delivered: 0 }
  const errors: string[] = []
  const confirmations: UiRequestOptions[] = []
  const questions: UiRequestOptions[] = []
  let confirm: () => Promise<boolean | undefined> = async () => true
  const handlers = new Map<string, (event: AnyEvent) => void>()
  const spawns: SpawnOptions[] = []
  const groups: {
    owner: string
    release(): void
    ended: Promise<void>
    drained: boolean
    activeChildren: number
    activeEvents: number
  }[] = []
  const events = new Map<string, (event: AnyEvent) => void>()
  const api = {
    cwd: process.cwd(),
    settings: {
      extensions: {
        swarm: {
          enabled: options.enabled ?? "always",
          limits: { noProgressRounds: 1 },
          memberWorkflows: { enabled: options.memberWorkflows ?? true },
        },
      },
    },
    session: () => ({ info: () => ({ id: root, permissions: { mode: "auto" } }) }),
    useService: (name: string) => (name === "workflow.runner" ? workflow : undefined),
    provideService: (name: string, service: unknown) => {
      if (name === "swarm.runner") runner = service as SwarmRunner
    },
    onUnload: (handler: () => void) => {
      unload = handler
    },
    ui: {
      confirm: async (_title: string, _message: string, opts: UiRequestOptions) => {
        confirmations.push(opts)
        return confirm()
      },
      select: async (_title: string, _choices: string[], opts: UiRequestOptions) => {
        questions.push(opts)
        return "Keep going"
      },
    },
    reportError: (error: string) => errors.push(error),
    requestRender: () => {},
    notify: () => {},
    registerCommand: () => {},
    registerInputHandler: () => {},
    registerStatusItem: () => {},
    registerView: () => {},
    registerTool: (value: ToolDefinition) => {
      tool = value
    },
    on: (name: string, handler: (event: AnyEvent) => void) => handlers.set(name, handler),
  } as unknown as ExtensionAPI
  const createGroup = (owner: string): SpawnGroup => {
    const ended = deferred<void>()
    const release = deferred<void>()
    if (!options.holdGroup) release.resolve()
    const entry = {
      owner,
      release: () => release.resolve(),
      ended: ended.promise,
      drained: false,
      activeChildren: 0,
      activeEvents: 0,
    }
    groups.push(entry)
    const children: (() => void)[] = []
    let attempts = 0
    return {
      spawn: (spawn: SpawnOptions) => {
        if (++attempts === failSpawn) throw new Error("unknown member model")
        entry.activeChildren++
        spawns.push(spawn)
        const id = `child-${spawns.length}`
        const result = deferred<SubagentResult>()
        let stopped = false
        const queue: AnyEvent[] = []
        let wake = deferred<void>()
        const stop = () => {
          if (stopped) return
          stopped = true
          entry.activeChildren--
          result.resolve({
            sessionId: id,
            status: "done",
            text: "Done",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            steps: 1,
            durationMs: 0,
          })
          wake.resolve()
        }
        events.set(spawn.title!, (event) => {
          queue.push(event)
          wake.resolve()
        })
        children.push(stop)
        if (options.ended) stop()
        const [provider, model] = (spawn.model ?? "fake/default").split("/")
        return {
          id,
          model: { provider, model },
          cwd: spawn.cwd,
          get state() {
            return stopped ? "ended" : "working"
          },
          turns: 1,
          pendingNotices: 0,
          events: {
            async *[Symbol.asyncIterator]() {
              entry.activeEvents++
              try {
                while (!stopped) {
                  await wake.promise
                  wake = deferred<void>()
                  while (queue.length) yield queue.shift()!
                }
              } finally {
                entry.activeEvents--
              }
            },
          },
          result: () => result.promise,
          stop,
          abort: stop,
          send: () => !stopped,
        } as unknown as ChildSession
      },
      info: () => ({ tokens: 0 }),
      end: () => {
        for (const stop of children) stop()
        ended.resolve()
      },
      ended: async () => {
        await ended.promise
        await release.promise
        entry.drained = true
        return { tokens: 0 }
      },
    } as unknown as SpawnGroup
  }
  await createSwarmExtension()(api)
  const abort = new AbortController()
  const owner: RunnerOwner = {
    sessionId: "project-owner",
    label: "Project",
    signal: abort.signal,
    createGroup: () => createGroup("project-owner"),
  }
  const request = (): SwarmStartRequest => ({
    goal: "Implement batch",
    members: structuredClone(members),
    cwd: process.cwd(),
    startedBy: { sessionId: "coordinator", label: "Batch 1" },
  })
  const started: string[] = []
  const start = async (input = request()) => {
    const result = await runner.startBound(input, owner)
    if ("runId" in result) started.push(result.runId)
    return result
  }
  const report = (runId: string) => new Promise<SwarmRunReport>((resolve) => runner.onResult(runId, resolve))
  const memberTool = (name: string, params = {}) =>
    spawns[0]!
      .extraTools!.find((tool) => tool.name === name)!
      .execute(params, {
        signal: new AbortController().signal,
        session: { sessionId: "member-writer" },
      } as ToolContext)
  const switchRoot = (id = "root-b") => {
    root = id
    handlers.get("session.start")?.({ type: "session.start", sessionId: id, data: {} } as AnyEvent)
  }
  cleanups.push(async () => {
    unload()
    for (const group of groups) group.release()
    await Promise.all(started.map(report))
  })
  return {
    runner,
    owner,
    abort,
    request,
    start,
    report,
    groups,
    spawns,
    errors,
    notices,
    setFailSpawn: (value: number | undefined) => {
      failSpawn = value
    },
    confirmations,
    questions,
    memberTool,
    unload: () => unload(),
    switchRoot,
    setWorkflow: (value: unknown) => {
      workflow = value
    },
    confirm: (fn: () => Promise<boolean | undefined>) => {
      confirm = fn
    },
    turn: (member: string) =>
      events.get(member)!({
        type: "turn.end",
        sessionId: `child-${member === "writer" ? 1 : 2}`,
        ts: 1,
        data: {},
      } as AnyEvent),
    endRoot: () =>
      handlers.get("session.end")?.({ type: "session.end", sessionId: root, data: {} } as AnyEvent),
    legacyStart: () =>
      tool.execute({ action: "start", goal: "Legacy", members }, {
        signal: new AbortController().signal,
        session: {
          sessionId: root,
          depth: 0,
          createGroup: () => createGroup(root),
          expectNotice: () => {
            notices.expected++
            return {
              cancel: () => notices.cancelled++,
              deliver: () => notices.delivered++,
            }
          },
        },
      } as unknown as ToolContext),
  }
}

async function idOf(result: Awaited<ReturnType<SwarmRunner["startBound"]>>) {
  expect(result).toHaveProperty("runId")
  if ("error" in result) throw new Error(result.error)
  return result.runId
}

test("bound service advertises all capabilities and spawns fresh members with explicit cwd, models and caller groups", async () => {
  const h = await harness()
  expect(h.runner.capabilities).toEqual(RUNNER_CAPABILITIES)
  const id = await idOf(await h.start())
  expect(h.groups.map((group) => group.owner)).toEqual(["project-owner"])
  for (const [index, spawn] of h.spawns.entries()) {
    expect(spawn.cwd).toBe(process.cwd())
    expect(spawn.context).toBe("fresh")
    expect(spawn).toHaveProperty("isolation", "none")
    expect(spawn.model).toBe(members[index]!.model)
    expect(spawn.persistent).toBe(true)
  }
  expect(h.runner.status(id)?.members.map((member) => [member.sessionId, member.model])).toEqual([
    ["child-1", "fake/writer"],
    ["child-2", "fake/reviewer"],
  ])
  expect(h.runner.status(id)?.startedBy).toEqual({ sessionId: "coordinator", label: "Batch 1" })
})

test("progress replays current snapshots, emits changes, detaches payloads and supports unsubscribe", async () => {
  const h = await harness()
  const id = await idOf(await h.start())
  const states: string[] = []
  const off = h.runner.onProgress(id, (snapshot) => {
    states.push(snapshot.state)
    snapshot.members[0]!.role = "mutated"
  })
  expect(states).toEqual([])
  await tick()
  expect(states).toEqual(["running"])
  expect(h.runner.status(id)?.members[0]?.role).toBe("writer")
  await h.memberTool("blackboard_write", { key: "evidence", value: "checked" })
  expect(states.length).toBeGreaterThan(1)
  off()
  const count = states.length
  await h.memberTool("blackboard_write", { key: "evidence", value: "checked again" })
  expect(states).toHaveLength(count)
  let replay = false
  h.runner.onProgress(id, () => {
    replay = true
  })()
  await tick()
  expect(replay).toBe(false)
})

test("results wait for group settlement, replay to late subscribers once and isolate listener failures", async () => {
  const h = await harness({ holdGroup: true })
  const id = await idOf(await h.start())
  let calls = 0
  h.runner.onResult(id, () => {
    throw new Error("listener failed")
  })
  h.runner.onResult(id, () => {
    calls++
  })
  expect(h.runner.stop(id)).toBe(true)
  await tick()
  expect(h.runner.status(id)?.state).toBe("ending")
  expect(calls).toBe(0)
  expect(await h.start()).toHaveProperty("error")
  h.groups[0]!.release()
  const result = await h.report(id)
  expect(result.cwd).toBe(process.cwd())
  expect(result.members[0]?.sessionId).toBe("child-1")
  expect(calls).toBe(1)
  expect(h.errors).toContain("swarm.runner listener: listener failed")
  h.runner.onResult(id, () => {
    calls++
  })
  expect(calls).toBe(1)
  await tick()
  expect(calls).toBe(2)
  h.runner.onResult(id, () => {
    calls++
  })()
  await tick()
  expect(calls).toBe(2)
  expect(h.runner.stop(id)).toBe(false)
  const next = await idOf(await h.start())
  expect(next).not.toBe(id)
  expect(h.runner.status(next)?.board).toEqual([])
})

test("immediate child completion is replayed after start without a subscription race", async () => {
  const h = await harness({ ended: true })
  const id = await idOf(await h.start())
  await tick()
  expect((await h.report(id)).members).toHaveLength(2)
  expect(h.runner.status(id)?.state).toBe("ended")
})

test("owner abort stops bound runs while root switch and root end do not orphan them", async () => {
  const h = await harness()
  const id = await idOf(await h.start())
  h.switchRoot()
  h.endRoot()
  expect(h.runner.status(id)?.state).toBe("running")
  h.abort.abort()
  expect((await h.report(id)).reason).toBe("its owner cancelled")
})

test("confirmation reserves one slot across concurrent service and legacy starts and captures caller values", async () => {
  const h = await harness({ enabled: "ask" })
  const confirmation = deferred<boolean | undefined>()
  h.confirm(() => confirmation.promise)
  const request = h.request()
  const start = h.start(request)
  expect(await h.start()).toHaveProperty("error")
  expect((await h.legacyStart()).isError).toBe(true)
  expect(h.confirmations).toHaveLength(1)
  expect(h.confirmations[0]?.sessionId).toBe("project-owner")
  h.switchRoot()
  request.goal = "Changed"
  request.members[0]!.model = "fake/changed"
  h.owner.createGroup = () => {
    throw new Error("owner mutated")
  }
  confirmation.resolve(true)
  const id = await idOf(await start)
  expect(h.runner.status(id)?.goal).toBe("Implement batch")
  expect(h.spawns[0]?.model).toBe("fake/writer")
  expect(h.groups[0]?.owner).toBe("project-owner")
})

for (const action of ["abort", "unload"] as const) {
  test(`${action} fails closed during confirmation even if the UI answers late`, async () => {
    const h = await harness({ enabled: "ask" })
    const confirmation = deferred<boolean | undefined>()
    h.confirm(() => confirmation.promise)
    const start = h.start()
    if (action === "abort") h.abort.abort()
    else h.unload()
    expect(await start).toHaveProperty("error")
    expect(h.confirmations[0]?.signal?.aborted).toBe(true)
    confirmation.resolve(true)
    await tick()
    expect(h.spawns).toHaveLength(0)
    expect(await h.start()).toHaveProperty("error")
  })
}

test("provider unload stops established runs and later launches remain unavailable", async () => {
  const h = await harness()
  const id = await idOf(await h.start())
  h.unload()
  expect((await h.report(id)).reason).toBe("swarm extension unloaded")
  expect(await h.start()).toHaveProperty("error")
})

test("bound mode confirmation and no-progress questions target the owner after root switch", async () => {
  const h = await harness({ enabled: "mode" })
  await h.start()
  expect(h.confirmations[0]?.sessionId).toBe("project-owner")
  h.switchRoot()
  await h.memberTool("send_message", { to: "reviewer", text: "Discuss" })
  h.turn("writer")
  h.turn("reviewer")
  await tick()
  expect(h.questions).toHaveLength(1)
  expect(h.questions[0]?.sessionId).toBe("project-owner")
})

test("disabled settings, invalid cwd and unknown run IDs fail without launching", async () => {
  const h = await harness({ enabled: "never" })
  expect(await h.start()).toHaveProperty("error")
  expect(await h.start({ ...h.request(), cwd: "relative" })).toHaveProperty("error")
  expect(h.runner.status("unknown")).toBeUndefined()
  expect(h.runner.stop("unknown")).toBe(false)
  h.runner.onProgress("unknown", () => {
    throw new Error("unexpected progress")
  })()
  h.runner.onResult("unknown", () => {
    throw new Error("unexpected result")
  })()
  expect(h.spawns).toHaveLength(0)
})

test("legacy tool still starts with old workflow service and stops on root switch", async () => {
  const service = workflowRunner()
  const h = await harness({ workflow: service.runner })
  expect((await h.legacyStart()).isError).not.toBe(true)
  expect(textOf(await h.memberTool("start_workflow", { name: "check" }))).toContain("Started workflow")
  expect(service.starts).toHaveLength(1)
  h.switchRoot()
  await Promise.all(h.groups.map((group) => group.ended))
  expect(service.stops).toEqual(["wf1"])
})

test("bound member workflows propagate cwd, owner, attribution and cancellation, never legacy start", async () => {
  const service = workflowRunner()
  const calls: { request: unknown; owner: RunnerOwner }[] = []
  const runner: WorkflowRunner = {
    ...service.runner,
    capabilities: RUNNER_CAPABILITIES,
    onProgress: () => () => {},
    start: async () => {
      throw new Error("legacy fallback")
    },
    startBound: async (request, owner) => {
      calls.push({ request, owner })
      return service.runner.start(request, { signal: owner.signal } as ToolContext)
    },
  }
  const h = await harness({ workflow: runner })
  const id = await idOf(await h.start())
  h.switchRoot()
  expect((await h.memberTool("start_workflow", { name: "check" })).isError).not.toBe(true)
  expect(calls[0]?.request).toEqual({
    name: "check",
    cwd: process.cwd(),
    startedBy: { sessionId: "member-writer", label: "writer" },
  })
  expect(calls[0]?.owner.sessionId).toBe("project-owner")
  expect(calls[0]?.owner.label).toBe("Project")
  h.abort.abort()
  await h.report(id)
  expect(calls[0]?.owner.signal.aborted).toBe(true)
  expect(service.stops).toEqual(["wf1"])
})

for (const kind of [
  "absent",
  "legacy",
  "missing flag",
  "missing progress",
  "replaced",
  "unloaded",
] as const) {
  test(`bound member workflow ${kind} is disabled with a reason and no fallback`, async () => {
    const service = workflowRunner()
    const full = {
      ...service.runner,
      capabilities: { ...RUNNER_CAPABILITIES },
      startBound: async () => ({ runId: "never" }),
      onProgress: () => () => {},
    }
    const candidate: unknown =
      kind === "absent"
        ? undefined
        : kind === "legacy"
          ? service.runner
          : kind === "missing flag"
            ? { ...full, capabilities: { ...RUNNER_CAPABILITIES, ownedLifetime: false } }
            : kind === "missing progress"
              ? { ...full, onProgress: undefined }
              : full
    const h = await harness({ workflow: candidate })
    await h.start()
    if (kind === "replaced") h.setWorkflow({ ...full })
    if (kind === "unloaded") h.setWorkflow(undefined)
    const result = await h.memberTool("start_workflow", { name: "check" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(BOUND_WORKFLOW_UNAVAILABLE)
    expect(service.starts).toHaveLength(0)
  })
}

test("explicitly disabled member workflows expose no workflow tools", async () => {
  const h = await harness({ memberWorkflows: false })
  await h.start()
  expect(h.spawns[0]?.extraTools?.some((tool) => tool.name === "start_workflow")).toBe(false)
})

for (const bound of [false, true]) {
  for (const failure of ["member spawn", "service lookup"] as const) {
    test(`${bound ? "bound" : "legacy"} startup ${failure} exception drains groups and listeners before releasing its slot`, async () => {
      const workflow = Object.defineProperty({}, "start", {
        get() {
          throw new Error("workflow service lookup failed")
        },
      })
      const h = await harness({
        holdGroup: true,
        ...(failure === "member spawn" ? { failSpawn: 2 } : { workflow }),
      })
      const pending = bound ? h.start() : h.legacyStart()
      let returned = false
      void pending.then(() => {
        returned = true
      })
      try {
        await tick()
        expect(h.spawns).toHaveLength(failure === "member spawn" ? 1 : 0)
        expect(returned).toBe(false)
        expect(await h.start()).toHaveProperty("error")
        expect((await h.legacyStart()).isError).toBe(true)
        expect(h.groups).toHaveLength(1)
        expect(h.groups[0]!.activeChildren).toBe(0)
        expect(h.groups[0]!.activeEvents).toBe(0)
        h.groups[0]!.release()
        const result = await pending
        if (bound) expect(result).toHaveProperty("error")
        else expect(result).toHaveProperty("isError", true)
        expect(h.groups[0]!.drained).toBe(true)
        expect(h.notices).toEqual({ expected: bound ? 0 : 1, cancelled: bound ? 0 : 1, delivered: 0 })
        h.setFailSpawn(undefined)
        h.setWorkflow(undefined)
        const id = await idOf(await h.start())
        h.runner.stop(id)
        h.groups[1]!.release()
        await h.report(id)
        expect(h.groups.every((group) => group.drained && !group.activeChildren && !group.activeEvents)).toBe(
          true,
        )
      } finally {
        for (const group of h.groups) group.release()
        await pending
      }
    })
  }
}
