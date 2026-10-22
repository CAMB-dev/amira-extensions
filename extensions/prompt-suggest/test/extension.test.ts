import { expect, test } from "bun:test"
import type { CompleteResult, ContextPreview, Message } from "@amira/api"
import { INSTRUCTION, userMessage } from "../src/prediction.ts"
import { deferred, fixture, flush, reply } from "./fixture.ts"

test("a normal main-session turn acquires synchronously and shows through the slot", async () => {
  const f = fixture()
  f.end()
  expect(f.acquire).toHaveBeenCalledTimes(1)
  expect(f.preview).toHaveBeenCalledTimes(1)
  await flush()
  expect(f.complete).toHaveBeenCalledTimes(1)
  expect(f.complete.mock.calls[0]![0]).toMatchObject({
    label: "prompt-suggest",
    maxTokens: 80,
    signal: f.leases[0]!.slot.signal,
  })
  expect(f.shown).toBe("run the tests")
  expect(f.leases[0]!.set).toHaveBeenCalledWith("run the tests")
  // A live suggestion retains its slot; releasing it would remove the ghost text.
  expect(f.leases[0]!.release).not.toHaveBeenCalled()
  f.edit()
  expect(f.shown).toBeUndefined()
  expect(f.leases[0]!.release).toHaveBeenCalledTimes(1)
})

test("does not predict on turn start, model output or a child turn end", async () => {
  const f = fixture()
  f.start()
  f.emit("message.end", { message: reply("done").message })
  f.emit("turn.end", { reason: "done", steps: 1 }, { sessionId: "child", parentSessionId: "main" })
  f.emit("turn.end", { reason: "done", steps: 1 }, { parentSessionId: "parent" })
  await flush()
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.complete).not.toHaveBeenCalled()
})

for (const reason of ["error", "aborted"] as const) {
  test(`skips ${reason} turns (including interrupts and budget/spend stops)`, async () => {
    const f = fixture()
    f.end(reason)
    await flush()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.complete).not.toHaveBeenCalled()
  })
}

test("a turn carrying an error is not treated as a normal success", async () => {
  const f = fixture()
  f.emit("turn.end", { reason: "done", steps: 1, error: "stopped" })
  await flush()
  expect(f.acquire).not.toHaveBeenCalled()
})

for (const condition of [
  "non-empty input",
  "busy input",
  "queued message",
  "approval",
  "dialog",
  "form",
  "completion popup",
  "pending paste",
  "print",
  "headless",
  "RPC",
  "remote",
  "subagent",
]) {
  test(`no slot (${condition}) means no preview or model request`, async () => {
    // These states are deliberately opaque to extensions: the host gates them all with no slot.
    const f = fixture({ available: false })
    f.end()
    await flush()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.preview).not.toHaveBeenCalled()
    expect(f.complete).not.toHaveBeenCalled()
  })
}

test("disabled means no acquisition or model call", async () => {
  const f = fixture({ settings: { enabled: false } })
  f.end()
  await flush()
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.complete).not.toHaveBeenCalled()
})

test("one request per turn, including after completion and a failed acquisition", async () => {
  const f = fixture()
  f.end()
  f.end()
  await flush()
  f.end()
  await flush()
  expect(f.complete).toHaveBeenCalledTimes(1)
  f.setAvailable(false)
  f.end("done", "turn-2")
  f.setAvailable(true)
  f.end("done", "turn-2")
  expect(f.acquire).toHaveBeenCalledTimes(2)
  expect(f.complete).toHaveBeenCalledTimes(1)
  f.start("turn-3")
  f.end("done", "turn-3")
  await flush()
  expect(f.complete).toHaveBeenCalledTimes(2)
})

