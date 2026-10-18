import { expect, test } from "bun:test"
import {
  type AiOptions,
  type AssistantMessage,
  type ModelRequest,
  resolveModelInfo,
  type StreamEvent,
  type ToolCallBlock,
  type Usage,
} from "@amira/ai"
import type { ToolResult } from "@amira/api"
import type { EvalOutcome, EvalRequest, EvalTool } from "../scripts/eval-desktop.ts"
import { createRunner } from "../scripts/eval-runner.ts"

// All AI streams and tool calls are fake. No harness runtime, network, or desktop imports.
const env = {
  AMIRA_UIA_EVAL_MODEL: "organization/vision-model",
  AMIRA_UIA_EVAL_BASE_URL: "https://example.invalid/v1",
  AMIRA_UIA_EVAL_API_KEY: "test-only-key",
}
const usage: Usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7 }
const call = (name = "ui_tree", id = "call-1"): ToolCallBlock => ({
  type: "toolCall",
  id,
  name,
  args: { window: "owned-fixture" },
})
function reply(
  content: AssistantMessage["content"] = [],
  measured: Usage | undefined = usage,
): AssistantMessage {
  return {
    role: "assistant",
    model: { provider: "uia-eval", model: env.AMIRA_UIA_EVAL_MODEL },
    content,
    usage: measured,
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "end",
  }
}
const done = (message = reply()): StreamEvent[] => [{ type: "done", message }]

function fake(
  responses: StreamEvent[][],
  overrides: Record<string, string | undefined> = {},
  onStream?: (request: ModelRequest, signal: AbortSignal | undefined) => AsyncIterable<StreamEvent>,
) {
  const requests: ModelRequest[] = []
  let config: AiOptions | undefined
  let resolved = 0
  const runner = createRunner({
    env: { ...env, ...overrides },
    createAi(options) {
      config = options
      return {
        model(ref) {
          resolved++
          expect(ref).toBe(`uia-eval/${env.AMIRA_UIA_EVAL_MODEL}`)
          return resolveModelInfo(options.providers![0]!, env.AMIRA_UIA_EVAL_MODEL)
        },
        async *stream(request, signal) {
          requests.push(request)
          if (onStream) yield* onStream(request, signal)
          else yield* responses[requests.length - 1] ?? []
        },
      }
    },
  })
  return { runner, requests, config: () => config!, resolved: () => resolved }
}
function request(tools: EvalTool[] = [], signal = new AbortController().signal): EvalRequest {
  return {
    task: {
      id: "profile",
      prompt: 'Set Name to "Ada Lovelace" and Project to "Orion", then save the profile.',
    },
    mode: "tree-only",
    window: "owned-fixture",
    tools,
    signal,
  }
}
function tool(name: string, execute: EvalTool["execute"]): EvalTool {
  return {
    name,
    description: `Fake ${name}`,
    parameters: { type: "object", properties: { window: { type: "string" } }, required: ["window"] },
    execute,
  }
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => String(error),
  )
}

async function failed(promise: Promise<EvalOutcome>): Promise<string> {
  return String((await promise).error)
}

test("default runner requires explicit env, never ambient auth, and rejects invalid config before AI creation", () => {
  const cases: [Record<string, string | undefined>, string][] = [
    [{ AMIRA_UIA_EVAL_MODEL: undefined }, "AMIRA_UIA_EVAL_MODEL"],
    [{ AMIRA_UIA_EVAL_MODEL: " " }, "AMIRA_UIA_EVAL_MODEL"],
    [{ AMIRA_UIA_EVAL_BASE_URL: undefined }, "AMIRA_UIA_EVAL_BASE_URL"],
    [{ AMIRA_UIA_EVAL_BASE_URL: "not a URL" }, "AMIRA_UIA_EVAL_BASE_URL"],
    [{ AMIRA_UIA_EVAL_BASE_URL: "file:///private" }, "HTTP(S)"],
    [{ AMIRA_UIA_EVAL_BASE_URL: "https://user:password@example.invalid" }, "without credentials"],
    [{ AMIRA_UIA_EVAL_BASE_URL: "https://example.invalid?api_key=secret" }, "without credentials"],
    [
      { AMIRA_UIA_EVAL_API_KEY: undefined, OPENAI_API_KEY: "ambient-must-not-work" },
      "AMIRA_UIA_EVAL_API_KEY",
    ],
    [{ AMIRA_UIA_EVAL_API_KEY: " " }, "AMIRA_UIA_EVAL_API_KEY"],
    [{ AMIRA_UIA_EVAL_KEYLESS: "true" }, "KEYLESS must be 0 or 1"],
    [{ AMIRA_UIA_EVAL_KEYLESS: "1" }, "not both"],
    [{ AMIRA_UIA_EVAL_DIALECT: "made-up" }, "Unsupported"],
    [{ AMIRA_UIA_EVAL_MAX_TURNS: "0" }, "positive integer"],
    [{ AMIRA_UIA_EVAL_MAX_TURNS: "1.5" }, "positive integer"],
    [{ AMIRA_UIA_EVAL_MAX_TURNS: "1e2" }, "positive integer"],
    [{ AMIRA_UIA_EVAL_MAX_TURNS: "9007199254740992" }, "positive integer"],
  ]
  for (const [overrides, message] of cases) {
    let created = false
    expect(() =>
      createRunner({
        env: { ...env, ...overrides },
        createAi() {
          created = true
          throw new Error("AI must not be created")
        },
      }),
    ).toThrow(message)
    expect(created).toBe(false)
  }
})

