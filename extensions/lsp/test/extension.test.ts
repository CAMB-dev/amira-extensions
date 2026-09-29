import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import {
  type AnyEvent,
  type CommandContext,
  defineTool,
  type Settings,
  type ToolResultMessage,
  textResult,
} from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { createLspExtension } from "../src/index.ts"

setDefaultTimeout(60_000)

const FAKE = path.join(import.meta.dir, "fake-lsp.ts")
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

/** Stand-ins for the built-in write and edit tools: same names, same details. */
const writeTool = defineTool<{ path: string; content: string; delayMs?: number }>({
  name: "write",
  description: "",
  parameters: {},
  concurrency: "parallel",
  execute: async (p, ctx) => {
    if (p.delayMs) await Bun.sleep(p.delayMs)
    const abs = path.resolve(ctx.cwd, p.path)
    writeFileSync(abs, p.content)
    return {
      ...textResult(`Wrote ${p.path}`),
      details: { path: abs, created: true, lines: 1, bytes: 1, hunks: [] },
    }
  },
})
const editTool = defineTool<{ path: string; old_string: string; new_string: string }>({
  name: "edit",
  description: "",
  parameters: {},
  concurrency: "parallel",
  execute: async (p) => {
    await Bun.sleep(100)
    return textResult(`old_string not found in ${p.path}`, true)
  },
})

function textOf(m: ModelRequest["messages"][number] | undefined): string {
  return m?.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? ""
}

async function setup(replies: ((req: ModelRequest) => MockReply)[], lsp: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lsp-ext-"))
  cleanup.push(async () => {
    for (let i = 0; ; i++) {
      try {
        return rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        if (i >= 50) throw err
        await Bun.sleep(100)
      }
    }
  })
  const mock = createMockDialect()
  for (const r of replies) mock.push(r)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  tools.register(writeTool, "builtin")
  tools.register(editTool, "builtin")
  const settings: Settings = {
    extensions: {
      lsp: {
        waitMs: 3000,
        servers: { fake: { command: [process.execPath, FAKE], extensions: [".fk"] } },
        ...lsp,
      },
    },
  }
  const host = new ExtensionHost({ bus, interceptors, tools, cwd: dir, settings })
  host.renderers.register("write", {
    summary: (a: { path?: string }) => String(a.path),
    result: () => "created",
  })
  expect(await host.load(createLspExtension({ which: () => null }), "pkg:lsp")).toBe(true)
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    systemPrompt: "sys",
    bus,
    tools,
    interceptors,
  })
  const command = async (args: string) => {
    const out: string[] = []
    const ctx = { cwd: dir, print: (t: string) => void out.push(t) } as unknown as CommandContext
    await host.commands.get("lsp")!.def.run(args, ctx)
    return out.join("\n")
  }
  cleanup.push(() => command("restart"))
  return { dir, mock, agent, host, events, bus, command }
}

const results = (req: ModelRequest) =>
  req.messages.filter((m): m is ToolResultMessage => m.role === "toolResult")

