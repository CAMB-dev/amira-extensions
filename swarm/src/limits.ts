import type { Budget } from "@amira/api"

/** The guardrails of one swarm. */
export interface SwarmLimits {
  /** Messages one member may send in all. */
  maxMessagesPerMember: number
  /** Messages the members may send in all (the user's and the commander's do not count). */
  maxMessages: number
  /** Turns each member runs at most; it ends after its last one. */
  maxTurnsPerMember: number
  /**
   * Rounds (every live member ending a turn once, on average) with messages but without any
   * blackboard change or finished part, after which the swarm pauses and asks the user.
   */
  noProgressRounds: number
  /** Messages two members may exchange back and forth while neither writes to the blackboard. */
  maxPairExchanges: number
  /** Members working at once; the agent tree's own limit still applies. */
  maxConcurrent?: number
  /**
   * Tokens and cost the whole swarm's agents may spend (cut to what the tree has left). The
   * commander's own turns, answering members, are the main session's and not counted here.
   */
  budget?: Budget
}

/** Tokens a swarm may spend unless the settings say otherwise: cache reads count too. */
export const DEFAULT_BUDGET_TOKENS = 3_000_000

export const DEFAULT_LIMITS: SwarmLimits = {
  maxMessagesPerMember: 30,
  maxMessages: 150,
  maxTurnsPerMember: 20,
  noProgressRounds: 3,
  maxPairExchanges: 8,
  budget: { tokens: DEFAULT_BUDGET_TOKENS },
}

/** The extension's settings: `extensions.swarm` in settings.json. */
export interface SwarmSettings {
  /**
   * When the model may start a swarm: "explicit" (the default) only after the user asked for
   * one (said "swarm", or typed `/swarm <goal>`), "always", or "never".
   */
  enabled: "explicit" | "always" | "never"
  /**
   * Ask the user before each start the model makes (default true). A start right after the
   * user typed `/swarm <goal>` is never asked about.
   */
  confirm: boolean
  /** Most members a swarm may have. */
  maxMembers: number
  limits: SwarmLimits
}

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined

/** Reads `extensions.swarm`; values that do not fit are reported and ignored. */
export function readSettings(raw: unknown, report: (problem: string) => void = () => {}): SwarmSettings {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const out: SwarmSettings = {
    enabled: "explicit",
    confirm: true,
    maxMembers: 6,
    limits: { ...DEFAULT_LIMITS },
  }
  if (s.enabled !== undefined) {
    if (s.enabled === "explicit" || s.enabled === "always" || s.enabled === "never") out.enabled = s.enabled
    else report('"extensions.swarm.enabled" must be "explicit", "always" or "never"')
  }
  if (s.confirm !== undefined) {
    if (typeof s.confirm === "boolean") out.confirm = s.confirm
    else report('"extensions.swarm.confirm" must be true or false')
  }
  if (s.maxMembers !== undefined) {
    const n = positive(s.maxMembers)
    if (n && n >= 2) out.maxMembers = n
    else report('"extensions.swarm.maxMembers" must be a whole number of at least 2')
  }
  const limits = s.limits && typeof s.limits === "object" ? (s.limits as Record<string, unknown>) : {}
  if (s.limits !== undefined && !(s.limits && typeof s.limits === "object"))
    report('"extensions.swarm.limits" must be an object')
  for (const key of [
    "maxMessagesPerMember",
    "maxMessages",
    "maxTurnsPerMember",
    "noProgressRounds",
    "maxPairExchanges",
    "maxConcurrent",
  ] as const) {
    if (limits[key] === undefined) continue
    const n = positive(limits[key])
    if (n) out.limits[key] = n
    else report(`"extensions.swarm.limits.${key}" must be a whole number of at least 1`)
  }
  const budget = limits.budget
  if (budget !== undefined) {
    const b = budget && typeof budget === "object" ? (budget as Record<string, unknown>) : undefined
    const tokens = positive(b?.tokens)
    const cost = typeof b?.costUsd === "number" && b.costUsd > 0 ? b.costUsd : undefined
    if (tokens || cost)
      out.limits.budget = { ...(tokens ? { tokens } : {}), ...(cost ? { costUsd: cost } : {}) }
    else report('"extensions.swarm.limits.budget" needs "tokens" or "costUsd"')
  }
  return out
}

/** Limits a start asks for, over the settings: each may only be lowered. */
export function withOverrides(base: SwarmLimits, asked: Record<string, unknown> | undefined): SwarmLimits {
  const out = { ...base }
  if (!asked) return out
  const map = {
    max_messages: "maxMessages",
    max_messages_per_member: "maxMessagesPerMember",
    max_turns_per_member: "maxTurnsPerMember",
  } as const
  for (const [param, key] of Object.entries(map)) {
    const n = positive(asked[param])
    if (n) out[key] = Math.min(out[key], n)
  }
  return out
}
