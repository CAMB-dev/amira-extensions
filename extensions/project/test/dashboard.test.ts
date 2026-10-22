import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { agentStatusState, type ExtensionAPI } from "@amira/api"
import { ProjectCosts } from "../src/cost.ts"
import { FileCostPersistence } from "../src/cost-storage.ts"
import {
  type DashboardData,
  dashboardCache,
  dashboardSources,
  loadDashboardData,
  type ProjectDashboardSource,
  ProjectDashboards,
  projectSourceId,
} from "../src/dashboard.ts"
import { initialIteration } from "../src/stage.ts"
import {
  createProject,
  HistoricalIterationReader,
  IterationStore,
  LifecycleStore,
  projectLifecycle,
  readProject,
} from "../src/store.ts"

import { commandHarness, consume, implement, startReview, summarize } from "./batch-test-helper.ts"
import { bindingFixture } from "./iteration-binding-helper.ts"

setDefaultTimeout(240_000)
const roots: string[] = []
const managers: ProjectDashboards[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<DashboardData> {
  const root = await mkdtemp(path.join(tmpdir(), "project-dashboard-"))
  roots.push(root)
  const project = await createProject(root, "Dashboard fixture", { language: "en" })
  const state = await new IterationStore(project).read()
  return {
    project,
    iterations: [{ state, artifacts: [] }],
    documents: "Design and decisions",
    ship: { 1: "not-started" },
  }
}
async function bytes(root: string): Promise<unknown> {
  const entries = await readdir(root, { withFileTypes: true })
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => [
        entry.name,
        entry.isDirectory()
          ? await bytes(path.join(root, entry.name))
          : await readFile(path.join(root, entry.name), "utf8"),
      ]),
  )
}
function service(cards = true) {
  const sources = new Map<string, ProjectDashboardSource>()
  let disposed = 0
  return {
    sources,
    get disposed() {
      return disposed
    },
    capabilities: cards ? { cards: true as const } : undefined,
    register(source: ProjectDashboardSource) {
      if (sources.has(source.id)) throw new Error("duplicate")
      sources.set(source.id, source)
      return () => {
        disposed++
        sources.delete(source.id)
      }
    },
  }
}
function manager(get: () => unknown, load: (project: DashboardData["project"]) => Promise<DashboardData>) {
  const value = new ProjectDashboards({ useService: get } as Pick<ExtensionAPI, "useService">, load)
  managers.push(value)
  return value
}

