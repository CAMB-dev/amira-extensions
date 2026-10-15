// offline.ts must run first (bunfig.toml preload): these real host imports must never resolve a live home.

import { expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionControl, TerminalApi } from "@amira/api"
import { frontendSuite, requireFrontendHost, waitFor } from "./frontend-host.ts"

export { frontendSuite, waitFor }
export const ESC = "\x1b[27u"
export const F6 = "\x1b[17~"

/** The upstream app harness's real runtime, with a host-owned conversation manager and durable session. */
export async function frontend(mode: "inline" | "fullscreen", existing?: { root: string; file: string }) {
  const {
    ai: { createAi, createMockDialect },
    core: {
      Agent,
      AgentTree,
      CommandHost,
      EventBus,
      ExtensionHost,
      InterceptorRegistry,
      SessionStore,
      ToolRegistry,
    },
    app: { runInteractive },
    files: { fileList },
    harness: { noProbe, paste },
    kit: { FakeTerminal },
    screen: { VirtualScreen },
    extension: { createProjectExtension },
    store: { IterationStore, readProject },
  } = requireFrontendHost()
  const root = existing?.root ?? (await mkdtemp(path.join(tmpdir(), "project-frontend-")))
  const cwd = path.join(root, "work")
  await mkdir(cwd, { recursive: true })
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const interceptors = new InterceptorRegistry()
  const mock = createMockDialect([])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://offline.invalid" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const session = existing
    ? SessionStore.open(existing.file)
    : SessionStore.create({ cwd, dir: path.join(root, "sessions") })
  const agent = new Agent({
    ai,
    model: ai.model("mock/frontend"),
    cwd,
    session,
    tree,
    bus,
    tools,
    interceptors,
    systemPrompt: "",
  })
  // A small session-control bridge, as in app-harness.ts. No UI API or conversation is substituted.
  const control = {
    info: () => ({
      id: agent.sessionId,
      cwd,
      file: session.file,
      model: { provider: "mock", model: "frontend" },
      contextWindow: 128_000,
      shell: "both",
      busy: agent.busy,
    }),
    data: agent.data,
    messages: () => agent.messages,
    models: () => ["mock/frontend"],
    replies: () => [],
    subagents: () => [],
  } as unknown as SessionControl
  const host = new ExtensionHost({
    bus,
    ai,
    tools,
    interceptors,
    cwd,
    conversations: { ai, tools, tree, home: path.join(root, "owned-home"), agent: () => agent },
    settingsSources: { cwd, home: process.env.AMIRA_HOME! },
  })
  host.setSessionControl(control, () => agent)
  expect(
    await host.load(createProjectExtension(), "test:project-frontend", `frontend-${path.basename(root)}`),
  ).toBe(true)
  const commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent })
  const terminal = new FakeTerminal(120, 42)
  const screen = new VirtualScreen(120, 42)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const outputs: { text: string; level: string }[] = []
  const off = bus.subscribe(
    (event) => {
      if (event.type === "command.output") outputs.push({ text: event.data.text, level: event.data.level })
    },
    { types: ["command.output"] },
  )
  const exited = runInteractive({
    agent,
    terminal,
    commands,
    ui: host.ui,
    status: host.status,
    panels: host.panels,
    views: host.views,
    toolRenderers: host.renderers,
    bindTerminal: (t: TerminalApi) => host.bindTerminal(t),
    setup: noProbe,
    files: fileList(async () => []),
    env: {},
    settings: { mode, margin: 0, marginRows: 0 },
    onReady: () => agent.start("startup"),
  })
  const live = () => screen.lines.join("\n")
  const all = () => [...screen.scrollback, ...screen.lines].join("\n")
  const visible = (text: string) =>
    waitFor(() => live().includes(text), `${mode} screen: ${text}\n${live()}`, 20_000)
  const dialog = async (title: string) => {
    await waitFor(
      () => host.ui.pending[0]?.title === title && live().includes(`╭ ${title}`),
      `${mode} visible dialog: ${title}`,
      20_000,
    )
    expect(host.ui.pending).toHaveLength(1)
  }
  const dismissed = () => waitFor(() => host.ui.pending.length === 0, "dialog dismissed", 20_000)
  const command = async (text: string, output: string) => {
    const before = outputs.length
    terminal.send(`${paste(`/project ${text}`)}\r`)
    await waitFor(
      () => {
        const fresh = outputs.slice(before)
        const failed = fresh.find((line) => line.level === "error")
        if (failed) throw new Error(`Command ${text} failed: ${failed.text}\n${live()}`)
        return fresh.some((line) => line.text.includes(output)) && all().includes(output)
      },
      `command ${text}: ${output}\n${live()}`,
      20_000,
    )
  }
  const send = (text: string) => terminal.send(`${paste(`/project ${text}`)}\r`)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    // Unloading cancels any visible question, releases actual owned handles and their leases.
    terminal.send(ESC)
    await dismissed()
    await bus.flush()
    host.unloadAll()
    await host.drain()
    agent.abort()
    await bus.flush()
    terminal.send("\x15\x04\x04")
    expect(await exited).toBe(0)
    await agent.dispose()
    off()
    session.release()
  }
  const cleanup = async () => {
    await stop()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  try {
    await visible("Amira")
    if (!existing) await command("new Frontend --language en", "Attached project Frontend")
    const project = await readProject(cwd)
    const store = new IterationStore(project)
    return {
      root,
      file: session.file,
      cwd,
      project,
      store,
      host,
      agent,
      mock,
      terminal,
      screen,
      live,
      all,
      visible,
      dialog,
      dismissed,
      command,
      send,
      stop,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function confirmSkip(f: Awaited<ReturnType<typeof frontend>>) {
  f.send("skip design")
  await f.dialog("Confirm stage change")
  f.terminal.send("\x1b[B\r")
  await f.dismissed()
  await f.visible("prototype · idle")
  expect((await f.store.read()).stage).toBe("prototype")
}
