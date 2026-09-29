import { expect, test } from "bun:test"
import path from "node:path"
import type { RunCommandOptions } from "@amira/api"
import {
  capOutput,
  cleanOutput,
  decisionOf,
  editedFile,
  fileMatches,
  type Hook,
  type HookRun,
  loadHooks,
  parseHooks,
  runHook,
  shellLaunch,
  toolMatches,
  trust,
  trustState,
  untrust,
} from "../src/index.ts"
import { callMatches } from "../src/match.ts"
import { tempDir, writeJson } from "./helpers.ts"

const parse = (section: Record<string, unknown>) => {
  const problems: string[] = []
  const hooks = parseHooks(section, {
    file: "f.json",
    origin: "user",
    cwd: "/p",
    defaultTimeoutMs: 1000,
    problems,
  })
  return { hooks, problems }
}

test("tools match by name or glob", () => {
  expect(toolMatches(["bash", "powershell"], "bash")).toBe(true)
  expect(toolMatches(["bash"], "bash_output")).toBe(false)
  expect(toolMatches(["*"], "anything")).toBe(true)
  expect(toolMatches(["mcp_*"], "mcp_github_create")).toBe(true)
})

test("file globs: no slash matches the name anywhere, with a slash the path in the project", () => {
  const p = path.resolve("/proj")
  const f = (rel: string) => path.join(p, rel)
  expect(fileMatches([], f("a/b.ts"), p)).toBe(true)
  expect(fileMatches(["*.ts"], f("deep/dir/b.ts"), p)).toBe(true)
  expect(fileMatches(["*.{ts,tsx}"], f("c.tsx"), p)).toBe(true)
  expect(fileMatches(["*.ts"], f("b.md"), p)).toBe(false)
  expect(fileMatches(["src/**/*.ts"], f("src/x/y.ts"), p)).toBe(true)
  expect(fileMatches(["src/**/*.ts"], f("test/y.ts"), p)).toBe(false)
  expect(fileMatches(["./src/*.ts"], f("src/y.ts"), p)).toBe(true)
  // Outside the project, a path glob sees the absolute path.
  expect(fileMatches(["**/other/*.ts"], path.resolve("/elsewhere/other/z.ts"), p)).toBe(true)
})

test("before-tool matching: every argument pattern must match; objects are matched as JSON", () => {
  const { hooks } = parse({
    beforeTool: [
      { tools: ["bash"], match: { command: "rm -rf|git push" }, action: "block" },
      { tools: ["write"], match: { path: "\\.env$", content: "SECRET" }, action: "ask" },
      { match: { "*": "prod" }, ignoreCase: true, action: "ask" },
    ],
  })
  const [shell, env, any] = hooks as [Hook, Hook, Hook]
  expect(callMatches(shell, "bash", { command: "cd x && rm -rf /" })).toBe(true)
  expect(callMatches(shell, "bash", { command: "ls" })).toBe(false)
  expect(callMatches(shell, "powershell", { command: "rm -rf /" })).toBe(false)
  expect(callMatches(env, "write", { path: "a/.env", content: "SECRET=1" })).toBe(true)
  expect(callMatches(env, "write", { path: "a/.env", content: "x" })).toBe(false)
  expect(callMatches(env, "write", { path: "a/.env" })).toBe(false)
  expect(callMatches(any, "deploy", { target: { env: "PROD" } })).toBe(true)
})

test("the edited file: absolute path from the details, else the path argument", () => {
  const p = path.resolve("/proj")
  expect(editedFile({ path: "a.ts" }, { path: path.resolve("/wt/a.ts") }, p)).toBe(path.resolve("/wt/a.ts"))
  expect(editedFile({ path: "a.ts" }, undefined, p)).toBe(path.join(p, "a.ts"))
  expect(editedFile({ file_path: "b.ts" }, {}, p)).toBe(path.join(p, "b.ts"))
  expect(editedFile({}, {}, p)).toBeUndefined()
})

test("parsing: defaults, names from commands, disabled entries, timeouts capped", () => {
  const { hooks, problems } = parse({
    afterEdit: [
      { command: "npx prettier --write $AMIRA_FILE" },
      { command: "bun run lint", disabled: true },
      { command: "/usr/bin/ruff format", timeoutMs: 99 * 60 * 60_000 },
    ],
    beforeTool: [{ action: "block" }],
    afterTurn: [{ command: "bun test", on: ["done", "error"] }],
    sessionStart: [{ command: "git fetch", reasons: ["startup", "resume"] }],
    sessionEnd: [{ command: "echo", cwd: "sub" }],
  })
  expect(problems).toEqual([])
  expect(hooks.map((h) => `${h.event}:${h.name}`)).toEqual([
    "sessionStart:git",
    "beforeTool:block",
    "afterEdit:prettier",
    "afterEdit:ruff",
    "afterTurn:bun test",
    "sessionEnd:echo",
  ])
  const prettier = hooks.find((h) => h.name === "prettier")!
  expect(prettier).toMatchObject({
    tools: ["edit", "write"],
    files: [],
    feedback: "onError",
    timeoutMs: 1000,
  })
  expect(hooks.find((h) => h.name === "ruff")!.timeoutMs).toBe(30 * 60_000)
  expect(hooks.find((h) => h.event === "beforeTool")!.tools).toEqual(["*"])
  expect(hooks.find((h) => h.event === "sessionEnd")!.cwd).toBe(path.resolve("/p", "sub"))
})

