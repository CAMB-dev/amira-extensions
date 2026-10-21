import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type ShipPlan, type ShipPorts, ShipPreflightError, ShipSequence } from "../src/ship.ts"
import { settleShipLifecycle } from "../src/ship-command.ts"
import { ShipStore } from "../src/ship-storage.ts"
import { createProject, ProjectDocumentStore, projectLifecycle, readProject } from "../src/store.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(strategy: "local-merge" | "pr" = "local-merge", withRemote = false) {
  const root = await mkdtemp(path.join(tmpdir(), "ship-storage-"))
  roots.push(root)
  const project = await createProject(root, "Ship receipts")
  const store = new ShipStore(project)
  const a = "a".repeat(40),
    b = "b".repeat(40),
    c = "c".repeat(40)
  const plan: ShipPlan = {
    schemaVersion: 1,
    id: "ship-1",
    projectId: project.marker.id,
    iteration: 1,
    stageRevision: 0,
    revision: 0,
    approval: { sessionId: "main", date: new Date().toISOString() },
    status: "pending",
    preference: { repository: root, strategy, target: "main", merge: "ff-only" },
    source: { root: path.join(root, "iteration"), branch: "iteration-1", head: a, tree: b, common: root },
    target: { root: path.join(root, "integration"), branch: "main", head: a, common: root },
    checkRoot: path.join(root, "source-checks"),
    files: ["code.ts"],
    checks: [{ id: "full", command: "check-product", cwd: "." }],
    notes: { language: "en", text: "Notes", location: "artifacts" },
    evidence: "qualified",
    skipped: [],
    message: "Candidate",
    results: [],
    operations: [],
    ...(strategy === "pr"
      ? {
          remote: { name: "origin", url: "fake://remote", branch: "iteration-1" },
          pr: { repository: "owner/repo", base: "main", title: "Ship", body: "Notes" },
        }
      : {}),
  }
  if (withRemote) plan.remote = { name: "origin", url: "fake://remote", branch: "main" }
  await store.create(plan)
  const effects: string[] = []
  const ports: ShipPorts = {
    save: (row) => store.save(row),
    confirm: async () => true,
    guard: async () => {},
    check: async (check, phase) => {
      if (phase === "integrated") expect((await store.latest())!.integrated).toBe(c)
      return {
        cwd: path.resolve(phase === "source" ? plan.checkRoot! : plan.target.root, check.cwd),
        tree: phase === "source" ? plan.source.tree : plan.integratedTree,
        ok: true,
        output: "passed",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      }
    },
    commit: async () => {
      effects.push("commit")
      return c
    },
    merge: async () => {
      effects.push("merge")
      plan.integratedTree = b
      return c
    },
    push: async () => {
      effects.push("push")
      return c
    },
    createPr: async () => {
      effects.push("pr")
      return "https://example.invalid/pr/1"
    },
    reconcile: async () => undefined,
    mergedPr: async () => {
      plan.integratedTree = b
      return c
    },
  }
  return { project, store, plan, ports, effects, sequence: new ShipSequence(ports, "main"), c }
}
test.each(["local-only", "skip", "revise"] as const)(
  "persisted push preflight permits explicit %s without remote absence or replay",
  async (choice) => {
    const f = await fixture("local-merge", true)
    f.ports.push = async () => {
      throw new ShipPreflightError("push", "Remote URL moved before dispatch")
    }
    await f.sequence.run(f.plan)
    const saved = (await f.store.latest())!
    expect(saved.operations.at(-1)).toMatchObject({ kind: "push", status: "failed", effectNotStarted: true })
    expect(saved.operations.at(-1)?.result).toContain("Remote URL moved")
    f.ports.reconcile = async () => {
      throw new Error("No remote observation may establish this local preflight fact")
    }
    await f.sequence.reconcile(saved)
    if (choice === "local-only") await f.sequence.localOnly(saved)
    else if (choice === "skip") await f.sequence.skip(saved)
    else await f.store.supersede(saved)
    const current = (await f.store.latest())!
    expect(current.status).toBe(
      choice === "local-only" ? "shipped" : choice === "skip" ? "skipped" : "superseded",
    )
    expect(current.operations.at(-1)).toMatchObject({ status: "failed", effectNotStarted: true })
    expect(f.effects).toEqual(["commit", "merge"])
  },
)

