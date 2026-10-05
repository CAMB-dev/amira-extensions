import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { offlineDemo } from "../scripts/offline.ts"

const core = process.env.AMIRA_TEST_CORE ?? "D:/dev/Amira"

test.skipIf(!existsSync(path.join(core, "packages", "cli", "src", "main.ts")))(
  "linked real Amira: default-mode save without approvals, next-turn index and RPC commands",
  async () => {
    const result = await offlineDemo(core)
    expect(result.approvals).toEqual([])
    expect(result.commands.some((command) => command.name === "memory")).toBe(true)
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]!.data?.result?.isError).not.toBe(true)
    expect(result.writes[0]!.data?.rejected).toBeUndefined()
    expect(result.writes[0]!.data?.approval).toBeUndefined()
    expect(result.storage.find((store) => store.scope === "project")!.entries).toContain("writing-style.md")
    expect(result.storage.find((store) => store.scope === "project")!.entries).toContain("MEMORY.md")
    expect(result.captures.length).toBeGreaterThanOrEqual(3)
    expect(result.captures[0]!.memory).not.toContain("writing-style.md")
    const latest = result.captures.at(-1)!
    expect(latest.memory).toContain("[writing-style](writing-style.md) — Preferred writing style")
    expect(latest.systemPrompt).toContain(latest.memory.trim())
    expect(latest.memory).toBe(result.captures.at(-2)!.memory)
    expect(result.steps[0]!.output).toContain("writing-style.md")
    expect(result.outputs["/memory show writing-style"]).toContain("The user prefers brief explanations")
    expect(result.outputs["/memory edit writing-style"]).toContain("writing-style.md")
    expect(result.outputs["/memory path"]).toContain("Global:")
    expect(result.outputs["/memory path"]).toContain("Project:")
    expect(result.outputs["/memory rm writing-style"]).toContain("Use --yes")
    expect(result.outputs["/memory rm writing-style --yes"]).toContain("Forgot: writing-style (project)")
    expect(result.outputs["/memory list"]).not.toContain("writing-style.md")
    expect(JSON.stringify(result.notices)).toContain("Remembered: writing-style (project)")
  },
  120_000,
)

test.skipIf(!existsSync(path.join(core, "packages", "cli", "src", "main.ts")))(
  "linked real Amira: plan mode denies global/project writes without approvals or memory files/index",
  async () => {
    const result = await offlineDemo(core, () => {}, "plan")
    expect(result.approvals).toEqual([])
    expect(result.commands.some((command) => command.name === "memory")).toBe(true)
    expect(result.writes).toHaveLength(2)
    for (const write of result.writes) {
      expect(write.data?.rejected).toBe("blocked")
      expect(write.data?.result?.isError).toBe(true)
      expect(write.data?.approval).toBeUndefined()
      expect(write.data?.waitedMs).toBeUndefined()
      const text = write
        .data!.result!.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
      expect(text).toContain('mode "plan" is read-only: files are not changed')
    }
    expect(result.storage).toHaveLength(2)
    for (const store of result.storage) {
      expect(store.entries).toEqual([])
    }
    expect(result.captures.length).toBeGreaterThanOrEqual(3)
    for (const capture of result.captures) {
      expect(capture.memory).not.toContain("writing-style.md")
      expect(capture.systemPrompt).toContain(capture.memory.trim())
    }
    expect(result.outputs["/memory list"]).toContain("No memories saved.")
    expect(result.outputs["/memory list"]).not.toContain("writing-style.md")
    expect(JSON.stringify(result.notices)).not.toContain("Remembered:")
  },
  120_000,
)