test("explicit provider config disables ambient credentials, extra tools, retries and compaction", () => {
  const f = fake([])
  expect(f.config()).toMatchObject({
    env: {},
    apiKeys: {},
    retry: { retries: 0 },
    webSearch: false,
    providers: [
      {
        id: "uia-eval",
        dialect: "openai-chat",
        baseUrl: env.AMIRA_UIA_EVAL_BASE_URL,
        apiKey: env.AMIRA_UIA_EVAL_API_KEY,
        catalogId: false,
        compat: { webSearch: false, compaction: "off" },
        defaultModel: { caps: { tools: "native", images: true, parallelToolCalls: false, webSearch: false } },
      },
    ],
  })
  expect(f.runner.model).toBe(`uia-eval/${env.AMIRA_UIA_EVAL_MODEL}`)
  expect(f.runner.name).toBe("amira-ai-env")
  const keyless = fake([], {
    AMIRA_UIA_EVAL_API_KEY: undefined,
    AMIRA_UIA_EVAL_KEYLESS: "1",
    AMIRA_UIA_EVAL_DIALECT: "openai-responses",
  })
  expect(keyless.config().providers![0]).toMatchObject({ keySource: "none", dialect: "openai-responses" })
  expect(keyless.config().providers![0]!.apiKey).toBeUndefined()
})

test("both modes share model/config/prompt but get fresh history on every trial", async () => {
  const f = fake([done(), done()])
  const first = request()
  expect(await f.runner.run(first)).toEqual({
    usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
  })
  await f.runner.run({ ...first, mode: "screenshot+tree" })
  expect(f.resolved()).toBe(1)
  expect(f.requests[0]!.model).toBe(f.requests[1]!.model)
  expect(f.requests[0]!.systemPrompt).toBe(f.requests[1]!.systemPrompt)
  expect(f.requests[0]!.systemPrompt).toContain("untrusted")
  expect(f.requests[0]!.messages).not.toBe(f.requests[1]!.messages)
  expect(f.requests.map((entry) => entry.messages.length)).toEqual([1, 1])
  expect(f.requests[0]!.messages[0]).toEqual(f.requests[1]!.messages[0])
  expect(JSON.stringify(f.requests[0]!.messages)).toContain("owned-fixture")
  expect(f.requests.every((entry) => entry.tools.length === 0)).toBe(true)
  await f.runner.close?.()
})

test("only passed schemas are offered, tools run serially, and all text/images/error results are forwarded intact", async () => {
  const events: string[] = []
  const content: ToolResult["content"] = [
    { type: "text", text: "untrusted tree" },
    { type: "image", mimeType: "image/png", data: "fake-base64-not-a-capture" },
    { type: "text", text: "trailing diagnostics" },
  ]
  const tools = [
    tool("ui_tree", async (args) => {
      expect(args).toEqual({ window: "owned-fixture" })
      events.push("tree-start")
      await Promise.resolve()
      events.push("tree-end")
      return { content }
    }),
    tool("ui_click", async () => {
      events.push("click")
      return { content: [{ type: "text", text: "blocked fake click" }], isError: true }
    }),
  ]
  const f = fake([
    [
      { type: "toolCall.delta", id: "partial", name: "must-not-execute", argsDelta: "{" },
      ...done(reply([call(), call("ui_click", "call-2")])),
    ],
    done(),
  ])
  expect(await f.runner.run(request(tools))).toEqual({
    usage: { input: 200, output: 40, cacheRead: 60, cacheWrite: 10 },
  })
  expect(events).toEqual(["tree-start", "tree-end", "click"])
  expect(f.requests[0]!.tools).toEqual(
    tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  )
  expect(f.requests[0]!.messages).toHaveLength(1)
  const messages = f.requests[1]!.messages
  expect(messages).toHaveLength(4)
  const result = messages[2]!
  expect(result).toMatchObject({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "ui_tree",
    isError: false,
  })
  expect(result.content).toBe(content)
  expect(result.content[1]).toBe(content[1])
  expect(messages[3]).toMatchObject({
    role: "toolResult",
    toolCallId: "call-2",
    toolName: "ui_click",
    isError: true,
  })
})

