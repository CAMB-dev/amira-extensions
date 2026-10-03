import { expect, test } from "bun:test"
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@amira/api"
import { buildContext } from "../src/context.ts"

function user(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content, model: { provider: "test", model: "main" } }
}

function result(text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
  }
}

test("context keeps user and assistant labels and chronological order", () => {
  const messages = [
    user("First question"),
    assistant([{ type: "text", text: "First answer" }]),
    user("Latest question"),
  ]
  expect(buildContext(messages)).toBe(
    "user:\nFirst question\n\nassistant:\nFirst answer\n\nuser:\nLatest question",
  )
})

test("trimming keeps the newest suffix, including a partial oldest message and separators", () => {
  const messages = [user("older context"), assistant([{ type: "text", text: "newest answer" }])]
  const whole = "user:\nolder context\n\nassistant:\nnewest answer"
  for (const budget of [1, 8, 25, 26, 27, whole.length - 1, whole.length, whole.length + 1]) {
    expect(buildContext(messages, budget)).toBe(whole.slice(-budget))
    expect(buildContext(messages, budget).length).toBeLessThanOrEqual(budget)
  }
  expect(buildContext(messages, "assistant:\nnewest answer".length)).toBe("assistant:\nnewest answer")
  expect(buildContext(messages, whole.length)).toBe(whole)
  expect(buildContext(messages, 8.9)).toBe(whole.slice(-8))
})

test("empty or nonpositive budgets yield no context and the default budget is 60,000 characters", () => {
  expect(buildContext([])).toBe("")
  expect(buildContext([user("not included")], 0)).toBe("")
  expect(buildContext([user("not included")], -1)).toBe("")
  const text = `${"old".repeat(30_000)}newest`
  expect(buildContext([user(text)])).toBe(text.slice(-60_000))
  expect(buildContext([user(text)]).length).toBe(60_000)
})

test("tool calls and results become short plain-text summaries", () => {
  const messages = [
    assistant([
      { type: "text", text: "Checking the file" },
      { type: "toolCall", id: "call-1", name: "read", args: { path: "src/main.ts" } },
    ]),
    result("  first line\n\n second\tline  "),
    result("  file\n missing  ", true),
  ]
  const expected = [
    'assistant:\nChecking the file\n[Tool call: read {"path":"src/main.ts"}]',
    "[Tool result: read: first line second line]",
    "[Tool result: read (error): file missing]",
  ].join("\n\n")
  expect(buildContext(messages)).toBe(expected)
})

test("tool summaries cap payloads at 240 characters, adding an ellipsis only when necessary", () => {
  const args = { query: "x".repeat(300) }
  const messages = [
    assistant([{ type: "toolCall", id: "call-1", name: "search", args }]),
    result("r".repeat(240)),
    result("s".repeat(241)),
  ]
  const expected = [
    `assistant:\n[Tool call: search ${JSON.stringify(args).slice(0, 239)}…]`,
    `[Tool result: read: ${"r".repeat(240)}]`,
    `[Tool result: read: ${"s".repeat(239)}…]`,
  ].join("\n\n")
  expect(buildContext(messages)).toBe(expected)
})

test("images, thinking and signatures never enter context or consume its budget", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "private-image-bytes" }
  const signature = { dialect: "test", value: "private-replay-signature" }
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Visible question", signature }, image] },
    assistant([
      { type: "thinking", text: "private reasoning", signature },
      { type: "text", text: "Visible answer", signature },
      { type: "thinking", text: "", redacted: true, signature },
    ]),
    { ...result("Visible result"), content: [{ type: "text", text: "Visible result", signature }, image] },
    { role: "user", content: [image] },
    assistant([{ type: "thinking", text: "private trailing reasoning", signature }]),
    { ...result(""), content: [image] },
    user(""),
  ]
  const expected =
    "user:\nVisible question\n\nassistant:\nVisible answer\n\n[Tool result: read: Visible result]"
  const before = structuredClone(messages)
  expect(buildContext(messages)).toBe(expected)
  expect(buildContext(messages, expected.length)).toBe(expected)
  expect(buildContext(messages, 12)).toBe(expected.slice(-12))
  expect(messages).toEqual(before)
})
