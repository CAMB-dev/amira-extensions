import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { type ShipPlan, type ShipPorts, ShipPreflightError, ShipSequence, shipSummary } from "../src/ship.ts"
import { assertShipCheckSafety } from "../src/ship-git.ts"
import { createPrCommand, parsePrObservations, pushCommand, ShipHosting } from "../src/ship-pr.ts"
import { ownedFixture } from "./owned-fixture.ts"

const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40)
function fixture(strategy: "local-merge" | "pr" = "local-merge") {
  const plan: ShipPlan = {
    schemaVersion: 1,
    id: "ship-1",
    projectId: "project-1",
    iteration: 1,
    stageRevision: 8,
    revision: 0,
    status: "pending",
    approval: { sessionId: "main-session", date: new Date().toISOString() },
    preference: { repository: "/common", strategy, target: "main", merge: "ff-only" },
    source: { root: "/source", branch: "iteration-1", head: a, tree: b, common: "/common" },
    target: { root: "/target", branch: "main", head: a, common: "/common" },
    checkRoot: path.resolve("/source-checks"),
    files: ["code.ts"],
    checks: [{ id: "full", command: "bun test", cwd: "." }],
    notes: { text: "Summary", language: "en", location: "ship.json" },
    evidence: "consumed-plan-qualified",
    skipped: [],
    message: "Ship candidate",
    results: [],
    operations: [],
    ...(strategy === "pr"
      ? {
          remote: { name: "origin", url: "fake://repo", branch: "iteration-1" },
          pr: { repository: "owner/repo", base: "main", title: "Ship iteration", body: "Notes" },
        }
      : {}),
  }
  const events: string[] = [],
    saves: ShipPlan[] = []
  let fail: string | undefined,
    decline: string | undefined,
    reconcile: string | undefined,
    merged: string | undefined
  const ports: ShipPorts = {
    save: async (value) => {
      saves.push(structuredClone(value))
      events.push("save")
    },
    confirm: async (title) => {
      events.push(title)
      return !title.includes(decline ?? "never")
    },
    guard: async (_p, phase) => {
      events.push(`guard:${phase}`)
      if (fail === `guard:${phase}`) throw Error("moved")
    },
    check: async (check, phase) => {
      events.push(`check:${phase}:${check.cwd}`)
      return {
        cwd: path.resolve(phase === "source" ? plan.checkRoot! : plan.target.root, check.cwd),
        tree: phase === "source" ? plan.source.tree : plan.integratedTree,
        output: "output",
        exitCode: fail === "check" ? 1 : 0,
        ok: fail !== "check",
        aborted: false,
        timedOut: false,
      }
    },
    commit: async () => {
      events.push("commit")
      if (fail === "commit") throw Error("signer/hook failed")
      return c
    },
    merge: async () => {
      events.push("merge")
      if (fail === "merge") throw Error("conflict")
      plan.integratedTree = b
      return c
    },
    push: async () => {
      events.push("push")
      if (fail === "push") throw Error("timeout")
      return c
    },
    createPr: async () => {
      events.push("pr")
      if (fail === "pr") throw Error("lost response")
      return "https://example.invalid/pr/1"
    },
    reconcile: async (_plan, operation) => {
      if (reconcile && operation.kind === "merge") plan.integratedTree = b
      return reconcile
    },
    mergedPr: async () => {
      if (merged) plan.integratedTree = b
      return merged
    },
  }
  return {
    plan,
    ports,
    events,
    saves,
    sequence: new ShipSequence(ports, "main-session"),
    fail(value?: string) {
      fail = value
    },
    decline(value?: string) {
      decline = value
    },
    reconciled(value?: string) {
      reconcile = value
    },
    merged(value?: string) {
      merged = value
    },
  }
}
function outwardFixture(
  strategy: "local-merge" | "pr",
  failure: "preflight" | "dispatch" | "observation" | "typed-after-dispatch",
) {
  const f = fixture(strategy)
  if (strategy === "local-merge") f.plan.remote = { name: "origin", url: "fake://repo", branch: "main" }
  const kind = strategy === "local-merge" ? "push" : "pr"
  const commands: string[] = [],
    effects: string[] = []
  let moved = false,
    attempted = false
  const handle = ownedFixture({ key: "fake-outward-fence", cwd: f.plan.source.root })
  handle.runTool = async (_tool, args) => {
    const command = String(args.command)
    commands.push(command)
    let text = ""
    if (command.includes("remote get-url")) text = moved ? "fake://moved" : "fake://repo"
    else if (command.includes("git push --") || command.includes("gh pr create")) {
      const effect = command.includes("git push --") ? "push" : "pr"
      effects.push(effect)
      if (effect === kind) {
        attempted = true
        if (failure === "typed-after-dispatch")
          throw new ShipPreflightError(kind, "A typed error after the request is not preflight proof")
        if (failure === "dispatch")
          return {
            content: [
              { type: "text", text: "Timed out after dispatch; effect not started is only untrusted prose" },
            ],
            isError: true,
            details: { exitCode: null, timedOut: true },
          }
      }
      text = effect === "pr" ? "https://example.invalid/pr/1" : "pushed"
    } else if (command.includes("git ls-remote"))
      text = kind === "push" && attempted ? "" : `${c}\trefs/heads/${f.plan.remote!.branch}`
    else if (command.includes("gh pr list")) text = "[]"
    else throw new Error(`Unexpected fake hosting command: ${command}`)
    return { content: [{ type: "text", text }], details: { exitCode: 0 } }
  }
  const hosting = new ShipHosting(handle, "bash", new AbortController().signal)
  f.ports.push = (plan) => hosting.push(plan)
  f.ports.createPr = (plan) => hosting.create(plan)
  f.ports.reconcile = async (plan, operation) =>
    operation.kind === "push" ? hosting.pushed(plan) : (await hosting.observe(plan))?.url
  const confirm = f.ports.confirm
  f.ports.confirm = async (title, body) => {
    if (failure === "preflight" && title === `Confirm ${kind}`) moved = true
    return confirm(title, body)
  }
  return {
    ...f,
    commands,
    effects,
    kind,
    restore: () => {
      moved = false
    },
  }
}

