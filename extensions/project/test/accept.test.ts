import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ACCEPT_RECORD, checkAcceptanceFreshness } from "../src/accept.ts"
import { DecisionStore } from "../src/store.ts"
import { acceptanceFixture } from "./accept-fixture.ts"
import { git } from "./implement-fixture.ts"

setDefaultTimeout(180_000)
const fixtures: Awaited<ReturnType<typeof acceptanceFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.acceptances.quiesce(f.project)
    await f.implementations.quiesce(f.project)
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function setup(options?: Parameters<typeof acceptanceFixture>[0]) {
  const f = await acceptanceFixture(options)
  fixtures.push(f)
  return f
}

test("acceptance uses a fresh read-only reviewer and independently reruns exact checks", async () => {
  const f = await setup()
  const checkout = f.specs.at(-1)!.cwd
  const removed = path.join(checkout, "removed-directory")
  await mkdir(removed)
  await writeFile(path.join(removed, "tracked.txt"), "removed input\n")
  await git(checkout, "add -- removed-directory/tracked.txt")
  await rm(removed, { recursive: true })
  // More listing/patch data than a host tool output preview can safely carry.
  await Promise.all(
    Array.from({ length: 180 }, (_, i) =>
      writeFile(path.join(checkout, `input-${i}-${"x".repeat(100)}.txt`), "ready\n"),
    ),
  )
  await writeFile(path.join(checkout, "result.txt"), `ready\n${"x".repeat(50_000)}`)
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.outcome).toBe("pass")
  expect(result.reviewerModel).toBe("mock/reviewer")
  expect(result.implementerModels).toEqual(["mock/actual-implementer"])
  expect(result.sameModelFallback).toBe(false)
  expect(result.items).toEqual([
    {
      itemId: "S1",
      status: "pass",
      evidence: ["result.txt:1 contains ready"],
      reason: "Observed required output",
    },
  ])
  expect(result.checks).toHaveLength(1)
  expect(result.checks[0]).toMatchObject({
    checkId: "C1",
    command: "git --version",
    exitCode: 0,
    status: "passed",
  })
  expect(Date.parse(result.checks[0]!.finishedAt)).toBeGreaterThanOrEqual(
    Date.parse(result.checks[0]!.startedAt),
  )
  const spec = f.reviewSpecs[0]!
  expect(spec.key).toBe(`${f.project.marker.id}/iteration/1/batch/B1/accept/${result.attemptId}`)
  expect(spec.cwd).toBe(f.specs.at(-1)!.cwd)
  expect(spec.model).toBe("mock/reviewer")
  expect(spec.writeRoots).toEqual([])
  expect(spec.callableTools).toEqual(["read", "grep", "glob", "bash", ACCEPT_RECORD])
  expect(f.seeds[0]).toContain("result.txt")
  expect(f.seeds[0]).toContain("git --version")
  expect(f.seeds[0]).not.toContain("Start approved batch")
  expect(f.reviewCalls.some((call) => call.key === spec.key && call.command.endsWith("git --version"))).toBe(
    true,
  )
  expect((await f.store.read()).attempts.at(-1)?.acceptance?.verdict).toBe("pass")
  expect(await checkAcceptanceFreshness(f.api, f.project, f.ctx)).toEqual({ stale: false, reason: null })
  await writeFile(path.join(spec.cwd, "result.txt"), `ready\n${"x".repeat(49_999)}y`)
  expect((await checkAcceptanceFreshness(f.api, f.project, f.ctx)).stale).toBe(true)
  await writeFile(path.join(spec.cwd, "result.txt"), `ready\n${"x".repeat(50_000)}`)
  await new DecisionStore(f.project).record(
    [
      {
        question: "Which result?",
        header: "Result",
        options: [
          { label: "Original", description: "Original requirement" },
          { label: "Revised", description: "Updated requirement" },
        ],
      },
    ],
    [{ selected: ["Revised"] }],
    { sessionId: "main-fixture", askId: "acceptance-staleness", language: "en" },
  )
  expect((await checkAcceptanceFreshness(f.api, f.project, f.ctx)).stale).toBe(true)
  f.commandResult(() => ({ content: [{ type: "text", text: "Freshness probe denied" }], isError: true }))
  const denied = await checkAcceptanceFreshness(f.api, f.project, f.ctx)
  expect(denied.stale).toBe(true)
  expect(denied.reason).toContain("Freshness probe denied")
  expect(f.seeds).toHaveLength(1)
  expect(f.reviewReleases).toHaveLength(f.reviewHandles.length)
  for (const release of f.reviewReleases) expect(release).toHaveBeenCalledTimes(1)
})