test.each(["skip", "revise"] as const)(
  "persisted PR preflight permits explicit %s while retaining the source push",
  async (choice) => {
    const f = await fixture("pr")
    f.ports.createPr = async () => {
      throw new ShipPreflightError("pr", "Remote URL moved before gh dispatch")
    }
    await f.sequence.run(f.plan)
    const saved = (await f.store.latest())!
    expect(saved.operations.at(-1)).toMatchObject({ kind: "pr", status: "failed", effectNotStarted: true })
    await f.sequence.reconcile(saved)
    if (choice === "skip") await f.sequence.skip(saved)
    else await f.store.supersede(saved)
    const current = (await f.store.latest())!
    expect(current.status).toBe(choice === "skip" ? "skipped" : "superseded")
    expect(current.operations.find((operation) => operation.kind === "push")?.status).toBe("succeeded")
    expect(current.skipped).not.toContain("push")
    expect(f.effects).toEqual(["commit", "push"])
  },
)

test("uncertain dispatch history cannot later invent a preflight-not-started receipt", async () => {
  const f = await fixture("local-merge", true)
  f.ports.push = async () => {
    throw new Error("Response lost after dispatch")
  }
  await f.sequence.run(f.plan)
  const forged = structuredClone((await f.store.latest())!)
  forged.revision++
  const operation = forged.operations.at(-1)!
  operation.status = "failed"
  operation.effectNotStarted = true
  operation.result = "Pretend preflight proof"
  await expect(f.store.save(forged)).rejects.toThrow("cannot be invented")
  expect((await f.store.latest())?.operations.at(-1)?.status).toBe("uncertain")
})

test("preflight-not-started receipt remains immutable and requires evidence", async () => {
  const f = await fixture("local-merge", true)
  f.ports.push = async () => {
    throw new ShipPreflightError("push", "Known preflight failure")
  }
  await f.sequence.run(f.plan)
  const changed = structuredClone((await f.store.latest())!)
  changed.revision++
  delete changed.operations.at(-1)!.effectNotStarted
  await expect(f.store.save(changed)).rejects.toThrow("cannot be invented")
  await new ProjectDocumentStore(f.project).update("ship.json", (value) => {
    ;(value as { plans: ShipPlan[] }).plans[0]!.operations.at(-1)!.result = ""
    return value
  })
  await expect(f.store.read()).rejects.toThrow("operation receipt")
})

test("explicit PR abandonment skips ship without relabeling its successful preparatory source push", async () => {
  const f = await fixture("pr")
  await f.sequence.run(f.plan)
  expect(f.plan.status).toBe("awaiting-merge")
  const effects = [...f.effects]
  await f.sequence.skip(f.plan)
  const saved = await f.store.latest()
  expect(saved?.outcome).toBe("ship-skipped")
  expect(saved?.skipped).toContain("ship")
  expect(saved?.skipped).not.toContain("push")
  expect(saved?.operations.find((operation) => operation.kind === "push")?.status).toBe("succeeded")
  expect(saved?.integrated).toBeUndefined()
  expect(f.effects).toEqual(effects)
})

test("PR merged commit is durably visible to production-shaped check ports", async () => {
  const f = await fixture("pr")
  await f.sequence.run(f.plan)
  expect((await f.store.latest())?.status).toBe("awaiting-merge")
  await f.sequence.reconcile(f.plan)
  expect((await f.store.latest())?.outcome).toBe("pr-merged")
})
test("crash between final ship receipt and lifecycle publication recovers locally, idempotently", async () => {
  const f = await fixture()
  await f.sequence.run(f.plan)
  expect(projectLifecycle(await readProject(f.project.root)).iterations[1]?.ship).toBe("not-started")
  const before = [...f.effects]
  await settleShipLifecycle(f.project, f.plan, "main")
  await settleShipLifecycle(f.project, f.plan, "main")
  const current = await readProject(f.project.root)
  expect(projectLifecycle(current).iterations[1]).toMatchObject({
    status: "open",
    ship: "shipped",
    receipt: { id: f.plan.id },
  })
  expect(f.effects).toEqual(before)
})
test("immutable exact inputs, check history and approvals reject rewrites; stale revision rejects", async () => {
  const f = await fixture()
  const changed = structuredClone(f.plan)
  changed.revision++
  changed.checks[0]!.command = "different"
  await expect(f.store.save(changed)).rejects.toThrow("immutable")
  f.plan.revision++
  f.plan.results.push({
    ...f.plan.checks[0]!,
    phase: "source",
    cwd: f.plan.checkRoot!,
    tree: f.plan.source.tree,
    ok: true,
    output: "old evidence",
    exitCode: 0,
    timedOut: false,
    aborted: false,
  })
  await f.store.save(f.plan)
  const stale = structuredClone(f.plan)
  f.plan.revision++
  f.plan.results[0]!.output = "rewritten"
  await expect(f.store.save(f.plan)).rejects.toThrow("history")
  await expect(f.store.save(stale)).rejects.toThrow("revision")
})
test.each([true, false])(
  "uncertain intent cannot be superseded; observed result (notApplied=%s) allows explicit revision without retry",
  async (notApplied) => {
    const f = await fixture()
    f.ports.merge = async () => {
      throw Error("ff-only refusal")
    }
    await f.sequence.run(f.plan)
    await expect(f.store.supersede(f.plan)).rejects.toThrow("uncertain")
    f.ports.reconcile = async () => ({
      notApplied,
      evidence: notApplied
        ? "Exact original clean target; no pending merge"
        : "Observed different unapproved result; new checks and approval required",
    })
    await f.sequence.reconcile(f.plan)
    expect(f.plan.operations.at(-1)?.status).toBe("failed")
    await f.store.supersede(f.plan)
    expect((await f.store.latest())?.status).toBe("superseded")
    expect(f.effects.filter((value) => value === "commit")).toHaveLength(1)
  },
)

