import type { ExtensionAPI, ViewLine } from "@amira/api"
import type { IterationArtifact } from "./artifacts.ts"
import { type CostLedger, type CostRollup, costRollups } from "./cost.ts"
import { FileCostPersistence } from "./cost-storage.ts"
import { stageDisplay } from "./dashboard-status.ts"
import { localize } from "./language.ts"
import { shipSummary } from "./ship.ts"
import { ShipStore } from "./ship-storage.ts"
import { type IterationState, initialIteration } from "./stage.ts"
import { stageName } from "./stage-view.ts"
import {
  DecisionStore,
  HistoricalIterationReader,
  type Project,
  ProjectStorageError,
  projectLifecycle,
  readDocument,
  readProject,
} from "./store.ts"

// Provider-local structural contract. Never import or require the optional dashboard.
type Status = "queued" | "running" | "idle" | "paused" | "done" | "failed" | "stopped"
interface Card {
  id: string
  name: string
  task: string
  status: Status
  note?: string
  card?: { kind: "stage"; label: string; outcome?: string; detail?: string; costText?: string }
  files: []
  actions: []
}
interface Snapshot {
  workspace: string
  phases: {
    id: string
    name: string
    status?: Status
    description?: string
    groups: { id: string; name: string; agents: Card[] }[]
  }[]
  note?: string
  warning?: string
}
interface Details {
  summary: ViewLine[]
  logs: ViewLine[]
  notes?: ViewLine[]
  tabs?: { key: string; label: string; render(): ViewLine[] }[]
}
export interface ProjectDashboardSource {
  id: string
  label: string
  snapshot(): Snapshot
  details(id: string): Details | undefined
  subscribe(changed: () => void): () => void
}
interface Sources {
  capabilities?: { cards?: true }
  register(source: ProjectDashboardSource): () => void
}
export function dashboardSources(value: unknown): Sources | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<Sources>
  return typeof candidate.register === "function" ? (candidate as Sources) : undefined
}
export const projectSourceId = (id: string) =>
  `project.${/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id : `key.${Buffer.from(id, "utf16le").toString("hex")}`}`