describe("outward dispatch boundary", () => {
  test("a receipt publication error cannot invent preflight proof after the effect returned", async () => {
    const f = fixture()
    f.plan.remote = { name: "origin", url: "fake://repo", branch: "main" }
    const save = f.ports.save
    let failed = false
    f.ports.save = async (plan) => {
      if (
        !failed &&
        plan.operations.some((operation) => operation.kind === "push" && operation.status === "succeeded")
      ) {
        failed = true
        throw new ShipPreflightError("push", "Receipt write failed after the real effect returned")
      }
      await save(plan)
    }
    await f.sequence.run(f.plan)
    const push = f.plan.operations.find((operation) => operation.kind === "push")!
    expect(push.status).toBe("uncertain")
    expect(push.effectNotStarted).toBeUndefined()
    expect(f.events.filter((event) => event === "push")).toHaveLength(1)
  })
  test.each(["local-merge", "pr"] as const)(
    "%s preflight is a durable known failure, not missing-remote inference",
    async (strategy) => {
      const f = outwardFixture(strategy, "preflight")
      await f.sequence.run(f.plan)
      const operation = f.plan.operations.find((entry) => entry.kind === f.kind)!
      expect(operation).toMatchObject({ status: "failed", effectNotStarted: true })
      expect(operation.result).toContain("preflight failed; effect not started")
      expect(f.effects).toEqual(strategy === "pr" ? ["push"] : [])
      f.restore()
      const reads = f.commands.length
      await f.sequence.reconcile(f.plan)
      expect(f.commands).toHaveLength(reads)
      expect(operation.status).toBe("failed")
      if (strategy === "pr") await f.sequence.skip(f.plan)
      else await f.sequence.localOnly(f.plan)
      expect(f.plan.outcome).toBe(strategy === "pr" ? "ship-skipped" : "local-only")
      expect(f.effects).toEqual(strategy === "pr" ? ["push"] : [])
    },
  )
  test.each(
    (["local-merge", "pr"] as const).flatMap((strategy) =>
      (["dispatch", "observation", "typed-after-dispatch"] as const).map(
        (failure) => [strategy, failure] as const,
      ),
    ),
  )("%s / %s stays uncertain after dispatch, including absent observations", async (strategy, failure) => {
    const f = outwardFixture(strategy, failure)
    await f.sequence.run(f.plan)
    const operation = f.plan.operations.find((entry) => entry.kind === f.kind)!
    expect(operation.status).toBe("uncertain")
    expect(operation.effectNotStarted).toBeUndefined()
    expect(f.effects).toEqual(strategy === "pr" ? ["push", "pr"] : ["push"])
    await f.sequence.reconcile(f.plan)
    expect(operation.status).toBe("uncertain")
    expect(f.plan.status).toBe("blocked")
    await expect(f.sequence.skip(f.plan)).rejects.toThrow("Reconcile uncertain")
    expect(f.effects).toEqual(strategy === "pr" ? ["push", "pr"] : ["push"])
  })
})