test("usage includes streamed attempt usage exactly once without adding reasoning/cache twice", async () => {
  const f = fake([
    [
      { type: "request.end", message: reply([], { input: 2, output: 1, cacheRead: 3, cacheWrite: 4 }) },
      ...done(),
    ],
  ])
  expect(await f.runner.run(request())).toEqual({
    usage: { input: 102, output: 21, cacheRead: 33, cacheWrite: 9 },
  })
})

test("missing or metadata-only usage anywhere remains unknown instead of estimated zero", async () => {
  for (const measured of [undefined, { ...usage, outputReported: false }]) {
    const message = reply([call()])
    message.usage = measured
    const f = fake([done(message), done()])
    const tools = [tool("ui_tree", async () => ({ content: [{ type: "text", text: "large tree" }] }))]
    expect(await f.runner.run(request(tools))).toEqual({ usage: null })
  }
  const retry = reply()
  delete retry.usage
  const f = fake([[{ type: "request.end", message: retry }, ...done()]])
  expect(await f.runner.run(request())).toEqual({ usage: null })
  const zero = fake([done(reply([], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))])
  expect(await zero.runner.run(request())).toEqual({
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
})

test("unknown tools deny the whole batch, including prototype names; duplicate tools are rejected", async () => {
  let calls = 0
  const allowed = tool("ui_tree", async () => {
    calls++
    return { content: [] }
  })
  for (const unknown of ["shell", "constructor", "toString"]) {
    const f = fake([done(reply([call(), call(unknown, "unknown")]))])
    expect(await f.runner.run(request([allowed]))).toEqual({
      error: `Unknown evaluation tool: ${unknown}`,
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
    })
    expect(f.requests).toHaveLength(1)
  }
  expect(calls).toBe(0)
  const duplicate = fake([])
  expect(await failed(duplicate.runner.run(request([allowed, allowed])))).toContain("unique names")
  expect(duplicate.requests).toHaveLength(0)
})

test("budget exhaustion returns structured failure with all measured usage", async () => {
  let calls = 0
  const tools = [
    tool("ui_tree", async () => {
      calls++
      return { content: [] }
    }),
  ]
  const f = fake([done(reply([call()]))], { AMIRA_UIA_EVAL_MAX_TURNS: "1" })
  expect(await f.runner.run(request(tools))).toEqual({
    error: "Evaluation model turn budget exceeded (1)",
    usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
  })
  expect(calls).toBe(1)
  expect(f.requests).toHaveLength(1)
})

test("turn cap bounds looping tools and invalid replies fail closed", async () => {
  const tools = [tool("ui_tree", async () => ({ content: [] }))]
  const capped = fake([done(reply([call()])), done(reply([call()]))], { AMIRA_UIA_EVAL_MAX_TURNS: "2" })
  expect(await failed(capped.runner.run(request(tools)))).toContain("turn budget exceeded (2)")
  expect(capped.requests).toHaveLength(2)
  const cases: [StreamEvent[], string][] = [
    [[], "without a reply"],
    [[...done(), ...done()], "multiple terminal"],
    [done({ ...reply(), stopReason: "maxTokens" }), "maxTokens"],
    [done({ ...reply(), stopReason: "aborted" }), "aborted"],
    [done({ ...reply(), stopReason: "toolUse" }), "without a tool call"],
    [done(reply([], { ...usage, input: -1 })), "invalid token usage"],
    [
      [{ type: "error", error: { message: "fake provider error" }, retryable: false, message: reply() }],
      "fake provider error",
    ],
    [
      [
        {
          type: "serverTool",
          block: { type: "serverTool", id: "search", name: "web_search", input: {}, status: "running" },
        },
      ],
      "forbids server-hosted",
    ],
  ]
  for (const [response, message] of cases) {
    const f = fake([response])
    expect(await failed(f.runner.run(request(tools)))).toContain(message)
  }
})

test("tool exceptions retain fully reported consumption without another model request", async () => {
  const f = fake([done(reply([call()]))])
  const tools = [
    tool("ui_tree", async () => {
      throw new Error("fake tool failure after model usage")
    }),
  ]
  expect(await f.runner.run(request(tools))).toEqual({
    error: "fake tool failure after model usage",
    usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
  })
  expect(f.requests).toHaveLength(1)
})

test("failed provider requests retain complete error-event usage but never invent unreported counters", async () => {
  for (const measured of [usage, undefined, { ...usage, outputReported: false }]) {
    const message = reply()
    message.usage = measured
    const f = fake([
      done(reply([call()])),
      [{ type: "error", error: { message: "fake second request failure" }, retryable: false, message }],
    ])
    expect(await f.runner.run(request([tool("ui_tree", async () => ({ content: [] }))]))).toEqual({
      error: "Evaluation model failed: fake second request failure",
      usage: measured === usage ? { input: 200, output: 40, cacheRead: 60, cacheWrite: 10 } : null,
    })
    expect(f.requests).toHaveLength(2)
  }
})

test("unreported stream errors after measured turns or attempts leave total usage unknown", async () => {
  for (const attempt of [false, true]) {
    let streams = 0
    const f = fake([], {}, async function* () {
      if (++streams === 1 && !attempt) {
        yield* done(reply([call()]))
        return
      }
      if (attempt) yield { type: "request.end", message: reply() }
      throw new Error("unreported in-flight request failure")
    })
    expect(await f.runner.run(request([tool("ui_tree", async () => ({ content: [] }))]))).toEqual({
      error: "unreported in-flight request failure",
      usage: null,
    })
    expect(f.requests).toHaveLength(attempt ? 1 : 2)
  }
})

test("interruption of an unreported in-flight request never reuses earlier measured counts", async () => {
  const started = Promise.withResolvers<void>()
  let streams = 0
  const f = fake([], {}, async function* (_request, signal) {
    if (++streams === 1) {
      yield* done(reply([call()]))
      return
    }
    started.resolve()
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
    signal!.throwIfAborted()
  })
  const controller = new AbortController()
  const running = f.runner.run(request([tool("ui_tree", async () => ({ content: [] }))], controller.signal))
  await started.promise
  controller.abort(new Error("interrupted second request"))
  expect(await running).toEqual({ error: "interrupted second request", usage: null })
  expect(f.requests).toHaveLength(2)
})

test("pre-aborted trials never stream; abort during a tool prevents later tools and model turns", async () => {
  const before = new AbortController()
  before.abort(new Error("already aborted"))
  const f = fake([done()])
  expect(await failed(f.runner.run(request([], before.signal)))).toContain("already aborted")
  expect(f.requests).toHaveLength(0)
  const during = new AbortController()
  let second = false
  const tools = [
    tool("ui_tree", async () => {
      during.abort(new Error("stop during tool"))
      return { content: [] }
    }),
    tool("ui_click", async () => {
      second = true
      return { content: [] }
    }),
  ]
  const g = fake([done(reply([call(), call("ui_click", "second")]))])
  expect(await failed(g.runner.run(request(tools, during.signal)))).toContain("stop during tool")
  expect(second).toBe(false)
  expect(g.requests).toHaveLength(1)
})

test("external abort propagates to AI and close cancels/drains active streams, refusing reuse or overlap", async () => {
  for (const close of [false, true]) {
    const started = Promise.withResolvers<void>()
    let drained = false
    let streamSignal: AbortSignal | undefined
    const f = fake([], {}, async function* (_request, signal) {
      streamSignal = signal
      try {
        started.resolve()
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        )
        yield* done()
      } finally {
        drained = true
      }
    })
    const controller = new AbortController()
    const running = failed(f.runner.run(request([], controller.signal)))
    await started.promise
    expect(await rejected(f.runner.run(request()))).toContain("must be serial")
    if (close) await f.runner.close?.()
    else controller.abort(new Error("external stop"))
    expect(await running).toContain(close ? "runner closed" : "external stop")
    expect(streamSignal!.aborted).toBe(true)
    expect(drained).toBe(true)
    await f.runner.close?.()
    expect(await rejected(f.runner.run(request()))).toContain("runner is closed")
  }
})
