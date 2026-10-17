import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import { acceptanceCodeHash } from "../src/accept-integrity.ts"
import { fixture, git, localShell } from "./implement-fixture.ts"

setDefaultTimeout(120_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

test("canonical acceptance fingerprint excludes its own committed-document outputs, but still binds code", async () => {
  const f = await fixture()
  homes.push(f.home)
  await f.approve()
  await git(f.root, "add -f .amira/project")
  await git(f.root, 'commit -m "Fixture committed documents"')
  const handle = {
    runTool: (_name: string, args: Record<string, unknown>) => localShell(String(args.command), f.root),
  } as unknown as OwnedConversation
  const checkout = { root: f.root, cwd: f.root }
  const before = await acceptanceCodeHash(f.project, await f.store.read(), handle, "bash", checkout)
  let state = await f.store.read()
  state = (
    await f.store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage: "implement",
      language: "en",
      summary: "New control-plane evidence",
      outputs: [],
      suggestion: "No code changed",
    })
  ).state
  const afterEvidence = await acceptanceCodeHash(f.project, state, handle, "bash", checkout)
  expect(afterEvidence).toBe(before)
  await writeFile(path.join(f.root, "real-code.txt"), "changed\n")
  expect(await acceptanceCodeHash(f.project, state, handle, "bash", checkout)).not.toBe(before)
})
