import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext, ConversationSpec, ExtensionAPI } from "@amira/api"
import { disposeAccounting } from "../src/accounting.ts"
import { DesignSessions } from "../src/design.ts"
import { createProject } from "../src/store.ts"
import { ownedFixture } from "./owned-fixture.ts"

setDefaultTimeout(60_000)

for (const action of ["abort", "switch main"] as const) {
  test(`a delayed design open cannot steal focus after ${action}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-focus-race-"))
    let api: ExtensionAPI | undefined
    try {
      const project = await createProject(root, "Delayed")
      const gate = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const abort = new AbortController()
      let mainId = "main-A"
      let focused = 0
      const control = { info: () => ({ id: mainId }) }
      api = {
        dataDir: path.join(root, "data"),
        session: () => control,
        conversations: {
          openOrCreate: async (spec: ConversationSpec) => {
            started.resolve()
            await gate.promise
            return ownedFixture(spec, "owned")
          },
        },
      } as unknown as ExtensionAPI
      const ctx = {
        session: control,
        signal: abort.signal,
        focusConversation: () => {
          focused++
          return true
        },
        unfocusConversation: () => true,
        print() {},
      } as unknown as CommandContext
      const opening = new DesignSessions(api).open(project, ctx, "en")
      await started.promise
      if (action === "abort") abort.abort()
      else mainId = "main-B"
      gate.resolve()
      await expect(opening).rejects.toThrow(/cancelled|session changed/i)
      expect(focused).toBe(0)
    } finally {
      if (api) await disposeAccounting(api)
      await rm(root, { recursive: true, force: true })
    }
  })
}