test("plan-mode Git denial leaves a durable blocked acceptance without a reviewer turn", async () => {
  const f = await setup()
  f.commandResult(() => ({
    content: [{ type: "text", text: "Plan mode denies shell execution" }],
    isError: true,
  }))
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.outcome).toBe("blocked")
  expect(result.items[0]!.status).toBe("blocked")
  expect(result.items[0]!.reason).toContain("Plan mode denies")
  expect(result.checks[0]).toMatchObject({ status: "blocked", exitCode: null })
  expect(f.reviewCalls.some((call) => call.command.endsWith("git --version"))).toBe(false)
  expect(f.seeds).toEqual([])
  expect((await f.store.read()).attempts.at(-1)?.acceptance?.verdict).toBe("blocked")
})

test("a denied check cannot become a pass from a reviewer claim", async () => {
  const f = await setup()
  f.commandResult((command) =>
    command.endsWith("git --version")
      ? { content: [{ type: "text", text: "Permission denied" }], isError: true }
      : undefined,
  )
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.outcome).toBe("blocked")
  expect(result.items[0]!.status).toBe("blocked")
  expect(result.checks[0]).toMatchObject({ status: "blocked", exitCode: null, output: "Permission denied" })
})

test("code changes during independent review block the original snapshot", async () => {
  const f = await setup()
  f.beforeReport(async () => {
    await writeFile(path.join(f.reviewSpecs[0]!.cwd, "result.txt"), "changed during review\n")
  })
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.outcome).toBe("blocked")
  expect(result.items[0]!.reason).toContain("changed during review")
  expect(result.checks[0]!.status).toBe("passed")
})

test("configured reviewer must differ from every contributing model; fallback is disclosed", async () => {
  const f = await setup({ contributors: ["mock/second-implementer"] })
  for (const model of ["mock/actual-implementer", "mock/second-implementer"]) {
    await expect(f.acceptances.run(f.project, f.ctx, "en", () => {}, model)).rejects.toThrow(
      "ALL implementer models",
    )
  }
  await expect(f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/unknown")).rejects.toThrow(
    "Unknown configured reviewer",
  )
  expect(f.reviewSpecs).toEqual([])
  expect((await f.store.read()).phase).toBe("confirmed")
  await f.acceptances.run(f.project, f.ctx, "en", () => {})
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.sameModelFallback).toBe(true)
  expect(result.implementerModels).toEqual(["mock/actual-implementer", "mock/second-implementer"])
  expect(result.reviewerModel).toBe("mock/second-implementer")
  expect(f.reviewSpecs[0]!.key).not.toBe(f.specs.at(-1)!.key)
  expect(f.seeds[0]).toContain("same-model fresh-session fallback")
})

test("a failed exact check maps failure back to the approved item", async () => {
  const f = await setup()
  f.commandResult((command) =>
    command.endsWith("git --version")
      ? {
          content: [{ type: "text", text: "Expected ready output was missing" }],
          isError: true,
          details: { exitCode: 1 },
        }
      : undefined,
  )
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.outcome).toBe("fail")
  expect(result.items[0]!.status).toBe("fail")
  expect(result.items[0]!.reason).toContain("C1: failed")
  expect(result.checks[0]).toMatchObject({ status: "failed", exitCode: 1 })
  expect((await f.store.read()).attempts.at(-1)?.acceptance?.failingItemIds).toEqual(["S1"])
})

test.each([
  ["missing", undefined],
  [
    "unknown item",
    { items: [{ itemId: "S999", status: "pass", evidence: ["claim"], reason: "Wrong item" }] },
  ],
  [
    "empty pass evidence",
    { items: [{ itemId: "S1", status: "pass", evidence: [], reason: "Claim without evidence" }] },
  ],
  [
    "duplicate",
    {
      items: [
        { itemId: "S1", status: "pass", evidence: ["claim"], reason: "First" },
        { itemId: "S1", status: "pass", evidence: ["claim"], reason: "Duplicate" },
      ],
    },
  ],
])("%s reviewer evidence cannot pass acceptance", async (_name, report) => {
  const f = await setup()
  f.report(report)
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const result = await f.verdict()
  expect(result.outcome).toBe("blocked")
  expect(result.items[0]!.status).toBe("blocked")
  expect(result.checks[0]!.status).toBe("passed")
  if (report !== undefined) expect(f.records[0]!.isError).toBe(true)
})

test("interrupted approval rejects stale reviewer recording and cannot be replayed", async () => {
  const f = await setup()
  f.beforeReport(async () => {
    const state = await f.store.read()
    await f.store.dispatch(state.revision, {
      type: "interrupt-work",
      expectedRevision: state.revision,
      attemptId: state.activeAttemptId!,
      changes: [],
    })
  })
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  expect(f.records[0]!.isError).toBe(true)
  expect((await f.store.read()).artifacts.some((entry) => entry.kind === "acceptance")).toBe(false)
  await expect(f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")).rejects.toThrow(
    "Interrupted reviews are never replayed",
  )
  expect(f.reviewSpecs).toHaveLength(1)
})
