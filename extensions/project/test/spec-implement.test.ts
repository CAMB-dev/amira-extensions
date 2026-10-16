import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SpawnOptions } from "@amira/api"
import { IMPLEMENT_SPAWN, IMPLEMENT_TOOLS, Implementations } from "../src/implement.ts"
import { checkCwd, toolEvidence, verifiedCheckCwd } from "../src/iteration-git.ts"
import { runSpec } from "../src/spec.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import { DecisionStore, IterationStore, writeDocument } from "../src/store.ts"
import { fixture, git, specDraft } from "./implement-fixture.ts"

setDefaultTimeout(120_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.implementations.quiesce(f.project)
    // Fixture cleanup only; production never removes iteration worktrees.
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function setup(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options)
  fixtures.push(f)
  return f
}
async function result(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.store.read()
  const ref = state.artifacts.findLast((entry) => entry.kind === "batch-result")!
  const saved = await f.store.readArtifact(ref)
  if (saved.kind !== "batch-result") throw new Error("No result")
  return saved
}

test("spec generation is text-only, renders the exact plan, revises stable IDs from feedback and pins approval", async () => {
  const f = await setup()
  await writeDocument(f.project, "design.md", "SECRET DESIGN TRANSCRIPT MUST NOT LEAK")
  f.drafts.push({ ...specDraft(2), spec: { ...specDraft(2).spec, summary: "Revised local result" } })
  f.answers.push("Request changes", "Clarify the constraints", "Approve spec and batch plan")
  const state = await runSpec(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect(state.approvedContext?.spec?.revision).toBe(2)
  expect(state.approvedContext?.batchPlan?.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(state.phase).toBe("confirmed")
  expect(state.receipts).toHaveLength(1)
  expect(state.artifacts.filter((entry) => entry.kind === "spec")).toHaveLength(2)
  expect(f.specs).toHaveLength(0)
  expect(f.prints.join("\n")).toContain("## Batch plan")
  expect(f.prints.join("\n")).toContain("cwd (relative to iteration project): `.`")
  const requests = JSON.stringify(f.complete.mock.calls)
  expect(requests).not.toContain("SECRET DESIGN TRANSCRIPT")
  expect(requests).toContain("Clarify the constraints")
  expect(requests).toContain('\\"id\\":\\"S1\\"')
  expect(f.commands).toHaveLength(0)
})

test("stale spec review cannot authorize a launch and cancellation creates no approval", async () => {
  const f = await setup()
  f.answers.push(async () => {
    const state = await f.store.read()
    await f.store.saveArtifact(state.revision, {
      kind: "stage-summary",
      stage: "design",
      language: "en",
      summary: "Concurrent change",
      outputs: [],
      suggestion: "Review",
    })
    return "Approve spec and batch plan"
  })
  await expect(
    runSpec(
      f.api,
      f.project,
      f.ctx,
      "en",
      () => {},
      async () => {},
    ),
  ).rejects.toThrow("revision")
  expect((await f.store.read()).receipts).toHaveLength(0)
  f.drafts.push(specDraft(2))
  f.answers.push("Cancel")
  await runSpec(
    f.api,
    f.project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  expect((await f.store.read()).approvedContext).toBeUndefined()
  expect(f.commands).toHaveLength(0)
})

test("spec rejects fabricated decisions, missing check cwd and incomplete batch coverage", async () => {
  for (const corruption of ["decision", "cwd", "coverage"] as const) {
    const f = await setup()
    const draft = f.drafts[0]!
    if (corruption === "decision") draft.spec.decisionIds.push("D999")
    if (corruption === "cwd") draft.spec.checks[0]!.cwd = ""
    if (corruption === "coverage") draft.batches = [{ ...draft.batches[0]!, itemIds: ["UNKNOWN"] }]
    await expect(
      runSpec(
        f.api,
        f.project,
        f.ctx,
        "en",
        () => {},
        async () => {},
      ),
    ).rejects.toThrow()
    expect((await f.store.read()).receipts).toHaveLength(0)
  }
})

test("single-agent batch has exact coordinator policy, fresh child seed, metadata models and runTool check evidence", async () => {
  const f = await setup()
  await git(f.repo, "config core.autocrlf true")
  await git(f.repo, "config core.safecrlf warn")
  await new DecisionStore(f.project).record(
    [
      {
        question: "How should this work?",
        options: [
          { label: "Offline", description: "Local only" },
          { label: "Online", description: "Network" },
        ],
      },
    ],
    [{ selected: ["Offline"] }],
    { sessionId: "design", askId: "confirmed", language: "en" },
  )
  const records = await new DecisionStore(f.project).records()
  const decisionId = records[0]!.id
  f.drafts[0]!.spec.decisionIds.push(decisionId)
  f.drafts[0]!.spec.items[0]!.decisionIds.push(decisionId)
  await writeDocument(f.project, "design.md", "SECRET DESIGN TRANSCRIPT")
  await f.approve()
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const state = await f.store.read()
  expect(state.phase, f.notifications.join("\n")).toBe("proposed")
  expect(state.pending?.to).toBe("accept")
  expect(state.pending?.suggestion).toContain("coming next")
  const coordinator = f.specs.at(-1)!
  expect(coordinator.key).toMatch(new RegExp(`^${f.project.marker.id}/iteration/1/batch/B1/implement/`))
  expect(coordinator.descendants).toBe("inherit")
  expect(coordinator.callableTools).toEqual([...IMPLEMENT_TOOLS, IMPLEMENT_SPAWN])
  expect(coordinator.callableTools).not.toContain("agent")
  expect(coordinator.cwd).not.toBe(f.root)
  const child = f.spawned() as SpawnOptions
  expect(child.context).toBe("fresh")
  expect(child.cwd).toBe(coordinator.cwd)
  expect(child.prompt).toContain("Offline")
  expect(child.prompt).toContain("S1")
  expect(child.prompt).toContain("git --version")
  expect(child.prompt).not.toContain("SECRET DESIGN TRANSCRIPT")
  expect(child.callableTools).not.toContain(IMPLEMENT_SPAWN)
  const saved = await result(f)
  expect(saved.implementerModels).toEqual(["mock/actual-implementer"])
  expect(saved.diffStat).toContain("result.txt")
  expect(saved.checks[0]).toMatchObject({
    checkId: "C1",
    cwd: coordinator.cwd,
    command: "git --version",
    status: "passed",
    exitCode: 0,
  })
  expect(
    f.commands.some((entry) => entry.command.endsWith("git --version") && entry.key === coordinator.key),
  ).toBe(true)
  expect(await readFile(path.join(coordinator.cwd, "result.txt"), "utf8")).toBe("ready\n")
  expect(await Bun.file(path.join(f.root, "result.txt")).exists()).toBe(false)
  expect(await git(f.repo, "branch --show-current")).not.toBe(
    await git(coordinator.cwd, "branch --show-current"),
  )
  expect(await git(coordinator.cwd, "status --short")).toContain("?? result.txt")
  const previousCommands = f.commands.length
  new Implementations(f.api)
  expect((await new IterationStore(f.project).read()).phase).toBe("proposed")
  expect(f.commands).toHaveLength(previousCommands)
})

test("dirty/untracked input blocks with committed-base preview until explicitly excluded", async () => {
  const f = await setup()
  await writeFile(path.join(f.root, "tracked.txt"), "Committed base\n")
  await git(f.repo, 'add tracked.txt && git commit -m "Tracked baseline"')
  await writeFile(path.join(f.root, "tracked.txt"), "Keep dirty local\n")
  await writeFile(path.join(f.root, "untracked.txt"), "Keep local\n")
  await f.approve()
  f.answers.push("Stop and resolve local changes")
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
    "Resolve local changes",
  )
  expect(f.prints.join("\n")).toContain("Committed base preview")
  expect(f.prints.join("\n")).toContain("untracked.txt")
  expect(f.specs.some((spec) => spec.descendants === "inherit")).toBe(false)
  f.answers.push("Use displayed commit and explicitly exclude ALL local changes")
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const cwd = f.specs.at(-1)!.cwd
  expect(await Bun.file(path.join(cwd, "untracked.txt")).exists()).toBe(false)
  expect(await readFile(path.join(f.root, "untracked.txt"), "utf8")).toBe("Keep local\n")
  const state = await f.store.read()
  const ref = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!
  expect(await f.store.readArtifact(ref)).toMatchObject({
    excluded: expect.stringContaining("?? untracked.txt"),
    status: "ready",
  })
  expect(await readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("Committed base\n")
  expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe("Keep dirty local\n")
})

test("a subdirectory project maps into the iteration worktree and checks cannot escape", async () => {
  const f = await setup({ subdirectory: true })
  await f.approve()
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const state = await f.store.read()
  const ref = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!
  const saved = await f.store.readArtifact(ref)
  if (saved.kind !== "iteration-worktree") throw new Error("No worktree")
  expect(path.relative(saved.root, saved.cwd)).toBe(path.join("packages", "local"))
  expect(checkCwd(saved, "../..")).toBe(saved.root)
  expect(() => checkCwd(saved, "../../..")).toThrow("escapes")
  const linked = path.join(saved.cwd, "linked-check")
  await symlink(f.repo, linked, process.platform === "win32" ? "junction" : "dir")
  await expect(verifiedCheckCwd(saved, "linked-check")).rejects.toThrow("redirected")
  await rm(linked)
  expect(await result(f)).toMatchObject({ worktree: saved.root })
})

test("empty/no-commit repo requires bootstrap confirmation; rejected hook is never bypassed", async () => {
  const f = await setup({ initialized: false })
  await f.approve()
  f.answers.push(false)
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("bootstrap cancelled")
  expect(await Bun.file(path.join(f.root, ".git", "HEAD")).exists()).toBe(false)
  await git(f.repo, "init")
  await git(f.repo, 'config user.name "Offline Fixture"')
  await git(f.repo, 'config user.email "fixture@invalid.local"')
  await git(f.repo, "config commit.gpgsign false")
  const hook = path.join(f.repo, ".git", "hooks", "pre-commit")
  await writeFile(hook, "#!/bin/sh\necho fixture-hook-rejected >&2\nexit 1\n", { mode: 0o755 })
  f.answers.push(true)
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
    "fixture-hook-rejected",
  )
  expect(f.commands.some((entry) => /--no-verify|gpgsign|hooksPath/.test(entry.command))).toBe(false)
  expect(f.specs.some((spec) => spec.descendants === "inherit")).toBe(false)
  await rm(hook)
  f.answers.push(true, "Use displayed commit and explicitly exclude ALL local changes")
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  expect(await git(f.repo, "ls-tree --name-only HEAD")).toBe("")
  expect(await git(f.repo, "log -1 --format=%s")).toBe("Initial project base")
})

test("branch collisions and tool failures stop without adoption, removal, or shared-cwd fallback", async () => {
  for (const mode of ["collision", "denied", "creation"] as const) {
    const f = await setup()
    await f.approve()
    if (mode === "collision")
      await git(f.repo, `branch amira/project/implementation-${f.project.marker.id}/iteration-1`)
    else f.block(mode === "denied" ? "git rev-parse --show-toplevel" : "git worktree add")
    if (mode !== "denied") f.answers.push(true)
    await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow()
    expect(f.spawned()).toBeUndefined()
    expect((await f.store.read()).phase).toBe("confirmed")
    expect(f.commands.some((entry) => /worktree remove|branch -D|reset --hard/.test(entry.command))).toBe(
      false,
    )
    if (mode !== "denied") {
      const before = f.commands.length
      await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
        "setup was interrupted",
      )
      expect(f.commands).toHaveLength(before)
    }
  }
})

test("failed exact checks are preserved as failures, never asserted to pass", async () => {
  const f = await setup()
  f.drafts[0]!.spec.checks[0]!.command = "git --not-a-command"
  await f.approve()
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  expect((await result(f)).checks[0]).toMatchObject({ status: "failed", exitCode: 129 })
  expect(toolEvidence({ content: [{ type: "text", text: "denied" }], isError: true }).ok).toBe(false)
})

test("running revisit stops and drains coordinator, preserves changes and does not finish the obsolete attempt", async () => {
  const f = await setup()
  await f.approve()
  f.answers.push(true)
  let release!: () => void
  f.hold(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  const running = await f.store.read()
  expect(running.status).toBe("working")
  const count = f.commands.length
  new Implementations(f.api)
  expect((await new IterationStore(f.project).read()).status).toBe("working")
  expect(f.commands).toHaveLength(count)
  const coordinator = f.handles.at(-1)!
  // Release the mock executor when stop is called, as real owned stop physically drains it.
  const originalStop = coordinator.stop
  coordinator.stop = async (reason) => {
    release()
    await originalStop(reason)
  }
  f.answers.push("Interrupt and preserve changes", false)
  const state = await runStageCommand(
    "revisit",
    ["design"],
    f.project,
    f.ctx,
    "en",
    () => {},
    () => f.implementations.quiesce(f.project),
  )
  expect(state.revisit?.policy).toBe("interrupt")
  expect(state.attempts.at(-1)?.status).toBe("interrupted")
  expect(await readFile(path.join(coordinator.cwd, "result.txt"), "utf8")).toBe("ready\n")
  expect(state.artifacts.some((entry) => entry.kind === "batch-result")).toBe(false)
  const before = f.commands.length
  new Implementations(f.api)
  expect(await new IterationStore(f.project).read()).toEqual(state)
  expect(f.commands).toHaveLength(before)
})

test("a separately approved next batch has a fresh coordinator and a non-cumulative uncommitted base", async () => {
  const f = await setup()
  const draft = f.drafts[0]!
  draft.spec.items.push({
    ...draft.spec.items[0]!,
    id: "S2",
    description: "Verify the established local result",
  })
  draft.batches.push({ id: "B2", itemIds: ["S2"], decisionIds: [], files: [] })
  await f.approve()
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const first = await result(f)
  const firstKey = f.specs.at(-1)!.key
  // Acceptance execution is next step; explicitly skip B1, do not fabricate a pass.
  f.answers.push(true)
  const approved = await runStageCommand(
    "skip",
    ["batch"],
    f.project,
    f.ctx,
    "en",
    () => {},
    () => f.implementations.quiesce(f.project),
  )
  expect(approved.approvedContext?.batchId).toBe("B2")
  expect(approved.batchResolutions?.[0]?.status).toBe("skipped")
  f.notifications.length = 0
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  const second = await result(f)
  expect(f.specs.at(-1)!.key).not.toBe(firstKey)
  expect(second.context.batchId).toBe("B2")
  expect(second.base).toBe(first.snapshot)
  expect(second.diffStat).toBe("")
  expect(await git(f.repo, "rev-list --count HEAD")).toBe("1")
})

test("Stop during summary publication retires finalization rather than proposing acceptance", async () => {
  const f = await setup()
  await f.approve()
  f.answers.push(true)
  const original = IterationStore.prototype.saveArtifact
  const publish = spyOn(IterationStore.prototype, "saveArtifact").mockImplementation(async function (
    this: IterationStore,
    revision,
    artifact,
  ) {
    const saved = await original.call(this, revision, artifact)
    if (artifact.kind === "stage-summary" && artifact.stage === "implement") {
      f.handles.at(-1)!.status = () => ({ state: "stopped", busy: false })
    }
    return saved
  })
  try {
    await f.implementations.run(f.project, f.ctx, "en", () => {})
    await f.settled()
    const state = await f.store.read()
    expect(state.status).toBe("interrupted")
    expect(state.pending).toBeUndefined()
    expect(state.attempts.at(-1)?.status).toBe("interrupted")
    expect(state.artifacts.some((entry) => entry.kind === "batch-result")).toBe(true)
    expect(await readFile(path.join(f.specs.at(-1)!.cwd, "result.txt"), "utf8")).toBe("ready\n")
  } finally {
    publish.mockRestore()
  }
})