for (const action of ["typing", "new turn", "session switch", "unload", "disable", "model change"] as const) {
  test(`cancels in-flight work on ${action} and discards an abort-ignoring result`, async () => {
    const f = fixture()
    const pending = deferred<CompleteResult>()
    f.complete.mockImplementationOnce(() => pending.promise)
    f.end()
    await flush()
    const slot = f.leases[0]!
    expect(f.complete.mock.calls[0]![0].signal).toBe(slot.controller.signal)
    if (action === "typing") f.edit()
    else if (action === "new turn") f.start()
    else if (action === "session switch") f.switchSession("other")
    else if (action === "unload") f.unload()
    else if (action === "disable") f.changeSettings({ enabled: false })
    else
      f.emit("model.changed", {
        from: { provider: "session", model: "current" },
        to: { provider: "session", model: "other" },
      })
    expect(slot.controller.signal.aborted).toBe(true)
    pending.resolve(reply("stale suggestion"))
    await flush()
    expect(slot.set).not.toHaveBeenCalled()
    expect(slot.release).toHaveBeenCalledTimes(1)
    expect(f.shown).toBeUndefined()
  })
}

test("type-then-delete cannot revive a request, even if the prompt is empty again", async () => {
  const f = fixture()
  const pending = deferred<CompleteResult>()
  f.complete.mockImplementationOnce(() => pending.promise)
  f.end()
  await flush()
  f.edit()
  f.setAvailable(true)
  pending.resolve(reply("run the tests"))
  await flush()
  f.end()
  expect(f.shown).toBeUndefined()
  expect(f.complete).toHaveBeenCalledTimes(1)
})

test("editing during context preview prevents even starting the model request", async () => {
  const f = fixture()
  const pending = deferred<ContextPreview>()
  f.preview.mockImplementationOnce(() => pending.promise)
  f.end()
  f.edit()
  pending.resolve(f.context)
  await flush()
  expect(f.complete).not.toHaveBeenCalled()
  expect(f.shown).toBeUndefined()
})

test("a late prior-turn result cannot replace or release the current suggestion", async () => {
  const f = fixture()
  const first = deferred<CompleteResult>()
  f.complete.mockImplementationOnce(() => first.promise)
  f.end()
  await flush()
  f.start()
  f.end("done", "turn-2")
  await flush()
  expect(f.shown).toBe("run the tests")
  first.resolve(reply("old message"))
  await flush()
  expect(f.shown).toBe("run the tests")
  expect(f.leases[0]!.set).not.toHaveBeenCalled()
  expect(f.leases[1]!.release).not.toHaveBeenCalled()
})

test("session switches reset per-turn deduplication", async () => {
  const f = fixture()
  f.end()
  await flush()
  f.switchSession("other")
  f.end()
  await flush()
  expect(f.complete).toHaveBeenCalledTimes(2)
})

test("unload clears displayed text and prevents any further requests", async () => {
  const f = fixture()
  f.end()
  await flush()
  f.unload()
  expect(f.shown).toBeUndefined()
  f.end("done", "turn-2")
  await flush()
  expect(f.complete).toHaveBeenCalledTimes(1)
})

test("a rejected model call releases the slot and is not retried", async () => {
  const f = fixture()
  f.complete.mockRejectedValueOnce(new Error("provider unavailable"))
  f.end()
  await flush()
  f.end()
  expect(f.leases[0]!.release).toHaveBeenCalledTimes(1)
  expect(f.shown).toBeUndefined()
  expect(f.complete).toHaveBeenCalledTimes(1)
})

for (const text of ["", "  \n ", "Fixed the bug.", "You are a coding assistant."]) {
  test(`an unusable prediction releases the slot: ${JSON.stringify(text)}`, async () => {
    const f = fixture()
    f.complete.mockResolvedValueOnce(reply(text))
    f.end()
    await flush()
    expect(f.shown).toBeUndefined()
    expect(f.leases[0]!.set).not.toHaveBeenCalled()
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1)
  })
}

test("a refused slot.set result releases the lease", async () => {
  const f = fixture()
  const pending = deferred<CompleteResult>()
  f.complete.mockImplementationOnce(() => pending.promise)
  f.end()
  await flush()
  f.leases[0]!.set.mockReturnValueOnce(false)
  pending.resolve(reply("run the tests"))
  await flush()
  expect(f.leases[0]!.release).toHaveBeenCalledTimes(1)
})

