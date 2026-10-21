import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ShipOperation, ShipPlan } from "../src/ship.ts"
import { runShip } from "../src/ship-command.ts"
import { ShipStore } from "../src/ship-storage.ts"
import { projectLifecycle, readProject } from "../src/store.ts"
import { acceptanceFixture } from "./accept-fixture.ts"
import { git } from "./implement-fixture.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(600_000)
const fixtures: Awaited<ReturnType<typeof acceptanceFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.acceptances.quiesce(f.project)
    await f.implementations.quiesce(f.project)
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function completed(changelog = false) {
  const f = await acceptanceFixture()
  fixtures.push(f)
  if (changelog)
    await writeFile(path.join(f.specs.at(-1)!.cwd, "CHANGELOG.md"), "# Existing release history\n")
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  let state = await f.store.read()
  expect(state.attempts.at(-1)?.acceptance?.verdict, f.notifications.join("\n")).toBe("pass")
  state = await f.store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "complete-for-ship",
      from: "accept",
      to: null,
      kind: "complete",
      summaryId: state.summaryId!,
      suggestion: "Complete acceptance only",
      skippedStages: [],
      context: state.approvedContext,
    },
  })
  await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, state.pending!.id, "complete"),
  })
  const confirmations: string[] = []
  f.ctx.ui.input = async (title) => {
    if (title === "Ship summary and release notes") return "Local delivery of the accepted result"
    if (title.startsWith("Target checkout")) return f.repo
    if (title.startsWith("Exact reviewed"))
      return changelog ? '["result.txt", "CHANGELOG.md"]' : '["result.txt"]'
    if (title.startsWith("Candidate commit")) return "Ship accepted result"
    if (title.startsWith("Additional complete")) return "[]"
    throw new Error(`Unexpected input ${title}`)
  }
  f.ctx.ui.select = async (_title, options) => options[0]
  f.ctx.ui.confirm = async (title) => {
    confirmations.push(title)
    return title !== "Include a remote push"
  }
  const quiesce = async () => {
    await f.implementations.quiesce(f.project)
    await f.acceptances.quiesce(f.project)
  }
  return { ...f, confirmations, quiesce }
}
test("production ship command includes uncommitted accepted work, stores notes/preference/receipts and leaves iteration open", async () => {
  const f = await completed()
  const before = await git(f.repo, "rev-parse HEAD")
  await runShip(f.api, f.project, [], f.ctx, "en", () => {}, f.quiesce)
  const plan = await new ShipStore(f.project).latest()
  expect(plan?.status, plan?.error).toBe("shipped")
  expect(plan?.outcome).toBe("local-only")
  expect(plan?.contentAcceptance).toBe("verified-before-notes")
  expect(plan?.commit).not.toBe(before)
  expect(await git(f.repo, "show HEAD:result.txt")).toBe("ready")
  expect(plan?.results.map((check) => [check.phase, check.ok])).toEqual([
    ["source", true],
    ["integrated", true],
  ])
  expect(plan?.notes.location).toContain("iterations/1/artifacts/stage-summary-")
  expect(plan?.results[0]).toMatchObject({
    cwd: plan!.checkRoot,
    checkoutRoot: plan!.checkRoot,
    tree: plan!.source.tree,
  })
  expect(plan?.results[1]).toMatchObject({ cwd: plan!.target.root, tree: plan!.integratedTree })
  expect(plan!.checkRoot).not.toBe(plan!.source.root)
  expect(existsSync(plan!.checkRoot!)).toBe(false)
  expect(plan?.operations.map((op) => [op.kind, op.status])).toEqual([
    ["commit", "succeeded"],
    ["merge", "succeeded"],
  ])
  expect(plan?.approval?.sessionId).toBe("main-fixture")
  expect(f.confirmations).toContain("Confirm commit")
  expect(f.confirmations).toContain("Confirm merge")
  const current = await readProject(f.project.root)
  expect(projectLifecycle(current).iterations[1]).toMatchObject({ status: "open", ship: "shipped" })
  expect((await new ShipStore(current).preference(plan!.source.common))?.strategy).toBe("local-merge")
  expect(
    f.reviewCalls.every(
      ({ command }) => !/--force|--no-verify|--no-gpg-sign|core\.hooksPath|HUSKY=0/.test(command),
    ),
  ).toBe(true)
  const count = f.reviewCalls.length
  await runShip(f.api, current, ["status"], f.ctx, "en", () => {}, f.quiesce)
  expect(f.reviewCalls).toHaveLength(count)
  expect(f.prints.at(-1)).toContain("local-only")
})
test("stale session after plan approval starts no irreversible Git command", async () => {
  const f = await completed()
  let stale = false
  f.ctx.ui.confirm = async (title) => {
    if (title === "Approve exact ship plan and full checks") stale = true
    return title !== "Include a remote push"
  }
  await expect(
    runShip(
      f.api,
      f.project,
      [],
      f.ctx,
      "en",
      () => {
        if (stale) throw new Error("Main session changed")
      },
      f.quiesce,
    ),
  ).rejects.toThrow("Main session changed")
  expect(f.reviewCalls.some(({ command }) => /git commit|git merge /.test(command))).toBe(false)
  expect(await new ShipStore(f.project).latest()).toBeUndefined()
})
test.each(["branch", "head", "evidence"] as const)(
  "notes revalidate %s after confirmation and never write to changed authority",
  async (change) => {
    const f = await completed(true)
    const source = f.specs.at(-1)!.cwd
    const before = await readFile(path.join(source, "CHANGELOG.md"), "utf8")
    f.ctx.ui.confirm = async (title) => {
      if (title === "Append notes to existing changelog") {
        if (change === "branch") await git(source, "checkout -b unapproved-branch")
        if (change === "head") await git(source, 'commit --allow-empty -m "Explicit external movement"')
        if (change === "evidence") {
          const state = await f.store.read()
          await f.store.saveArtifact(state.revision, {
            kind: "stage-summary",
            stage: "accept",
            language: "en",
            summary: "Changed while notes dialog was open",
            outputs: [],
            suggestion: "Review again",
          })
        }
      }
      return title !== "Include a remote push"
    }
    await expect(runShip(f.api, f.project, [], f.ctx, "en", () => {}, f.quiesce)).rejects.toThrow(
      /identity|branch|HEAD|evidence/i,
    )
    expect(await readFile(path.join(source, "CHANGELOG.md"), "utf8")).toBe(before)
    if (change === "branch") expect(await git(source, "branch --show-current")).toBe("unapproved-branch")
    expect(f.reviewCalls.some(({ command }) => /cat .*amira-ship-notes|Copy-Item/.test(command))).toBe(false)
    expect(await new ShipStore(f.project).latest()).toBeUndefined()
  },
)

