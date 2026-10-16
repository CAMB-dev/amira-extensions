import { expect, mock } from "bun:test"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  ConversationRuntime,
  ConversationSpec,
  ExtensionAPI,
  OwnedConversation,
  ToolContext,
  ToolDefinition,
} from "@amira/api"
import type { SpecArtifact } from "../src/artifacts.ts"
import { Implementations } from "../src/implement.ts"
import { runSpec } from "../src/spec.ts"
import { createProject, IterationStore } from "../src/store.ts"

export const specDraft = (
  revision = 1,
): { spec: SpecArtifact; batches: import("../src/artifacts.ts").BatchPlanArtifact["batches"] } => ({
  spec: {
    kind: "spec",
    revision,
    language: "en",
    summary: "Build a local result without promoting prototype code.",
    body: "## Goal\nExpose a local result.\n\n## Constraints\nNo network or prototype imports.",
    decisionIds: [],
    items: [
      {
        id: "S1",
        description: "Write the approved local result",
        constraints: ["Offline only"],
        verification: ["Run C1"],
        acceptanceCriteria: ["result.txt contains ready"],
        decisionIds: [],
        checkIds: ["C1"],
        ui: false,
      },
    ],
    checks: [{ id: "C1", cwd: ".", command: "git --version" }],
  } satisfies SpecArtifact,
  batches: [{ id: "B1", itemIds: ["S1"], decisionIds: [], files: ["result.txt"] }],
})

// Only local, controlled fixture commands. No process uses the real home or network.
export async function localShell(command: string, cwd: string) {
  const gitPath = Bun.which("git")
  const executable =
    process.platform === "win32" && gitPath
      ? ([
          path.resolve(path.dirname(gitPath), "../bin/bash.exe"),
          path.resolve(path.dirname(gitPath), "../../usr/bin/bash.exe"),
          path.resolve(path.dirname(gitPath), "../usr/bin/bash.exe"),
        ].find((file) => require("node:fs").existsSync(file)) ??
        Bun.which("bash") ??
        "bash")
      : "bash"
  const child = Bun.spawn([executable, "-c", command], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    content: [{ type: "text" as const, text: `${stdout}${stderr}`.trimEnd() }],
    isError: exitCode !== 0,
    details: { exitCode },
  }
}
export const fixtureShell: ToolDefinition = {
  name: "bash",
  description: "Offline temporary-repository fixture shell",
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, timeout: { type: "number" } },
    required: ["command"],
  },
  traits: { shell: "bash" },
  execute: (args, ctx) => localShell(String(args.command), ctx.cwd),
}
export async function git(cwd: string, command: string) {
  const result = await localShell(`git ${command}`, cwd)
  if (result.isError) throw new Error(result.content[0]!.text)
  return result.content[0]!.text.trim()
}
export async function fixture(options: { initialized?: boolean; subdirectory?: boolean } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "project-implement-")))
  const repo = path.join(home, "repo")
  const root = options.subdirectory ? path.join(repo, "packages", "local") : repo
  await mkdir(root, { recursive: true })
  const project = await createProject(root, "Implementation", { language: "en" })
  if (options.initialized !== false) {
    await git(repo, "init")
    await git(repo, 'config user.name "Offline Fixture"')
    await git(repo, 'config user.email "fixture@invalid.local"')
    await git(repo, "config commit.gpgsign false")
    await git(repo, "add -A")
    await git(repo, 'commit -m "Fixture baseline"')
  }
  const store = new IterationStore(project)
  const answers: (string | boolean | undefined | (() => Promise<string | boolean | undefined>))[] = []
  const dialogs: string[] = []
  const prints: string[] = []
  const ask = async (title: string) => {
    dialogs.push(title)
    expect(answers.length, `Unexpected dialog ${title}`).toBeGreaterThan(0)
    const next = answers.shift()
    return typeof next === "function" ? next() : next
  }
  const ctx = {
    cwd: root,
    signal: new AbortController().signal,
    session: {
      info: () => ({ id: "main-fixture", model: { provider: "mock", model: "implementer" }, shell: "bash" }),
    },
    print: (text: string) => prints.push(text),
    focusConversation: mock(() => true),
    ui: {
      select: (title: string) => ask(title),
      confirm: (title: string) => ask(title),
      input: (title: string) => ask(title),
      ask: mock(async () => undefined),
    },
  } as unknown as CommandContext
  const specs: ConversationSpec[] = []
  const runtimes: ConversationRuntime[] = []
  const commands: { key: string; cwd: string; command: string }[] = []
  const handles: OwnedConversation[] = []
  const notifications: string[] = []
  const drafts = [specDraft()]
  const complete = mock(async (_request: unknown) => ({ text: JSON.stringify(drafts.shift()) }))
  let blockCommand: string | undefined
  let hold: (() => Promise<void>) | undefined
  let spawned: unknown
  const api = {
    apiVersion: "0.1.53",
    dataDir: path.join(home, "extension-data"),
    complete,
    notify: (message: string) => notifications.push(message),
    conversations: {
      openOrCreate: async (spec: ConversationSpec, runtime: ConversationRuntime) => {
        specs.push(spec)
        runtimes.push(runtime)
        const handle = {
          id: `owned-${specs.length}`,
          ...spec,
          data: { read: () => [], append: () => {} },
          history: () => [],
          status: () => ({ state: "idle", busy: false }),
          events: { async *[Symbol.asyncIterator]() {} },
          runTool: mock(async (_name: string, args: Record<string, unknown>) => {
            commands.push({ key: spec.key, cwd: spec.cwd, command: String(args.command) })
            if (blockCommand && String(args.command).includes(blockCommand))
              return { content: [{ type: "text", text: "Fixture policy denial" }], isError: true }
            return localShell(String(args.command), spec.cwd)
          }),
          send: mock(async () => {
            if (hold) await hold()
            await runtime.extraTools![0]!.execute({}, {
              cwd: spec.cwd,
              session: { sessionId: handle.id },
              signal: new AbortController().signal,
            } as ToolContext)
          }),
          stop: mock(async () => {}),
          release: mock(async () => {}),
          createGroup: mock(() => ({
            spawn: (opts: unknown) => {
              spawned = opts
              return {
                model: { provider: "mock", model: "actual-implementer" },
                result: async () => {
                  await writeFile(path.join(spec.cwd, "result.txt"), "ready\n")
                  return {
                    status: "done",
                    text: "Implemented the local result",
                    sessionId: "real-child-mock",
                  }
                },
              }
            },
            end: () => {},
            ended: async () => ({}),
          })),
        } as unknown as OwnedConversation
        handles.push(handle)
        return handle
      },
    },
  } as unknown as ExtensionAPI
  const implementations = new Implementations(api)
  const approve = async () => {
    answers.push("Approve spec and batch plan")
    return runSpec(
      api,
      project,
      ctx,
      "en",
      () => {},
      async () => {},
    )
  }
  const settled = async () => {
    for (let i = 0; i < 2400; i++) {
      if (notifications.length) return
      await Bun.sleep(25)
    }
    throw new Error("Implementation did not settle")
  }
  return {
    home,
    repo,
    root,
    project,
    store,
    ctx,
    api,
    specs,
    runtimes,
    handles,
    commands,
    drafts,
    complete,
    answers,
    dialogs,
    prints,
    notifications,
    implementations,
    approve,
    settled,
    spawned: () => spawned,
    block: (value: string) => {
      blockCommand = value
    },
    hold: (value: () => Promise<void>) => {
      hold = value
    },
  }
}
