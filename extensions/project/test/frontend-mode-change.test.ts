import { expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import { runModeChange } from "../src/mode-change.ts"
import { batchProgress } from "../src/stage.ts"
import { IterationStore } from "../src/store.ts"
import { commandHarness, consume, startReview, summarize } from "./batch-test-helper.ts"
import { ESC, frontend, frontendSuite } from "./frontend-harness.ts"
import { bindingFixture } from "./iteration-binding-helper.ts"

setDefaultTimeout(240_000)

frontendSuite("frontend-mode-change", () => {
  test("fullscreen: unavailable workflow preserves accepted B1 while native menus reapprove only B2 as single agent", async () => {
    const roots: string[] = []
    try {
      const binding = await bindingFixture(roots, true, false, "workflow")
      const review = await startReview(binding.store, binding.state, binding.verdict)
      await summarize(binding.store, await consume(binding.store, review.state, review.verdict))
      const original = await commandHarness(binding.project).run()
      expect(original.approvedContext?.batchId).toBe("B2")
      expect(original.approvedContext?.mode).toBe("workflow")
      expect(batchProgress(original).remaining).toEqual(["B2"])
      expect(original.batchResolutions).toHaveLength(1)
      expect(original.batchResolutions![0]).toMatchObject({ batchId: "B1", status: "accepted" })
      const resolved = original.batchResolutions![0]!
      const specRef = original.artifacts.find((ref) => ref.kind === "spec")!
      const spec = await binding.store.readArtifact(specRef)
      const evidenceRef = original.artifacts.find((ref) => ref.kind === "acceptance")!
      const evidence = await binding.store.readArtifact(evidenceRef)
      const f = await frontend(undefined, [], { rows: 64 })
      try {
        // frontend() owns a different project; attach the prepared binding through the real command.
        await f.command(`switch "${binding.project.root}"`, "Attached project Binding")
        expect(await binding.store.read()).toEqual(original)
        expect(f.mock.requests).toEqual([])
        expect(f.agent.tree!.groups()).toEqual([])

        // The command helper rejects error output, so observe this intentional block directly.
        f.send("implement")
        await f.visible("workflow.runner is unavailable or disabled")
        await f.visible("/project mode")
        await f.idle()
        const blocked = await binding.store.read()
        expect(blocked.approvedContext).toEqual(original.approvedContext)
        expect(blocked.pending).toBeUndefined()
        expect(blocked.attempts).toEqual(original.attempts)
        expect(blocked.activeAttemptId).toBeUndefined()
        expect(blocked.batchResolutions).toEqual(original.batchResolutions)
        expect(batchProgress(blocked).remaining).toEqual(["B2"])
        expect(f.mock.requests).toEqual([])
        expect(f.agent.tree!.groups()).toEqual([])

        f.send("mode")
        await f.dialog("Change execution mode")
        expect(f.live()).toContain("Single agent")
        expect(f.live()).not.toContain("Swarm")
        f.terminal.send(ESC)
        await f.dismissed()
        expect(await binding.store.read()).toEqual(blocked)
        expect(f.mock.requests).toEqual([])
        expect(f.agent.tree!.groups()).toEqual([])

        f.send("mode")
        await f.dialog("Change execution mode")
        f.terminal.send("\r") // Single agent is the only available mode.
        await f.dialog("Approve execution mode change")
        expect(f.live()).toContain("Change mode workflow → single")
        expect(f.live()).toContain("selected batch B2")
        expect(f.live()).toContain("Schedule only B2")
        expect(f.live()).toContain("B1: accepted")
        expect(f.live()).toContain(resolved.receiptId)
        expect(f.live()).toContain(original.approvedContext!.spec!.hash)
        const proposed = await binding.store.read()
        expect(proposed.approvedContext).toBeUndefined()
        expect(proposed.pending).toMatchObject({
          from: "implement",
          to: "implement",
          kind: "reapprove",
          context: {
            spec: original.approvedContext!.spec,
            batchId: "B2",
            mode: "single",
            model: original.approvedContext!.model,
          },
        })
        const context = proposed.pending!.context!
        expect(context.batchPlan).not.toEqual(original.approvedContext!.batchPlan)
        const planRef = proposed.artifacts.find((ref) => ref.id === context.batchPlan!.artifactId)!
        expect(context.batchPlan).toEqual({ artifactId: planRef.id, hash: planRef.hash })
        const plan = await binding.store.readArtifact(planRef)
        expect(plan).toEqual({
          ...binding.plan,
          mode: "single",
          batches: [binding.plan.batches[1]!],
          modeChange: {
            previousPlan: original.approvedContext!.batchPlan!,
            sourceApprovalId: original.receipts.at(-1)!.id,
            batchId: "B2",
            carriedResolutions: [{ batchId: "B1", receiptId: resolved.receiptId }],
          },
        })
        expect(f.live()).toContain(planRef.hash)
        f.terminal.send(ESC)
        await f.dismissed()
        expect(await binding.store.read()).toEqual(proposed)
        expect(proposed.receipts).toEqual(original.receipts)
        expect(proposed.attempts).toEqual(original.attempts)
        expect(proposed.batchResolutions).toEqual(original.batchResolutions)
        expect(f.mock.requests).toEqual([])
        expect(f.agent.tree!.groups()).toEqual([])

        f.send("next")
        await f.dialog("Choose the next step")
        expect(f.live()).toContain("Confirm proposed next step")
        expect(await binding.store.read()).toEqual(proposed)
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        expect(f.live()).toContain("Change mode workflow → single")
        expect(f.live()).toContain("Schedule only B2")
        expect(f.live()).toContain("B1: accepted")
        expect(f.live()).toContain(resolved.receiptId)
        expect(f.live()).toContain('"mode": "single"')
        expect(f.live()).toContain('"batchId": "B2"')
        expect(f.live()).toContain(context.spec!.hash)
        expect(f.live()).toContain(planRef.id)
        expect(f.live()).toContain(planRef.hash)
        expect(await binding.store.read()).toEqual(proposed)
        f.terminal.send("\x1b[B\r") // Native confirmation defaults to Cancel; explicitly approve.
        await f.dismissed()
        const approved = await binding.store.read()
        expect(approved.pending).toBeUndefined()
        expect(approved.approvedContext).toEqual(context)
        expect(approved.phase).toBe("confirmed")
        expect(approved.status).toBe("idle")
        expect(approved.activeAttemptId).toBeUndefined()
        expect(approved.completion).toBeUndefined()
        expect(approved.receipts).toHaveLength(original.receipts.length + 1)
        expect(approved.receipts.slice(0, -1)).toEqual(original.receipts)
        expect(approved.receipts.at(-1)).toMatchObject({
          provenance: "human",
          subjectId: proposed.pending!.id,
          context,
        })
        expect(approved.receipts.at(-1)!.id).not.toBe(original.receipts.at(-1)!.id)
        expect(approved.approvedContext!.spec).toEqual(original.approvedContext!.spec)
        expect(approved.artifacts.filter((ref) => ref.kind === "spec")).toEqual([specRef])
        expect(await binding.store.readArtifact(specRef)).toEqual(spec)
        expect(approved.artifacts.filter((ref) => ref.kind === "acceptance")).toEqual([evidenceRef])
        expect(await binding.store.readArtifact(evidenceRef)).toEqual(evidence)
        expect(approved.batchResolutions).toEqual(original.batchResolutions)
        expect(approved.attempts).toEqual(original.attempts)
        expect(batchProgress(approved)).toMatchObject({
          manifest: {
            batchIds: ["B2"],
            carriedResolutions: [{ batchId: "B1", receiptId: resolved.receiptId }],
          },
          remaining: ["B2"],
          resolutions: [resolved],
        })
        expect(batchProgress(approved).resolutions[0]!.context.batchPlan).toEqual(
          original.approvedContext!.batchPlan,
        )
        await f.command("status", [
          "Stage: implementation",
          "Batch: B2",
          "Accepted batches: B1",
          "Skipped batches (not passed): —",
          "Unresolved batches: B2",
        ])
        expect(f.live()).toContain("Accepted batches: B1")
        expect(f.live()).toContain("Unresolved batches: B2")
        expect(await new IterationStore(binding.project).read()).toEqual(approved)
        expect(f.mock.requests).toEqual([])
        expect(f.agent.tree!.groups()).toEqual([])
      } finally {
        await f.cleanup()
      }
    } finally {
      for (const root of roots) await rm(root, { recursive: true, force: true })
    }
  })
})

frontendSuite("frontend-mode-change recovery", () => {
  test("fullscreen: withdrawing a mode proposal lets next re-review the same plan without generation", async () => {
    const roots: string[] = []
    try {
      const binding = await bindingFixture(roots, true, false, "workflow")
      const review = await startReview(binding.store, binding.state, binding.verdict)
      await summarize(binding.store, await consume(binding.store, review.state, review.verdict))
      const original = await commandHarness(binding.project).run()
      const api = { useService: () => undefined } as unknown as ExtensionAPI
      const ctx = {
        signal: new AbortController().signal,
        session: { info: () => ({ id: "fixture-main" }) },
        print: () => {},
        ui: { select: async () => "Single agent", confirm: async () => false },
      } as unknown as CommandContext
      const drafted = await runModeChange(
        api,
        binding.project,
        ctx,
        "en",
        () => {},
        async () => {},
      )
      const plan = drafted.pending!.context!.batchPlan!
      const h = commandHarness(binding.project)
      h.control.pick = async () => "Continue current stage"
      const withdrawn = await h.run()
      expect(withdrawn.approvedContext).toBeUndefined()
      expect(withdrawn.pending).toBeUndefined()
      const f = await frontend(undefined, [], { rows: 64 })
      try {
        await f.command(`switch "${binding.project.root}"`, "Attached project Binding")
        f.send("next")
        await f.dialog("Approve execution mode change")
        expect(f.live()).not.toContain("Generate implementation spec")
        expect(f.live()).toContain("selected batch B2")
        expect(f.live()).toContain("Schedule only B2")
        expect(f.live()).toContain(plan.hash)
        const pending = await binding.store.read()
        expect(pending.approvedContext).toBeUndefined()
        expect(pending.pending?.context?.batchPlan).toEqual(plan)
        expect(pending.receipts).toEqual(original.receipts)
        expect(f.mock.requests).toEqual([])
        f.terminal.send(ESC)
        await f.dismissed()
        expect(await binding.store.read()).toEqual(pending)
        f.send("mode")
        await f.dialog("Approve execution mode change")
        expect(await binding.store.read()).toEqual(pending)
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        const approved = await binding.store.read()
        expect(approved.approvedContext?.batchId).toBe("B2")
        expect(approved.approvedContext?.mode).toBe("single")
        expect(approved.approvedContext?.batchPlan).toEqual(plan)
        expect(approved.approvedContext?.model).toBe(original.approvedContext?.model)
        expect(approved.receipts.at(-1)?.subjectId).toBe(pending.pending?.id)
        expect(approved.batchResolutions).toEqual(original.batchResolutions)
        expect(batchProgress(approved).remaining).toEqual(["B2"])
        expect(approved.artifacts.filter((ref) => ref.kind === "spec")).toEqual(
          original.artifacts.filter((ref) => ref.kind === "spec"),
        )
        expect(f.mock.requests).toEqual([])
        expect(f.agent.tree!.groups()).toEqual([])
      } finally {
        await f.cleanup()
      }
    } finally {
      for (const root of roots) await rm(root, { recursive: true, force: true })
    }
  })
})
