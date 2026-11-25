import type { GoalJudgeMode, GoalMode } from "./types.ts"

export type ParsedGoalCommand =
  | { kind: "dock" }
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop"; reason?: string }
  | { kind: "edit"; action: "add" | "rm" | "check"; value: string }
  | { kind: "help" }
  | {
      kind: "start"
      prompt: string
      mode: GoalMode
      verifyCommands: string[]
      judge: GoalJudgeMode
      maxIterations: number
      budgetUsd?: number
      requireCompleteTool: boolean
      noChecklist: boolean
    }

const DEFAULT_MAX_ITERATIONS = 15

/** Shell-like tokenizer preserving single and double quoted strings. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaping = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (escaping) current += "\\"
  if (current) tokens.push(current)
  return tokens
}

export function parseGoalArgs(raw: string): ParsedGoalCommand {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: "dock" }
  const tokens = tokenizeArgs(trimmed)
  const head = tokens[0]?.toLowerCase()

  if (head === "status") return { kind: "status" }
  if (head === "pause") return { kind: "pause" }
  if (head === "resume") return { kind: "resume" }
  if (head === "help" || head === "--help" || head === "-h") return { kind: "help" }
  if (head === "stop" || head === "cancel") {
    const reason = tokens.slice(1).join(" ").trim()
    return { kind: "stop", ...(reason ? { reason } : {}) }
  }
  if (head === "edit") {
    const sub = tokens[1]?.toLowerCase()
    const value = tokens.slice(2).join(" ").trim()
    if ((sub === "add" || sub === "rm" || sub === "check") && value) {
      return { kind: "edit", action: sub, value }
    }
    return { kind: "help" }
  }

  let mode: GoalMode = "session"
  const verifyCommands: string[] = []
  let judge: GoalJudgeMode = "none"
  let maxIterations = DEFAULT_MAX_ITERATIONS
  let budgetUsd: number | undefined
  let requireCompleteTool = true
  let noChecklist = false
  const promptParts: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const next = () => {
      const val = tokens[++i]
      if (val === undefined) throw new Error(`Missing value for ${token}`)
      return val
    }
    if (token === "--verify" || token === "-v") {
      verifyCommands.push(next())
    } else if (token === "--mode" || token === "-m") {
      const m = next().toLowerCase()
      if (m !== "session" && m !== "fresh") throw new Error(`Invalid --mode "${m}"; use session or fresh`)
      mode = m
    } else if (token === "--fresh") {
      mode = "fresh"
    } else if (token === "--judge" || token === "-j") {
      const j = next().toLowerCase()
      if (j !== "none" && j !== "llm" && j !== "verifier") {
        throw new Error(`Invalid --judge "${j}"; use none, llm, or verifier`)
      }
      judge = j
    } else if (token === "--max" || token === "--max-iterations") {
      const n = Number.parseInt(next(), 10)
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new Error(`Invalid --max value; expected integer 1..100`)
      }
      maxIterations = n
    } else if (token === "--budget") {
      const b = Number.parseFloat(next().replace(/^\$/, ""))
      if (!Number.isFinite(b) || b <= 0) throw new Error(`Invalid --budget value; expected positive USD`)
      budgetUsd = b
    } else if (token === "--no-complete-tool") {
      requireCompleteTool = false
    } else if (token === "--now" || token === "--no-checklist") {
      noChecklist = true
    } else {
      promptParts.push(token)
    }
  }

  const prompt = promptParts.join(" ").trim()
  if (!prompt) throw new Error("Goal prompt is required. Usage: /goal <objective> [--verify <cmd>]")

  return {
    kind: "start",
    prompt,
    mode,
    verifyCommands,
    judge,
    maxIterations,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    requireCompleteTool,
    noChecklist,
  }
}

export const GOAL_SUBCOMMANDS = [
  { text: "status", label: "status", description: "Show current goal progress & verification log" },
  { text: "pause", label: "pause", description: "Pause the active goal loop" },
  { text: "resume", label: "resume", description: "Resume a paused goal loop" },
  { text: "stop", label: "stop", description: "Stop and clear the active goal" },
  { text: "edit add ", label: "edit add", description: "Add a completion criterion to the active goal" },
  { text: "edit rm ", label: "edit rm", description: "Remove a criterion by id or index" },
  { text: "help", label: "help", description: "Show /goal flags and examples" },
] as const

export const GOAL_FLAGS = [
  { text: "--verify ", label: "--verify", description: "Shell command that must exit 0 to pass" },
  { text: "--mode fresh", label: "--mode fresh", description: "Run each iteration in fresh context (Ralph)" },
  { text: "--mode session", label: "--mode session", description: "Continue inside the main session" },
  { text: "--judge llm", label: "--judge llm", description: "Add fast LLM semantic verification" },
  { text: "--judge verifier", label: "--judge verifier", description: "Spawn read-only verifier subagent" },
  { text: "--max ", label: "--max", description: "Maximum continuation iterations (1-100, default 15)" },
  { text: "--budget ", label: "--budget", description: "Stop if spend exceeds USD budget (e.g. 2.5)" },
  { text: "--now", label: "--now", description: "Skip criteria preview and start immediately" },
] as const