test("errors in files a batch of writes changed come back once, with the last write's result", async () => {
  const { mock, agent, host, events, bus, command } = await setup([
    () => ({
      toolCalls: [
        { id: "w1", name: "write", args: { path: "a.fk", content: "ERROR: broken a\n" } },
        {
          id: "w2",
          name: "write",
          args: { path: "b.fk", content: "WARN: meh\nERROR: broken b\n", delayMs: 100 },
        },
        { id: "w3", name: "write", args: { path: "notes.txt", content: "ERROR: not code\n" } },
      ],
    }),
    (req) => {
      const [r1, r2, r3] = results(req)
      // The first write finished while the second still ran: nothing on it.
      expect(textOf(r1)).toBe("Wrote a.fk")
      expect(textOf(r3)).toBe("Wrote notes.txt")
      expect(textOf(r2)).toBe(
        [
          "Wrote b.fk",
          "LSP diagnostics: 2 errors",
          "a.fk:1:1 error broken a (F1)",
          "b.fk:2:1 error broken b (F1)",
        ].join("\n"),
      )
      return { toolCalls: [{ id: "w4", name: "write", args: { path: "a.fk", content: "fixed\n" } }] }
    },
    (req) => {
      expect(textOf(results(req).at(-1))).toBe(
        "Wrote a.fk\nLSP diagnostics: no problems\na.fk: no problems now",
      )
      return { text: "done" }
    },
  ])
  expect(await agent.prompt("go")).toMatchObject({ reason: "done" })
  expect(mock.requests).toHaveLength(3)
  await bus.flush()
  // The frontend event carries the diagnostics too, and the presenter shows them.
  const end = events.find((e) => e.type === "tool.execute.end" && e.data.toolCallId === "w2")
  const presenter = host.renderers.get("write")!
  const view = { args: { path: "b.fk" }, result: (end!.data as { result: never }).result, text: "" }
  expect(presenter.summary?.({ path: "b.fk" })).toBe("b.fk")
  expect(presenter.result?.(view)).toBe("created · 2 errors")
  expect(presenter.body?.(view, { detail: "summary", width: 80 })).toEqual([
    { kind: "error", text: "a.fk:1:1 error broken a (F1)" },
    { kind: "error", text: "b.fk:2:1 error broken b (F1)" },
  ])
  // b.fk still has its error; the status bar counts it.
  expect(host.status.snapshot().find((s) => s.id === "lsp")).toMatchObject({
    text: "lsp 1 error",
    tone: "error",
  })
  const listing = await command("")
  expect(listing).toContain("fake")
  expect(listing).toContain("fake        running · fake-lsp 1.0 · . · 2 files open")
  expect(listing).toContain("b.fk: 1 error")
})

test("a failed edit adds no file, but still reports for the batch; the severity threshold holds", async () => {
  const { mock, agent } = await setup(
    [
      () => ({
        toolCalls: [
          { id: "w1", name: "write", args: { path: "a.fk", content: "WARN: w\nINFO: i\n" } },
          { id: "e1", name: "edit", args: { path: "b.fk", old_string: "x", new_string: "y" } },
        ],
      }),
      (req) => {
        const [w, e] = results(req)
        expect(textOf(w)).toBe("Wrote a.fk")
        expect(textOf(e)).toBe(
          "old_string not found in b.fk\nLSP diagnostics: 1 warning\na.fk:1:1 warning w (F1)",
        )
        return { text: "ok" }
      },
    ],
    { severity: "warning" },
  )
  expect(await agent.prompt("go")).toMatchObject({ reason: "done" })
  expect(mock.requests).toHaveLength(2)
})

test("files of a batch cut short by an abort are not reported with the next turn's edit", async () => {
  const { agent, bus } = await setup([
    () => ({
      toolCalls: [
        { id: "w1", name: "write", args: { path: "a.fk", content: "ERROR: from the aborted turn\n" } },
        { id: "w2", name: "write", args: { path: "b.fk", content: "fine\n", delayMs: 1500 } },
      ],
    }),
    () => ({ toolCalls: [{ id: "w3", name: "write", args: { path: "c.fk", content: "fine\n" } }] }),
    (req) => {
      expect(textOf(results(req).at(-1))).toBe("Wrote c.fk")
      return { text: "ok" }
    },
  ])
  // Abort once the first write is done, while the second still runs.
  const off = bus.subscribe((e) => {
    if (e.type === "tool.execute.end" && e.data.toolCallId === "w1") agent.abort()
  })
  expect(await agent.prompt("go")).toMatchObject({ reason: "aborted" })
  off()
  await bus.flush()
  expect(await agent.prompt("again")).toMatchObject({ reason: "done" })
})

test("servers are shut down when Amira exits, within its exit handlers' time", async () => {
  const { agent, host, command } = await setup([
    () => ({ toolCalls: [{ id: "w1", name: "write", args: { path: "a.fk", content: "fine\n" } }] }),
    () => ({ text: "ok" }),
  ])
  await agent.prompt("go")
  expect(await command("")).toContain("running · fake-lsp")
  const started = Date.now()
  await host.runExitHandlers()
  expect(Date.now() - started).toBeLessThan(4000)
  expect(await command("")).not.toContain("running")
})