test("budget and spend stops prevent prediction even if a done event follows", async () => {
  for (const limit of [{ tokens: 10 }, { costUsd: 0.1 }]) {
    const f = fixture()
    f.emit("budget.exceeded", { tokens: 11, costUsd: 0.2, limit })
    f.end()
    await flush()
    expect(f.acquire).not.toHaveBeenCalled()
    f.emit("budget.update", { tokens: 11, costUsd: 0.2, limit: {} })
    f.end("done", "turn-2")
    await flush()
    expect(f.complete).toHaveBeenCalledTimes(1)
  }
})

test("replayed exhausted budget updates suppress requests", async () => {
  for (const limit of [{ tokens: 10 }, { costUsd: 0.1 }]) {
    const f = fixture()
    f.emit("budget.update", { tokens: 11, costUsd: 0.2, limit })
    f.end()
    await flush()
    expect(f.complete).not.toHaveBeenCalled()
  }
})

test("unset model preserves the preview's system and entire message prefix without mutation", async () => {
  const history: Message[] = [
    userMessage("修复这个错误"),
    {
      ...reply("正在检查").message,
      content: [
        { type: "thinking", text: "reasoning", signature: { dialect: "test", value: "opaque" } },
        { type: "toolCall", id: "call", name: "read", args: { path: "test.ts" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
    },
    reply("已修复。").message,
  ]
  const before = structuredClone(history)
  const f = fixture({ history })
  f.end()
  await flush()
  const request = f.complete.mock.calls[0]![0]
  expect(request.model).toBeUndefined() // api.complete selects the current session model.
  expect(request.system).toBe(f.context.systemPrompt)
  expect(request.keepSessionTools).toBe(true)
  expect(request.messages.slice(0, -1)).toEqual(before)
  for (let i = 0; i < history.length; i++) expect(request.messages[i]).toBe(history[i]!)
  expect(request.messages.at(-1)).toEqual(userMessage(INSTRUCTION))
  expect(history).toEqual(before)
})

test("configured model gets bounded recent text, not the session system, tools or full history", async () => {
  const history: Message[] = [userMessage("OLD SECRET")]
  for (let i = 0; i < 20; i++) {
    history.push(userMessage(`question ${i} ${"q".repeat(2000)}`))
    history.push({
      ...reply(`answer ${i} ${"a".repeat(2000)}`).message,
      content: [
        { type: "text", text: `answer ${i} ${"a".repeat(2000)}` },
        { type: "thinking", text: "PRIVATE REASONING" },
        { type: "toolCall", id: "call", name: "SECRET TOOL", args: {} },
      ],
    })
  }
  history.push({
    role: "toolResult",
    toolCallId: "call",
    toolName: "SECRET TOOL",
    isError: false,
    content: [{ type: "text", text: "SECRET TOOL OUTPUT" }],
  })
  history.push({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "SECRET IMAGE" }] })
  history.push(userMessage("recent question"), reply("recent answer").message)
  const f = fixture({ settings: { model: "cheap/small/model" }, history })
  f.end()
  await flush()
  const request = f.complete.mock.calls[0]![0]
  expect(request.model).toBe("cheap/small/model")
  expect(request.keepSessionTools).toBeUndefined()
  expect(request.system).toBeUndefined()
  expect(f.preview).not.toHaveBeenCalled()
  expect(request.messages).toHaveLength(2)
  const context = request.messages[0]!.content[0]!
  expect(context.type).toBe("text")
  if (context.type !== "text") throw new Error("Expected text context")
  expect(context.text.length).toBeLessThanOrEqual(6060)
  expect(context.text).toContain("recent question")
  expect(context.text).toContain("recent answer")
  for (const secret of ["OLD SECRET", "PRIVATE REASONING", "SECRET TOOL", "SECRET IMAGE"])
    expect(context.text).not.toContain(secret)
  expect(request.messages[1]).toEqual(userMessage(INSTRUCTION))
})

test("unsupported tool retention still yields a single suggestion, without a second request", async () => {
  const f = fixture()
  f.complete.mockResolvedValueOnce({ ...reply("continue"), toolsKept: false })
  f.end()
  await flush()
  expect(f.shown).toBe("continue")
  expect(f.complete).toHaveBeenCalledTimes(1)
})

test("works with the individual-event API fallback", async () => {
  const f = fixture({ ordered: false })
  f.end()
  await flush()
  expect(f.shown).toBe("run the tests")
})