test("PR source check cannot use an excluded dirty dependency; no commit or publication occurs", async () => {
  const f = await completed()
  const source = f.specs.at(-1)!.cwd
  await writeFile(path.join(source, "unrelated.txt"), "excluded-dependency\n")
  const indexFile = path.join(await git(source, "rev-parse --absolute-git-dir"), "index")
  const beforeIndex = await readFile(indexFile)
  const beforeHead = await git(source, "rev-parse HEAD")
  const input = f.ctx.ui.input
  f.ctx.ui.input = (title, options) =>
    title === "Remote name"
      ? Promise.resolve("origin")
      : title.startsWith("GitHub repository")
        ? Promise.resolve("owner/repo")
        : title.startsWith("Additional complete")
          ? Promise.resolve('[{"id":"needs-excluded","command":"test -f unrelated.txt","cwd":"."}]')
          : input(title, options)
  f.ctx.ui.select = async (title, options) =>
    title === "Repository integration preference" ? options[1] : options[0]
  // No native Git hosting/network operation is ever permitted by this fixture.
  f.commandResult((command) =>
    command.includes("remote get-url")
      ? { content: [{ type: "text", text: "https://example.invalid/owner/repo" }], details: { exitCode: 0 } }
      : /git push|gh pr/.test(command)
        ? {
            content: [{ type: "text", text: "Unexpected outward operation denied by fake executor" }],
            isError: true,
            details: { exitCode: 1 },
          }
        : undefined,
  )
  await runShip(f.api, f.project, [], f.ctx, "en", () => {}, f.quiesce)
  const plan = await new ShipStore(f.project).latest()
  expect(plan?.preference.strategy).toBe("pr")
  expect(plan?.status).toBe("blocked")
  expect(plan?.results.at(-1)).toMatchObject({
    id: "needs-excluded",
    phase: "source",
    ok: false,
    tree: plan!.source.tree,
    cwd: plan!.checkRoot,
  })
  expect(plan?.operations).toEqual([])
  expect(f.reviewCalls.some(({ command }) => /git commit|git merge |git push|gh pr/.test(command))).toBe(
    false,
  )
  expect(await readFile(indexFile)).toEqual(beforeIndex)
  expect(await git(source, "rev-parse HEAD")).toBe(beforeHead)
  expect(await readFile(path.join(source, "unrelated.txt"), "utf8")).toBe("excluded-dependency\n")
  expect(existsSync(plan!.checkRoot!)).toBe(false)
})

