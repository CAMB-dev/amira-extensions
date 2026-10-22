import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CompleteRequest,
  CompleteResult,
  ConversationSpec,
  ConversationUsageSnapshot,
  ExtensionAPI,
  OwnedConversation,
} from "@amira/api"
import { accountedGeneration } from "../src/accounted-generation.ts"
import { disposeAccounting } from "../src/accounting.ts"
import { createProject } from "../src/store.ts"

setDefaultTimeout(60_000)
const roots: string[] = []
const apis: ExtensionAPI[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => disposeAccounting(api)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "project-accounted-generation-"))
  roots.push(home)
  const root = path.join(home, "project")
  await mkdir(root)
  const project = await createProject(root, "Text generation")
  const specs: ConversationSpec[] = []
  const controller = new AbortController()
  const ctx = { signal: controller.signal } as CommandContext
  let revision = 0
  let knownCostUsd = 0
  const usage = (): ConversationUsageSnapshot => {
    const value = {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: knownCostUsd },
      knownCostUsd,
      complete: true,
    }
    return { sessionId: "generation-owner", revision, own: value, total: value, descendants: [] }
  }
  let generate: (request: Omit<CompleteRequest, "model">) => Promise<CompleteResult> = async () => ({
    toolsKept: false,
    text: "not valid JSON",
    message: {
      role: "assistant",
      model: { provider: "mock", model: "fixture" },
      content: [{ type: "text", text: "not valid JSON" }],
    },
  })
  const complete = mock(async (request: Omit<CompleteRequest, "model">) => {
    revision++
    knownCostUsd += 0.25
    return generate(request)
  })
  const release = mock(async () => {})
  let handle: OwnedConversation
  const api = {
    dataDir: path.join(home, "extension-data"),
    complete: mock(async () => {
      throw new Error("Main-bound completion must never run")
    }),
    conversations: {
      openOrCreate: mock(async (spec: ConversationSpec) => {
        specs.push(spec)
        handle = {
          id: "generation-owner",
          ...spec,
          complete,
          usage,
          history: () => [],
          status: () => ({ state: "idle", busy: false }),
          events: { async *[Symbol.asyncIterator]() {} },
          data: { read: () => [], append: () => {} },
          stop: async () => {},
          release,
          send: async () => {
            throw new Error("Text generation must not create a conversation turn")
          },
          createGroup: () => {
            throw new Error("Text generation must not create groups")
          },
          runTool: async () => {
            throw new Error("Text generation must not execute tools")
          },
        }
        return handle
      }),
      read: async () =>
        handle && {
          id: handle.id,
          key: handle.key,
          cwd: handle.cwd,
          name: handle.name,
          archived: false,
          history: [],
          usage: usage(),
        },
    },
  } as unknown as ExtensionAPI
  apis.push(api)
  return {
    api,
    ctx,
    project,
    specs,
    complete,
    release,
    controller,
    usage,
    setGenerate(value: typeof generate) {
      generate = value
    },
    run: () =>
      accountedGeneration(
        api,
        project,
        ctx,
        { stage: "implement", role: "spec-generation" },
        {
          system: "English instructions",
          messages: [],
          label: "Project spec",
        },
      ),
  }
}

test("text generation uses an inventoried tool-less owner, never main complete or history", async () => {
  const f = await fixture()
  const result = await f.run()
  expect(result.text).toBe("not valid JSON")
  expect(result.toolsKept).toBe(false)
  expect(() => JSON.parse(result.text)).toThrow()
  expect(f.specs).toHaveLength(1)
  expect(f.specs[0]).toMatchObject({ cwd: f.project.root, callableTools: [], writeRoots: [] })
  expect(f.specs[0]!.key).toContain("/iteration/1/generation/spec-generation/")
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.complete.mock.calls[0]![0]).not.toHaveProperty("model")
  expect(f.complete.mock.calls[0]![0]).not.toHaveProperty("keepSessionTools")
  expect(f.api.complete).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.usage().total.knownCostUsd).toBe(0.25)
})

test("failed owned generation is still drained and retains reported usage", async () => {
  const f = await fixture()
  f.setGenerate(async () => {
    throw new Error("Reported provider failure")
  })
  await expect(f.run()).rejects.toThrow("Reported provider failure")
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.usage().total.knownCostUsd).toBe(0.25)
  expect(f.api.complete).not.toHaveBeenCalled()
})

test("already-cancelled generation creates no owner or request", async () => {
  const f = await fixture()
  f.controller.abort(new Error("Cancelled before launch"))
  await expect(f.run()).rejects.toThrow("Cancelled before launch")
  expect(f.specs).toHaveLength(0)
  expect(f.complete).not.toHaveBeenCalled()
  expect(f.api.complete).not.toHaveBeenCalled()
})

test("cancellation propagates into owned complete and drains before returning", async () => {
  const f = await fixture()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  f.setGenerate(
    (request) =>
      new Promise((_resolve, reject) => {
        started()
        request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true })
      }),
  )
  const pending = f.run()
  await ready
  f.controller.abort(new Error("Stop generation"))
  await expect(pending).rejects.toThrow("Stop generation")
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.api.complete).not.toHaveBeenCalled()
})

test("missing owned complete fails closed without falling back to main completion", async () => {
  const f = await fixture()
  const open = f.api.conversations!.openOrCreate.bind(f.api.conversations)
  f.api.conversations!.openOrCreate = async (spec, runtime) => {
    const handle = await open(spec, runtime)
    Object.defineProperty(handle, "complete", { value: undefined })
    return handle
  }
  await expect(f.run()).rejects.toThrow("owner-bound complete")
  expect(f.complete).not.toHaveBeenCalled()
  expect(f.api.complete).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledTimes(1)
})