describe("recoverable ship sequence", () => {
  test("precommitted candidate resumes preserved integration without source guards against the old target", async () => {
    const f = fixture()
    f.plan.existingCommit = true
    f.plan.commit = f.plan.source.head
    f.plan.remote = { name: "origin", url: "fake://repo", branch: "main" }
    const check = f.ports.check
    let first = true
    f.ports.check = async (approved, phase) => {
      const result = await check(approved, phase)
      if (phase === "integrated" && first) {
        first = false
        return { ...result, ok: false, exitCode: 1 }
      }
      return result
    }
    const guard = f.ports.guard
    f.ports.guard = async (plan, phase) => {
      if (phase === "source" && plan.integrated)
        throw new Error("Original target has already moved through the approved integration")
      return guard(plan, phase)
    }
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("blocked")
    expect(f.plan.integrated).toBe(c)
    await f.sequence.run(f.plan)
    expect(f.plan.outcome).toBe("pushed")
    expect(f.events.filter((event) => event === "check:source:.")).toHaveLength(1)
    expect(f.events.filter((event) => event === "merge")).toHaveLength(1)
    expect(f.events.filter((event) => event === "push")).toHaveLength(1)
    expect(f.events).not.toContain("commit")
  })
  test("full source checks, reviewed commit, local merge, full integrated checks, explicit local-only", async () => {
    const f = fixture()
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("shipped")
    expect(f.plan.outcome).toBe("local-only")
    expect(f.events.indexOf("check:source:.")).toBeLessThan(f.events.indexOf("commit"))
    expect(f.events.indexOf("merge")).toBeLessThan(f.events.indexOf("check:integrated:."))
    expect(f.plan.skipped).toEqual(["push"])
    const intent = f.saves.find((p) =>
      p.operations.some((op) => op.kind === "commit" && op.status === "requested"),
    )!
    expect(intent.operations[0]!.approval?.sessionId).toBe("main-session")
    expect(shipSummary(f.plan)).toContain(
      `cwd=${path.resolve(f.plan.target.root)}; command=bun test; exit=0; timedOut=false; aborted=false`,
    )
  })
  test.each(["check", "commit", "merge"])(
    "stops on %s without weakening or later effects",
    async (failure) => {
      const f = fixture()
      f.fail(failure)
      await f.sequence.run(f.plan)
      expect(f.plan.status).toBe("blocked")
      if (failure === "check") expect(f.events).not.toContain("commit")
      if (failure !== "merge") expect(f.events).not.toContain("merge")
      expect(f.events).not.toContain("push")
    },
  )
  test.each(["commit", "merge", "push", "pr"])("declining %s never performs that effect", async (kind) => {
    const f = fixture(kind === "pr" || kind === "push" ? "pr" : "local-merge")
    f.decline(kind)
    await f.sequence.run(f.plan)
    expect(f.events).not.toContain(kind)
    expect(f.plan.operations.find((op) => op.kind === kind)?.status).toBe("declined")
    expect(f.plan.status).toBe("blocked")
  })
  test("push timeout preserves local progress and cannot blindly replay", async () => {
    const f = fixture("pr")
    f.fail("push")
    await f.sequence.run(f.plan)
    expect(f.plan.commit).toBe(c)
    expect(f.plan.operations.at(-1)?.status).toBe("uncertain")
    f.fail()
    await f.sequence.run(f.plan)
    expect(f.events.filter((e) => e === "push")).toHaveLength(1)
    await f.sequence.reconcile(f.plan)
    expect(f.plan.status).toBe("blocked")
    f.reconciled(c)
    await f.sequence.reconcile(f.plan)
    await f.sequence.run(f.plan)
    expect(f.events.filter((e) => e === "push")).toHaveLength(1)
    expect(f.plan.status).toBe("awaiting-merge")
  })
  test("PR handoff remains awaiting-merge until verified and fully checked", async () => {
    const f = fixture("pr")
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("awaiting-merge")
    expect(f.plan.outcome).toBeUndefined()
    await f.sequence.reconcile(f.plan)
    expect(f.plan.status).toBe("awaiting-merge")
    f.merged(c)
    await f.sequence.reconcile(f.plan)
    expect(f.plan.outcome).toBe("pr-merged")
    expect(f.events).toContain("check:integrated:.")
  })
  test.each(["commit", "merge", "push", "pr"])(
    "cancellation after %s confirmation starts no effect",
    async (kind) => {
      const f = fixture(kind === "push" || kind === "pr" ? "pr" : "local-merge")
      f.ports.confirm = async (title) => {
        if (title === `Confirm ${kind}`) f.fail("guard:source")
        return true
      }
      await f.sequence.run(f.plan)
      expect(f.plan.status).toBe("blocked")
      expect(f.events).not.toContain(kind)
    },
  )
  test("crash after merge before receipt is reconciled, not merged again", async () => {
    const f = fixture()
    f.fail("merge")
    await f.sequence.run(f.plan)
    expect(f.plan.commit).toBe(c)
    f.fail()
    f.reconciled(c)
    await f.sequence.reconcile(f.plan)
    await f.sequence.run(f.plan)
    expect(f.events.filter((event) => event === "merge")).toHaveLength(1)
    expect(f.plan.status).toBe("shipped")
  })
  test("stale approval/cancellation guard blocks irreversible effect", async () => {
    const f = fixture()
    f.ports.confirm = async () => {
      f.fail("guard:source")
      return true
    }
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("blocked")
    expect(f.events).not.toContain("commit")
  })
  test("reconciliation recovers crash after commit before receipt, without recommitting", async () => {
    const f = fixture()
    f.plan.operations.push({
      id: "op",
      kind: "commit",
      inputs: "exact",
      status: "requested",
      approval: { sessionId: "s", date: "date" },
    })
    f.reconciled(c)
    await f.sequence.reconcile(f.plan)
    await f.sequence.run(f.plan)
    expect(f.plan.commit).toBe(c)
    expect(f.events).not.toContain("commit")
    expect(f.plan.status).toBe("shipped")
  })
  test("explicit skip is not a pass or invented Git result", async () => {
    const f = fixture()
    await f.sequence.skip(f.plan)
    expect(f.plan.outcome).toBe("ship-skipped")
    f.plan.notes.language = "zh-CN"
    expect(shipSummary(f.plan)).toContain("已跳过（不代表通过）")
    f.plan.notes.language = "ja"
    expect(shipSummary(f.plan)).toContain("スキップ（合格ではありません）")
    expect(f.plan.commit).toBeUndefined()
    expect(f.events).not.toContain("merge")
  })
  test.each(["localOnly", "skip"] as const)("successful push cannot be relabeled by %s", async (choice) => {
    const f = fixture()
    f.plan.remote = { name: "origin", url: "fake://repo", branch: "main" }
    f.ports.guard = async () => {
      if (f.plan.operations.some((op) => op.kind === "push" && op.status === "succeeded"))
        throw Error("interrupted after durable push")
    }
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("blocked")
    f.ports.guard = async () => {}
    await expect(f.sequence[choice](f.plan)).rejects.toThrow("successful push")
    expect(f.plan.skipped).not.toContain("push")
    expect(f.plan.skipped).not.toContain("ship")
  })
  test.each(["run", "reconcile"] as const)(
    "%s recovers durable push without replay or checks",
    async (resume) => {
      const f = fixture()
      f.plan.remote = { name: "origin", url: "fake://repo", branch: "main" }
      f.ports.guard = async () => {
        if (f.plan.operations.some((op) => op.kind === "push" && op.status === "succeeded"))
          throw Error("interrupted after durable push")
      }
      await f.sequence.run(f.plan)
      expect(f.plan.status).toBe("blocked")
      const results = structuredClone(f.plan.results)
      f.ports.guard = async () => {}
      f.ports.check = async () => {
        throw Error("must use durable check receipts")
      }
      await f.sequence[resume](f.plan)
      expect(f.plan.status).toBe("shipped")
      expect(f.plan.outcome).toBe("pushed")
      expect(f.plan.results).toEqual(results)
      expect(f.events.filter((event) => event === "push")).toHaveLength(1)
    },
  )
  test.each(["cwd", "tree", "exitCode", "timedOut", "aborted"] as const)(
    "invalid %s check evidence stops before commit",
    async (field) => {
      const f = fixture()
      const check = f.ports.check
      f.ports.check = async (...args) => ({
        ...(await check(...args)),
        [field]:
          field === "cwd"
            ? path.resolve("/elsewhere")
            : field === "tree"
              ? a
              : field === "exitCode"
                ? 1
                : true,
      })
      await f.sequence.run(f.plan)
      expect(f.plan.status).toBe("blocked")
      expect(f.events).not.toContain("commit")
    },
  )
  test("PR handoff cannot be mislabeled local-only", async () => {
    const f = fixture("pr")
    await f.sequence.run(f.plan)
    await expect(f.sequence.localOnly(f.plan)).rejects.toThrow("successful push")
  })
})
describe("hosting adapter command safety", () => {
  test.each([
    "git push --force",
    "git push --force-with-lease",
    "git commit --no-verify",
    "git commit --no-gpg-sign",
    "git -c commit.gpgsign=false commit",
    "git -c core.hooksPath=/empty commit",
    "HUSKY=0 git commit",
    "gh release create v1",
    "npm publish",
  ])("check cannot disguise an irreversible/bypass command: %s", (command) => {
    expect(() => assertShipCheckSafety(command)).toThrow()
  })
  test.each(["bash", "powershell"] as const)(
    "%s commands contain no force/hook/signing bypass or implicit release",
    (shell) => {
      const f = fixture("pr")
      f.plan.commit = c
      const commands = [pushCommand(f.plan, shell), createPrCommand(f.plan, shell)].join("\n")
      expect(commands).toContain(`${c}:refs/heads/iteration-1`)
      expect(commands).toContain("--repo 'owner/repo'")
      expect(commands).not.toMatch(
        /--force|--force-with-lease|--no-verify|--no-gpg-sign|commit\.gpgsign|core\.hooksPath|HUSKY|git tag|gh release|npm publish|reset --hard|branch -D/,
      )
    },
  )
  test("fake hosting rejects multiple/changed push URLs and pushes only the confirmed destination", async () => {
    const f = fixture("pr")
    f.plan.commit = c
    const handle = ownedFixture({ key: "fake-hosting", cwd: "/fake" })
    const commands: string[] = []
    let urls = "fake://repo\nfake://unapproved"
    handle.runTool = async (_tool, args) => {
      const command = String(args.command)
      commands.push(command)
      return {
        content: [
          {
            type: "text",
            text: command.includes("get-url")
              ? urls
              : command.includes("ls-remote")
                ? `${c}\trefs/heads/iteration-1`
                : "",
          },
        ],
        details: { exitCode: 0 },
      }
    }
    const hosting = new ShipHosting(handle, "bash", new AbortController().signal)
    await expect(hosting.push(f.plan)).rejects.toThrow("Remote URL changed")
    expect(commands.some((command) => command.includes("git push"))).toBe(false)
    urls = "fake://changed"
    await expect(hosting.push(f.plan)).rejects.toThrow("Remote URL changed")
    urls = "fake://repo"
    expect(await hosting.push(f.plan)).toBe(c)
    expect(commands.find((command) => command.includes("git push"))).toContain("git push -- 'fake://repo'")
    expect(
      commands
        .filter((command) => command.includes("get-url"))
        .every((command) => command.includes("--push --all")),
    ).toBe(true)
  })
  test("fake hosting creates an exactly observed PR with multiline body only after source ref verification", async () => {
    const f = fixture("pr")
    f.plan.commit = c
    f.plan.pr!.body = "Notes\n\nSecond paragraph"
    const handle = ownedFixture({ key: "fake-gh-create", cwd: "/fake" })
    const commands: string[] = []
    handle.runTool = async (_tool, args) => {
      const command = String(args.command)
      commands.push(command)
      let text = ""
      if (command.includes("get-url")) text = "fake://repo"
      else if (command.includes("ls-remote")) text = `${c}\trefs/heads/iteration-1`
      else if (command.includes("gh pr create")) {
        const file = /--body-file '([^']+)'/.exec(command)?.[1]
        expect(file).toBeDefined()
        expect(await readFile(file!, "utf8")).toBe(f.plan.pr!.body)
        text = "https://example.invalid/pr/1"
      } else if (command.includes("gh pr list"))
        text = JSON.stringify([
          {
            url: "https://example.invalid/pr/1",
            state: "OPEN",
            headRefOid: c,
            baseRefName: "main",
            mergeCommit: null,
          },
        ])
      else throw Error("Unexpected fake hosting command")
      return { content: [{ type: "text", text }], details: { exitCode: 0 } }
    }
    const hosting = new ShipHosting(handle, "bash", new AbortController().signal)
    expect(await hosting.create(f.plan)).toBe("https://example.invalid/pr/1")
    expect(commands.findIndex((command) => command.includes("ls-remote"))).toBeLessThan(
      commands.findIndex((command) => command.includes("gh pr create")),
    )
  })
  test("fake gh observations bind the exact PR head/base and merged commit", async () => {
    const f = fixture("pr")
    f.plan.commit = c
    const handle = ownedFixture({ key: "fake-gh", cwd: "/fake" })
    let head = a
    handle.runTool = async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              url: "https://example.invalid/pr/1",
              state: "MERGED",
              headRefOid: head,
              baseRefName: "main",
              mergeCommit: { oid: b },
            },
          ]),
        },
      ],
      details: { exitCode: 0 },
    })
    const hosting = new ShipHosting(handle, "bash", new AbortController().signal)
    expect(await hosting.observe(f.plan)).toBeUndefined()
    head = c
    expect((await hosting.observe(f.plan))?.mergeCommit?.oid).toBe(b)
  })
  test("ref injection and malformed hosting observations fail closed", () => {
    const f = fixture("pr")
    f.plan.commit = c
    f.plan.remote!.branch = "--force"
    expect(() => pushCommand(f.plan, "bash")).toThrow()
    expect(() => parsePrObservations('[{"state":"MERGED"}]')).toThrow()
    expect(parsePrObservations("[]")).toEqual([])
  })
})