test("full ship check failure records actual cwd/output and convention notes before any commit", async () => {
  const f = await completed(true)
  const original = f.ctx.ui.input
  f.ctx.ui.input = (title, options) =>
    title.startsWith("Additional complete")
      ? Promise.resolve('[{"id":"full-failure","command":"git show definitely-missing-ref","cwd":"."}]')
      : original(title, options)
  await runShip(f.api, f.project, [], f.ctx, "en", () => {}, f.quiesce)
  const plan = await new ShipStore(f.project).latest()
  expect(plan?.status).toBe("blocked")
  expect(plan?.results.at(-1)?.ok).toBe(false)
  expect(plan?.results.at(-1)?.cwd).toBe(path.resolve(plan!.checkRoot!))
  expect(plan?.results.at(-1)?.tree).toBe(plan!.source.tree)
  expect(existsSync(plan!.checkRoot!)).toBe(false)
  expect(plan?.results.at(-1)?.output).toContain("definitely-missing-ref")
  expect(plan?.operations).toEqual([])
  expect(plan?.notes.location).toBe("CHANGELOG.md")
  expect(await readFile(path.join(plan!.source.root, "CHANGELOG.md"), "utf8")).toContain(
    "Existing release history\n\nLocal delivery",
  )
  expect(plan?.files).toContain("CHANGELOG.md")
})