test.each(["local-only", "ship-skipped", "skipped-push"] as const)(
  "persisted successful push rejects contradictory %s outcome",
  async (contradiction) => {
    const f = await fixture("local-merge", true)
    const documents = new ProjectDocumentStore(f.project)
    await f.sequence.run(f.plan)
    expect(f.plan.outcome).toBe("pushed")
    await documents.update("ship.json", (value) => {
      const row = (value as { plans: ShipPlan[] }).plans[0]!
      if (contradiction === "skipped-push") row.skipped.push("push")
      else {
        row.outcome = contradiction
        row.completion!.choice = contradiction
        if (contradiction === "ship-skipped") row.status = "skipped"
      }
      return value
    })
    await expect(f.store.read()).rejects.toThrow("successful push")
  },
)

test.each(["cwd", "tree", "missing-tree", "source-cwd", "source-not-isolated", "missing-source"] as const)(
  "persisted settled outcome rejects %s evidence mismatch",
  async (gap) => {
    const f = await fixture()
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("shipped")
    await new ProjectDocumentStore(f.project).update("ship.json", (value) => {
      const row = (value as { plans: ShipPlan[] }).plans[0]!
      const result = row.results.find(
        (result) =>
          result.phase === (gap === "source-cwd" || gap === "source-not-isolated" ? "source" : "integrated"),
      )!
      if (gap === "cwd" || gap === "source-cwd") result.cwd = path.join(f.project.root, "wrong-directory")
      if (gap === "tree") result.tree = "d".repeat(40)
      if (gap === "missing-tree") delete result.tree
      if (gap === "source-not-isolated") {
        row.checkRoot = path.join(row.source.root, "fake-checkout")
        result.cwd = row.checkRoot
      }
      if (gap === "missing-source") row.results = row.results.filter((result) => result.phase !== "source")
      return value
    })
    await expect(f.store.read()).rejects.toThrow("check")
  },
)

test("persisted candidate/source tree contradiction cannot authorize lifecycle recovery", async () => {
  const f = await fixture()
  await f.sequence.run(f.plan)
  const documents = new ProjectDocumentStore(f.project)
  await documents.update("ship.json", (value) => {
    const row = (value as { plans: ShipPlan[] }).plans[0]!
    row.candidate = {
      tree: row.source.tree,
      paths: [...row.files],
      fingerprint: "f".repeat(64),
      incoming: { base: row.source.head, paths: [...row.files] },
      pin: {
        source: { ...row.source, gitDir: path.join(row.source.root, ".git"), identity: "source-fixture" },
        target: { ...row.target, gitDir: path.join(row.target.root, ".git"), identity: "target-fixture" },
        worktree: {
          kind: "iteration-worktree",
          status: "ready",
          repository: f.project.root,
          root: row.source.root,
          cwd: row.source.root,
          branch: row.source.branch,
          base: row.source.head,
          excluded: "",
          confirmation: "Fixture",
          setupKey: "fixture",
        },
      },
    }
    return value
  })
  expect((await f.store.latest())?.source.tree).toBe(f.plan.source.tree)
  await documents.update("ship.json", (value) => {
    ;(value as { plans: ShipPlan[] }).plans[0]!.source.tree = "d".repeat(40)
    return value
  })
  await expect(f.store.read()).rejects.toThrow("candidate")
  await expect(settleShipLifecycle(f.project, f.plan, "main")).rejects.toThrow("candidate")
  expect(projectLifecycle(await readProject(f.project.root)).iterations[1]?.ship).toBe("not-started")
})

