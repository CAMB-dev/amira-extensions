import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, type CommandContext, defineTool, textResult } from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { createHooksExtension, type HooksDeps } from "../src/index.ts"

export interface SetupOptions {
  /** `extensions.hooks` of the user's settings. */
  user?: Record<string, unknown>
  /** The project's .amira/hooks.json. */
  project?: Record<string, unknown>
  /** `extensions.hooks` of the project's .amira/settings.json. */
  projectSettings?: Record<string, unknown>
  /**
   * Answers every confirm dialog; undefined cancels it at once (as print mode does), null leaves
   * it open.
   */
  confirm?: (title: string, message: string) => boolean | undefined | null
  home?: string
  project_dir?: string
  deps?: HooksDeps
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `amira-hooks-${prefix}-`))
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

export async function until(done: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

/**
 * A real host and agent (with a scripted model) in a temporary project, with the hooks
 * extension loaded, an `edit` tool that reports the file it changed like the built-in one does,
 * and a `bash` tool that only echoes its command.
 */
export async function setup(steps: MockStep[], o: SetupOptions = {}) {
  const home = o.home ?? tempDir("home")
  const cwd = o.project_dir ?? tempDir("project")
  if (o.user) writeJson(path.join(home, "settings.json"), { extensions: { hooks: o.user } })
  if (o.project) writeJson(path.join(cwd, ".amira", "hooks.json"), o.project)
  if (o.projectSettings)
    writeJson(path.join(cwd, ".amira", "settings.json"), { extensions: { hooks: o.projectSettings } })
  process.env.AMIRA_HOME = home

  const mock = createMockDialect(steps)
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
  const host = new ExtensionHost({ bus, interceptors, tools, cwd })
  const ran: string[] = []
  tools.register(
    defineTool<{ path: string }>({
      name: "edit",
      description: "",
      parameters: {},
      execute: async (p) => {
        const abs = path.resolve(cwd, p.path)
        mkdirSync(path.dirname(abs), { recursive: true })
        writeFileSync(abs, "x\n")
        return { content: [{ type: "text", text: `edited ${p.path}` }], details: { path: abs } }
      },
    }),
    "test",
  )
  tools.register(
    defineTool<{ command: string }>({
      name: "bash",
      description: "",
      parameters: {},
      execute: async (p) => {
        ran.push(p.command)
        return textResult(`ran ${p.command}`)
      },
    }),
    "test",
  )
  const asked: { title: string; message: string }[] = []
  bus.subscribe((e) => {
    if (e.type !== "ui.request" || e.data.kind !== "confirm") return
    const title = e.data.title
    const message = e.data.message ?? ""
    asked.push({ title, message })
    const answer = o.confirm?.(title, message)
    if (answer === null) return
    if (answer === undefined) host.ui.cancel(e.data.requestId)
    else host.ui.respond(e.data.requestId, answer)
  })
  const ok = await host.load(createHooksExtension(o.deps), "hooks")
  if (!ok) throw new Error(JSON.stringify(events.filter((e) => e.type === "extension.error")))
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd,
    systemPrompt: "sys",
    bus,
    interceptors,
    tools,
  })
  await bus.flush()

  const notices = () =>
    events.flatMap((e) => (e.type === "extension.notice" ? [`${e.data.level}: ${e.data.text}`] : []))
  const errors = () => events.flatMap((e) => (e.type === "extension.error" ? [e.data.error] : []))
  /** Runs a /hooks command line and returns what it printed. */
  const command = async (args: string, extra: Partial<CommandContext> = {}) => {
    const printed: string[] = []
    const ctx = {
      cwd,
      frontend: "print",
      signal: new AbortController().signal,
      ui: host.ui.api("test"),
      print: (text: string) => void printed.push(text),
      ...extra,
    } as unknown as CommandContext
    await host.commands.get("hooks")!.def.run(args, ctx)
    return printed.join("\n")
  }
  return { agent, mock, bus, events, host, home, cwd, ran, asked, notices, errors, command }
}

/** The text blocks of the tool results the model was sent in request `i`. */
export function toolResultTexts(mock: ReturnType<typeof createMockDialect>, i: number): string[] {
  return mock.requests[i]!.messages.flatMap((m) =>
    m.role === "toolResult" ? m.content.map((b) => (b.type === "text" ? b.text : "")) : [],
  )
}
