import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext, ToolDefinition, ToolResult } from "@amira/api"
import type { Bundle } from "../src/collect.ts"

const roots: string[] = []
export function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), "amira-review-unit-"))
  roots.push(root)
  return root
}
export function cleanup(): void {
  for (const root of roots.splice(0).reverse()) rmSync(root, { force: true, recursive: true })
}
export function file(root: string, name: string, text: string | Uint8Array = "one\ntwo\nthree\n"): void {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  writeFileSync(path.join(root, name), text)
}
export function bundle(root: string, inventory = ["src/file.ts"]): Bundle {
  return {
    root,
    repoKey: "test-repository",
    head: "a".repeat(40),
    base: "b".repeat(40),
    scope: { kind: "worktree", paths: [], includeUntracked: false },
    inventory,
    changes: [
      {
        path: "src/file.ts",
        oldPath: "src/file.ts",
        status: "M",
        untracked: false,
        metadataOnly: false,
        patch:
          "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,3 @@\n one\n-old\n+two\n three\n",
        hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }],
      },
    ],
    excluded: [],
    untracked: [],
    patch: "",
    fingerprint: "fixture-fingerprint",
    added: 1,
    removed: 1,
  }
}
export async function call(
  tool: ToolDefinition,
  params: unknown,
  signal = new AbortController().signal,
): Promise<ToolResult> {
  const ctx: ToolContext = { cwd: "/not-used", signal, toolCallId: "fixture", update: () => {} }
  return tool.execute(params, ctx)
}
export function text(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}