const stages = ["design", "prototype", "implement", "accept", "ship"] as const
const lines = (text: string): ViewLine[] => text.split("\n").map((text) => ({ kind: "text", text }))
/** Mirrors the host status bar and /cost thresholds without importing another extension. */
const money = (usd: number): string => {
  if (usd < 0) return -usd < 0.00005 ? ">-$0.0001" : `-${money(-usd)}`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(3)}`
  return usd < 0.00005 ? "<$0.0001" : `$${usd.toFixed(4)}`
}
const price = (total: CostRollup | undefined, evidence = true): string => {
  if (!total) return evidence ? "unavailable · spend not fully reported" : "not reported yet"
  const incomplete = !total.complete || total.unknown
  if (!evidence && !incomplete && !total.pending) return "not reported yet"
  if (incomplete && total.knownCostUsd === 0) return "unavailable · unpriced spend"
  return `${money(total.knownCostUsd)} reported${incomplete ? " · incomplete/unknown" : ""}${total.estimated ? " · estimated" : ""}${total.pending ? " · pending" : ""}`
}
const ledgerText = (ledger: CostLedger): string => {
  const totals = costRollups(ledger)
  return [
    `Project cost: ${price(totals.project)}`,
    `Cap: ${ledger.policy.capUsd === undefined ? "none" : money(ledger.policy.capUsd)}${ledger.policy.latch ? ` · STOPPED (${ledger.policy.latch.reason})` : ""}`,
    `Coverage since ${ledger.coverage.since}${ledger.coverage.legacyIncomplete ? "; earlier costs are unavailable, not zero" : ""}`,
    ...Object.entries(totals.iterations).map(([id, value]) => `Iteration ${id}: ${price(value)}`),
    ...Object.entries(totals.stages).map(([id, value]) => `Stage ${id}: ${price(value)}`),
    ...Object.entries(totals.sessions).map(([id, value]) => `Session/child ${id}: ${price(value)}`),
  ].join("\n")
}
export interface DashboardData {
  project: Project
  iterations: { state: IterationState; artifacts: IterationArtifact[] }[]
  ledger?: CostLedger
  documents: string
  decisionCount?: number
  ship: Record<string, string>
  histories?: Record<string, ViewLine[]>
}

/** Only inert, validated readers here: no repair, owner open, shell, or accounting initialization. */
export async function loadDashboardData(selected: Project): Promise<DashboardData> {
  const project = await readProject(selected.root, selected.marker.id)
  const lifecycle = projectLifecycle(project)
  const iterations: DashboardData["iterations"] = []
  for (const number of Object.keys(lifecycle.iterations)
    .map(Number)
    .sort((a, b) => a - b)) {
    const reader = new HistoricalIterationReader(project, number)
    let state: IterationState
    try {
      state = await reader.read()
    } catch (error) {
      if (!(error instanceof ProjectStorageError) || error.code !== "missing") throw error
      state = initialIteration(project.marker.id, number)
    }
    const artifacts = await Promise.all(state.artifacts.map((ref) => reader.readArtifact(ref)))
    iterations.push({ state, artifacts })
  }
  const documents = await Promise.all(
    (["design.md", "decisions.md"] as const).map(
      async (name) => `${name}\n${await readDocument(project, name)}`,
    ),
  )
  const plans = (await new ShipStore(project).read()).plans
  const ship = Object.fromEntries(
    Object.keys(lifecycle.iterations).map((number) => {
      const plan = plans.findLast((plan) => plan.iteration === Number(number))
      return [number, plan ? shipSummary(plan) : `Ship: ${lifecycle.iterations[number]!.ship}. /project ship`]
    }),
  )
  return {
    project,
    iterations,
    ledger: await new FileCostPersistence(project).read(),
    documents: documents.join("\n\n"),
    decisionCount: (await new DecisionStore(project).records()).length,
    ship,
  }
}

/** Build one coherent cache. Aggregate costs live in labelled text, never row.cost. */
export function dashboardCache(
  data: DashboardData,
  cards: boolean,
): { snapshot: Snapshot; details: Map<string, Details> } {
  const { project, ledger } = data
  const lifecycle = projectLifecycle(project)
  const language = project.marker.settings.language ?? "en"
  const t = (en: string, zh: string, ja: string) => localize(language, en, zh, ja)
  const totals = ledger ? costRollups(ledger) : undefined
  const details = new Map<string, Details>()
  const stopped = ledger?.policy.latch
  const readOnly = t(
    "Read-only dashboard. Progress with /project commands.",
    "只读仪表盘。请使用 /project 命令推进。",
    "読み取り専用です。/project コマンドで進めてください。",
  )
  const snapshot: Snapshot = {
    workspace: project.root,
    note: `${t("Project cost", "项目花费", "プロジェクト費用")}: ${price(totals?.project)}. ${readOnly} Costs are labelled rollups, not agent-row totals.`,
    warning:
      [
        lifecycle.status !== "active"
          ? `${lifecycle.status} · ${t("Read-only. Restore explicitly with /project restore; no work resumes automatically.", "只读。请用 /project restore 明确恢复，不会自动启动工作。", "読み取り専用。/project restore で明示的に復元できます。作業は自動再開しません。")}`
          : "",
        stopped
          ? `${t("Budget stopped", "预算已停止", "予算により停止")} (${stopped.reason}). /project cost · ${price(totals?.project)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    phases: data.iterations.map(({ state, artifacts }) => {
      const iteration = lifecycle.iterations[state.iteration]!
      const ship = data.ship[state.iteration] ?? `Ship: ${iteration.ship}`
      const phaseId = `${project.marker.id}/${state.iteration}`
      const agents = stages.map((stage): Card => {
        const id = `${phaseId}/${stage}`
        const attempts = state.attempts.filter((attempt) => attempt.stage === stage)
        const current = stage === state.stage && state.phase !== "complete"
        const display = stage === "ship" ? undefined : stageDisplay(state, stage)
        let status: Status =
          display?.status ??
          (iteration.ship === "shipped" || iteration.ship === "skipped"
            ? "done"
            : iteration.ship === "blocked"
              ? "failed"
              : iteration.ship === "running"
                ? "running"
                : "idle")
        let outcome =
          display?.outcome ?? (iteration.ship === "skipped" ? "skipped (not passed)" : iteration.ship)
        if (stopped && current) {
          status = "stopped"
          outcome = "budget stopped"
        }
        const historical =
          lifecycle.status !== "active" || iteration.status !== "open" || iteration.continuationRequired
        if (historical && status === "running") {
          status = "stopped"
          outcome = "interrupted; read-only"
        }
        const owners =
          ledger?.owners.filter((owner) => owner.iteration === state.iteration && owner.stage === stage) ?? []
        const relevant = artifacts.filter((artifact) =>
          artifact.kind === "stage-summary"
            ? artifact.stage === stage
            : stage === "prototype"
              ? artifact.kind === "prototype-manifest"
              : stage === "implement"
                ? ["spec", "batch-plan", "batch-result", "correction", "iteration-worktree"].includes(
                    artifact.kind,
                  )
                : stage === "accept"
                  ? ["acceptance", "manual-trial"].includes(artifact.kind)
                  : false,
        )
        const output = relevant.map((artifact) => JSON.stringify(artifact, null, 2)).join("\n\n")
        const batches = (state.batchResolutions ?? [])
          .map(
            (resolution) =>
              `${resolution.batchId} [plan ${resolution.context.batchPlan?.artifactId ?? "unavailable"}]: ${resolution.status}${resolution.status === "skipped" ? " (not passed)" : ""}`,
          )
          .join(" · ")
        const evidence =
          attempts.length > 0 ||
          relevant.length > 0 ||
          owners.some((owner) => owner.snapshot || owner.unavailable || owner.provenance === "recovered")
        const stageCost = price(totals?.stages[`${state.iteration}/${stage}`], evidence)
        const title = stage === "ship" ? t("Ship", "发布", "リリース") : stageName(stage, language)
        const previous = attempts.filter((attempt) => !current || attempt.id !== display?.attempt?.id)
        const history = previous.map(
          (attempt) =>
            `Historical ${stage}${attempt.context?.batchId ? ` ${attempt.context.batchId}` : ""}: ${attempt.acceptance?.verdict ?? attempt.status} · ${attempt.id}`,
        )
        const facts = [
          ...((current || stage === "implement" || stage === "accept") && state.approvedContext?.batchId
            ? [`Batch ${state.approvedContext.batchId}`]
            : []),
          ...(display?.resolutionSummary ? [display.resolutionSummary] : []),
          ...(stage === "design" && data.decisionCount ? [`${data.decisionCount} project decisions`] : []),
          ...(relevant.length ? [`${relevant.length} output records`] : []),
          ...(previous.length ? [`${previous.length} historical attempts`] : []),
          ...(stopped && current
            ? [
                `${ledger?.policy.capUsd === undefined ? "Budget policy" : `Cap ${money(ledger.policy.capUsd)}`} · /project cost`,
              ]
            : []),
        ]
        const brief = facts.join(" · ") || "Read-only · /project commands"
        const summary = [
          ...(!cards
            ? [
                `${outcome}${historical ? " · read-only" : ""}`,
                `${t("Stage cost", "阶段花费", "段階費用")}: ${stageCost}`,
              ]
            : []),
          ...(state.approvedContext?.batchId
            ? [
                `Approved batch: ${state.approvedContext.batchId} [plan ${state.approvedContext.batchPlan?.artifactId ?? "unavailable"}]`,
              ]
            : []),
          ...(display?.resolutionSummary ? [display.resolutionSummary] : []),
          ...(batches ? [`Saved batch resolutions: ${batches}`] : []),
          ...(stage === "ship" ? [ship] : facts),
          readOnly,
        ].join("\n")
        details.set(id, {
          summary: lines(summary),
          logs: lines(
            attempts
              .map(
                (attempt) =>
                  `${current && attempt.id === display?.attempt?.id ? "Current" : "Historical"} ${attempt.context?.batchId ? `${attempt.context.batchId} · ` : ""}${attempt.id}: ${attempt.acceptance?.verdict ?? attempt.status}${attempt.staleReason ? ` · ${attempt.staleReason}` : ""}`,
              )
              .join("\n") || "No stage attempts recorded.",
          ),
          notes: lines(
            [
              `Iteration ${state.iteration}: ${iteration.status} · ${price(totals?.iterations[state.iteration], state.attempts.length > 0 || !!ledger?.owners.some((owner) => owner.iteration === state.iteration && (owner.snapshot || owner.unavailable)))}`,
              ...history,
            ].join("\n"),
          ),
          tabs: [
            {
              key: "outputs",
              label: t("Outputs", "产出", "成果"),
              render: () => lines(output || (stage === "ship" ? ship : "No output records.")),
            },
            { key: "documents", label: t("Documents", "文档", "文書"), render: () => lines(data.documents) },
            {
              key: "history",
              label: t("Owned history", "所属会话历史", "所有する会話履歴"),
              render: () =>
                owners.flatMap((owner) => [
                  { kind: "text" as const, text: `${owner.role} · ${owner.id ?? owner.key}` },
                  ...(data.histories?.[owner.key]
                    ? structuredClone(data.histories[owner.key]!)
                    : lines("History unavailable. No current-main navigation authority is assumed.")),
                ]),
            },
            {
              key: "costs",
              label: t("Costs", "花费", "費用"),
              render: () =>
                lines(
                  ledger
                    ? `${ledgerText(ledger)}\n\n${owners.map((owner) => `${owner.role} · ${owner.id ?? owner.key} · ${owner.batch ?? owner.variant ?? ""} · ${owner.runs.map((run) => `${run.kind}/${run.id}`).join(", ")}`).join("\n")}`
                    : "Accounting unavailable; not zero.",
                ),
            },
          ],
        })
        return {
          id,
          name: title,
          task: cards ? outcome : `${outcome} · cost: ${stageCost}`,
          status,
          // The fixed legacy source contract treats done + any note as early-stopped.
          // Keep successful/skipped cards done; their outcome stays explicit in task/details.
          ...(status === "done"
            ? {}
            : { note: `${outcome} · ${stageCost}${historical ? " · read-only" : ""}` }),
          ...(cards
            ? { card: { kind: "stage" as const, label: title, outcome, detail: brief, costText: stageCost } }
            : {}),
          files: [],
          actions: [],
        }
      })
      return {
        id: phaseId,
        name: `${project.marker.name} · Iteration ${state.iteration}`,
        status:
          iteration.status === "closed"
            ? iteration.ship === "shipped"
              ? "done"
              : "stopped"
            : agents[stages.indexOf(state.stage)]!.status,
        description: `${iteration.status} · cost: ${price(totals?.iterations[state.iteration], state.attempts.length > 0 || !!ledger?.owners.some((owner) => owner.iteration === state.iteration && (owner.snapshot || owner.unavailable)))}`,
        groups: [{ id: `${phaseId}/stages`, name: "Stages", agents }],
      }
    }),
  }
  return { snapshot, details }
}

