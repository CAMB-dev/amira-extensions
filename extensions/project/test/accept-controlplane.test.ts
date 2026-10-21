import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI, InterceptContext, OwnedConversation } from "@amira/api"
import { Acceptances } from "../src/accept.ts"
import { acceptanceCodeHash } from "../src/accept-integrity.ts"
import { initialIteration } from "../src/stage.ts"
import { createProject, IterationStore } from "../src/store.ts"
import { fixture, git, localShell } from "./implement-fixture.ts"
import { ownedFixture } from "./owned-fixture.ts"

setDefaultTimeout(120_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

test("acceptance's real interceptor allows a slow current-state validation but still blocks obsolete or aborted tools", async () => {
  const { InterceptorRegistry } = await import("@amira/core")
  const registry = new InterceptorRegistry()
  const intercept: ExtensionAPI["intercept"] = (point, handler, options) =>
    registry.add(point, handler, options, "slow-acceptance")
  const acceptance = new Acceptances({ intercept } as unknown as ExtensionAPI)
  const root = await mkdtemp(path.join(tmpdir(), "slow-acceptance-"))
  homes.push(root)
  const project = await createProject(root, "Slow validation")
  const state = initialIteration(project.marker.id, 1)
  Object.assign(state, { stage: "accept", phase: "running", status: "working", activeAttemptId: "review" })
  const binding = {
    handle: ownedFixture({ key: "slow-review", cwd: process.cwd() }),
    paused: false,
    controller: new AbortController(),
    started: true,
    project,
  }
  const running = Reflect.get(acceptance, "running") as Map<string, typeof binding>
  running.set("review", binding)
  let delay = 5_500
  const read = spyOn(IterationStore.prototype, "read").mockImplementation(async () => {
    await Bun.sleep(delay)
    return state
  })
  const context = { sessionId: binding.handle.id, signal: new AbortController().signal } as InterceptContext
  const call = { toolCallId: "record", name: "project_record_acceptance", args: {} }
  try {
    expect(await registry.run("tool.call.before", call, context)).toMatchObject({ blocked: false })
    delay = 0
    state.phase = "complete"
    expect(await registry.run("tool.call.before", call, context)).toMatchObject({ blocked: true })
    const controller = new AbortController()
    controller.abort()
    expect(
      await registry.run("tool.call.before", call, { ...context, signal: controller.signal }),
    ).toMatchObject({ blocked: true })
  } finally {
    // A timed-out handler is still a read in flight, not permission to overlap a new test.
    await Bun.sleep(600)
    read.mockRestore()
  }
}, 20_000)

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