test("parsing: problems name the file, the entry and what is wrong", () => {
  const { hooks, problems } = parse({
    afterEdit: [{ command: "x", feedback: "sometimes" }, { command: "" }, "echo"],
    beforeTool: [{ action: "block", command: "x" }, { action: "deny" }],
    afterTurn: [{ command: "x", on: ["finished"] }],
    sessionEnd: [{ command: "x", env: { A: 1 } }],
    befroeTool: [],
  })
  expect(hooks).toEqual([])
  expect(problems).toEqual([
    'f.json: unknown hooks key "befroeTool" (ignored)',
    'f.json: beforeTool[0]: use either "action" or "command", not both',
    'f.json: beforeTool[1]: "action" must be "block" or "ask"',
    'f.json: afterEdit[0]: "feedback" must be "onError", "always" or "never"',
    'f.json: afterEdit[1]: "command" must be a command line',
    "f.json: afterEdit[2]: must be an object",
    'f.json: afterTurn[0]: "on" must list "done", "error" or "aborted"',
    'f.json: sessionEnd[0]: "env.A" must be text',
  ])
})

test("loading: user hooks first, options only from the user, a fingerprint of the project's hooks", () => {
  const home = tempDir("home")
  const cwd = tempDir("proj")
  writeJson(path.join(home, "settings.json"), {
    model: "x/y",
    extensions: { hooks: { showSuccess: false, afterTurn: [{ command: "user" }] } },
  })
  writeJson(path.join(cwd, ".amira", "hooks.json"), { afterTurn: [{ command: "project" }] })
  const a = loadHooks(cwd, home)
  expect(a.hooks.map((h) => `${h.origin}:${h.command}`)).toEqual(["user:user", "project:project"])
  expect(a.options.showSuccess).toBe(false)
  expect(a.projectHash).toMatch(/^[0-9a-f]{32}$/)
  // Formatting does not change the fingerprint; the hooks do.
  writeJson(
    path.join(cwd, ".amira", "hooks.json"),
    JSON.parse(JSON.stringify({ afterTurn: [{ command: "project" }] })),
  )
  expect(loadHooks(cwd, home).projectHash).toBe(a.projectHash!)
  writeJson(path.join(cwd, ".amira", "hooks.json"), { afterTurn: [{ command: "project2" }] })
  expect(loadHooks(cwd, home).projectHash).not.toBe(a.projectHash!)
  // Without project hooks there is nothing to trust.
  expect(loadHooks(tempDir("empty"), home).projectHash).toBeUndefined()
})

test("loading: unreadable JSON is a problem, not a crash", () => {
  const home = tempDir("home")
  const cwd = tempDir("proj")
  const r = loadHooks(cwd, home, (file) => {
    if (file.endsWith("hooks.json")) return "{ nope"
    throw Object.assign(new Error("missing"), { code: "ENOENT" })
  })
  expect(r.hooks).toEqual([])
  expect(r.problems[0]).toContain("invalid JSON")
})

test("trust: remembered per project and fingerprint, listed parents count, untrust forgets", () => {
  const home = tempDir("home")
  const cwd = tempDir("proj")
  expect(trustState(home, cwd, "h1", [])).toBe("unknown")
  trust(home, cwd, "h1")
  expect(trustState(home, cwd, "h1", [])).toBe("trusted")
  expect(trustState(home, cwd, "h2", [])).toBe("changed")
  expect(trustState(home, path.join(cwd, "sub"), "h1", [])).toBe("unknown")
  expect(trustState(home, path.join(cwd, "sub"), "h9", [cwd])).toBe("trusted")
  expect(untrust(home, cwd)).toBe(true)
  expect(untrust(home, cwd)).toBe(false)
  expect(trustState(home, cwd, "h1", [])).toBe("unknown")
})

test("output: escapes and progress redraws are removed; long output keeps its start and end", () => {
  expect(cleanOutput("\x1b[31mred\x1b[0m\r\n10%\r50%\r100%\n\x1b]8;;http://x\x07link\x1b]8;;\x07\n\n")).toBe(
    "red\n100%\nlink",
  )
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
  const { text, cut } = capOutput(long, 200)
  expect(text.startsWith("line 0\n")).toBe(true)
  expect(text.endsWith("line 199")).toBe(true)
  expect(cut).toBeGreaterThan(1000)
  expect(text).toContain(`… ${cut} characters cut …`)
  expect(text.length).toBeLessThan(260)
  expect(capOutput("short", 200)).toEqual({ text: "short", cut: 0 })
})

const fakeRun = (r: Partial<HookRun>): HookRun =>
  ({ ok: false, exitCode: 0, timedOut: false, aborted: false, output: "", cut: 0, ...r }) as HookRun