/** Optional service discovery is bounded and independent of accounting/budget observers. */
export class ProjectDashboards {
  private service?: Sources
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  private readonly entries = new Map<
    string,
    {
      project: Project
      source: ProjectDashboardSource
      dispose?: () => void
      cache: ReturnType<typeof dashboardCache>
      listeners: Set<() => void>
      task?: Promise<void>
    }
  >()
  constructor(
    private readonly api: Pick<ExtensionAPI, "useService"> & Partial<Pick<ExtensionAPI, "conversations">>,
    private readonly load = loadDashboardData,
  ) {}
  track(project: Project): void {
    if (this.closed) return
    if (!this.entries.has(project.marker.id)) {
      const listeners = new Set<() => void>()
      const entry = {
        project,
        listeners,
        cache: {
          snapshot: { workspace: project.root, phases: [], note: "Loading project history…" },
          details: new Map<string, Details>(),
        },
        source: undefined as unknown as ProjectDashboardSource,
      }
      entry.source = {
        id: projectSourceId(project.marker.id),
        label: project.marker.name,
        snapshot: () => structuredClone(entry.cache.snapshot),
        details: (id) => {
          const value = entry.cache.details.get(id)
          return value
            ? {
                ...value,
                summary: structuredClone(value.summary),
                logs: structuredClone(value.logs),
                notes: structuredClone(value.notes),
              }
            : undefined
        },
        subscribe: (changed) => {
          if (this.closed) return () => {}
          listeners.add(changed)
          return () => {
            listeners.delete(changed)
          }
        },
      }
      this.entries.set(project.marker.id, entry)
    } else {
      const entry = this.entries.get(project.marker.id)!
      if (entry.project.root !== project.root) {
        entry.project = project
        // Do not let an older directory read publish over a newly attached root.
        void entry.task?.finally(() => {
          if (!this.closed) void this.refresh()
        })
      }
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh()
      }, 5000)
      this.timer.unref?.()
    }
    void this.refresh()
  }
  async refresh(): Promise<void> {
    if (this.closed) return
    let service: Sources | undefined
    try {
      service = dashboardSources(this.api.useService?.("dashboard.sources"))
    } catch {
      /* optional or unloaded */
    }
    if (this.service !== service) {
      for (const entry of this.entries.values()) {
        try {
          entry.dispose?.()
        } catch {
          /* already unloaded */
        }
        entry.dispose = undefined
      }
      this.service = service
    }
    // No optional UI means no history/document IO. Accounting has its own lifetime.
    if (!service) return
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.task) return entry.task
        const selected = entry.project
        entry.task = (async () => {
          try {
            const data = await this.load(selected)
            // Inert owner-authorized snapshots only, never open/focus an owned conversation
            // or route its IDs through current-main transcript/trace navigation.
            data.histories = {}
            if (this.api.conversations?.read) {
              await Promise.all(
                (data.ledger?.owners ?? []).map(async (owner) => {
                  try {
                    const saved = await this.api.conversations!.read(
                      owner.id ? { id: owner.id } : { key: owner.key },
                    )
                    data.histories![owner.key] = lines(
                      saved ? JSON.stringify(saved.history, null, 2) : "Owned history missing; not reopened.",
                    )
                  } catch (error) {
                    data.histories![owner.key] = lines(
                      `Owned history unavailable: ${error instanceof Error ? error.message : String(error)}`,
                    )
                  }
                }),
              )
            }
            if (this.closed || entry.project.root !== selected.root) return
            entry.project = data.project
            entry.cache = dashboardCache(data, this.service?.capabilities?.cards === true)
            entry.source.label = data.project.marker.name
          } catch (error) {
            if (this.closed || entry.project.root !== selected.root) return
            entry.cache = {
              snapshot: {
                workspace: entry.project.root,
                phases: [],
                note: "Read-only project source. Use /project status to inspect saved history, then reopen /dashboard.",
                warning: `Project history unavailable: ${error instanceof Error ? error.message : String(error)}. Use /project status.`,
              },
              details: new Map(),
            }
          }
          if (!entry.dispose && this.service) {
            try {
              entry.dispose = this.service.register(entry.source)
            } catch {
              /* closed registry; retry after replacement */
            }
          }
          for (const changed of entry.listeners) {
            try {
              changed()
            } catch {
              /* provider listener cannot break refresh */
            }
          }
        })().finally(() => {
          entry.task = undefined
        })
        return entry.task
      }),
    )
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    for (const entry of this.entries.values()) {
      try {
        entry.dispose?.()
      } catch {
        /* already unloaded */
      }
      entry.listeners.clear()
      entry.cache = {
        snapshot: {
          workspace: entry.project.root,
          phases: [],
          note: "Project extension unloaded. Reopen /dashboard after reloading.",
        },
        details: new Map(),
      }
    }
    this.entries.clear()
    this.service = undefined
  }
}
