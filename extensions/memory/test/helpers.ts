import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI, ToolContext } from "@amira/api"
import type { MemoryInput } from "../src/format.ts"

export function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "amira-memory-"))
  const home = path.join(root, "home")
  const cwd = path.join(root, "work")
  mkdirSync(home)
  mkdirSync(cwd)
  return { root, home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export const signal = () => new AbortController().signal

export const fact = (name = "writing-style"): MemoryInput => ({
  name,
  type: "user",
  description: "Preferred writing style",
  body: "The user prefers brief explanations with concrete examples.",
})

export function gitResult(output = "", exitCode = 1): ExtensionAPI["runCommand"] {
  return async () => ({
    output,
    exitCode,
    signalCode: null,
    truncated: false,
    timedOut: false,
    aborted: false,
    settled: true,
    contained: true,
  })
}

export function toolContext(cwd: string, depth: number | undefined = 0): ToolContext {
  return {
    cwd,
    toolCallId: "test-call",
    signal: signal(),
    update() {},
    session:
      depth === undefined
        ? undefined
        : {
            sessionId: "test-main",
            depth,
            maxDepth: 3,
            model: { provider: "mock", model: "m" },
            deferredTools: () => [],
            loadTools: () => [],
          },
  }
}
