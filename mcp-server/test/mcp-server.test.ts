import { expect, test } from "bun:test"
import path from "node:path"
import type { PackageCommandContext, RunCommandOptions, RunCommandResult } from "@amira/api"
import command from "../src/command.ts"

const WORK = path.resolve("/work")
const events = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n")

/** Feeds `requests` to `amira mcp serve` and returns the parsed responses plus the child commands. */
async function session(requests: object[], output: string, argv = ["serve", "-m", "x/y"], exitCode = 0) {
  const runs: { argv: string[]; options: RunCommandOptions }[] = []
  let out = ""
  const ctx: PackageCommandContext = {
    apiVersion: "0.1.0",
    argv,
    cwd: "/work",
    home: "/home",
    amiraArgv: ["amira"],
    runCommand: async (a, options): Promise<RunCommandResult> => {
      runs.push({ argv: a, options })
      return { output, exitCode, signalCode: null, timedOut: false, aborted: false, settled: true, contained: true }
    },
    stdin: new Response(requests.map((r) => `${JSON.stringify(r)}\n`).join("")).body!,
    stdout: (s) => {
      out += s
    },
    stderr: () => {},
  }
  const code = await command(ctx)
  const responses = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  return { code, responses, runs }
}

test("initialize, list and call amira_run", async () => {
  const output = events(
    { type: "session.start", data: { resume: ["amira", "--resume", "s_abc"] } },
    { type: "tool.execute.start", data: { name: "read" } },
    { type: "message.end", data: { message: { content: [{ type: "text", text: "All done." }] } } },
    { type: "turn.end", data: { reason: "done", steps: 2 } },
  )
  const { code, responses, runs } = await session(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "amira_run", arguments: { prompt: "fix it" } } },
      { jsonrpc: "2.0", id: 4, method: "nope" },
    ],
    output,
  )
  expect(code).toBe(0)
  const byId = Object.fromEntries(responses.map((r) => [r.id, r]))
  expect(byId[1].result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "amira" } })
  expect(byId[2].result.tools.map((t: { name: string }) => t.name)).toEqual(["amira_run"])
  expect(byId[3].result).toEqual({
    content: [{ type: "text", text: "All done.\n\n[amira session s_abc]" }],
    structuredContent: { reply: "All done.", sessionId: "s_abc", reason: "done", toolCalls: 1 },
    isError: false,
  })
  expect(byId[4].error.code).toBe(-32601)
  expect(runs[0]!.argv).toEqual(["amira", "-p", "--json", "-C", WORK, "-m", "x/y", "--", "fix it"])
})

test("a sessionId resumes that session; a failed turn is an error result", async () => {
  const output = events({ type: "turn.end", data: { reason: "error", error: "rate limited", steps: 1 } })
  const { responses, runs } = await session(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "amira_run", arguments: { prompt: "more", sessionId: "s_abc", model: "a/b" } },
      },
    ],
    output,
  )
  expect(runs[0]!.argv).toEqual(["amira", "-p", "--json", "-C", WORK, "-m", "a/b", "--resume", "s_abc", "--", "more"])
  expect(responses[0].result.isError).toBe(true)
  expect(responses[0].result.content[0].text).toContain("rate limited")
})

test("a failure before any event reports Amira's stderr message", async () => {
  const { responses, runs } = await session(
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "amira_run", arguments: { prompt: "p" } } }],
    "amira: no API key for provider x\n\nRun amira --help for usage.\n",
    ["serve", "-m", "x/y"],
    2,
  )
  expect(runs[0]!.options.stdoutOnly).toBeUndefined()
  expect(responses[0].result.isError).toBe(true)
  expect(responses[0].result.content[0].text).toBe(
    "Amira failed (exit 2): amira: no API key for provider x\nRun amira --help for usage.",
  )
})

test("a relative cwd is resolved once, against the default", async () => {
  const { runs } = await session(
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "amira_run", arguments: { prompt: "p", cwd: "sub" } } }],
    "",
  )
  const sub = path.join(WORK, "sub")
  expect(runs[0]!.options.cwd).toBe(sub)
  expect(runs[0]!.argv.slice(3, 5)).toEqual(["-C", sub])
})

test("bad arguments and unknown subcommands", async () => {
  const bad = await session(
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "amira_run", arguments: { prompt: " " } } }],
    "",
  )
  expect(bad.responses[0].result.isError).toBe(true)
  expect(bad.runs).toEqual([])
  expect((await session([], "", ["frobnicate"])).code).toBe(2)
})