async function outwardFailure(strategy: "local-merge" | "pr", failure: "preflight" | "after-dispatch") {
  const f = await completed()
  const kind = strategy === "pr" ? "pr" : "push"
  const input = f.ctx.ui.input
  f.ctx.ui.input = (title, options) =>
    title === "Remote name"
      ? Promise.resolve("origin")
      : title.startsWith("GitHub repository")
        ? Promise.resolve("owner/repo")
        : input(title, options)
  f.ctx.ui.select = async (title, options) =>
    title === "Repository integration preference" && strategy === "pr" ? options[1] : options[0]
  let changed = false
  let missing = false
  let pushed = ""
  let requested: ShipOperation | undefined
  const effects: string[] = []
  const observations: string[] = []
  const document = path.join(f.project.root, ".amira", "project", "ship.json")
  f.ctx.ui.confirm = async (title) => {
    f.confirmations.push(title)
    if (title === `Confirm ${kind}` && failure === "preflight") changed = true
    return true
  }
  const output = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: { exitCode: 0 },
    isError: false,
  })
  // Every outward executor is fake. Only temporary-repository Git operations fall through.
  f.commandResult((command) => {
    if (command.includes("git remote get-url")) {
      if (!requested && existsSync(document)) {
        const stored: { plans: ShipPlan[] } = JSON.parse(readFileSync(document, "utf8"))
        const operation = stored.plans.at(-1)?.operations.find((entry) => entry.kind === kind)
        if (operation?.status === "requested") requested = structuredClone(operation)
      }
      return output(changed ? "fake://moved" : "fake://approved")
    }
    if (command.includes("git push --")) {
      effects.push("push")
      if (kind === "push" && failure === "after-dispatch") return output("ambiguous push result")
      pushed = command.match(/([a-f0-9]{40,64}):refs\/heads\//)![1]!
      return output("fake preparatory source push accepted")
    }
    if (command.includes("git ls-remote")) {
      observations.push("push")
      const branch = command.match(/refs\/heads\/([^'"\s]+)/)![1]!
      return output(missing || !pushed ? "" : `${pushed}\trefs/heads/${branch}`)
    }
    if (command.includes("gh pr create")) {
      effects.push("pr")
      return output("ambiguous PR create result")
    }
    if (command.includes("gh pr list")) {
      observations.push("pr")
      return output("[]")
    }
    if (/\b(?:git (?:push|fetch|pull|ls-remote)|gh)\b/.test(command))
      throw new Error(`Unexpected outward command denied by fake executor: ${command}`)
    return undefined
  })
  return {
    ...f,
    kind,
    effects,
    observations,
    requested: () => requested,
    restore: () => {
      changed = false
      // Neither a later absent ref nor an absent PR proves whether an earlier effect ran.
      missing = true
    },
    reload: async () => new ShipStore(await readProject(f.project.root)).latest(),
  }
}

test.each(["local-merge", "pr"] as const)(
  "%s outward preflight failure is durable and permits only explicit abandonment",
  async (strategy) => {
    const f = await outwardFailure(strategy, "preflight")
    await runShip(f.api, f.project, [], f.ctx, "en", () => {}, f.quiesce)
    let plan = (await f.reload())!
    const requested = f.requested()!
    expect(requested).toMatchObject({
      kind: f.kind,
      status: "requested",
      approval: { sessionId: "main-fixture" },
    })
    expect(JSON.parse(requested.inputs).remote.url).toBe("fake://approved")
    const failed = plan.operations.find((operation) => operation.kind === f.kind)!
    expect(plan.status).toBe("blocked")
    expect(plan.outcome).toBeUndefined()
    expect(plan.completion).toBeUndefined()
    expect(failed).toMatchObject({
      id: requested.id,
      inputs: requested.inputs,
      approval: requested.approval,
      status: "failed",
      effectNotStarted: true,
    })
    expect(failed.result).toMatch(/preflight/i)
    expect(failed.result).toContain("Remote URL changed")
    expect(f.effects).toEqual(strategy === "pr" ? ["push"] : [])
    const preparatory = plan.operations.find((operation) => operation.kind === "push")
    if (strategy === "pr") expect(preparatory).toMatchObject({ status: "succeeded", result: plan.commit })

    f.restore()
    const observed = [...f.observations]
    await runShip(f.api, f.project, ["reconcile"], f.ctx, "en", () => {}, f.quiesce)
    plan = (await f.reload())!
    expect(plan.status).toBe("blocked")
    expect(plan.operations.find((operation) => operation.kind === f.kind)).toEqual(failed)
    expect(plan.error).toMatch(/preflight/i)
    expect(f.observations).toEqual(observed)
    expect(f.effects).toEqual(strategy === "pr" ? ["push"] : [])
    const calls = f.reviewCalls.length
    await runShip(f.api, f.project, ["status"], f.ctx, "en", () => {}, f.quiesce)
    expect(f.reviewCalls).toHaveLength(calls)
    expect(f.prints.at(-1)).toContain("Ship: blocked")
    expect(plan.outcome).toBeUndefined()
    expect(plan.completion).toBeUndefined()

    await runShip(
      f.api,
      f.project,
      [strategy === "pr" ? "skip" : "local-only"],
      f.ctx,
      "en",
      () => {},
      f.quiesce,
    )
    plan = (await f.reload())!
    expect(plan.status).toBe(strategy === "pr" ? "skipped" : "shipped")
    expect(plan.outcome).toBe(strategy === "pr" ? "ship-skipped" : "local-only")
    expect(plan.completion?.choice).toBe(plan.outcome)
    expect(plan.operations.find((operation) => operation.kind === f.kind)).toEqual(failed)
    expect(f.effects).toEqual(strategy === "pr" ? ["push"] : [])
    if (strategy === "pr") {
      expect(plan.operations.find((operation) => operation.kind === "push")).toEqual(preparatory)
      expect(plan.skipped).not.toContain("push")
      expect(plan.skipped).toContain("ship")
      expect(plan.pr?.url).toBeUndefined()
    } else {
      expect(plan.skipped).toContain("push")
      expect(await git(f.repo, "rev-parse HEAD")).toBe(plan.integrated!)
    }
    const current = await readProject(f.project.root)
    expect(projectLifecycle(current).iterations[1]).toMatchObject({
      status: "open",
      ship: strategy === "pr" ? "skipped" : "shipped",
    })
  },
)

test.each(["local-merge", "pr"] as const)(
  "%s ambiguous outward result after dispatch remains uncertain despite later absence",
  async (strategy) => {
    const f = await outwardFailure(strategy, "after-dispatch")
    await runShip(f.api, f.project, [], f.ctx, "en", () => {}, f.quiesce)
    let plan = (await f.reload())!
    const uncertain = plan.operations.find((operation) => operation.kind === f.kind)!
    expect(plan.status).toBe("blocked")
    expect(uncertain).toMatchObject({
      status: "uncertain",
      inputs: f.requested()!.inputs,
      approval: f.requested()!.approval,
    })
    expect(uncertain).not.toMatchObject({ effectNotStarted: true })
    expect(uncertain.result).toMatch(/Push returned|PR create returned/)
    const effects = strategy === "pr" ? ["push", "pr"] : ["push"]
    expect(f.effects).toEqual(effects)

    f.restore()
    const observations = f.observations.length
    await runShip(f.api, f.project, ["reconcile"], f.ctx, "en", () => {}, f.quiesce)
    plan = (await f.reload())!
    expect(plan.status).toBe("blocked")
    expect(plan.error).toContain("outcome is unavailable")
    expect(plan.operations.find((operation) => operation.kind === f.kind)).toEqual(uncertain)
    expect(f.observations.slice(observations)).toEqual([f.kind])
    expect(plan.outcome).toBeUndefined()
    expect(plan.completion).toBeUndefined()
    if (strategy === "local-merge")
      await expect(
        runShip(f.api, f.project, ["local-only"], f.ctx, "en", () => {}, f.quiesce),
      ).rejects.toThrow("Reconcile uncertain")
    await expect(runShip(f.api, f.project, ["skip"], f.ctx, "en", () => {}, f.quiesce)).rejects.toThrow(
      "Reconcile uncertain",
    )
    expect(f.effects).toEqual(effects)
    expect((await f.reload())?.operations.find((operation) => operation.kind === f.kind)).toEqual(uncertain)
  },
)
