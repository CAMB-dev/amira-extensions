import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CorrectionInputs } from "../src/correction.ts"
import { collectCorrectionChanges } from "../src/correction-checkout.ts"
import { acceptanceFixture } from "./accept-fixture.ts"
import { git } from "./implement-fixture.ts"

setDefaultTimeout(180_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

test("correction captures partial edits without a batch result and preserves branch and written work; denial fails closed", async () => {
  const f = await acceptanceFixture()
  homes.push(f.home)
  const state = await f.store.read()
  const ref = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!
  const worktree = await f.store.readArtifact(ref)
  if (worktree.kind !== "iteration-worktree") throw new Error("Expected checkout")
  const spec = await f.store.readArtifact(state.artifacts.findLast((entry) => entry.kind === "spec")!)
  if (spec.kind !== "spec") throw new Error("Expected spec")
  const branch = await git(worktree.root, "symbolic-ref --short HEAD")
  const head = await git(worktree.root, "rev-parse HEAD")
  await writeFile(path.join(worktree.cwd, "partial-edit.txt"), "unfinished correction input\n")
  const context: CorrectionInputs = {
    revisitReceiptId: "visit",
    previousSpec: spec,
    decisionLinks: [],
    affectedSpecItemIds: ["S1"],
    changes: [],
    worktree,
    implemented: [],
    accepted: [],
  }
  await collectCorrectionChanges(f.api, f.project, f.ctx, context, () => {})
  expect(context.implemented).toEqual([
    { itemIds: ["S1"], changedFiles: ["partial-edit.txt", "result.txt"], pointer: worktree.root },
  ])
  expect(await readFile(path.join(worktree.cwd, "result.txt"), "utf8")).toBe("ready\n")
  expect(await readFile(path.join(worktree.cwd, "partial-edit.txt"), "utf8")).toBe(
    "unfinished correction input\n",
  )
  expect(await git(worktree.root, "symbolic-ref --short HEAD")).toBe(branch)
  expect(await git(worktree.root, "rev-parse HEAD")).toBe(head)
  expect(f.seeds).toEqual([])
  expect(f.reviewCalls.some((call) => call.command.includes("git ls-files -z --others"))).toBe(true)
  f.commandResult((command) =>
    command.includes("git diff --name-only")
      ? { content: [{ type: "text", text: "Approval denied" }], isError: true }
      : undefined,
  )
  await expect(collectCorrectionChanges(f.api, f.project, f.ctx, context, () => {})).rejects.toThrow(
    "mapping blocked",
  )
  expect(context.implemented).toHaveLength(1)
  f.commandResult((command) =>
    command.includes("git diff --name-only")
      ? { content: [{ type: "text", text: "truncated-file-list" }], details: { exitCode: 0 } }
      : undefined,
  )
  await expect(collectCorrectionChanges(f.api, f.project, f.ctx, context, () => {})).rejects.toThrow(
    "incomplete Git file list",
  )
  expect(context.implemented).toHaveLength(1)
})
