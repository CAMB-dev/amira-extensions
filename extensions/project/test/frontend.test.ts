import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { completed, summarizedRevisit, unresolvedRevisit } from "./frontend-fixtures.ts"
import { confirmSkip, ESC, F6, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"

// Real Windows durable writes and lease cleanup can exceed the upstream harness's 3s default.
setDefaultTimeout(120_000)

frontendSuite("frontend", () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    test(`${mode}: persisted stage/status panel, cancelled confirmation, and inert prototype offer`, async () => {
      const f = await frontend(mode)
      let resumed: Awaited<ReturnType<typeof frontend>> | undefined
      try {
        await f.visible("Project Frontend · iteration 1 · design · idle")
        f.send("skip design")
        await f.dialog("Confirm stage change")
        expect(f.live()).toContain("Skip design")
        f.terminal.send(ESC)
        await f.dismissed()
        await f.visible("design · awaiting confirmation")
        const declined = await f.store.read()
        expect(declined.stage).toBe("design")
        expect(declined.pending?.kind).toBe("skip")
        expect(declined.receipts).toEqual([])
        await f.command("status", "Pending approval:")
        expect(f.all()).toContain(declined.pending!.id)
        expect(f.all()).toContain("Manual trial: not requested")
        f.send("next")
        await f.dialog("Choose the next step")
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await f.visible("prototype · idle")
        const skipped = await f.store.read()
        expect(skipped.skips.map((s) => s.stage)).toEqual(["design"])
        expect(skipped.receipts).toHaveLength(1)
        expect(skipped.attempts).toEqual([])
        f.send("next")
        await f.dialog("Prototype next step")
        expect(f.live()).toContain("Open prototype variants")
        f.terminal.send(ESC)
        await f.dismissed()
        expect(f.mock.requests).toEqual([])
        expect((await f.store.read()).revision).toBe(skipped.revision)
        await f.stop()
        resumed = await frontend(mode, { root: f.root, file: f.file })
        await resumed.visible("Project Frontend · iteration 1 · prototype · idle")
        expect(resumed.live()).toContain("/project prototype")
        await resumed.command("status", "Stage: prototype")
        expect(resumed.all()).toContain("Pending approval: none")
        expect((await resumed.store.read()).revision).toBe(skipped.revision)
        expect(resumed.mock.requests).toEqual([])
      } finally {
        await resumed?.stop()
        await f.cleanup()
      }
    })

    test(`${mode}: an external revision during a visible dialog rejects the stale human answer`, async () => {
      const f = await frontend(mode)
      try {
        f.send("skip design")
        await f.dialog("Confirm stage change")
        const current = await f.store.read()
        const external = await f.store.saveArtifact(current.revision, {
          kind: "stage-summary",
          stage: "design",
          language: "en",
          summary: "A separate writer changed this revision while the real dialog was visible.",
          outputs: [],
          suggestion: "Review the changed evidence again",
        })
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
        await waitFor(() => /stale.*revision/i.test(f.all()), "rendered stale revision error", 20_000)
        const rejected = await f.store.read()
        expect(rejected.revision).toBe(external.state.revision)
        expect(rejected.stage).toBe("design")
        expect(rejected.receipts).toEqual([])
        expect(rejected.pending?.id).toBe(current.pending?.id)
        expect(f.mock.requests).toEqual([])
      } finally {
        await f.cleanup()
      }
    })

    for (const [language, stage, title, stale] of [
      ["zh-CN", "阶段：设计", "确认阶段变更", "版本已过期"],
      ["ja", "段階：設計", "段階の変更を確認", "リビジョンは古く"],
    ]) {
      test(`${mode}: ${language} stale confirmation is rendered in the live project language`, async () => {
        const f = await frontend(mode)
        try {
          await writeFile(
            path.join(f.project.root, ".amira/project.json"),
            JSON.stringify({ ...f.project.marker, settings: { ...f.project.marker.settings, language } }),
          )
          await f.command("status", stage!)
          f.send("skip design")
          await f.dialog(title!)
          const current = await f.store.read()
          await f.store.saveArtifact(current.revision, {
            kind: "stage-summary",
            stage: "design",
            language: "en",
            summary: "An external draft changed this revision",
            outputs: [],
            suggestion: "Review again",
          })
          f.terminal.send("\x1b[B\r")
          await f.dismissed()
          await waitFor(() => f.all().includes(stale!), `${mode} localized stale revision`, 20_000)
          expect(f.all()).not.toContain("Stale iteration writer")
          expect((await f.store.read()).receipts).toEqual([])
          expect(f.mock.requests).toEqual([])
        } finally {
          await f.cleanup()
        }
      })
    }

    test(`${mode}: actual owned focus guards slash commands without changing stage or receipts`, async () => {
      const f = await frontend(mode)
      try {
        const before = await f.store.read()
        f.send("design")
        await f.visible("main idle")
        expect(f.live()).toContain("Design")
        f.send("skip design")
        await waitFor(
          () => f.all().includes("Return to main"),
          "native focused-conversation slash guard",
          20_000,
        )
        expect(f.host.ui.pending).toEqual([])
        expect(await f.store.read()).toEqual(before)
        expect(f.mock.requests).toEqual([])
        f.terminal.send(F6)
        await waitFor(() => !f.live().includes("main idle"), "return to main with F6", 20_000)
        // The guarded draft is still present: clear it rather than accidentally submitting it.
        f.terminal.send("\x15")
        await f.command("status", "Stage: design")
        expect((await f.store.read()).receipts).toEqual([])
      } finally {
        await f.cleanup()
      }
    })

    test(`${mode}: cancel unresolved revisit, recover a visible approval after restart, then revisit again`, async () => {
      const f = await frontend(mode)
      let resumed: Awaited<ReturnType<typeof frontend>> | undefined
      try {
        await confirmSkip(f)
        f.send("revisit design")
        await f.dialog("Revisit design?")
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        f.terminal.send(ESC)
        await f.dismissed()
        await f.visible("prototype · awaiting confirmation")
        const pending = await f.store.read()
        expect(pending.revisit?.target).toBe("design")
        expect(pending.pending?.kind).toBe("revisit")
        f.send("next")
        await f.dialog("Choose the next step")
        expect(f.live()).toContain("Continue current stage")
        f.terminal.send("\x1b[B\x1b[B\x1b[B\r")
        await f.dismissed()
        await f.visible("prototype · idle")
        const cancelled = await f.store.read()
        expect(cancelled.pending).toBeUndefined()
        expect(cancelled.revisit).toBeUndefined()
        const revision = cancelled.revision
        await f.command("next", "Ship: coming later.")
        expect((await f.store.read()).revision).toBe(revision)
        expect(f.host.ui.pending).toEqual([])
        f.send("revisit design")
        await f.dialog("Revisit design?")
        f.terminal.send("\r")
        await f.dialog("Confirm stage change")
        const interrupted = await f.store.read()
        // Close the frontend at a durable unresolved approval, without synthesizing a human answer.
        await f.stop()
        resumed = await frontend(mode, { root: f.root, file: f.file })
        await resumed.visible("prototype · awaiting confirmation")
        expect(await resumed.store.read()).toEqual(interrupted)
        expect(resumed.host.ui.pending).toEqual([])
        resumed.send("next")
        await resumed.dialog("Choose the next step")
        resumed.terminal.send("\r")
        await resumed.dialog("Confirm stage change")
        resumed.terminal.send("\x1b[B\r")
        await resumed.dismissed()
        await resumed.visible("design · idle")
        const recovered = await resumed.store.read()
        expect(recovered.transitions.at(-1)?.kind).toBe("revisit")
        expect(recovered.pending).toBeUndefined()
        expect(recovered.revisit).toBeUndefined()
        await confirmSkip(resumed)
        resumed.send("revisit design")
        await resumed.dialog("Revisit design?")
        resumed.terminal.send("\r")
        await resumed.dialog("Confirm stage change")
        resumed.terminal.send("\x1b[B\r")
        await resumed.dismissed()
        await resumed.visible("design · idle")
        const second = await resumed.store.read()
        expect(second.transitions.filter((t) => t.kind === "revisit")).toHaveLength(2)
        expect(second.revisit).toBeUndefined()
        expect(second.attempts).toEqual([])
        expect(resumed.mock.requests).toEqual([])
      } finally {
        await resumed?.stop()
        await f.cleanup()
      }
    })

    test(`${mode}: reload recovers a durable revisit request left before summary publication without replay`, async () => {
      const f = await frontend(mode)
      let resumed: Awaited<ReturnType<typeof frontend>> | undefined
      try {
        await confirmSkip(f)
        const crashBoundary = await unresolvedRevisit(f.store)
        expect(crashBoundary.revisit?.target).toBe("design")
        expect(crashBoundary.pending).toBeUndefined()
        await f.stop()
        resumed = await frontend(mode, { root: f.root, file: f.file })
        await resumed.visible("prototype · idle")
        expect(await resumed.store.read()).toEqual(crashBoundary)
        expect(resumed.host.ui.pending).toEqual([])
        expect(resumed.mock.requests).toEqual([])
        resumed.send("next")
        await resumed.dialog("Confirm stage change")
        expect(resumed.live()).toContain("Return to design; preserve changes")
        resumed.terminal.send("\x1b[B\r")
        await resumed.dismissed()
        await resumed.visible("design · idle")
        const recovered = await resumed.store.read()
        expect(recovered.transitions.at(-1)?.kind).toBe("revisit")
        expect(recovered.revisit).toBeUndefined()
        expect(recovered.pending).toBeUndefined()
        expect(recovered.attempts).toEqual([])
        expect(resumed.mock.requests).toEqual([])
      } finally {
        await resumed?.stop()
        await f.cleanup()
      }
    })

    test(`${mode}: restart between revisit summary and proposal reuses the saved summary`, async () => {
      const f = await frontend(mode)
      let resumed: Awaited<ReturnType<typeof frontend>> | undefined
      try {
        await confirmSkip(f)
        const crashBoundary = await summarizedRevisit(f.store)
        expect(crashBoundary.phase).toBe("summarized")
        expect(crashBoundary.pending).toBeUndefined()
        await f.stop()
        resumed = await frontend(mode, { root: f.root, file: f.file })
        await resumed.visible("prototype · idle")
        expect(await resumed.store.read()).toEqual(crashBoundary)
        expect(resumed.host.ui.pending).toEqual([])
        resumed.send("next")
        await resumed.dialog("Confirm stage change")
        expect(resumed.live()).toContain("Return to design; preserve changes")
        const proposed = await resumed.store.read()
        expect(proposed.pending?.summaryId).toBe(crashBoundary.summaryId)
        expect(proposed.artifacts).toEqual(crashBoundary.artifacts)
        resumed.terminal.send("\x1b[B\r")
        await resumed.dismissed()
        await resumed.visible("design · idle")
        const recovered = await resumed.store.read()
        expect(recovered.transitions.at(-1)?.summaryId).toBe(crashBoundary.summaryId)
        expect(recovered.revisit).toBeUndefined()
        expect(resumed.mock.requests).toEqual([])
      } finally {
        await resumed?.stop()
        await f.cleanup()
      }
    })

    for (const completion of ["accepted", "skipped"] as const) {
      test(`${mode}: revisit design from ${completion} completion preserves evidence and allows another revisit`, async () => {
        const f = await frontend(mode)
        try {
          f.agent.permissions.setMode("auto")
          const before = await completed(f.store, completion)
          expect(before.completion).toBe(completion)
          await f.command("status", "Stage: acceptance")
          expect(f.all()).toContain(
            completion === "accepted" ? "Accepted" : "Acceptance skipped — not a pass",
          )
          f.send("revisit design")
          await f.dialog("Revisit design?")
          f.terminal.send("\r")
          await f.dialog("Confirm stage change")
          f.terminal.send("\x1b[B\r")
          await f.dismissed()
          await f.visible("design · idle")
          const returned = await f.store.read()
          expect(returned.completion).toBeUndefined()
          expect(returned.revisit).toBeUndefined()
          expect(returned.attempts).toEqual(before.attempts)
          expect(returned.artifacts.slice(0, before.artifacts.length)).toEqual(before.artifacts)
          expect(returned.transitions.at(-1)?.kind).toBe("revisit")
          // No implementation is replayed. Advance only the user-command fixture's empty design.
          await confirmSkip(f)
          f.send("revisit design")
          await f.dialog("Revisit design?")
          f.terminal.send("\r")
          await f.dialog("Confirm stage change")
          f.terminal.send("\x1b[B\r")
          await f.dismissed()
          await f.visible("design · idle")
          const again = await f.store.read()
          expect(again.transitions.filter((t) => t.kind === "revisit")).toHaveLength(2)
          expect(again.attempts).toEqual(before.attempts)
          expect(f.mock.requests).toEqual([])
        } finally {
          await f.cleanup()
        }
      })
    }
  }
})
