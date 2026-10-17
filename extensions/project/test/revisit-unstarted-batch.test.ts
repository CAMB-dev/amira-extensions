import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CommandContext } from "@amira/api"
import type { WorktreeArtifact } from "../src/artifacts.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { consume, startReview, summarize } from "./batch-test-helper.ts"
import { fixture } from "./implement-fixture.ts"
import { bindingFixture, human } from "./iteration-binding-helper.ts"

setDefaultTimeout(240_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function commands(project: import("../src/store.ts").Project) {
  const control = {
    pick: async (_title: string, options: string[]): Promise<string | undefined> => options[0],
    quiesce: async (): Promise<void> => {},
  }
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main" }) },
    ui: {
      select: (title: string, options: string[]) => control.pick(title, options),
      confirm: async () => true,
    },
    print: () => {},
  } as unknown as CommandContext
  return {
    control,
    run: (verb: "next" | "revisit", args: string[] = []) =>
      runStageCommand(
        verb,
        args,
        project,
        ctx,
        "en",
        () => {},
        () => control.quiesce(),
      ),
  }
}

async function unstartedSecondBatch() {
  const f = await bindingFixture(roots, true)
  // This command/store seam reads worktree metadata only; no Git/model executor
  // is substituted or started. A real retained file detects accidental rewinds.
  const root = path.join(f.project.root, "retained-checkout")
  await mkdir(root)
  await writeFile(path.join(root, "accepted-B1.txt"), "accepted work stays\n")
  const worktree: WorktreeArtifact = {
    kind: "iteration-worktree",
    status: "ready",
    repository: f.project.root,
    root,
    cwd: root,
    branch: "fixture/retained-iteration",
    base: "fixture-base",
    excluded: "",
    confirmation: "Offline retained-checkout fixture",
    setupKey: "fixture/setup",
  }
  const saved = await f.store.saveArtifact(f.state.revision, worktree)
  const review = await startReview(f.store, saved.state, f.verdict)
  await summarize(f.store, await consume(f.store, review.state, review.verdict))
  const h = commands(f.project)
  const state = await h.run("next")
  expect(state).toMatchObject({
    stage: "implement",
    phase: "confirmed",
    status: "idle",
    approvedContext: { batchId: "B2" },
  })
  expect(state.activeAttemptId).toBeUndefined()
  expect(state.batchResolutions).toMatchObject([
    { batchId: "B1", status: "accepted", attemptId: review.verdict.attemptId },
  ])
  return { ...f, h, state, worktree, worktreeRef: saved.artifact, review }
}

test("B1 accepted then B2 confirmed/unstarted can revisit design without attributing retained work to a nonexistent attempt", async () => {
  const f = await unstartedSecondBatch()
  const before = f.state
  const after = await f.h.run("revisit", ["design"])
  expect(after.stage).toBe("design")
  expect(after.attempts).toEqual(before.attempts)
  expect(after.batchResolutions).toEqual(before.batchResolutions)
  expect(after.revisitHistory?.at(-1)?.attemptId).toBeUndefined()
  const visit = after.revisitHistory!.at(-1)!
  expect(after.receipts.find((entry) => entry.id === visit.receiptId)?.subjectId).toBe("revisit:implement")
  expect(await f.store.readArtifact(f.worktreeRef)).toEqual(f.worktree)
  expect(await readFile(path.join(f.worktree.root, "accepted-B1.txt"), "utf8")).toBe("accepted work stays\n")
  const verdictRef = after.artifacts.find(
    (entry) => entry.id === before.attempts.at(-1)!.acceptance!.artifactId,
  )!
  expect(await f.store.readArtifact(verdictRef)).toEqual(f.review.verdict)
})

for (const selection of [undefined, "Keep current stage"]) {
  test(`unstarted B2 revisit ${selection ?? "Escape"} is inert`, async () => {
    const f = await unstartedSecondBatch()
    let stops = 0
    f.h.control.pick = async () => selection
    f.h.control.quiesce = async () => {
      stops++
    }
    expect(await f.h.run("revisit", ["design"])).toEqual(f.state)
    expect(await f.store.read()).toEqual(f.state)
    expect(stops).toBe(0)
    expect(await f.store.readArtifact(f.worktreeRef)).toEqual(f.worktree)
    expect(await readFile(path.join(f.worktree.root, "accepted-B1.txt"), "utf8")).toBe(
      "accepted work stays\n",
    )
  })
}

test("an active B2 revisit keeps its root and the attempt changes recorded while quiescing", async () => {
  const f = await unstartedSecondBatch()
  let state = await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "active-B2",
  })
  const acceptedAttempt = structuredClone(state.attempts[0])
  f.h.control.quiesce = async () => {
    state = await f.store.read()
    if (state.phase !== "running") return
    await f.store.dispatch(state.revision, {
      type: "interrupt-work",
      expectedRevision: state.revision,
      attemptId: "active-B2",
      changes: ["diff:partial-B2"],
    })
  }
  const after = await f.h.run("revisit", ["design"])
  expect(after.stage).toBe("design")
  expect(after.attempts.find((entry) => entry.id === "active-B2")).toMatchObject({
    status: "interrupted",
    changes: ["diff:partial-B2", f.worktree.root],
  })
  expect(after.attempts[0]).toEqual(acceptedAttempt)
  expect(after.revisitHistory?.at(-1)?.attemptId).toBe("active-B2")
  expect(after.batchResolutions).toEqual(f.state.batchResolutions)
  expect(await readFile(path.join(f.worktree.root, "accepted-B1.txt"), "utf8")).toBe("accepted work stays\n")
})

test("a changed active attempt during quiescence cannot inherit the old revisit request", async () => {
  const f = await unstartedSecondBatch()
  await f.store.dispatch(f.state.revision, {
    type: "start-work",
    expectedRevision: f.state.revision,
    attemptId: "old-B2",
  })
  f.h.control.quiesce = async () => {
    let state = await f.store.read()
    state = await f.store.dispatch(state.revision, {
      type: "interrupt-work",
      expectedRevision: state.revision,
      attemptId: "old-B2",
      changes: ["diff:old-B2"],
    })
    state = await f.store.dispatch(state.revision, {
      type: "confirm-continuation",
      expectedRevision: state.revision,
      receipt: human(state, "old-B2", "resume"),
    })
    await f.store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId: "new-B2",
    })
  }
  await expect(f.h.run("revisit", ["design"])).rejects.toThrow("active attempt changed")
  const state = await f.store.read()
  expect(state).toMatchObject({ stage: "implement", phase: "running", activeAttemptId: "new-B2" })
  expect(state.revisit).toBeUndefined()
  expect(state.attempts.find((entry) => entry.id === "old-B2")?.changes).toEqual(["diff:old-B2"])
  expect(state.attempts.find((entry) => entry.id === "new-B2")?.changes).toEqual([])
  expect(state.batchResolutions).toEqual(f.state.batchResolutions)
})

test("first implementation planning with no attempt or checkout can still revisit design", async () => {
  const f = await fixture({ initialized: false })
  roots.push(f.home)
  const before = await f.approve()
  expect(before.activeAttemptId).toBeUndefined()
  const after = await commands(f.project).run("revisit", ["design"])
  expect(after.stage).toBe("design")
  expect(after.attempts).toEqual(before.attempts)
  expect(after.revisitHistory?.at(-1)?.attemptId).toBeUndefined()
  expect(after.correctionObligations).toEqual([])
  expect(f.specs).toEqual([])
  expect(f.commands).toEqual([])
})