test("durable push interruption reconciles truthful delivery without replay or replacement checks", async () => {
  const f = await fixture("local-merge", true)
  f.ports.guard = async (plan) => {
    if (plan.operations.some((op) => op.kind === "push" && op.status === "succeeded"))
      throw Error("interrupted after durable push")
  }
  await f.sequence.run(f.plan)
  const persisted = (await f.store.latest())!
  expect(persisted.status).toBe("blocked")
  expect(persisted.operations.at(-1)?.status).toBe("succeeded")
  f.ports.guard = async () => {}
  f.ports.check = async () => {
    throw Error("durable receipts must not be replaced")
  }
  await expect(f.sequence.localOnly(persisted)).rejects.toThrow("successful push")
  await expect(f.sequence.skip(persisted)).rejects.toThrow("successful push")
  await f.sequence.reconcile(persisted)
  expect((await f.store.latest())?.outcome).toBe("pushed")
  expect((await f.store.latest())?.results).toEqual(f.plan.results)
  expect(f.effects).toEqual(["commit", "merge", "push"])
  await settleShipLifecycle(f.project, persisted, "main")
  expect(projectLifecycle(await readProject(f.project.root)).iterations[1]?.ship).toBe("shipped")
})

test("observed successful push recovers pushed without replay after uncertain response", async () => {
  const f = await fixture("local-merge", true)
  f.ports.push = async () => {
    f.effects.push("push")
    throw Error("response lost")
  }
  await f.sequence.run(f.plan)
  expect((await f.store.latest())?.operations.at(-1)?.status).toBe("uncertain")
  f.ports.reconcile = async (_plan, operation) => (operation.kind === "push" ? f.c : undefined)
  await f.sequence.reconcile(f.plan)
  expect((await f.store.latest())?.outcome).toBe("pushed")
  expect(f.effects).toEqual(["commit", "merge", "push"])
})

test.each(["commit", "integrated", "integratedTree"] as const)(
  "persisted %s delivery pin cannot be rewritten",
  async (field) => {
    const f = await fixture()
    f.ports.confirm = async (title) => title !== "Finish local-only ship"
    await f.sequence.run(f.plan)
    expect(f.plan.status).toBe("blocked")
    const changed = structuredClone(f.plan)
    changed.revision++
    changed[field] = "d".repeat(40)
    await expect(f.store.save(changed)).rejects.toThrow("pins cannot be rewritten")
  },
)

test("wrong-cwd integrated check cannot settle delivery or lifecycle", async () => {
  const f = await fixture("local-merge", true)
  const check = f.ports.check
  f.ports.check = async (approved, phase) => ({
    ...(await check(approved, phase)),
    ...(phase === "integrated" ? { cwd: path.join(f.project.root, "not-the-approved-directory") } : {}),
  })
  await f.sequence.run(f.plan)
  const actual = (await f.store.latest())!
  expect(actual.status).toBe("blocked")
  expect(actual.results.at(-1)?.ok).toBe(false)
  expect(actual.results.at(-1)?.cwd).toBe(path.join(f.project.root, "not-the-approved-directory"))
  expect(f.effects).not.toContain("push")
  await expect(settleShipLifecycle(f.project, actual, "main")).rejects.toThrow("settled ship receipt")
  expect(projectLifecycle(await readProject(f.project.root)).iterations[1]?.ship).toBe("not-started")
})

test("later failed recheck remains durable without erasing earlier successful operation evidence", async () => {
  const f = await fixture()
  f.ports.confirm = async (title) => title !== "Finish local-only ship"
  await f.sequence.run(f.plan)
  expect(f.plan.status).toBe("blocked")
  f.plan.revision++
  f.plan.results.push({ ...f.plan.results[0]!, ok: false, exitCode: 1, output: "later check failed" })
  await f.store.save(f.plan)
  expect((await f.store.latest())?.results.at(-1)?.output).toBe("later check failed")
  f.plan.revision++
  f.plan.operations.push({
    id: "new-push",
    kind: "push",
    inputs: "exact",
    status: "requested",
    approval: f.plan.approval,
  })
  await expect(f.store.save(f.plan)).rejects.toThrow("latest full tree-bound source check")
})
