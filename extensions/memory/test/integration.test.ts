import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { offlineDemo } from "../scripts/offline.ts"

const core = process.env.AMIRA_TEST_CORE ?? "D:/dev/Amira"

test.skipIf(!existsSync(path.join(core, "packages", "cli", "src", "main.ts")))(
  "linked real Amira: approval-gated save, next-turn index and all RPC commands using an offline model",
  async () => {
    const result = await offlineDemo(core)
    expect(result.approved).toBe(true) // This is deliberately not a default-autonomy claim.
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
