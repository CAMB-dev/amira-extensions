import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext } from "@amira/api"
import { acceptancePanelText, acceptanceView } from "../src/accept-view.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { consume, startReview, summarize, trial } from "./batch-test-helper.ts"
import { bindingFixture, human } from "./iteration-binding-helper.ts"

setDefaultTimeout(120_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function passed(ui = false) {
  const f = await bindingFixture(roots, true, ui)
  const review = await startReview(f.store, f.state, f.verdict)
  let state = await consume(f.store, review.state, review.verdict, ui)
  if (ui) state = await trial(f.store, state, review.verdict, "pending")
  state = await summarize(f.store, state)
  return { ...f, state, verdict: review.verdict }
}

for (const fresh of [true, false]) {
  test(`acceptance consumption rechecks freshness after confirmation: ${fresh}`, async () => {
    const f = await passed()
    let probes = 0
    const ctx = {
      signal: new AbortController().signal,
      session: { info: () => ({ id: "main" }) },
      ui: { select: async (_title: string, choices: string[]) => choices[0], confirm: async () => true },
      print: () => {},
    } as unknown as CommandContext
    const state = await runStageCommand(
      "next",
      [],
      f.project,
      ctx,
      "en",
      () => {},
      async () => {},
      () => {},
      undefined,
      undefined,
      async () => {
        probes++
        return { stale: !fresh, reason: fresh ? null : "Code changed since review" }
      },
    )
    expect(probes).toBe(1)
    if (fresh) {
      expect(state.stage).toBe("implement")
      expect(state.batchResolutions).toMatchObject([{ batchId: "B1", status: "accepted" }])
    } else {
      expect(state.status).toBe("interrupted")
      expect(state.batchResolutions).toEqual([])
      expect(state.attempts.at(-1)).toMatchObject({
        staleReason: "Code changed since review",
        acceptance: { verdict: "pass" },
      })
      const ref = state.artifacts.find((entry) => entry.id === state.attempts.at(-1)!.acceptance!.artifactId)!
      expect(await f.store.readArtifact(ref)).toEqual(f.verdict)
      const resumed = await f.store.dispatch(state.revision, {
        type: "confirm-continuation",
        expectedRevision: state.revision,
        receipt: human(state, state.activeAttemptId!, "resume"),
      })
      expect(resumed.phase).toBe("confirmed")
      expect(resumed.attempts.at(-1)?.staleReason).toBe("Code changed since review")
    }
  })
}

test("manual trial confirmation cancellation leaves artifacts, receipts and state untouched", async () => {
  const f = await passed(true)
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main" }) },
    print: () => {},
    ui: { select: async (_title: string, choices: string[]) => choices[0], confirm: async () => false },
  } as unknown as CommandContext
  const result = await runStageCommand(
    "next",
    [],
    f.project,
    ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(result).toEqual(f.state)
  expect(await f.store.read()).toEqual(f.state)
})

test("panel distinguishes item counts, pending trial, deferred and stale without executing tools", async () => {
  const f = await passed(true)
  const view = await acceptanceView(f.store, f.state)
  expect(view).toMatchObject({
    total: 1,
    outcome: "pass",
    counts: { pass: 1, fail: 0, blocked: 0 },
    manualTrial: "pending",
    verified: false,
  })
  expect(acceptancePanelText(view!, "en")).toContain("manual trial: pending")
  expect(acceptancePanelText({ ...view!, manualTrial: "deferred" }, "en")).toContain("deferred (not tried)")
  expect(acceptancePanelText({ ...view!, stale: true }, "en")).toContain("STALE")
})
