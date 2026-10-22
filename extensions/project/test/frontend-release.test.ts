import { expect, setDefaultTimeout, test } from "bun:test"
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { costRollups } from "../src/cost.ts"
import { ShipStore } from "../src/ship-storage.ts"
import { DecisionStore, HistoricalIterationReader, projectLifecycle, readProject } from "../src/store.ts"
import { ESC, frontendSuite, waitFor } from "./frontend-harness.ts"
import {
  accept,
  approveSpec,
  charge,
  configure,
  confirm,
  decision,
  files,
  implement,
  input,
  ledger,
  main,
  next,
  openRelease,
  paste,
  proposePrototype,
  releaseServices,
  stateWhen,
} from "./frontend-release-fixture.ts"
import { git } from "./implement-fixture.ts"

setDefaultTimeout(1_800_000)

frontendSuite("frontend-offline-release", () => {
  test("fullscreen: accounted design to local ship, durable budget stop, repair, close, archive and inert restore", async () => {
    const services = releaseServices()
    let f = await openRelease(services)
    const root = f.root
    console.info(`Offline release fixture: ${root}`)
    const restart = async (label: string) => {
      const runs = services.workflow.runs.length
      const commands = services.commands.length
      await f.stop()
      f = await openRelease(services, f)
      configure(f)
      // Settled lifecycle operations print their retained owner inventory, so
      // the leading status line can legitimately scroll off the 42-row screen.
      await f.command("iteration", "iteration", 180_000)
      expect(f.mock.requests, `${label}: restart must not call a model`).toEqual([])
      expect(services.workflow.runs, `${label}: restart must not replay a provider`).toHaveLength(runs)
      expect(services.commands, `${label}: restart must not run tools`).toHaveLength(commands)
      expect(f.host.ui.pending).toEqual([])
      expect(f.live()).not.toContain("main idle")
      console.info(`Offline release restart: ${label}`)
    }
    try {
      configure(f)
      await git(f.cwd, "init -b main")
      await git(f.cwd, 'config user.name "Offline Release Fixture"')
      await git(f.cwd, 'config user.email "release@invalid.local"')
      await git(f.cwd, "add -A")
      await git(f.cwd, 'commit -m "Offline release baseline"')
      const baseline = await git(f.cwd, "rev-parse HEAD")
      const decisionId = await decision(f)
      await f.command("cost", "$0.1000", 180_000)
      expect(costRollups(await ledger(f)).stages["1/design"]?.knownCostUsd).toBeCloseTo(0.1)
      await restart("design decision")

      // Main lifetime and unrelated charges are independent of project focus/accounting.
      f.mock.push({ text: "Unrelated main work remains available", usage: charge(7) })
      f.terminal.send(`${paste("This is unrelated main conversation work.")}\r`)
      await f.visible("Unrelated main work remains available")
      await waitFor(() => !f.agent.busy, "main turn settled", 30_000)
      await f.command("cost", "$0.1000", 180_000)
      f.send("next")
      await confirm(f, "Prepare the design summary?")
      await f.dialog("Choose the next step")
      f.terminal.send(ESC)
      await f.dismissed()
      await next(f)
      await proposePrototype(f)
      await f.command("cost", "$0.2000", 180_000)
      await restart("prototype proposal")
      // Explicit skip is retained as skipped, never manufactured as a prototype pass.
      f.send("skip prototype")
      await confirm(f, "Confirm stage change")
      await f.dismissed()
      expect((await f.store.read()).skips.map((entry) => entry.stage)).toEqual(["prototype"])
      await approveSpec(f, decisionId)
      expect(services.workflow.runs).toEqual([])
      await f.command("cost", "$0.3000", 180_000)
      await restart("approved spec; no automatic launch")

      await f.command("cost cap 0.5", "Cost policy saved", 180_000)
      f.mock.push(
        {
          usage: charge(0.25),
          toolCalls: [
            {
              id: "budget-interrupted-write",
              name: "write",
              args: { path: "result.txt", content: "partial\n" },
            },
          ],
        },
        { text: "This continuation must be cancelled", delayMs: 60_000, usage: charge(0) },
      )
      f.send("implement")
      await confirm(f, "Use committed base")
      await waitFor(() => services.workflow.runs.length === 1, "bound budget attempt started", 180_000)
      await f.idle()
      const interrupted = await stateWhen(f, (state) => state.status === "interrupted", "budget interruption")
      await main(f)
      await f.command("cost", ["$0.5500", "STOPPED (cap)"], 180_000)
      expect((await ledger(f)).policy.latch?.reason).toBe("cap")
      expect(services.stops).toContain(services.workflow.runs[0]!.snapshot.runId)
      expect(interrupted.attempts.at(-1)?.status).toBe("interrupted")
      expect(interrupted.pending).toBeUndefined()
      expect(f.agent.busy).toBe(false)
      expect(f.all()).toContain("80%")
      const interruptedId = interrupted.attempts.at(-1)!.id
      await restart("latched budget interruption")
      expect((await ledger(f)).policy.latch?.reason).toBe("cap")
      f.mock.push({ text: "Main still works while project spending is stopped", usage: charge(1) })
      f.terminal.send(`${paste("Continue unrelated main work, not project work.")}\r`)
      await f.visible("Main still works while project spending is stopped")
      await waitFor(() => !f.agent.busy, "main survives the project stop", 30_000)
      await f.command("cost", ["$0.5500", "STOPPED (cap)"], 180_000)
      const calls = f.mock.requests.length
      await expect(f.command("implement", "never launched", 180_000)).rejects.toThrow(
        "Interrupted/restarted work is never replayed",
      )
      await f.idle()
      expect(f.mock.requests).toHaveLength(calls)
      expect(services.workflow.runs).toHaveLength(1)
      // The cancelled response may have incomplete usage. Explicitly remove the
      // cap instead of pretending a larger cap acknowledges an unpriced receipt.
      await f.command("cost remove", ["Cost policy saved", "Stopped attempts were not resumed"], 180_000)
      expect((await ledger(f)).receipts.at(-1)?.action).toBe("remove")
      expect(services.workflow.runs).toHaveLength(1)
      f.send("next")
      await confirm(f, "Confirm continuation")
      await f.dismissed()
      expect(services.workflow.runs).toHaveLength(1)

      // A new explicit attempt, independent failed review, then a human-approved repair.
      const cwd = await implement(f, services, "needs-repair\n")
      await restart("implementation result")
      await next(f)
      const failed = await accept(f, "fail")
      expect(failed.state.completion).toBeUndefined()
      await restart("failed independent review")
      await next(f)
      expect(await implement(f, services, "ready\n")).toBe(cwd)
      await restart("repair result")
      await next(f)
      await accept(f, "pass")
      const accepted = await next(f)
      expect(accepted.completion).toBe("accepted")
      expect(accepted.batchResolutions).toMatchObject([{ batchId: "B1", status: "accepted" }])
      expect(accepted.attempts.find((entry) => entry.id === interruptedId)?.status).toBe("interrupted")
      expect(await f.store.readArtifact(failed.ref)).toEqual(failed.verdict)
      expect(await Bun.file(path.join(cwd, "reviewer-must-not-write.txt")).exists()).toBe(false)
      await f.command("cost", "$0.9500", 180_000)
      const costs = costRollups(await ledger(f))
      expect(costs.project.knownCostUsd).toBeCloseTo(0.95)
      expect(costs.iterations["1"]?.knownCostUsd).toBeCloseTo(0.95)
      expect(costs.stages["1/prototype"]?.knownCostUsd).toBeCloseTo(0.1)
      expect(costs.stages["1/implement"]?.knownCostUsd).toBeCloseTo(0.55)
      expect(costs.stages["1/accept"]?.knownCostUsd).toBeCloseTo(0.2)
      expect(costs.sessions[f.agent.sessionId]).toBeUndefined()
      expect((await ledger(f)).owners.some((owner) => owner.snapshot?.descendants.length)).toBe(true)
      await restart("accepted work remains unshipped and open")
      expect(await git(f.cwd, "rev-parse HEAD")).toBe(baseline)
      await f.command("iteration", "iteration 1: open · ship: not-started", 180_000)

      // All ship effects are driven by visible native dialogs, not a fabricated UI API.
      f.send("ship")
      await f.dialog("Repository integration preference", 180_000)
      f.terminal.send("\r")
      await input(f, "Target checkout directory (never checked out or reset by project)", f.cwd)
      await input(
        f,
        "Ship summary and release notes",
        "Deliver the independently checked offline local result.",
      )
      await f.dialog("Local integration strategy", 180_000)
      f.terminal.send("\r")
      await input(f, "Exact reviewed repository-relative file paths as a JSON array", '["result.txt"]')
      await input(
        f,
        "Candidate commit message (repository signing and hooks apply)",
        "Deliver offline local result",
      )
      await input(
        f,
        "Additional complete ship checks as JSON (or [] if item checks cover the full product)",
        "[]",
      )
      await confirm(f, "Include a remote push", false)
      await f.dialog("Approve exact ship plan and full checks", 180_000)
      expect(await git(f.cwd, "rev-parse HEAD")).toBe(baseline)
      expect(await new ShipStore(f.project).latest()).toBeUndefined()
      f.terminal.send("\x1b[B\r")
      await f.dialog("Confirm commit", 180_000)
      const beforeCommit = await new ShipStore(f.project).latest()
      expect(beforeCommit?.results).toMatchObject([{ phase: "source", ok: true }])
      expect(beforeCommit?.commit).toBeUndefined()
      f.terminal.send("\x1b[B\r")
      await f.dialog("Confirm merge", 180_000)
      expect(await git(f.cwd, "rev-parse HEAD")).toBe(baseline)
      expect((await new ShipStore(f.project).latest())?.commit).toBeDefined()
      f.terminal.send("\x1b[B\r")
      await f.dialog("Finish local-only ship", 180_000)
      const integrated = await new ShipStore(f.project).latest()
      expect(integrated?.integrated).toBe(await git(f.cwd, "rev-parse HEAD"))
      f.terminal.send(ESC)
      await f.dismissed()
      await restart("integrated result awaiting explicit local-only completion")
      expect((await new ShipStore(f.project).latest())?.operations).toEqual(integrated?.operations)
      f.send("ship")
      await confirm(f, "Finish local-only ship")
      await f.dismissed()
      const shipped = await new ShipStore(f.project).latest()
      expect(shipped).toMatchObject({ status: "shipped", outcome: "local-only" })
      expect(shipped?.operations.map((operation) => [operation.kind, operation.status])).toEqual([
        ["commit", "succeeded"],
        ["merge", "succeeded"],
      ])
      expect(shipped?.results.map((result) => [result.phase, result.ok])).toEqual([
        ["source", true],
        ["integrated", true],
        ["integrated", true],
      ])
      // Stage skips remain in iteration history; ship skips describe delivery operations/batches.
      expect((await new HistoricalIterationReader(await readProject(f.cwd), 1).read()).skips).toContainEqual(
        expect.objectContaining({ stage: "prototype" }),
      )
      expect(shipped?.skipped).toContain("push")
      expect(await readFile(path.join(f.cwd, "result.txt"), "utf8")).toBe("ready\n")
      expect(await Bun.file(path.join(cwd, "result.txt")).exists()).toBe(true)
      await restart("durable local ship; no duplicate commit/merge")
      await f.command("ship status", "local-only", 180_000)
      expect(await new ShipStore(f.project).latest()).toEqual(shipped)

      f.send("iteration close")
      await f.dialog("Close iteration")
      f.terminal.send(ESC)
      await f.dismissed()
      expect(projectLifecycle(await readProject(f.cwd)).iterations[1]?.status).toBe("open")
      f.send("iteration close")
      await confirm(f, "Close iteration")
      await f.dismissed()
      await restart("closed iteration")
      expect(projectLifecycle(await readProject(f.cwd))).toMatchObject({
        status: "active",
        iterations: { 1: { status: "closed", ship: "shipped" } },
      })
      const history = await new HistoricalIterationReader(await readProject(f.cwd), 1).read()
      expect(history.completion).toBe("accepted")
      expect(await readdir(cwd)).toContain("result.txt")

      f.send("archive")
      await confirm(f, "Archive project")
      await f.dismissed()
      await restart("archived project")
      expect(projectLifecycle(await readProject(f.cwd)).status).toBe("archived")
      const archived = await files(path.join(f.cwd, ".amira"))
      const toolCount = services.commands.length
      await f.command("status", "archived", 180_000)
      await f.command("cost", "$0.9500", 180_000)
      await f.command("iteration 1", "local", 180_000)
      // Archived mutation is refused even through the stale main attachment.
      await expect(f.command("design", "never opened", 180_000)).rejects.toThrow(/read-only|archived/i)
      await f.idle()
      expect(await files(path.join(f.cwd, ".amira"))).toEqual(archived)
      expect(services.commands).toHaveLength(toolCount)
      expect(f.mock.requests).toEqual([])
      await f.command("list", "No projects", 180_000)
      f.send("list --archived")
      await f.dialog("Projects — attach to this main session")
      expect(f.live()).toContain("[archived] Frontend")
      f.terminal.send(ESC)
      await f.dismissed()

      f.send("restore")
      await confirm(f, "Restore project")
      await f.dismissed()
      expect(f.mock.requests).toEqual([])
      expect(services.commands).toHaveLength(toolCount)
      await restart("restored metadata, closed conversations remain inert")
      expect(projectLifecycle(await readProject(f.cwd))).toMatchObject({
        status: "active",
        iterations: { 1: { status: "closed" } },
      })
      expect(await new HistoricalIterationReader(await readProject(f.cwd), 1).read()).toEqual(history)
      expect((await new DecisionStore(f.project).records()).map((entry) => entry.id)).toContain(decisionId)
      f.send("iteration new")
      await confirm(f, "Start next iteration")
      await f.dismissed()
      expect(f.mock.requests).toEqual([])
      expect(services.commands).toHaveLength(toolCount)
      await restart("explicit inert second iteration")
      expect(f.project.marker.currentIteration).toBe(2)
      expect(await f.store.read()).toMatchObject({ stage: "design", status: "idle", attempts: [] })
      expect(await new HistoricalIterationReader(f.project, 1).read()).toEqual(history)
      expect(await Bun.file(path.join(cwd, "result.txt")).exists()).toBe(true)
      expect(services.workflow.runs).toHaveLength(3)
      expect(
        services.commands.some(({ command }) =>
          /git push|gh |git tag|worktree remove.*--force/.test(command),
        ),
      ).toBe(false)
    } catch (error) {
      console.error("Offline release boundary failure:", error, f.live())
      throw error
    } finally {
      // A declined optional ship step can open the next approval. Cancel the
      // entire command, not just its first dialog, before the harness drains.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!f.host.ui.pending.length && !f.live().includes("esc cancel command")) break
        f.terminal.send(ESC)
        await Bun.sleep(100)
      }
      await f.stop()
      // Only remove the fixture's own temporary root; project never auto-cleans retained resources.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
