import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import type { CommandContext, CommandDefinition, FormSpec, FormValues, Settings } from "@amira/api"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { type Run, runner } from "../src/git.ts"
import { createShareExtension } from "../src/index.ts"

const dirs: string[] = []

export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function tempDir(prefix = "share-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** Runs git in a test repository (tests may spawn; the extension itself never does). */
export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** A repository with one commit on main, and identity and signing set for the test only. */
export function repo(): string {
  const cwd = path.join(tempDir("share-repo-"), "project")
  mkdirSync(cwd, { recursive: true })
  git(cwd, "init", "-q", "-b", "main")
  git(cwd, "config", "user.name", "Test")
  git(cwd, "config", "user.email", "test@example.com")
  git(cwd, "config", "commit.gpgsign", "false")
  git(cwd, "config", "core.autocrlf", "false")
  writeFileSync(path.join(cwd, "a.txt"), "one\n")
  git(cwd, "add", "a.txt")
  git(cwd, "commit", "-q", "-m", "feat: first")
  return cwd
}

/** Scripted answers to dialogs, by kind; each call takes the next one. */
export interface Dialogs {
  select?: (string | undefined)[]
  form?: (FormValues | undefined)[]
}

/** The mock model's answer to a request, by which command's sub-agent asks. */
export type Reply = (req: ModelRequest) => MockReply

/** Which of the extension's sub-agents a request comes from. */
export function who(req: ModelRequest): "commit" | "pr" | "review" | "other" {
  if (req.systemPrompt.includes("You write git commit messages")) return "commit"
  if (req.systemPrompt.includes("You write pull request titles")) return "pr"
  if (req.systemPrompt.includes("You are a code reviewer")) return "review"
  return "other"
}

/** Answers with return_result(value) first, then a closing line. */
export function returns(value: Record<string, unknown>): MockReply {
  return { toolCalls: [{ name: "return_result", args: value }] }
}

export function lastIsResult(req: ModelRequest): boolean {
  return req.messages.at(-1)?.role === "toolResult"
}

/**
 * The extension loaded into a real extension host, with a real agent tree on a mock model,
 * so /commit, /pr and /review reach the model the way they do in Amira.
 */
export async function harness(opts: {
  cwd: string
  reply: Reply
  settings?: Settings
  dialogs?: Dialogs
  /** Wraps the runner, e.g. to stand in for gh. */
  run?: (real: Run) => Run
  frontend?: CommandContext["frontend"]
}) {
  const mock = createMockDialect()
  for (let i = 0; i < 200; i++) mock.push((req) => (lastIsResult(req) ? { text: "done" } : opts.reply(req)))
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, cwd: opts.cwd, settings: opts.settings ?? {} })
  const errors: string[] = []
  bus.subscribe((e) => {
    if (e.type === "extension.error") errors.push(JSON.stringify(e.data))
  })
  const ranArgv: string[][] = []
  expect(
    await host.load((api) => {
      // Programs run through the host's runCommand, as in Amira.
      const base = runner(api)
      const inner = opts.run ? opts.run(base) : base
      const run: Run = (argv, o) => {
        ranArgv.push(argv)
        return inner(argv, o)
      }
      createShareExtension({ run })(api)
    }, "pkg:share"),
  ).toBe(true)
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const root = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: opts.cwd,
    systemPrompt: "main",
    bus,
    interceptors,
    tools,
    tree,
  })
  const printed: { text: string; level: string }[] = []
  const asked: { kind: string; title: string; spec?: FormSpec }[] = []
  const selects = [...(opts.dialogs?.select ?? [])]
  const forms = [...(opts.dialogs?.form ?? [])]
  const controller = new AbortController()
  const ctx = {
    cwd: opts.cwd,
    frontend: opts.frontend ?? "tui",
    signal: controller.signal,
    print: (text: string, level = "info") => void printed.push({ text, level }),
    ui: {
      select: async (title: string) => {
        asked.push({ kind: "select", title })
        return selects.shift()
      },
      confirm: async () => undefined,
      input: async () => undefined,
      reviewDiff: async () => undefined,
      form: async (spec: FormSpec) => {
        asked.push({ kind: "form", title: spec.title, spec })
        return forms.shift()
      },
    },
    session: {
      createGroup: (o: Parameters<AgentTree["createGroup"]>[1]) => tree.createGroup(root, o),
      info: () => ({ id: root.sessionId, cwd: opts.cwd }),
    },
    commands: () => [],
    skills: () => [],
    aliases: () => [],
    quit: () => {},
  } as unknown as CommandContext
  const command = (name: string): CommandDefinition => host.commands.get(name)!.def
  const run = async (line: string) => {
    const [name, ...rest] = line.replace(/^\//, "").split(" ")
    printed.length = 0
    await command(name!).run(rest.join(" "), ctx)
    return printed.map((p) => p.text).join("\n")
  }
  return { host, mock, run, printed, asked, errors, ranArgv, ctx, controller, command, tree }
}
