import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  ChildSession,
  CommandContext,
  ExtensionAPI,
  OwnedConversation,
  SessionControl,
  SpawnGroup,
  SpawnGroupInfo,
  SpawnOptions,
  SubagentResult,
  ToolDefinition,
  UiApi,
} from "@amira/api"
import { fixPrompt, parse, ReviewCommands, words } from "../src/command.ts"
import extension from "../src/index.ts"
import { hash } from "../src/privacy.ts"
import { ReviewRunner, settingFields, settingsSnapshot } from "../src/run.ts"
import { ReportStore, repoKey } from "../src/store.ts"
import { consentSummary, preflight } from "../src/ui.ts"
import { fakeWorkflow } from "./deep-fixture.ts"

setDefaultTimeout(60000)
const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})
const defaults = Object.fromEntries(settingFields.map((field) => [field.key, field.default]))
const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }
const signal = () => new AbortController().signal
const done = (value: unknown): SubagentResult => ({
  sessionId: "child",
  status: "done",
  text: "DO NOT PARSE THIS",
  value,
  usage,
  steps: 1,
  durationMs: 1,
})
const empty = () => done({ findings: [], limitations: [] })
const candidate = {
  path: "file.ts",
  side: "new",
  startLine: 1,
  endLine: 1,
  severity: "P2",
  category: "correctness",
  summary: "Failure on changed input",
  scenario: "Calling the changed function returns an invalid value.",
  suggestedFix: "Restore the contract.",
  evidence: [{ path: "file.ts", side: "new", line: 1, reason: "Changed value" }],
}