describe("optional read-only project dashboard", () => {
  test("local guards accept old service, reject malformed or missing service", () => {
    expect(dashboardSources(undefined)).toBeUndefined()
    expect(dashboardSources({ register: true })).toBeUndefined()
    expect(dashboardSources(service(false))).toBeDefined()
    expect(projectSourceId("valid legacy / id")).toMatch(/^[a-z][\w.-]*$/i)
    expect(projectSourceId("a/b")).not.toBe(projectSourceId("a-b"))
  })
  test("phases/stages are stable per project; no action or host-navigation authority", async () => {
    const data = await fixture()
    const other = await fixture()
    data.iterations[0]!.state.approvedContext = {
      batchId: "B1",
      batchPlan: { artifactId: "new-plan", hash: "a".repeat(64) },
    }
    data.iterations[0]!.state.batchResolutions = [
      {
        batchId: "B1",
        receiptId: "old-receipt",
        status: "skipped",
        context: { batchPlan: { artifactId: "old-plan", hash: "b".repeat(64) } },
      },
    ]
    const cache = dashboardCache(data, true)
    const rows = cache.snapshot.phases.flatMap((phase) => phase.groups.flatMap((group) => group.agents))
    expect(rows.map((row) => row.card?.kind)).toEqual(Array(5).fill("stage"))
    const summary = JSON.stringify(cache.details.get(rows[0]!.id)?.summary)
    expect(summary).toContain("Approved batch: B1 [plan new-plan]")
    expect(summary).toContain("B1 [plan old-plan]: skipped (not passed)")
    expect(rows.every((row) => row.actions.length === 0 && !("sessionId" in row) && !("cost" in row))).toBe(
      true,
    )
    expect(rows[0]!.id).not.toBe(dashboardCache(other, true).snapshot.phases[0]!.groups[0]!.agents[0]!.id)
    expect(
      cache.details
        .get(rows[0]!.id)
        ?.summary.map((line) => ("text" in line ? line.text : ""))
        .join(" "),
    ).toContain("/project")
    expect(dashboardCache(data, false).snapshot.phases[0]!.groups[0]!.agents[0]!.card).toBeUndefined()
  })
  test("costs deduplicate descendants; budget stops and unknown costs are visible without row totals", async () => {
    const data = await fixture()
    const costs = new ProjectCosts(data.project.marker.id, new FileCostPersistence(data.project), {
      stop() {},
      notify() {},
    })
    await costs.load(false, 1)
    await costs.intent("design", { iteration: 1, stage: "design", role: "research" })
    await costs.bind("design", "root")
    const usage = (cost: number) => ({
      knownCostUsd: cost,
      complete: true,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost },
    })
    await costs.observe("design", {
      sessionId: "root",
      revision: 1,
      own: usage(0.4),
      total: usage(1.2),
      descendants: [{ sessionId: "child", parentSessionId: "root", groupId: "g", usage: usage(0.8) }],
    })
    data.ledger = costs.snapshot()
    data.ledger.coverage.legacyIncomplete = true
    const cache = dashboardCache(data, true)
    expect(cache.snapshot.warning).toContain("Budget stopped")
    expect(cache.snapshot.note).toContain("$1.20")
    expect(cache.snapshot.note).toContain("incomplete/unknown")
    const row = cache.snapshot.phases[0]!.groups[0]!.agents[0]!
    expect(row.status).toBe("stopped")
    expect(row.note).toContain("budget stopped")
    expect(row.card?.costText).toBe("$1.20 reported")
    expect(
      JSON.stringify(
        cache.details
          .get(row.id)
          ?.tabs?.find((tab) => tab.key === "costs")
          ?.render(),
      ),
    ).toContain("$1.20 reported")
    expect(cache.snapshot.phases[0]!.status).toBe("stopped")
    expect("cost" in row).toBe(false)
  })
  test("unstarted stage cards use not-reported cost and omit empty counters and repeated headings", async () => {
    const data = await fixture()
    const rows = dashboardCache(data, true).snapshot.phases[0]!.groups[0]!.agents
    for (const row of rows) {
      expect(row.card?.costText).toBe("not reported yet")
      expect(row.card?.detail).not.toMatch(/0 (?:project decisions|output records|attempts)/)
      expect(row.task).not.toContain(`${row.name} ·`)
    }
  })
  test("reported rollups use host money formatting, including signed corrections and unpriced spend", async () => {
    const data = await fixture()
    data.ledger = (await new FileCostPersistence(data.project).read())!
    for (const [cost, expected] of [
      [0, "$0.000"],
      [0.00001, "<$0.0001"],
      [0.00012, "$0.0001"],
      [0.0123, "$0.012"],
      [0.4567, "$0.457"],
      [1.234, "$1.23"],
      [25, "$25.00"],
      [-0.125, "-$0.125"],
      [-0.00001, ">-$0.0001"],
    ] as const) {
      const usage = {
        knownCostUsd: cost,
        complete: true,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost },
      }
      data.ledger.owners = [
        {
          key: "design",
          id: "owner",
          iteration: 1,
          stage: "design",
          role: "design",
          provenance: "owned",
          groups: [],
          sessions: [],
          runs: [],
          snapshot: { sessionId: "owner", revision: 1, own: usage, total: usage, descendants: [] },
        },
      ]
      const cache = dashboardCache(data, true)
      const row = cache.snapshot.phases[0]!.groups[0]!.agents[0]!
      expect(row.card?.costText).toBe(`${expected} reported`)
      expect(
        JSON.stringify(
          cache.details
            .get(row.id)
            ?.tabs?.find((tab) => tab.key === "costs")
            ?.render(),
        ),
      ).toContain(`${expected} reported`)
      expect("cost" in row).toBe(false)
    }
    const usage = data.ledger.owners[0]!.snapshot!.own
    usage.complete = false
    usage.knownCostUsd = 0
    usage.usage.pricingUnknown = true
    const row = dashboardCache(data, true).snapshot.phases[0]!.groups[0]!.agents[0]!
    expect(row.card?.costText).toContain("unavailable")
    expect(row.card?.costText).toContain("unpriced")
    expect(row.card?.costText).not.toBe("not reported yet")
  })
  test("closed iterations stay readable; archive/restore are inert and rendering writes nothing", async () => {
    const data = await fixture()
    let project = data.project
    const receipt = { id: "human", sessionId: "main", date: new Date().toISOString() }
    for (const event of [
      { type: "ship" as const, status: "skipped" as const, receipt },
      { type: "close-pending" as const, receipt },
      { type: "close" as const, receipt },
      { type: "next-iteration" as const, receipt },
      { type: "archive-pending" as const, receipt },
      { type: "archived" as const, receipt },
    ]) {
      project = await new LifecycleStore(project).transition(projectLifecycle(project).revision, event)
    }
    const before = await bytes(project.root)
    const loaded = await loadDashboardData(project)
    const cache = dashboardCache(loaded, true)
    expect(cache.snapshot.phases).toHaveLength(2)
    // Regression: generic note text on done rows means early-stop to legacy sources.
    expect(agentStatusState({ status: "done", note: "shipped" })).toBe("stopped")
    expect(agentStatusState(cache.snapshot.phases[0]!.groups[0]!.agents.at(-1)!)).toBe("done")
    expect(cache.snapshot.warning).toContain("archived")
    expect(cache.snapshot.phases[0]!.groups[0]!.agents.at(-1)?.task).toContain("skipped (not passed)")
    for (const details of cache.details.values()) for (const tab of details.tabs ?? []) tab.render()
    expect(await bytes(project.root)).toEqual(before)
    project = await new LifecycleStore(project).transition(projectLifecycle(project).revision, {
      type: "restore",
      receipt,
    })
    expect(
      dashboardCache(await loadDashboardData(project), true).snapshot.phases[1]!.groups[0]!.agents[0]!.note,
    ).toContain("read-only")
  })
  test("absence, old capability, unload/replacement and stale disposer do not affect project operations", async () => {
    const data = await fixture()
    let provider: ReturnType<typeof service> | undefined
    let reads = 0
    const adapter = manager(
      () => provider,
      async () => {
        reads++
        return data
      },
    )
    adapter.track(data.project)
    await adapter.refresh()
    expect(reads).toBe(0)
    expect((await readProject(data.project.root)).marker.id).toBe(data.project.marker.id)
    provider = service(false)
    await adapter.refresh()
    const old = provider
    const source = [...old.sources.values()][0]!
    expect(source.snapshot().phases[0]!.groups[0]!.agents[0]!.card).toBeUndefined()
    let notifications = 0
    const unsubscribe = source.subscribe(() => {
      notifications++
    })
    const before = reads
    const saved = source.snapshot()
    saved.phases.length = 0
    for (let i = 0; i < 5; i++) {
      for (const row of source.snapshot().phases[0]!.groups[0]!.agents)
        for (const tab of source.details(row.id)?.tabs ?? []) tab.render()
    }
    expect(reads).toBe(before)
    provider = service()
    await adapter.refresh()
    expect(old.sources.size).toBe(0)
    expect(old.disposed).toBe(1)
    expect([...provider.sources.values()][0]!.snapshot().phases[0]!.groups[0]!.agents[0]!.card?.kind).toBe(
      "stage",
    )
    expect(notifications).toBeGreaterThan(0)
    unsubscribe()
    adapter.dispose()
    adapter.dispose()
    await adapter.refresh()
    expect(provider.disposed).toBe(1)
    expect(source.snapshot().phases).toEqual([])
  })
  test("durable B2 approval never borrows B1 implementation or acceptance success", async () => {
    const f = await bindingFixture(roots, true)
    const h = commandHarness(f.project)
    const review = await startReview(f.store, f.state, f.verdict)
    await summarize(f.store, await consume(f.store, review.state, review.verdict))
    let state = await h.run()
    const data = (): DashboardData => ({
      project: f.project,
      iterations: [{ state, artifacts: [] }],
      documents: "",
      ship: {},
    })
    expect(state.approvedContext?.batchId).toBe("B2")
    expect(state.activeAttemptId).toBeUndefined()
    expect(dashboardCache(data(), true).snapshot.phases[0]!.groups[0]!.agents[2]!.status).toBe("idle")
    await implement(f.store, state)
    await h.run()
    state = await new HistoricalIterationReader(f.project, 1).read()
    expect(state.approvedContext?.batchId).toBe("B2")
    expect(state.activeAttemptId).toBeUndefined()
    expect(state.attempts.filter((attempt) => attempt.stage === "accept")).toHaveLength(1)
    const cache = dashboardCache(data(), true)
    const card = cache.snapshot.phases[0]!.groups[0]!.agents[3]!
    expect(card.status).toBe("idle")
    expect(card.task).toContain("awaiting review")
    expect(card.task).not.toContain("pass")
    const evidence = JSON.stringify(cache.details.get(card.id))
    expect(evidence).toContain("Historical")
    expect(evidence).toContain("B1")
  })
  test("durable accepted B1 plus final skipped B2 is mixed completion, never automated pass", async () => {
    const f = await bindingFixture(roots, true)
    const h = commandHarness(f.project)
    const review = await startReview(f.store, f.state, f.verdict)
    await summarize(f.store, await consume(f.store, review.state, review.verdict))
    const b2 = await h.run()
    await implement(f.store, b2)
    await h.run()
    await h.run("skip", ["batch"])
    const state = await new HistoricalIterationReader(f.project, 1).read()
    expect(state.completion).toBe("skipped")
    const cache = dashboardCache(
      { project: f.project, iterations: [{ state, artifacts: [] }], documents: "", ship: {} },
      true,
    )
    const card = cache.snapshot.phases[0]!.groups[0]!.agents[3]!
    expect(card.status).not.toBe("done")
    expect(card.task).toContain("completed with skips")
    expect(card.task).not.toContain("automated pass")
    expect(JSON.stringify(cache.details.get(card.id))).toContain("1 accepted / 1 skipped")
  })
  test("an active attempt from another approval cannot describe the current review", async () => {
    const data = await fixture()
    const state = data.iterations[0]!.state
    state.stage = "accept"
    state.phase = "confirmed"
    state.approvedContext = {
      batchId: "B2",
      batchPlan: { artifactId: "plan", hash: "a".repeat(64) },
      changes: ["new-diff"],
    }
    state.activeAttemptId = "old-review"
    state.attempts = [
      {
        id: "old-review",
        stage: "accept",
        status: "finished",
        changes: [],
        context: { ...state.approvedContext, changes: ["old-diff"] },
        acceptance: { verdict: "pass", failingItemIds: [], artifactId: "verdict" },
      },
    ]
    const cache = dashboardCache(data, true)
    const card = cache.snapshot.phases[0]!.groups[0]!.agents[3]!
    expect(card.status).toBe("idle")
    expect(card.task).toBe("awaiting review")
    expect(JSON.stringify(cache.details.get(card.id)?.notes)).toContain("Historical accept B2: pass")
  })
  test("completion rollups ignore same-named skipped batches from a superseded plan", async () => {
    const data = await fixture()
    const state = data.iterations[0]!.state
    const context = {
      batchId: "B1",
      batchPlan: { artifactId: "new-plan", hash: "a".repeat(64) },
      spec: { artifactId: "spec", revision: 1, hash: "b".repeat(64) },
      mode: "single" as const,
    }
    state.approvedContext = context
    state.stage = "accept"
    state.phase = "complete"
    state.completion = "accepted"
    state.batchManifests = [{ ...context, batchIds: ["B1"] }]
    state.batchResolutions = [
      {
        context: { ...context, batchPlan: { artifactId: "old-plan", hash: "c".repeat(64) } },
        batchId: "B1",
        receiptId: "old-skip",
        status: "skipped",
      },
      { context, batchId: "B1", receiptId: "new-pass", status: "accepted" },
    ]
    const cache = dashboardCache(data, true)
    const card = cache.snapshot.phases[0]!.groups[0]!.agents[3]!
    expect(card.status).toBe("done")
    expect(card.task).toBe("accepted")
    expect(JSON.stringify(cache.details.get(card.id)?.summary)).toContain("1 accepted / 0 skipped")
  })
  test("revisited stages with no active attempt remain awaiting execution despite matching old results", async () => {
    const data = await fixture()
    const state = data.iterations[0]!.state
    state.phase = "confirmed"
    state.attempts = [{ id: "old-design", stage: "design", status: "finished", changes: [] }]
    state.transitions = [
      {
        id: "revisit",
        from: "prototype",
        to: "design",
        kind: "revisit",
        summaryId: "summary",
        suggestion: "Revisit design",
        skippedStages: [],
      },
    ]
    const cache = dashboardCache(data, true)
    const card = cache.snapshot.phases[0]!.groups[0]!.agents[0]!
    expect(card.status).toBe("idle")
    expect(card.task).toContain("awaiting execution")
    expect(JSON.stringify(cache.details.get(card.id))).toContain("Historical")
  })
  test("historical skip receipts do not hide revisited working or interrupted stages", async () => {
    const data = await fixture()
    const state = data.iterations[0]!.state
    state.skips = [{ stage: "design", receiptId: "old-skip" }]
    state.transitions = [
      {
        id: "skip",
        from: "design",
        to: "prototype",
        kind: "skip",
        summaryId: "s1",
        suggestion: "skip",
        skippedStages: ["design"],
      },
      {
        id: "revisit",
        from: "prototype",
        to: "design",
        kind: "revisit",
        summaryId: "s2",
        suggestion: "revisit",
        skippedStages: [],
      },
    ]
    state.attempts = [{ id: "reopened", stage: "design", status: "working", changes: [] }]
    state.activeAttemptId = "reopened"
    state.phase = "running"
    state.status = "working"
    const card = () => dashboardCache(data, true).snapshot.phases[0]!.groups[0]!.agents[0]!
    expect(card().status).toBe("running")
    expect(card().task).not.toContain("skipped")
    state.attempts[0]!.status = "interrupted"
    expect(card().status).toBe("stopped")
  })
  test("human trial problems and required pending trials are not successful acceptance cards", async () => {
    const data = await fixture()
    const state = data.iterations[0]!.state
    state.stage = "accept"
    state.attempts = [
      {
        id: "review",
        stage: "accept",
        status: "finished",
        changes: [],
        acceptance: { verdict: "pass", failingItemIds: [], artifactId: "verdict", manualTrialRequired: true },
      },
    ]
    state.activeAttemptId = "review"
    const acceptance = () => dashboardCache(data, true).snapshot.phases[0]!.groups[0]!.agents[3]!
    expect(acceptance().status).not.toBe("done")
    expect(acceptance().task).toContain("pending")
    state.manualTrial = { status: "problem", artifactId: "trial" }
    state.attempts[0]!.manualTrial = state.manualTrial
    expect(acceptance().status).toBe("failed")
    expect(acceptance().task).toContain("problem")
    state.attempts[0]!.manualTrial = { status: "tried", artifactId: "trial" }
    expect(acceptance().status).toBe("done")
    state.attempts[0]!.staleReason = "Spec changed"
    expect(acceptance().status).not.toBe("done")
    expect(acceptance().task).toContain("stale")
  })
  test("retracking a moved project uses its new root without changing the source identity", async () => {
    const data = await fixture()
    const provider = service()
    let moved = false
    const selected: string[] = []
    const adapter = manager(
      () => provider,
      async (project) => {
        selected.push(project.root)
        if (moved && project.root === data.project.root) throw new Error("Old directory moved")
        return { ...data, project }
      },
    )
    adapter.track(data.project)
    await adapter.refresh()
    const source = [...provider.sources.values()][0]!
    moved = true
    const relocated = { ...data.project, root: path.join(data.project.root, "relocated") }
    adapter.track(relocated)
    await adapter.refresh()
    expect(selected.at(-1)).toBe(relocated.root)
    expect([...provider.sources.values()][0]).toBe(source)
    expect(source.snapshot().workspace).toBe(relocated.root)
  })
  test("history tabs use only inert owner-authorized reads and render synchronously", async () => {
    const data = await fixture()
    const costs = new ProjectCosts(data.project.marker.id, new FileCostPersistence(data.project), {
      stop() {},
      notify() {},
    })
    await costs.load()
    await costs.intent("owned-key", { iteration: 1, stage: "design", role: "designer" })
    await costs.bind("owned-key", "owned-id")
    data.ledger = costs.snapshot()
    const provider = service()
    const refs: unknown[] = []
    const api = {
      useService: () => provider,
      conversations: {
        async read(ref: unknown) {
          refs.push(ref)
          return { history: [{ role: "assistant", content: [{ type: "text", text: "Owned history only" }] }] }
        },
        open() {
          throw new Error("Must not open runtime")
        },
      },
    } as unknown as ExtensionAPI
    const adapter = new ProjectDashboards(api, async () => data)
    managers.push(adapter)
    adapter.track(data.project)
    await adapter.refresh()
    expect(refs).toEqual([{ id: "owned-id" }])
    const source = [...provider.sources.values()][0]!
    const row = source.snapshot().phases[0]!.groups[0]!.agents[0]!
    const tab = source.details(row.id)!.tabs!.find((tab) => tab.key === "history")!
    expect(JSON.stringify(tab.render())).toContain("Owned history only")
    expect(refs).toHaveLength(1)
    expect("sessionId" in row).toBe(false)
  })
  test("unload during async load cannot publish or register late data; failed load is explicit", async () => {
    const data = await fixture()
    const provider = service()
    let finish!: (data: DashboardData) => void
    const adapter = manager(
      () => provider,
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    adapter.track(data.project)
    const pending = adapter.refresh()
    adapter.dispose()
    finish(data)
    await pending
    expect(provider.sources.size).toBe(0)
    const failed = manager(
      () => provider,
      async () => {
        throw new Error("corrupt evidence")
      },
    )
    failed.track(data.project)
    await failed.refresh()
    expect([...provider.sources.values()][0]!.snapshot().warning).toContain("corrupt evidence")
    expect(initialIteration(data.project.marker.id, 1).attempts).toEqual([])
  })
})
