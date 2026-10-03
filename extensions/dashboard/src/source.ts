import type { TraceSummary, UiNode, ViewLine } from "@amira/api"

export type DashboardStatus = "queued" | "running" | "idle" | "paused" | "done" | "failed" | "stopped"
export type DashboardAction = "pause" | "resume" | "stop" | "request-changes"

export interface DashboardFile {
  path: string
  /** Actual diff lines, when supplied by the source. Paths alone are not a diff. */
  diff?: ViewLine[]
}

export interface DashboardAgent {
  id: string
  /** Child session ID for host-authorized transcript and trace navigation. */
  sessionId?: string
  name: string
  task: string
  status: DashboardStatus
  startedAt?: number
  durationMs?: number
  cost?: number
  language?: string
  /** A known fraction, not an estimate from tool counts. Omit when unknown. */
  progress?: number
  files: DashboardFile[]
  actions: DashboardAction[]
}

export interface DashboardGroup {
  id: string
  name: string
  ref?: string
  agents: DashboardAgent[]
}

export interface DashboardPhase {
  id: string
  name: string
  groups: DashboardGroup[]
}

export interface DashboardSnapshot {
  workspace: string
  phases: DashboardPhase[]
  note?: string
}

export interface DashboardTab {
  /** Stable, unique key; summary/diff/logs/actions/stats are reserved. */
  key: string
  label: string
  /** Synchronous, side-effect-free content. Widget IDs need only be unique within this tab. */
  render(): UiNode | ViewLine[]
}

export interface DashboardDetails {
  summary: ViewLine[]
  logs: ViewLine[]
  stats?: TraceSummary
  tabs?: DashboardTab[]
}

/** Synchronous, side-effect-free reads: adapters cache asynchronous work before rendering. */
export interface DashboardSource {
  /** Stable service-wide ID; "agents" and "trace" are reserved. */
  id: string
  label: string
  snapshot(): DashboardSnapshot
  details(agentId: string): DashboardDetails | undefined
  /** Optional change notification. The returned function releases the subscription. */
  subscribe?(changed: () => void): () => void
  /** Capability must also be present in the agent's actions. A result is user-facing text. */
  act?(agentId: string, action: DashboardAction, text?: string): string | Promise<string>
}

export interface DashboardSources {
  register(source: DashboardSource): () => void
}

declare module "@amira/api" {
  interface AmiraServices {
    "dashboard.sources": DashboardSources
  }
}

export const agentsOf = (snapshot: DashboardSnapshot): DashboardAgent[] =>
  snapshot.phases.flatMap((phase) => phase.groups.flatMap((group) => group.agents))

export function languageOf(files: DashboardFile[]): string | undefined {
  const languages: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    rs: "Rust",
    go: "Go",
    md: "Markdown",
    sql: "SQL",
  }
  const found = new Set(
    files.flatMap(({ path }) => {
      const language = languages[path.split(".").at(-1)?.toLowerCase() ?? ""]
      return language ? [language] : []
    }),
  )
  return found.size === 1 ? [...found][0] : undefined
}