test("before-tool commands decide by exit code 2 or JSON; failures allow", () => {
  expect(decisionOf(fakeRun({ exitCode: 2, output: "nope" }))).toEqual({ decision: "block", reason: "nope" })
  expect(decisionOf(fakeRun({ exitCode: 2 }))).toEqual({ decision: "block" })
  expect(decisionOf(fakeRun({ exitCode: 2, timedOut: true }))).toEqual({ decision: "allow" })
  expect(decisionOf(fakeRun({ exitCode: 1, output: '{"decision":"block"}' }))).toEqual({ decision: "allow" })
  expect(decisionOf(fakeRun({ ok: true, output: 'checking\n{"decision":"ask","reason":"sure?"}' }))).toEqual({
    decision: "ask",
    reason: "sure?",
  })
  expect(decisionOf(fakeRun({ ok: true, output: '{"decision":"approve"}' }))).toEqual({ decision: "allow" })
  expect(decisionOf(fakeRun({ ok: true, output: "{not json" }))).toEqual({ decision: "allow" })
})

test("shells: Git Bash on Windows from git on PATH, PowerShell without it, bash elsewhere", () => {
  const files = new Set(["C:\\Git\\usr\\bin\\bash.exe"])
  const win = {
    platform: "win32" as const,
    env: { Path: "C:\\x" },
    exists: (p: string) => files.has(p),
    which: (n: string) =>
      n === "git"
        ? "C:\\Git\\cmd\\git.exe"
        : n === "pwsh"
          ? null
          : n === "powershell"
            ? "C:\\ps\\powershell.exe"
            : null,
  }
  const bash = shellLaunch("bash", "echo hi", win)
  expect(bash.argv).toEqual(["C:\\Git\\usr\\bin\\bash.exe", "-c", "echo hi"])
  expect(bash.env.Path?.startsWith("C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;")).toBe(true)
  expect(bash.env.MSYSTEM).toBe("MINGW64")
  // WSL's bash is never used.
  const wsl = shellLaunch("bash", "echo hi", {
    ...win,
    which: (n: string) => (n === "git" ? null : n === "powershell" ? "C:\\ps\\powershell.exe" : null),
    exists: (p: string) => p.includes("System32"),
  })
  expect(wsl.label).toBe("powershell (Git Bash not found)")
  const ps = shellLaunch("powershell", "Write-Output 'a \"b\"'", win)
  expect(ps.argv.slice(0, -1)).toEqual([
    "C:\\ps\\powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ])
  expect(Buffer.from(ps.argv.at(-1)!, "base64").toString("utf16le")).toBe("Write-Output 'a \"b\"'")
  const posix = shellLaunch("bash", "ls", {
    platform: "linux",
    exists: (p) => p === "/bin/bash",
    which: () => null,
  })
  expect(posix.argv).toEqual(["/bin/bash", "-c", "ls"])
})

test("runHook: env, stdin JSON, cwd and timeout reach runCommand; failures to start are runs too", async () => {
  const seen: { argv: string[]; opts: RunCommandOptions }[] = []
  const { hooks } = parse({
    afterTurn: [{ name: "t", command: "bun test", timeoutMs: 1234, env: { X: "1" } }],
  })
  const hook = hooks[0]!
  const r = await runHook(hook, {
    runCommand: async (argv, opts) => {
      seen.push({ argv, opts })
      return {
        output: "\x1b[32m3 pass\x1b[0m\n",
        exitCode: 0,
        signalCode: null,
        timedOut: false,
        aborted: false,
        settled: true,
        contained: true,
      }
    },
    projectDir: "/p",
    vars: { AMIRA_TURN_END: "done" },
    input: { turn: { reason: "done" } },
    signal: new AbortController().signal,
    maxOutputChars: 100,
    id: 1,
    baseEnv: { HOME: "/h" },
    shell: { platform: "linux", exists: (p) => p === "/bin/bash", which: () => null },
  })
  expect(r).toMatchObject({ ok: true, exitCode: 0, output: "3 pass" })
  expect(seen[0]!.argv).toEqual(["/bin/bash", "-c", "bun test"])
  expect(seen[0]!.opts).toMatchObject({ cwd: "/p", timeoutMs: 1234 })
  expect(seen[0]!.opts.env).toMatchObject({
    HOME: "/h",
    X: "1",
    AMIRA_EVENT: "afterTurn",
    AMIRA_HOOK: "t",
    AMIRA_TURN_END: "done",
  })
  expect(JSON.parse(seen[0]!.opts.stdin!)).toEqual({
    event: "afterTurn",
    hook: "t",
    projectDir: "/p",
    turn: { reason: "done" },
  })
  const failed = await runHook(hook, {
    runCommand: async () => {
      throw new Error("spawn failed")
    },
    projectDir: "/p",
    vars: {},
    input: {},
    signal: new AbortController().signal,
    maxOutputChars: 100,
    id: 2,
  })
  expect(failed).toMatchObject({ ok: false, error: "spawn failed" })
})
