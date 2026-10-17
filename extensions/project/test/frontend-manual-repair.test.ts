import { expect, setDefaultTimeout, test } from "bun:test"
import type { AcceptanceArtifact } from "../src/artifacts.ts"
import { consume, implement, startReview, summarize, trial } from "./batch-test-helper.ts"
import { frontendFingerprint } from "./frontend-fingerprint.ts"
import { ESC, frontend, frontendSuite } from "./frontend-harness.ts"
import { proposeUiReview } from "./manual-repair-helper.ts"

setDefaultTimeout(600_000)

async function approveNext(f: Awaited<ReturnType<typeof frontend>>, stage: string) {
  f.send("next")
  await f.dialog("Choose the next step")
  f.terminal.send("\r")
  await f.dialog("Confirm stage change")
  f.terminal.send("\x1b[B\r")
  await f.dismissed()
  await f.visible(`${stage} · idle`)
}

frontendSuite("frontend-manual-repair", () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    test(`${mode}: actual human problem leads to pinned repair approval, fresh review/trial and acceptance`, async () => {
      const f = await frontend(mode)
      try {
        f.agent.permissions.setMode("auto")
        const context = await proposeUiReview(f.store)
        await approveNext(f, "acceptance")
        const base: AcceptanceArtifact = {
          kind: "acceptance",
          specHash: context.spec.hash,
          specRevision: 1,
          batchId: "B1",
          batchPlan: context.batchPlan,
          attemptId: "unused",
          attempt: 1,
          codeHash: await frontendFingerprint(f.project, f.store),
          reviewerModel: "mock/reviewer",
          implementerModels: ["mock/frontend"],
          sameModelFallback: false,
          outcome: "pass",
          checks: [],
          items: [{ itemId: "S1", status: "pass", evidence: ["Observed"], reason: "Works" }],
        }
        const first = await startReview(f.store, await f.store.read(), base)
        let state = await summarize(f.store, await consume(f.store, first.state, first.verdict, true))
        await trial(f.store, state, first.verdict, "pending")
        f.send("next")
        await f.dialog("Record manual UI trial")
        f.terminal.send("\x1b[B\r")
        await f.dialog("Confirm manual trial record")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.command("status", "Manual trial: problem")
        const problem = await f.store.read()
        expect(problem.manualTrial?.status).toBe("problem")
        expect(problem.receipts.at(-1)?.choice).toBe("problem")
        expect(problem.receipts.at(-1)?.provenance).toBe("human")
        f.send("next")
        await f.dialog("Choose the next step")
        state = await f.store.read()
        expect(state.pending?.kind).toBe("repair")
        expect(state.pending?.context).toEqual(context)
        expect(state.batchResolutions).toEqual([])
        expect(state.attempts).toEqual(problem.attempts)
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        expect(f.live()).toContain("human-reported UI problem")
        expect(f.live()).toContain('"batchId": "B1"')
        f.terminal.send(ESC)
        await f.dismissed()
        expect((await f.store.read()).stage).toBe("accept")
        await approveNext(f, "implementation")
        state = await f.store.read()
        expect(state.attempts).toEqual(problem.attempts)
        expect(state.activeAttemptId).toBeUndefined()
        expect(state.approvedContext).toEqual(context)
        expect(f.mock.requests).toEqual([])
        state = await implement(f.store, state, ["diff:repaired-control"])
        await approveNext(f, "acceptance")
        const fresh = await startReview(f.store, await f.store.read(), {
          ...base,
          codeHash: await frontendFingerprint(f.project, f.store),
        })
        expect(fresh.verdict.attempt).toBe(2)
        state = await summarize(f.store, await consume(f.store, fresh.state, fresh.verdict, true))
        await trial(f.store, state, fresh.verdict, "pending")
        f.send("next")
        await f.dialog("Record manual UI trial")
        f.terminal.send("\r")
        await f.dialog("Confirm manual trial record")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.command("status", "Manual trial: tried")
        f.send("next")
        await f.dialog("Choose the next step")
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.command("status", "Accepted batches: B1")
        const accepted = await f.store.read()
        expect(accepted.completion).toBe("accepted")
        expect(accepted.batchResolutions?.[0]).toMatchObject({
          status: "accepted",
          attemptId: fresh.verdict.attemptId,
          manualTrial: { status: "tried" },
        })
        expect(accepted.attempts[0]).toEqual(problem.attempts[0])
        expect(accepted.attempts[0]?.acceptance).toMatchObject({ verdict: "pass", failingItemIds: [] })
        expect(f.mock.requests).toEqual([])
      } finally {
        await f.cleanup()
      }
    })
  }
})