async function fixture(
  results = [empty(), empty()],
  options: {
    held?: boolean
    exceeded?: boolean
    releaseError?: boolean | string
    shellKind?: string
    deny?: boolean
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "amira-review-run-"))
  roots.push(root)
  const repo = path.join(root, "repo"),
    data = path.join(root, "data")
  await mkdir(repo)
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Review fixture",
    GIT_AUTHOR_EMAIL: "test@invalid",
    GIT_COMMITTER_NAME: "Review fixture",
    GIT_COMMITTER_EMAIL: "test@invalid",
  }
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code) throw new Error(`${args.join(" ")}: ${stderr}`)
    return stdout
  }
  await git("init", "-q")
  await writeFile(path.join(repo, "file.ts"), "export const answer = 1\n")
  await git("add", "file.ts")
  await git("-c", "core.hooksPath=", "commit", "-qm", "fixture")
  await writeFile(path.join(repo, "file.ts"), "export const answer = 2\n")
  let currentId = "main",
    busy = false,
    released = 0,
    ownerSends = 0,
    mainSends = 0,
    stopped = 0,
    raw = 0
  let releaseHeld: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  const specs: unknown[] = [],
    spawns: SpawnOptions[] = [],
    calls: string[] = [],
    states: string[] = [],
    outputs: string[] = [],
    saves: unknown[] = []
  const children: ChildSession[] = []
  let runtimeTools: ToolDefinition[] = []
  const group = {
    id: "group",
    name: "test",
    spawn(opts: SpawnOptions) {
      spawns.push(opts)
      const result = results[spawns.length - 1] ?? empty()
      const child = {
        id: `child${spawns.length}`,
        state: options.held ? "queued" : "working",
        events: (async function* () {})(),
        result: async () => {
          if (options.held) await held
          return result
        },
        abort: () => releaseHeld?.(),
      } as unknown as ChildSession
      children.push(child)
      return child
    },
    info: () =>
      ({
        id: "group",
        name: "test",
        parentSessionId: "owner",
        state: options.exceeded ? "ended" : "active",
        exceeded: options.exceeded,
        tokens: 10,
        usage,
        limits: {},
        agents: { total: spawns.length, ended: spawns.length, queued: 0, working: 0, idle: 0 },
      }) as SpawnGroupInfo,
    end: () => releaseHeld?.(),
    ended: async () => group.info(),
    children: () => children,
    setStatus: () => {},
  } as SpawnGroup
  const owner = {
    id: "owner",
    key: "inert",
    cwd: repo,
    send: async () => {
      ownerSends++
      throw new Error("Owner send forbidden")
    },
    createGroup: (limits: unknown) => {
      specs.push(limits)
      return group
    },
    stop: async () => {
      stopped++
      releaseHeld?.()
    },
    release: async () => {
      released++
      if (options.releaseError)
        throw new Error(typeof options.releaseError === "string" ? options.releaseError : "release failed")
    },
    runTool: async (name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      opts?.signal?.throwIfAborted()
      if (name === "review_artifact") {
        const tool = runtimeTools.find((entry) => entry.name === name)!
        return tool.execute(args, {
          cwd: repo,
          signal: opts?.signal ?? signal(),
          toolCallId: "artifact",
          update: () => {},
        })
      }
      const command = String(args.command)
      calls.push(command)
      if (options.deny) return { isError: true, content: [{ type: "text", text: "Denied by policy" }] }
      if (command === "git --version")
        return {
          content: [{ type: "text", text: "git version fixture\n\nExit code: 0" }],
          details: {
            exitCode: 0,
            timedOut: false,
            aborted: false,
            settled: true,
            shellKind: options.shellKind ?? "bash",
            outputLines: 1,
          },
        }
      const executable = Bun.which("bash")!
      if (!executable) throw new Error("Offline test Bash is unavailable")
      const proc = Bun.spawn([executable, "-c", command], {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
        signal: opts?.signal,
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const output = (stdout + stderr).trimEnd()
      return {
        content: [{ type: "text", text: `${output || "(no output)"}\n\nExit code: ${code}` }],
        isError: code !== 0,
        details: {
          exitCode: code,
          timedOut: false,
          aborted: false,
          settled: true,
          shellKind: "bash",
          outputLines: output ? output.split("\n").length : 0,
        },
      }
    },
  } as unknown as OwnedConversation
  const session = {
    info: () => ({
      id: currentId,
      cwd: repo,
      model: { provider: "mock", model: "review" },
      busy,
      shell: "bash",
    }),
    models: () => ["mock/review"],
    tools: () => [{ name: "bash", enabled: true, traits: { shell: "bash" } }],
    send: async () => {
      mainSends++
    },
  } as unknown as SessionControl
  const ui = {
    confirm: async () => true,
    ask: async () => undefined,
    choose: async () => undefined,
  } as unknown as UiApi
  const api = {
    dataDir: data,
    cwd: repo,
    apiVersion: "0.1.56",
    conversations: {
      openOrCreate: async (spec: unknown, runtime: { extraTools: ToolDefinition[] }) => {
        specs.push(spec)
        runtimeTools = runtime.extraTools
        return owner
      },
    },
    session: () => session,
    requestRender: () => {
      states.push(runner.snapshot()?.phase ?? "idle")
    },
    reportError: (error: string) => outputs.push(error),
    runCommand: () => {
      raw++
      throw new Error("raw command forbidden")
    },
  } as unknown as ExtensionAPI
  const store = new ReportStore(data)
  const original = store.save.bind(store)
  store.save = async (report) => {
    saves.push(structuredClone(report))
    await original(report)
  }
  const runner = new ReviewRunner(api, store)
  const request = {
    scope: { kind: "worktree" as const, paths: [], includeUntracked: false },
    session,
    cwd: repo,
    ui,
    settings: settingsSnapshot(defaults, session),
    signal: signal(),
    printMode: false,
  }
  const ctx = {
    cwd: repo,
    session,
    frontend: "tui",
    signal: signal(),
    ui,
    print: (text: string) => outputs.push(text),
  } as unknown as CommandContext
  return {
    runner,
    git,
    request,
    store,
    session,
    api,
    ctx,
    repo,
    spawns,
    specs,
    calls,
    states,
    outputs,
    saves,
    counters: () => ({ released, ownerSends, mainSends, stopped, raw }),
    switch: () => {
      currentId = "switched"
    },
    busy: () => {
      busy = true
    },
    release: () => releaseHeld?.(),
  }
}

describe("bounded runner", () => {
  for (const ref of ["ordinary-baseline", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"]) {
    test(`since scope exposes only the resolved base OID, never the ref name (${ref.startsWith("ghp_") ? "credential-shaped" : "ordinary"})`, async () => {
      const f = await fixture([
        done({ findings: [candidate], limitations: [] }),
        empty(),
        done({
          assessments: [
            {
              id: "F001",
              assessment: "supported",
              rationale: "Static caller evidence supports the changed contract.",
            },
          ],
          limitations: [],
        }),
      ])
      const base = (await f.git("rev-parse", "HEAD")).trim()
      await f.git("tag", ref, base)
      await f.git("-c", "core.hooksPath=", "commit", "-qam", "benign temporary change")
      const scope = { kind: "since" as const, ref, paths: [], includeUntracked: false }
      const request = { ...f.request, scope }
      let preview = "",
        confirmation = "",
        promptBytes = 0
      const report = await (
        await f.runner.start(request, async (bundle, guidance, _signal, exposure) => {
          preview = preflight(bundle, request.settings, guidance, exposure)
          confirmation = consentSummary(bundle, request.settings, guidance, exposure.promptBytes)
          promptBytes = exposure.promptBytes
          expect(bundle.scope.ref).toBe(ref) // Keep operational identity private and unchanged.
          return true
        })
      ).completion
      expect(report.state).toBe("completed")
      expect(f.spawns).toHaveLength(3)
      expect(f.spawns.map((child) => child.prompt.includes(ref))).toEqual([false, false, false])
      expect(preview).not.toContain(ref)
      expect(confirmation).not.toContain(ref)
      expect(confirmation).toContain(base)
      const expected = { kind: "since", paths: [], includeUntracked: false, base }
      // Undo only the Markdown escaping in the preview's scope line for a semantic comparison.
      const previewScope = preview.split("\n").find((line) => line.startsWith("Scope: "))!
      const exposed = JSON.parse(
        previewScope.slice(previewScope.indexOf("; ") + 2).replace(/\\([\\`*_{}[\]<>#+!|])/g, "$1"),
      )
      expect(exposed).toEqual(expected)
      for (const child of f.spawns) {
        expect(child.prompt).not.toContain(ref)
        expect(JSON.parse(/^Scope: (.+)$/m.exec(child.prompt)![1]!)).toEqual(exposed)
        expect(child.systemPrompt).not.toContain(ref)
      }
      expect(promptBytes).toBe(
        f.spawns
          .slice(0, 2)
          .reduce((bytes, child) => bytes + Buffer.byteLength((child.systemPrompt ?? "") + child.prompt), 0),
      )
      if (ref.startsWith("ghp_")) {
        const saved = await f.store.last(report.repoKey)
        expect(JSON.stringify(saved)).not.toContain(ref)
        expect(fixPrompt(saved!.findings[0]!, saved!)).not.toContain(ref)
      }
    })
  }

  test("middle-only PEM changes never expose key bodies in reviewer prompts, context, reports or hand-off", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString()
    const rows = ["export const embedded = `", ...pem.trimEnd().split("\n"), "`", ""]
    const line = Math.floor(rows.length / 2)
    const rawBody = rows[line]!
    const keyFinding = {
      ...candidate,
      startLine: line + 1,
      endLine: line + 1,
      summary: `Check this material: ${rawBody}`,
      evidence: [{ path: "file.ts", side: "new", line: line + 1, reason: "Changed embedded key material" }],
    }
    const f = await fixture([done({ findings: [keyFinding], limitations: [] }), empty()])
    await writeFile(path.join(f.repo, "file.ts"), rows.join("\n"))
    await f.git("add", "file.ts")
    await f.git("-c", "core.hooksPath=", "commit", "-qm", "embedded temporary test key")
    rows[line] += " "
    await writeFile(path.join(f.repo, "file.ts"), rows.join("\n"))
    f.request.settings = { ...f.request.settings, verify: false }
    const report = await (await f.runner.start(f.request, async () => true)).completion
    expect(report.state).toBe("completed")
    expect(report.findings).toHaveLength(1)
    expect(f.spawns.map((child) => child.prompt).join("\n")).not.toContain(rawBody)
    const reader = f.spawns[0]!.extraTools!.find((tool) => tool.name === "review_read")!
    const result = await reader.execute(
      { path: "file.ts", offset: line, limit: 4 },
      { cwd: f.repo, signal: signal(), toolCallId: "pem-context", update() {} },
    )
    expect(JSON.stringify(result)).not.toContain(rawBody)
    const saved = await f.store.last(report.repoKey)
    expect(JSON.stringify(saved)).not.toContain(rawBody)
    expect(fixPrompt(saved!.findings[0]!, saved!)).not.toContain(rawBody)
  })

  test("two fresh schema children, exact ceilings, running checkpoint, no owner/raw calls and zero candidate finish", async () => {
    const f = await fixture()
    const { completion } = await f.runner.start(f.request, async () => true)
    const report = await completion
    expect(report.state).toBe("completed")
    expect(report.findings).toEqual([])
    expect(f.spawns).toHaveLength(2)
    for (const child of f.spawns) {
      expect(child.context).toBe("fresh")
      expect(child.tools).toEqual([])
      expect(child.callableTools).toEqual(["review_read", "review_search", "return_result"])
      expect(child.extraTools?.map((tool) => tool.name)).toEqual(["review_read", "review_search"])
      expect(child.schema).toBeDefined()
      expect(child.persistent).not.toBe(true)
      expect(child.ephemeral).not.toBe(true)
    }
    expect(f.specs).toContainEqual(
      expect.objectContaining({ maxAgents: 3, maxConcurrent: 2, budget: { tokens: 120000, costUsd: 2 } }),
    )
    expect(f.specs).toContainEqual(
      expect.objectContaining({
        writeRoots: [],
        descendants: "research",
        callableTools: ["bash", "review_artifact", "review_read", "review_search", "return_result"],
      }),
    )
    expect((f.saves[0] as { state: string }).state).toBe("running")
    expect(f.counters()).toEqual({ released: 1, ownerSends: 0, mainSends: 0, stopped: 0, raw: 0 })
    expect(await f.store.last(report.repoKey)).toEqual(report)
    expect(f.runner.snapshot()).toBeUndefined()
  })
  test("one batched verifier assesses candidates and group usage counted once", async () => {
    const f = await fixture([
      done({ findings: [candidate], limitations: [] }),
      empty(),
      done({
        assessments: [
          { id: "F001", assessment: "supported", rationale: "Changed value defeats the caller contract" },
        ],
        limitations: [],
      }),
    ])
    const report = await (await f.runner.start(f.request, async () => true)).completion
    expect(report.state).toBe("completed")
    expect(f.spawns).toHaveLength(3)
    expect(report.findings[0]?.assessment).toBe("supported")
    expect(report.usage).toEqual({ tokens: 10, reported: usage })
  })
  test("no-verify leaves candidates unchecked without a third agent", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
    f.request.settings = { ...f.request.settings, verify: false }
    const report = await (await f.runner.start(f.request, async () => true)).completion
    expect(report.state).toBe("completed")
    expect(f.spawns).toHaveLength(2)
    expect(report.findings[0]?.assessment).toBe("unchecked")
  })
  test("failed/text-only/early child results are incomplete, never parsed or retried", async () => {
    for (const failed of [
      { ...empty(), status: "error", value: undefined },
      { ...empty(), value: undefined, text: '{"findings":[]}' },
      { ...empty(), note: "turn limit" },
    ]) {
      const f = await fixture([failed as SubagentResult, empty()])
      const report = await (await f.runner.start(f.request, async () => true)).completion
      expect(report.state).toBe("partial")
      expect(f.spawns).toHaveLength(2)
      expect(report.limitations.join(" ")).toContain("incomplete")
    }
  })
  test("long reviewer, verifier and cleanup diagnostics retain valid partial findings durably", async () => {
    const diagnostic = "failure with ordinary diagnostic detail ".repeat(160)
    const failure = { ...empty(), status: "error" as const, value: undefined, error: diagnostic }
    for (const phase of ["reviewer", "verifier", "cleanup"]) {
      const results = [
        done({ findings: [candidate], limitations: [] }),
        phase === "reviewer" ? failure : empty(),
        failure,
      ]
      const f = await fixture(results, { releaseError: phase === "cleanup" ? diagnostic : false })
      f.request.settings = { ...f.request.settings, verify: phase === "verifier" }
      const report = await (await f.runner.start(f.request, async () => true)).completion
      expect(report.state).toBe("partial")
      expect(report.findings).toHaveLength(1)
      expect(report.limitations.every((message) => message.length <= 4096)).toBe(true)
      expect(report.limitations.join("\n")).toContain("[truncated]")
      expect((await f.store.last(report.repoKey))?.findings).toHaveLength(1)
      expect((await f.store.last(report.repoKey))?.state).toBe("partial")
    }
  })
  test("domain-invalid structured findings are partial coverage, not a clean completed review", async () => {
    const f = await fixture([
      done({ findings: [{ ...candidate, startLine: 999, endLine: 999 }], limitations: [] }),
      empty(),
    ])
    const report = await (await f.runner.start(f.request, async () => true)).completion
    expect(report.state).toBe("partial")
    expect(report.findings).toHaveLength(0)
    expect(report.limitations.join(" ")).toContain("omitted")
  })
  test("stop cancels unanswered consent and settled waits for preflight owner release", async () => {
    const f = await fixture()
    let entered!: () => void
    const atConsent = new Promise<void>((resolve) => {
      entered = resolve
    })
    const starting = f.runner.start(f.request, async (_bundle, _guidance, runSignal) => {
      entered()
      return new Promise<boolean>((resolve) =>
        runSignal.addEventListener("abort", () => resolve(false), { once: true }),
      )
    })
    const failure = starting.catch((error: unknown) => error)
    await atConsent
    const settled = f.runner.settled()
    f.runner.stop("Stopped at consent")
    expect(String(await failure)).toContain("cancelled")
    await settled
    expect(f.runner.snapshot()).toBeUndefined()
    expect(f.counters().released).toBe(1)
    expect(f.spawns).toHaveLength(0)
  })
  test("budget exhaustion before assessment keeps findings unchecked and partial", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()], { exceeded: true })
    const report = await (await f.runner.start(f.request, async () => true)).completion
    expect(f.spawns).toHaveLength(2)
    expect(report.state).toBe("partial")
    expect(report.findings[0]?.assessment).toBe("unchecked")
  })
  test("queued initial snapshot, second run refusal, explicit stop drains and releases", async () => {
    const f = await fixture(undefined, { held: true })
    const { completion } = await f.runner.start(f.request, async () => true)
    expect(Object.values(f.runner.snapshot()!.children)).toEqual(["queued", "queued"])
    await expect(f.runner.start(f.request, async () => true)).rejects.toThrow("active")
    f.runner.stop("Test stop")
    expect(f.runner.snapshot()?.phase).toBe("stopping")
    expect((await completion).state).toBe("cancelled")
    expect(f.counters().released).toBe(1)
  })
  test("interactive command signal is detached after consent; print signal remains cancellation", async () => {
    for (const printMode of [false, true]) {
      const f = await fixture(undefined, { held: true }),
        abort = new AbortController()
      f.request.signal = abort.signal
      f.request.printMode = printMode
      const { completion } = await f.runner.start(f.request, async () => true)
      abort.abort()
      if (!printMode) {
        expect(f.runner.snapshot()?.phase).toBe("reviewing")
        f.release()
      }
      expect((await completion).state).toBe(printMode ? "cancelled" : "completed")
    }
  })
  test("preflight cancellation, drift, busy, denial and unsupported dialect stop without provider work", async () => {
    const cancelled = await fixture()
    await expect(cancelled.runner.start(cancelled.request, async () => false)).rejects.toThrow("cancelled")
    expect(cancelled.spawns).toHaveLength(0)
    expect(cancelled.counters().released).toBe(1)
    const drift = await fixture()
    await expect(
      drift.runner.start(drift.request, async () => {
        await writeFile(path.join(drift.repo, "file.ts"), "edited\n")
        return true
      }),
    ).rejects.toThrow("changed")
    expect(drift.spawns).toHaveLength(0)
    for (const options of [{ deny: true }, { shellKind: "unknown" }]) {
      const f = await fixture(undefined, options)
      await expect(f.runner.start(f.request, async () => true)).rejects.toThrow()
      expect(f.spawns).toHaveLength(0)
      expect(f.counters().raw).toBe(0)
    }
    const f = await fixture()
    f.busy()
    await expect(f.runner.start(f.request, async () => true)).rejects.toThrow("idle")
  })
  test("freshness drift during review marks stale; cleanup failures visible", async () => {
    const f = await fixture(undefined, { held: true, releaseError: true })
    const { completion } = await f.runner.start(f.request, async () => true)
    await writeFile(path.join(f.repo, "file.ts"), "another value\n")
    f.release()
    const report = await completion
    expect(report.stale).toBe(true)
    expect(report.state).toBe("partial")
    expect(report.limitations.join(" ")).toContain("cleanup failed")
  })
})

describe("command contracts", () => {
  test("explicit scopes, include-untracked opt-in and literal quoting", () => {
    expect(parse("worktree")).toEqual({
      action: "start",
      scope: { kind: "worktree", paths: [], includeUntracked: false },
      noVerify: false,
      yes: false,
    })
    expect(
      parse('worktree --include-untracked --path "space and apostrophe\'s/文件.ts" --no-verify --yes'),
    ).toMatchObject({
      scope: { includeUntracked: true, paths: ["space and apostrophe's/文件.ts"] },
      noVerify: true,
      yes: true,
    })
    expect(words('since "HEAD~1"')).toEqual(["since", "HEAD~1"])
    for (const input of [
      "since",
      "since -x",
      "since A..B",
      "since HEAD --include-untracked",
      "worktree --path ../escape",
      "worktree --path :/all",
      "worktree --wat",
      "fix F001 F002",
      "status extra",
      "worktree\nstop",
      'worktree --path "unterminated',
    ])
      expect(() => parse(input)).toThrow()
  })
  test("model/setting validation and capabilities fail early", async () => {
    const f = await fixture()
    for (const changes of [
      { reviewerModel: "missing/model" },
      { maxParallel: 3 },
      { maxTokens: NaN },
      { maxCostUsd: 0 },
      { verify: "yes" },
    ])
      expect(() => settingsSnapshot({ ...defaults, ...changes }, f.session)).toThrow()
    expect(settingsSnapshot(defaults, f.session, true).verify).toBe(false)
    expect(settingsSnapshot({ ...defaults, maxCostUsd: 0.001 }, f.session).maxCostUsd).toBe(0.001)
    const noOwned = new ReviewRunner({ ...f.api, conversations: undefined })
    await expect(noOwned.start(f.request, async () => true)).rejects.toThrow("0.1.56")
  })
  test("print explicit yes, complete report, and no automatic main send/focus", async () => {
    const f = await fixture(),
      command = new ReviewCommands(f.api, f.runner, () => defaults)
    Object.assign(f.ctx, {
      frontend: "print",
      openView: () => {
        throw new Error("Automatic focus forbidden")
      },
    })
    await command.run("worktree", f.ctx)
    expect(f.spawns).toHaveLength(0)
    expect(f.outputs.join(" ")).toContain("--yes")
    await command.run("worktree --yes", f.ctx)
    expect(f.spawns).toHaveLength(2)
    expect(f.outputs.join("\n")).toContain("Limitations")
    expect(f.counters().mainSends).toBe(0)
  })
  test("hand-off is explicit once, current idle identity and fresh scope/context required", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
    f.request.settings = { ...f.request.settings, verify: false }
    await (await f.runner.start(f.request, async () => true)).completion
    const command = new ReviewCommands(f.api, f.runner, () => defaults)
    Object.assign(f.ctx.ui, { confirm: async () => false })
    await command.run("fix F001", f.ctx)
    expect(f.counters().mainSends).toBe(0)
    Object.assign(f.ctx.ui, { confirm: async () => true })
    await command.run("fix F001", f.ctx)
    expect(f.counters().mainSends).toBe(1)
    await writeFile(path.join(f.repo, "file.ts"), "drift\n")
    await command.run("fix F001", f.ctx)
    expect(f.counters().mainSends).toBe(1)
    expect(f.outputs.join(" ")).toContain("stale")
  })
  test("freshness accepts recorded empty source snapshots without inventing a line", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
    await writeFile(path.join(f.repo, "empty.ts"), "")
    await f.git("add", "empty.ts")
    f.request.settings = { ...f.request.settings, verify: false }
    const report = await (await f.runner.start(f.request, async () => true)).completion
    report.snapshotHashes["empty.ts"] = hash("")
    await expect(f.runner.checkFresh(report, f.session, f.repo, f.ctx.ui, signal())).resolves.toBeUndefined()
  })
  test("the final asynchronous repository lookup cannot steer a busy, switched or cancelled main", async () => {
    for (const cause of ["busy", "switch", "cancel"]) {
      const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
      f.request.settings = { ...f.request.settings, verify: false }
      await (await f.runner.start(f.request, async () => true)).completion
      const controller = new AbortController()
      Object.assign(f.ctx, { signal: controller.signal })
      let armed = false
      const fresh = f.runner.checkFresh.bind(f.runner)
      f.runner.checkFresh = async (...args) => {
        await fresh(...args)
        armed = true
      }
      const info = f.session.info.bind(f.session)
      f.session.info = () => {
        const captured = info()
        if (armed) {
          armed = false
          queueMicrotask(() => {
            if (cause === "busy") f.busy()
            else if (cause === "switch") f.switch()
            else controller.abort("Cancelled during final lookup")
          })
        }
        return captured
      }
      const command = new ReviewCommands(f.api, f.runner, () => defaults)
      await command.run("fix F001", f.ctx)
      expect(f.counters().mainSends).toBe(0)
      expect(f.outputs.join(" ")).toContain(
        cause === "busy" ? "busy" : cause === "switch" ? "changed" : "Cancelled",
      )
    }
  })
  test("ignoring from an older open picker does not replace a newer completed report", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
    f.request.settings = { ...f.request.settings, verify: false }
    const older = await (await f.runner.start(f.request, async () => true)).completion
    let latestId = ""
    let chosen = false
    Object.assign(f.ctx.ui, {
      choose: async (_title: string, options: string[]) => {
        if (chosen) return undefined
        chosen = true
        // The picker already holds A when the background review B becomes last.
        const newer = await (await f.runner.start(f.request, async () => true)).completion
        latestId = newer.id
        return { option: options.find((option) => option.includes("F001"))!, key: "i" }
      },
    })
    await new ReviewCommands(f.api, f.runner, () => defaults).run("last", f.ctx)
    expect(latestId).not.toBe(older.id)
    expect((await f.store.last(older.repoKey))?.id).toBe(latestId)
    expect((await f.store.load(older.repoKey, older.id))?.findings[0]?.ignored).toBe(true)
  })
  test("session identity is captured before asynchronous report loading", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
    f.request.settings = { ...f.request.settings, verify: false }
    await (await f.runner.start(f.request, async () => true)).completion
    const load = f.store.last.bind(f.store)
    f.store.last = async (key) => {
      const report = await load(key)
      f.switch()
      return report
    }
    const command = new ReviewCommands(f.api, f.runner, () => defaults)
    await command.run("fix F001", f.ctx)
    expect(f.counters().mainSends).toBe(0)
    expect(f.outputs.join(" ")).toContain("changed")
  })
  test("busy, wrong repo and switched during confirmation never send", async () => {
    for (const cause of ["busy", "wrong-repo", "switch"]) {
      const f = await fixture([done({ findings: [candidate], limitations: [] }), empty()])
      f.request.settings = { ...f.request.settings, verify: false }
      await (await f.runner.start(f.request, async () => true)).completion
      const command = new ReviewCommands(f.api, f.runner, () => defaults)
      Object.assign(f.ctx.ui, {
        confirm: async () => {
          if (cause === "busy") f.busy()
          else if (cause === "switch") f.switch()
          else {
            const other = path.join(f.repo, "..", "other-repository")
            await mkdir(path.join(other, ".git"), { recursive: true })
            Object.assign(f.ctx, { cwd: other })
          }
          return true
        },
      })
      await command.run("fix F001", f.ctx)
      expect(f.counters().mainSends).toBe(0)
      expect(f.outputs.join(" ")).toContain(
        cause === "busy" ? "busy" : cause === "switch" ? "changed" : "Wrong repository",
      )
    }
  })
  test("packaging public-only imports, version/index, templates and usage-only skill", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.version).toBe("0.2.0")
    expect(manifest.amira.engines.amira).toBe("^0.1.56")
    const index = JSON.parse(await readFile(new URL("../../../index.json", import.meta.url), "utf8"))
    expect(index.extensions.find((entry: { name: string }) => entry.name === "review").version).toBe("0.1.1")
    const skill = await readFile(new URL("../skills/code-review/SKILL.md", import.meta.url), "utf8")
    expect(skill).toContain("documentation only")
    expect(hash(skill)).toHaveLength(64)
    const names = new Bun.Glob("*.ts")
    for await (const name of names.scan(
      new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    )) {
      const text = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8")
      expect(text).not.toMatch(/from ["']@amira\/(?!api["'])/)
      expect(text).not.toContain("api.runCommand(")
    }
    expect(repoKey("C:\\Repo")).toBe(repoKey("c:/repo"))
  })
  test("registrations coexist with share and live reviews drain on unload, origin end and root switch", async () => {
    for (const cause of ["unload", "end", "switch"]) {
      const f = await fixture(undefined, { held: true })
      const commands: string[] = ["review"]
      const handlers = new Map<string, (event: unknown) => void>()
      let run!: (input: string, ctx: CommandContext) => void | Promise<void>
      let unload!: () => void
      let exit!: () => Promise<void>
      let status!: () => string | undefined
      const api = {
        ...f.api,
        settings: { declare: () => ({ get: () => defaults }) },
        registerCommand: (command: { name: string; run: typeof run }) => {
          commands.push(command.name)
          run = command.run
        },
        registerView: () => {},
        registerStatusItem: (item: { text: typeof status }) => {
          status = item.text
        },
        on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
        onUnload: (fn: () => void) => {
          unload = fn
        },
        onExit: (fn: () => Promise<void>) => {
          exit = fn
        },
      } as unknown as ExtensionAPI
      await extension(api)
      expect(commands).toEqual(["review", "code-review"])
      await run("worktree --yes", f.ctx)
      expect(status()).toContain("reviewing")
      handlers.get("session.end")!({ sessionId: "unrelated-child" })
      handlers.get("session.start")!({ sessionId: "child", parentSessionId: "main" })
      expect(status()).toContain("reviewing")
      if (cause === "unload") unload()
      else if (cause === "end") handlers.get("session.end")!({ sessionId: "main" })
      else handlers.get("session.start")!({ sessionId: "replacement-main" })
      await exit()
      expect(status()).toBeUndefined()
      expect((await f.store.last(repoKey(f.repo)))?.state).toBe("cancelled")
      expect(f.counters().released).toBe(1)
      expect(f.counters().ownerSends).toBe(0)
    }
  })
})

describe("deep owner-bound workflow reviews", () => {
  test("parallel launch has original owner/cwd, strict tools, redacted prompts, merged dedup and one verifier", async () => {
    const review = done({ findings: [candidate], limitations: [] })
    const f = await fixture(
      [
        review,
        review,
        review,
        done({
          assessments: [{ id: "F001", assessment: "supported", rationale: "Static evidence agrees." }],
          limitations: [],
        }),
      ],
      { held: true },
    )
    const fake = fakeWorkflow({ maxConcurrent: 2 })
    f.api.useService = (() => fake.runner) as ExtensionAPI["useService"]
    await writeFile(
      path.join(f.repo, "file.ts"),
      "export const answer = 2 // token ghp_abcdefghijklmnopqrstuvwxyz1234567890\n",
    )
    let bytes = 0
    const { completion } = await f.runner.start(
      { ...f.request, scope: { ...f.request.scope, deep: true } },
      async (_bundle, _guidance, _signal, exposure) => {
        bytes = exposure.promptBytes
        return true
      },
    )
    await fake.started
    expect(f.spawns).toHaveLength(3) // All launches precede any held result.
    const start = fake.starts[0]!
    expect(start.request.cwd).toBe(f.request.cwd)
    expect(start.request.startedBy.sessionId).toBe("main")
    expect(start.owner.sessionId).toBe("owner")
    expect(start.owner.signal.aborted).toBe(false)
    expect(start.request.script).toContain("parallel(")
    expect(f.runner.snapshot()!.phase).toBe("reviewing")
    expect(Object.keys(f.runner.snapshot()!.children)).toHaveLength(3)
    for (const spawn of f.spawns) {
      expect(spawn.cwd).toBe(f.request.cwd)
      expect(spawn.context).toBe("fresh")
      expect(spawn.tools).toEqual([])
      expect(spawn.writeRoots).toEqual([])
      expect(spawn.callableTools).toEqual(["review_read", "review_search", "return_result"])
      expect(spawn.extraTools!.map((tool) => tool.name)).toEqual(["review_read", "review_search"])
      expect(spawn.prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890")
    }
    expect(bytes).toBe(
      f.spawns.reduce((sum, child) => sum + Buffer.byteLength((child.systemPrompt ?? "") + child.prompt), 0),
    )
    expect(f.specs[1]).toMatchObject({
      maxAgents: 3,
      maxConcurrent: 2,
      budget: { tokens: 120000, costUsd: 2 },
    })
    f.release()
    const report = await completion
    expect(report.state).toBe("completed")
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]!.sources).toEqual([
      "change group 1",
      "correctness/security",
      "contracts/tests/standards",
    ])
    expect(report.findings[0]!.assessment).toBe("supported")
    expect(f.spawns).toHaveLength(4)
    expect(f.specs[2]).toMatchObject({
      maxAgents: 1,
      maxConcurrent: 1,
      budget: { tokens: 119990, costUsd: 2 },
    })
    expect(await f.store.last(report.repoKey)).toMatchObject({ scope: { deep: true }, state: "completed" })
    expect(f.counters().ownerSends).toBe(0)
  })
  test("stop reaches original workflow runner, drains owner, and retains validated partial findings", async () => {
    const f = await fixture([done({ findings: [candidate], limitations: [] }), empty(), empty()], {
      held: true,
    })
    const fake = fakeWorkflow()
    f.api.useService = (() => fake.runner) as ExtensionAPI["useService"]
    const { completion } = await f.runner.start(
      { ...f.request, scope: { ...f.request.scope, deep: true } },
      async () => true,
    )
    await fake.started
    f.runner.stop()
    const report = await completion
    expect(report.state).toBe("cancelled")
    expect(report.findings).toHaveLength(1)
    expect(fake.stops()).toBeGreaterThan(0)
    expect(fake.starts[0]!.owner.signal.aborted).toBe(true)
    expect(f.counters().released).toBe(1)
    expect(f.runner.snapshot()).toBeUndefined()
  })
  test("disabled provider during a run stops its original handle without normal fallback", async () => {
    const f = await fixture([], { held: true })
    const fake = fakeWorkflow()
    f.api.useService = (() => fake.runner) as ExtensionAPI["useService"]
    const { completion } = await f.runner.start(
      { ...f.request, scope: { ...f.request.scope, deep: true } },
      async () => true,
    )
    await fake.started
    fake.disable()
    const report = await completion
    expect(report.state).not.toBe("completed")
    expect(report.limitations.join("\n")).toContain("extensions.workflow.enabled: never")
    expect(fake.stops()).toBeGreaterThan(0)
    expect(f.spawns).toHaveLength(3)
  })
  test("availability is checked again at launch after exposure approval", async () => {
    const f = await fixture()
    const fake = fakeWorkflow()
    f.api.useService = (() => fake.runner) as ExtensionAPI["useService"]
    const { completion } = await f.runner.start(
      { ...f.request, scope: { ...f.request.scope, deep: true } },
      async () => {
        fake.disable()
        return true
      },
    )
    const report = await completion
    expect(report.state).toBe("failed")
    expect(fake.starts).toHaveLength(0)
    expect(f.spawns).toHaveLength(0)
  })
  test("unavailable mode offers an explicit normal review; Escape and print are inert", async () => {
    const f = await fixture()
    const commands = new ReviewCommands(f.api, f.runner, () => defaults)
    let choices = 0
    f.ctx.ui.choose = async () => {
      choices++
      return undefined
    }
    await commands.run("worktree --deep --yes", f.ctx)
    expect(choices).toBe(1)
    expect(f.spawns).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
    expect(f.outputs.join("\n")).toContain("normal review without --deep")
    await commands.run("worktree --deep --yes", { ...f.ctx, frontend: "print" })
    expect(choices).toBe(1)
    expect(f.spawns).toHaveLength(0)
    f.ctx.ui.choose = async () => ({ option: "Review normally" })
    await commands.run("worktree --deep --yes", f.ctx)
    await f.runner.settled()
    expect(f.spawns).toHaveLength(2)
  })
  test("Escape on deep scope picker and PR input starts nothing", async () => {
    const f = await fixture()
    const commands = new ReviewCommands(f.api, f.runner, () => defaults)
    await commands.run("--deep", f.ctx)
    f.ctx.ui.choose = async () => ({ option: "GitHub PR" })
    f.ctx.ui.input = async () => undefined
    await commands.run("--deep", f.ctx)
    f.ctx.ui.input = async () => "123 --yes"
    await commands.run("--deep", f.ctx)
    expect(f.outputs.join("\n")).toContain("canonical")
    expect(f.calls).toHaveLength(0)
    expect(f.spawns).toHaveLength(0)
  })
})
