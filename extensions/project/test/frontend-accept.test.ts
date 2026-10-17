import { expect, setDefaultTimeout, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { ConversationSpec } from "@amira/api"
import type { AcceptanceArtifact } from "../src/artifacts.ts"
import { IMPLEMENT_SPAWN } from "../src/implement.ts"
import type { IterationState } from "../src/stage.ts"
import { writeDocument } from "../src/store.ts"
import { ESC, F6, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"
import { fixtureShell, git, specDraft } from "./implement-fixture.ts"

setDefaultTimeout(600_000)

type Frontend = Awaited<ReturnType<typeof frontend>>
const RECORD_ACCEPTANCE = "project_record_acceptance"

async function dismissed(f: Frontend) {
  await waitFor(() => f.host.ui.pending.length === 0, "acceptance dialog dismissed", 30_000)
  // Freshness probes run real local Git through the owned host. Keep the shared
  // harness's short timeout unchanged for its other suites, but allow this work
  // to finish on slower Windows process launches.
  for (let attempt = 0; ; attempt++) {
    try {
      await f.idle()
      return
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
}

async function stateWhen(f: Frontend, check: (state: IterationState) => boolean, label: string) {
  for (let i = 0; i < 2400; i++) {
    const state = await f.store.read()
    if (check(state)) return state
    if (state.status === "interrupted")
      throw new Error(`${label}: work interrupted\n${JSON.stringify(state)}\n${f.live()}`)
    await Bun.sleep(25)
  }
  throw new Error(`${label}\n${JSON.stringify(await f.store.read())}\n${f.live()}`)
}

async function prepare(f: Frontend, ui: boolean) {
  f.agent.permissions.setMode("auto")
  f.host.setSettings({
    extensions: { [`frontend-${path.basename(f.root)}`]: { reviewerModel: "mock/reviewer" } },
  })
  await git(f.cwd, "init")
  await git(f.cwd, 'config user.name "Acceptance Frontend Fixture"')
  await git(f.cwd, 'config user.email "acceptance@invalid.local"')
  await git(f.cwd, "config commit.gpgsign false")
  await git(f.cwd, "add -A")
  await git(f.cwd, 'commit -m "Offline acceptance baseline"')
  await writeDocument(f.project, "design.md", "SECRET DESIGN TRANSCRIPT")
  const draft = specDraft()
  draft.spec.items[0]!.ui = ui
  f.mock.push({ text: JSON.stringify(draft) })
  f.send("spec")
  await f.dialog("Review implementation spec", 30_000)
  f.terminal.send("\r")
  await dismissed(f)
}

async function implement(f: Frontend, content = "ready\n", first = true) {
  const before = f.mock.requests.length
  f.mock.push(
    { toolCalls: [{ id: `spawn-${f.mock.requests.length}`, name: IMPLEMENT_SPAWN, args: {} }] },
    {
      toolCalls: [
        { id: `write-${f.mock.requests.length}`, name: "write", args: { path: "result.txt", content } },
      ],
    },
    { text: "Implemented S1 in the isolated iteration checkout." },
    { text: "The single implementation child finished; review the independent checks." },
  )
  f.send("implement")
  if (first) {
    await f.dialog("Use committed base", 30_000)
    f.terminal.send("\x1b[B\r")
  }
  await waitFor(() => f.mock.requests.length > before, "implementation coordinator started", 60_000)
  await f.idle()
  const state = await stateWhen(f, (state) => state.pending?.to === "accept", "implementation completed")
  f.terminal.send(F6)
  await waitFor(() => !f.live().includes("main idle"), "return from implementation", 20_000)
  const ref = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!
  const worktree = await f.store.readArtifact(ref)
  if (worktree.kind !== "iteration-worktree") throw new Error("Missing iteration worktree")
  expect(await readFile(path.join(worktree.cwd, "result.txt"), "utf8")).toBe(content)
  expect(await Bun.file(path.join(f.cwd, "result.txt")).exists()).toBe(false)
  return worktree
}

async function approveNext(f: Frontend, stage?: "accept" | "implement") {
  const calls = f.mock.requests.length
  f.send("next")
  await f.dialog("Choose the next step")
  f.terminal.send("\r")
  await f.dialog("Confirm stage change")
  f.terminal.send("\x1b[B\r")
  await dismissed(f)
  const state = await f.store.read()
  if (stage) {
    expect(state.stage).toBe(stage)
    expect(state.phase).toBe("confirmed")
  }
  expect(f.mock.requests).toHaveLength(calls)
  return state
}

async function cancelNext(f: Frontend, title = "Choose the next step") {
  const before = await f.store.read()
  const calls = f.mock.requests.length
  f.send("next")
  await f.dialog(title)
  f.terminal.send(ESC)
  await dismissed(f)
  expect(await f.store.read()).toEqual(before)
  expect(f.mock.requests).toHaveLength(calls)
  expect(f.host.ui.pending).toEqual([])
}

function reviewItems(outcome: "pass" | "fail") {
  return [
    {
      itemId: "S1",
      status: outcome,
      evidence: [
        outcome === "pass" ? "result.txt contains the approved local result" : "result.txt needs a repair",
      ],
      reason:
        outcome === "pass"
          ? "The approved result is present."
          : "Repair the local result before accepting S1.",
    },
  ]
}

async function accept(f: Frontend, outcome: "pass" | "fail", hold = false) {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const before = f.mock.requests.length
  f.mock.push(
    {
      text: "Reviewing S1 against its pinned spec and independently executed checks.",
      ...(hold ? { hold: { chunks: 1, until: held } } : {}),
      toolCalls: [
        {
          id: `denied-reviewer-write-${before}`,
          name: "write",
          args: { path: "reviewer-must-not-write.txt", content: "This write must be blocked.\n" },
        },
        {
          id: `record-review-${before}`,
          name: RECORD_ACCEPTANCE,
          args: { items: reviewItems(outcome) },
        },
      ],
    },
    { text: `Acceptance review finished: ${outcome}. No code was merged.` },
  )
  try {
    f.send("accept")
    await waitFor(() => f.mock.requests.length > before, "acceptance reviewer model started", 60_000)
    await f.idle()
    const request = f.mock.requests[before]!
    expect(request.model.id).toBe("reviewer")
    expect(request.tools.map((tool) => tool.name)).toContain(RECORD_ACCEPTANCE)
    const files = (await readdir(path.join(f.root, "owned-home"), { recursive: true })).filter((file) =>
      file.endsWith(".spec.json"),
    )
    const specs = await Promise.all(
      files.map(
        async (file) =>
          (
            JSON.parse(await readFile(path.join(f.root, "owned-home", file), "utf8")) as {
              spec: ConversationSpec
            }
          ).spec,
      ),
    )
    const reviewer = specs.findLast((spec) => spec.key.includes("/accept/"))!
    expect(reviewer).toMatchObject({ model: "mock/reviewer", writeRoots: [] })
    expect(reviewer.callableTools).toContain(RECORD_ACCEPTANCE)
    expect(reviewer.callableTools).not.toContain("write")
    expect(reviewer.callableTools).not.toContain(IMPLEMENT_SPAWN)
    const seed = JSON.stringify(request.messages)
    expect(seed).toContain("S1")
    expect(seed).toContain("git --version")
    expect(seed).not.toContain("SECRET DESIGN TRANSCRIPT")
    if (hold) {
      const state = await f.store.read()
      expect(state.stage).toBe("accept")
      expect(state.status).toBe("working")
      expect(
        state.attempts.find((attempt) => attempt.id === state.activeAttemptId)?.acceptance,
      ).toBeUndefined()
      await f.visible("Accept B1")
      await f.visible("Acceptance 1: in progress")
      expect(f.live()).toContain("0 pass")
      expect(f.live()).toContain("main idle")
    }
    f.terminal.send(F6)
    await waitFor(() => !f.live().includes("main idle"), "return from acceptance", 20_000)
    release()
    const state = await stateWhen(
      f,
      (state) => state.stage === "accept" && ["summarized", "proposed"].includes(state.phase),
      "acceptance summary recorded",
    )
    expect(await Bun.file(path.join(reviewer.cwd, "reviewer-must-not-write.txt")).exists()).toBe(false)
    expect(JSON.stringify(f.mock.requests[before + 1]!.messages)).toContain("not callable")
    const ref = state.artifacts.findLast((entry) => entry.kind === "acceptance")!
    const verdict = await f.store.readArtifact(ref)
    expect(verdict).toMatchObject({
      kind: "acceptance",
      outcome,
      reviewerModel: "mock/reviewer",
      implementerModels: ["mock/frontend"],
      sameModelFallback: false,
      items: reviewItems(outcome),
      checks: [{ checkId: "C1", command: "git --version", status: "passed", exitCode: 0 }],
    })
    const summary = await f.store.readArtifact(state.artifacts.find((entry) => entry.id === state.summaryId)!)
    expect(summary).toMatchObject({ kind: "stage-summary", stage: "accept", language: "en" })
    expect(JSON.stringify(summary)).toContain("S1")
    return { state, ref, verdict: verdict as AcceptanceArtifact }
  } finally {
    release()
  }
}

frontendSuite("frontend-acceptance", () => {
  test(`fullscreen: real offline acceptance renders progress, summary and a human-only manual trial`, async () => {
    const f = await frontend(undefined, [fixtureShell])
    try {
      await prepare(f, true)
      await implement(f)
      await cancelNext(f)
      await approveNext(f, "accept")
      await cancelNext(f, "Review this batch")
      const review = await accept(f, "pass", true)
      expect(review.state.completion).toBeUndefined()
      expect(review.state.manualTrialRequired).toBe(true)
      expect(review.state.manualTrial?.status).toBe("pending")
      await f.command(
        "status",
        ["Stage: acceptance", "Manual trial: pending", "Batch B1 automated pass, manual trial pending"],
        90_000,
      )
      const trialRef = review.state.artifacts.find(
        (entry) => entry.id === review.state.manualTrial!.artifactId,
      )!
      const trial = await f.store.readArtifact(trialRef)
      expect(trial).toMatchObject({
        kind: "manual-trial",
        status: "pending",
        batchId: "B1",
        attemptId: review.verdict.attemptId,
        attempt: review.verdict.attempt,
        codeHash: review.verdict.codeHash,
      })
      if (trial.kind !== "manual-trial") throw new Error("Missing human trial prompt")
      expect(trial.instructions.length).toBeGreaterThan(0)
      expect(trial.observe.length).toBeGreaterThan(0)
      const before = await f.store.read()
      const calls = f.mock.requests.length
      f.send("next")
      await f.dialog("Record manual UI trial")
      expect(f.all()).toContain("Record tried")
      f.terminal.send(ESC)
      await dismissed(f)
      expect(await f.store.read()).toEqual(before)
      expect(f.mock.requests).toHaveLength(calls)
      f.send("next")
      await f.dialog("Record manual UI trial")
      f.terminal.send("\r")
      await f.dialog("Confirm manual trial record")
      f.terminal.send(ESC)
      await dismissed(f)
      expect(await f.store.read()).toEqual(before)
      expect(f.mock.requests).toHaveLength(calls)
      expect(await f.store.readArtifact(trialRef)).toEqual(trial)
      f.send("next")
      await f.dialog("Record manual UI trial")
      f.terminal.send("\r")
      await f.dialog("Confirm manual trial record")
      f.terminal.send("\x1b[B\r")
      await dismissed(f)
      await f.command("status", "Manual trial: tried", 90_000)
      const tried = await f.store.read()
      expect(tried.receipts.at(-1)).toMatchObject({ provenance: "human", choice: "tried" })
      expect(tried.completion).toBeUndefined()
      const accepted = await approveNext(f)
      expect(accepted.completion).toBe("accepted")
      expect(accepted.batchResolutions).toMatchObject([
        { batchId: "B1", status: "accepted", attemptId: review.verdict.attemptId },
      ])
      expect(f.mock.requests).toHaveLength(calls)
      await f.command("status", ["Accepted batches: B1", "Manual trial: tried"], 90_000)
      expect(await f.store.readArtifact(review.ref)).toEqual(review.verdict)
    } finally {
      await f.cleanup()
    }
  }, 600_000)

  test(`fullscreen: failure requires repair approval and a fresh acceptance without rewriting the old verdict`, async () => {
    const f = await frontend(undefined, [fixtureShell])
    try {
      await prepare(f, false)
      const worktree = await implement(f, "needs-repair\n")
      await approveNext(f, "accept")
      const failed = await accept(f, "fail")
      const oldAttempt = failed.state.attempts.find((attempt) => attempt.id === failed.verdict.attemptId)!
      expect(oldAttempt.acceptance).toMatchObject({ verdict: "fail", failingItemIds: ["S1"] })
      expect(failed.state.completion).toBeUndefined()
      expect(failed.state.batchResolutions).toEqual([])
      const calls = f.mock.requests.length
      f.send("next")
      await f.dialog("Choose the next step")
      f.terminal.send("\r")
      await f.dialog("Confirm stage change")
      expect(f.live()).toContain('"batchId": "B1"')
      const proposed = await f.store.read()
      expect(proposed.pending).toMatchObject({
        kind: "repair",
        to: "implement",
        context: failed.state.approvedContext,
      })
      f.terminal.send(ESC)
      await dismissed(f)
      expect((await f.store.read()).stage).toBe("accept")
      expect((await f.store.read()).attempts).toEqual(failed.state.attempts)
      expect(f.mock.requests).toHaveLength(calls)
      await cancelNext(f)
      const repair = await approveNext(f, "implement")
      expect(repair.approvedContext).toEqual(failed.state.approvedContext)
      expect(repair.attempts).toEqual(failed.state.attempts)
      expect(repair.activeAttemptId).toBeUndefined()
      const repairedWorktree = await implement(f, "ready\n", false)
      expect(repairedWorktree.root).toBe(worktree.root)
      await approveNext(f, "accept")
      const fresh = await accept(f, "pass")
      expect(fresh.verdict.attempt).toBe(failed.verdict.attempt + 1)
      expect(fresh.verdict.attemptId).not.toBe(failed.verdict.attemptId)
      expect(fresh.verdict.codeHash).not.toBe(failed.verdict.codeHash)
      expect(fresh.state.attempts.find((attempt) => attempt.id === oldAttempt.id)).toEqual(oldAttempt)
      expect(await f.store.readArtifact(failed.ref)).toEqual(failed.verdict)
      const accepted = await approveNext(f)
      expect(accepted.completion).toBe("accepted")
      expect(accepted.batchResolutions).toMatchObject([
        { batchId: "B1", status: "accepted", attemptId: fresh.verdict.attemptId },
      ])
      expect(accepted.attempts.filter((attempt) => attempt.stage === "accept")).toHaveLength(2)
      expect(await f.store.readArtifact(failed.ref)).toEqual(failed.verdict)
      await f.command("status", "Accepted batches: B1", 90_000)
    } finally {
      await f.cleanup()
    }
  }, 600_000)
})
