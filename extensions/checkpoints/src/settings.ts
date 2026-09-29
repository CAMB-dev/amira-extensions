import { DEFAULT_STORE_LIMITS, type StoreLimits } from "./store.ts"

/** The extension's settings: `extensions.checkpoints` in settings.json. */
export interface CheckpointSettings extends StoreLimits {
  /** Take checkpoints at all. */
  enabled: boolean
  /** Checkpoints kept per session; older ones are removed. */
  keep: number
  /** Checkpoints of any session older than this many days are removed at startup. */
  maxAgeDays: number
  /**
   * Also take one before each call of these tools (when something changed since the last
   * one), e.g. ["edit", "write", "bash", "powershell"]. Empty: only before each turn.
   */
  beforeTools: string[]
  /** Outside a git repository: "shadow" keeps snapshots in a repository of Amira's own; "off". */
  nonGit: "shadow" | "off"
  /** How long one snapshot may take before the turn goes on without it. */
  timeoutMs: number
}

export const MUTATING_TOOLS = ["edit", "write", "bash", "powershell"]

export const DEFAULT_SETTINGS: CheckpointSettings = {
  enabled: true,
  keep: 50,
  maxAgeDays: 30,
  beforeTools: [],
  nonGit: "shadow",
  timeoutMs: 30_000,
  ...DEFAULT_STORE_LIMITS,
}

const whole = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : undefined

/** Reads `extensions.checkpoints`; values that do not fit are reported and ignored. */
export function readSettings(raw: unknown, report: (problem: string) => void = () => {}): CheckpointSettings {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const out: CheckpointSettings = { ...DEFAULT_SETTINGS, beforeTools: [] }
  const key = (k: string) => `"extensions.checkpoints.${k}"`
  if (s.enabled !== undefined) {
    if (typeof s.enabled === "boolean") out.enabled = s.enabled
    else report(`${key("enabled")} must be true or false`)
  }
  if (s.beforeTools !== undefined) {
    if (s.beforeTools === true) out.beforeTools = [...MUTATING_TOOLS]
    else if (s.beforeTools === false) out.beforeTools = []
    else if (Array.isArray(s.beforeTools) && s.beforeTools.every((t) => typeof t === "string"))
      out.beforeTools = [...s.beforeTools]
    else report(`${key("beforeTools")} must be true, false or a list of tool names`)
  }
  if (s.nonGit !== undefined) {
    if (s.nonGit === "shadow" || s.nonGit === "off") out.nonGit = s.nonGit
    else report(`${key("nonGit")} must be "shadow" or "off"`)
  }
  const numbers: [keyof CheckpointSettings, number][] = [
    ["keep", 1],
    ["maxAgeDays", 1],
    ["timeoutMs", 1000],
    ["maxFileBytes", 1],
    ["maxUntrackedFiles", 0],
    ["maxUntrackedBytes", 1],
  ]
  for (const [k, min] of numbers) {
    if (s[k] === undefined) continue
    const n = whole(s[k], min)
    if (n !== undefined) (out as unknown as Record<string, number>)[k] = n
    else report(`${key(k)} must be a whole number of at least ${min}`)
  }
  return out
}