test("the check runs after other tool.call.after handlers, so it sees what a formatter wrote", async () => {
  const { mock, agent, host } = await setup([
    () => ({ toolCalls: [{ id: "w1", name: "write", args: { path: "a.fk", content: "ERROR: unformatted\n" } }] }),
    (req) => {
      expect(textOf(results(req)[0])).toBe("Wrote a.fk\nformatted")
      return { text: "ok" }
    },
  ])
  // Loaded after lsp, at the default priority: a formatter hook that fixes the file.
  await host.load(
    (api) =>
      void api.intercept("tool.call.after", (v) => {
        writeFileSync(path.resolve(v.cwd, String(v.args.path)), "fine\n")
        const content = [...v.result.content, { type: "text" as const, text: "formatted" }]
        return { action: "modify", value: { ...v, result: { ...v.result, content } } }
      }),
    "pkg:formatter",
  )
  expect(await agent.prompt("go")).toMatchObject({ reason: "done" })
  expect(mock.requests).toHaveLength(2)
})

test("the diagnostics tool checks any file, with warnings by default", async () => {
  const { dir, mock, agent } = await setup([
    () => ({
      toolCalls: [
        { id: "d1", name: "diagnostics", args: { path: "c.fk" } },
        { id: "d2", name: "diagnostics", args: { path: "clean.fk" } },
        { id: "d3", name: "diagnostics", args: { path: "x.rs" } },
        { id: "d4", name: "diagnostics", args: { path: "readme.md" } },
        { id: "d5", name: "diagnostics", args: { path: "missing.fk" } },
      ],
    }),
    (req) => {
      const [d1, d2, d3, d4, d5] = results(req).map(textOf)
      expect(d1).toBe("LSP diagnostics: 1 warning\nc.fk:1:1 warning careful (F1)")
      expect(d2).toBe("No problems in clean.fk (fake).")
      expect(d3).toBe("No rust language server is installed (looked for rust-analyzer on PATH).")
      expect(d4).toBe("No language server is set up for .md readme.md.")
      expect(d5).toBe("missing.fk is not a file")
      return { text: "ok" }
    },
  ])
  writeFileSync(path.join(dir, "c.fk"), "WARN: careful\n")
  writeFileSync(path.join(dir, "clean.fk"), "ok\n")
  writeFileSync(path.join(dir, "x.rs"), "fn main() {}\n")
  writeFileSync(path.join(dir, "readme.md"), "# hi\n")
  expect(await agent.prompt("go")).toMatchObject({ reason: "done" })
  expect(mock.requests).toHaveLength(2)
  expect(mock.requests[0]!.tools.map((t) => t.name)).toContain("diagnostics")
})

test("settings problems are reported, and enabled: false registers nothing", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tools = new ToolRegistry()
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools,
    settings: { extensions: { lsp: { enabled: false, maxItems: "x" } } },
  })
  await host.load(createLspExtension(), "pkg:lsp")
  await bus.flush()
  expect(tools.get("diagnostics")).toBeUndefined()
  expect(host.commands.get("lsp")).toBeUndefined()
  expect(
    events.filter((e) => e.type === "extension.error").map((e) => (e.data as { error: string }).error),
  ).toEqual(["lsp: extensions.lsp.maxItems must be a number of at least 1"])
})

test("a deleted file's old problems leave the status bar", async () => {
  const { dir, agent, host } = await setup([
    () => ({ toolCalls: [{ id: "w1", name: "write", args: { path: "a.fk", content: "ERROR: e\n" } }] }),
    () => ({ text: "ok" }),
    () => ({ toolCalls: [{ id: "d1", name: "diagnostics", args: { path: "a.fk" } }] }),
    () => ({ text: "ok" }),
  ])
  await agent.prompt("go")
  expect(host.status.snapshot().find((s) => s.id === "lsp")?.text).toBe("lsp 1 error")
  rmSync(path.join(dir, "a.fk"))
  await agent.prompt("again")
  expect(host.status.snapshot().find((s) => s.id === "lsp")?.text).toBe("lsp ✓")
})
