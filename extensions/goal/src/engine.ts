import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { AssistantMessage, ExtensionAPI, OwnedConversation } from "@amira/api"
import type {
  GoalConfig,
  GoalCriterion,
  GoalRunRequest,
  GoalRunResult,
  GoalState,
  GoalStatusSnapshot,
} from "./types.ts"
import { extractAssistantText, runVerification, workspaceDiffHash } from "./verifiers.ts"

const STUCK_THRESHOLD = 3
const SESSION_DATA_KEY = "goal.state"

export class GoalEngine {
  #api: ExtensionAPI
  #state: GoalState | undefined
  #completeClaimed = false
  #completeSummary: string | undefined
  #freshConv: OwnedConversation | undefined
  #freshAbort: AbortController | undefined
  #waiters: ((result: GoalRunResult) => void)[] = []
  #onChange: () => void

  constructor(api: ExtensionAPI, onChange: () => void) {
    this.#api = api
    this.#onChange = onChange
  }

  get state(): GoalState | undefined {
    return this.#state
  }

  snapshot(): GoalStatusSnapshot | undefined {
    const s = this.#state
    if (!s) return undefined
    return {
      id: s.id,
      prompt: s.config.prompt,
      phase: s.phase,
      mode: s.config.mode,
      iteration: s.iteration,
      maxIterations: s.config.maxIterations,
      spentUsd: s.spentUsd,
      ...(s.config.budgetUsd !== undefined ? { budgetUsd: s.config.budgetUsd } : {}),
      criteria: s.config.criteria.map((c) => ({ ...c })),
      ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}),
      ...(s.logs.length ? { lastLog: s.logs[s.logs.length - 1] } : {}),
    }
  }

  restoreFromSession(): void {
    const records = this.#api.session()?.data?.read(SESSION_DATA_KEY)
    if (!records?.length) return
    const last = records[records.length - 1] as GoalState | undefined
    if (!last || typeof last !== "object" || !last.config?.prompt) return
    if (last.phase === "running" || last.phase === "verifying") {
      this.#state = {
        ...last,
        phase: "paused",
        pauseReason: "Restored from previous session — run /goal resume to continue.",
      }
    } else if (last.phase === "paused") {
      this.#state = last
    }
    this.#onChange()
  }

  #persist(): void {
    if (!this.#state) return
    this.#state.updatedAt = Date.now()
    try {
      this.#api.session()?.data?.append(SESSION_DATA_KEY, structuredClone(this.#state))
    } catch {
      // Session data may be absent in minimal hosts.
    }
    try {
      const file = path.join(this.#api.dataDir, "active-goal.json")
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(this.#state, null, 2), "utf8")
    } catch {
      // Best-effort durable mirror for fresh-context mode.
    }
  }

  #currentSessionSpend(): number {
    const usage = this.#api.session()?.usage?.()
    if (usage) return usage.total.knownCostUsd
    return 0
  }

  #refreshSpend(extraUsd = 0): number {
    if (!this.#state) return 0
    const delta = Math.max(0, this.#currentSessionSpend() - this.#state.baselineCostUsd)
    this.#state.spentUsd = Number((delta + extraUsd).toFixed(6))
    return this.#state.spentUsd
  }

  start(config: GoalConfig): GoalState {
    if (this.#state && (this.#state.phase === "running" || this.#state.phase === "verifying")) {
      throw new Error("A goal is already running. Use /goal pause or /goal stop first.")
    }
    this.#completeClaimed = false
    this.#completeSummary = undefined
    const now = Date.now()
    this.#state = {
      id: `g_${randomUUID().slice(0, 8)}`,
      config: {
        ...config,
        criteria: config.criteria.length
          ? config.criteria.map((c) => ({ ...c }))
          : [{ id: "c1", text: config.prompt, done: false }],
      },
      phase: "running",
      iteration: 0,
      startedAt: now,
      updatedAt: now,
      baselineCostUsd: this.#currentSessionSpend(),
      spentUsd: 0,
      recentFailures: [],
      reflectionUsed: false,
      logs: [],
    }
    this.#persist()
    this.#onChange()
    return this.#state
  }

  claimComplete(
    summary: string,
    criteriaUpdates?: { id: string; done: boolean; evidence?: string }[],
  ): string {
    if (!this.#state || (this.#state.phase !== "running" && this.#state.phase !== "verifying")) {
      return "No active goal is currently running."
    }
    if (criteriaUpdates?.length) {
      for (const update of criteriaUpdates) {
        const match = this.#state.config.criteria.find((c) => c.id === update.id)
        if (match) {
          match.done = update.done
          if (update.evidence) match.evidence = update.evidence
        }
      }
    } else {
      for (const c of this.#state.config.criteria) c.done = true
    }
    this.#completeClaimed = true
    this.#completeSummary = summary.trim() || "Goal claimed complete."
    this.#persist()
    this.#onChange()
    return `Completion claim recorded (${this.#state.config.criteria.filter((c) => c.done).length}/${this.#state.config.criteria.length} criteria marked done). Verification will run when this turn finishes.`
  }

  addCriterion(text: string): GoalCriterion {
    if (!this.#state) throw new Error("No active goal to edit.")
    const nextNum = this.#state.config.criteria.length + 1
    const item: GoalCriterion = { id: `c${nextNum}`, text: text.trim(), done: false }
    this.#state.config.criteria.push(item)
    this.#completeClaimed = false
    this.#persist()
    this.#onChange()
    return item
  }

  removeCriterion(target: string): boolean {
    if (!this.#state) throw new Error("No active goal to edit.")
    const idx = this.#state.config.criteria.findIndex((c, i) => c.id === target || String(i + 1) === target)
    if (idx === -1) return false
    this.#state.config.criteria.splice(idx, 1)
    this.#persist()
    this.#onChange()
    return true
  }

  toggleCriterion(target: string): boolean {
    if (!this.#state) throw new Error("No active goal to edit.")
    const item = this.#state.config.criteria.find((c, i) => c.id === target || String(i + 1) === target)
    if (!item) return false
    item.done = !item.done
    this.#persist()
    this.#onChange()
    return true
  }

  pause(reason = "Paused by user"): void {
    if (!this.#state) return
    if (this.#state.phase === "completed" || this.#state.phase === "stopped") return
    this.#freshAbort?.abort(new Error(reason))
    this.#state.phase = "paused"
    this.#state.pauseReason = reason
    this.#persist()
    this.#onChange()
  }

  resume(): GoalState {
    if (this.#state?.phase !== "paused") {
      throw new Error("No paused goal to resume.")
    }
    this.#state.phase = "running"
    this.#state.pauseReason = undefined
    this.#state.recentFailures = []
    this.#state.reflectionUsed = false
    this.#completeClaimed = false
    this.#persist()
    this.#onChange()
    return this.#state
  }

  async stop(reason = "Stopped by user"): Promise<void> {
    this.#freshAbort?.abort(new Error(reason))
    if (this.#freshConv) {
      await this.#freshConv.release().catch(() => {})
      this.#freshConv = undefined
    }
    if (!this.#state) return
    const finalState = this.#state
    finalState.phase = "stopped"
    finalState.pauseReason = reason
    this.#persist()
    this.#resolveWaiters({
      id: finalState.id,
      status: "stopped",
      iterations: finalState.iteration,
      summary: reason,
      spentUsd: finalState.spentUsd,
    })
    this.#onChange()
  }

  /** Build the system prompt section injected on every model call while a goal is active. */
  buildSystemSection(): string | undefined {
    const s = this.#state
    if (!s || (s.phase !== "running" && s.phase !== "verifying")) return undefined
    const lines = [
      `Active Goal (${s.id}, iteration ${s.iteration + 1}/${s.config.maxIterations}):`,
      `Objective: ${s.config.prompt}`,
      "Acceptance Criteria:",
      ...s.config.criteria.map(
        (c) => `- [${c.done ? "x" : " "}] (${c.id}) ${c.text}${c.evidence ? ` — ${c.evidence}` : ""}`,
      ),
    ]
    if (s.config.verifyCommands.length) {
      lines.push("Verification commands that MUST pass (exit 0):")
      for (const cmd of s.config.verifyCommands) lines.push(`- \`${cmd}\``)
    }
    if (s.config.requireCompleteTool) {
      lines.push(
        "Execution contract: Keep working until EVERY criterion and verification command passes. Do NOT stop early to report intermediate progress. When truly done, call `goal_complete` with concrete evidence.",
      )
    }
    const pairPeers = this.#connectedPairPeers()
    if (pairPeers.length > 0) {
      lines.push(
        `Connected Pair teammates available: ${pairPeers.join(", ")}. If you encounter genuine requirement or contract ambiguity while pursuing this goal, you may call \`pair_ask\` to clarify with the relevant teammate and then continue executing.`,
      )
    }
    return lines.join("\n")
  }

  #connectedPairPeers(): string[] {
    const fn = this.#api.useService("pair.peers" as never) as
      | (() => { name?: string; role?: string }[])
      | undefined
    if (typeof fn !== "function") return []
    try {
      const peers = fn()
      if (!Array.isArray(peers)) return []
      return peers.map((p) => (p.name ? (p.role ? `${p.name} (${p.role})` : p.name) : "")).filter(Boolean)
    } catch {
      return []
    }
  }

  /** Called from `turn.beforeEnd` interceptor in `session` mode. */
  async onBeforeTurnEnd(
    lastMessage: AssistantMessage,
    signal: AbortSignal,
  ): Promise<{ block: false } | { block: true; reason: string; displayText: string }> {
    const s = this.#state
    if (s?.config.mode !== "session" || s.phase !== "running") return { block: false }

    s.iteration++
    const spent = this.#refreshSpend()

    // Check budget cap before spending more.
    if (s.config.budgetUsd !== undefined && spent >= s.config.budgetUsd) {
      this.#pauseWith(
        `Budget cap reached ($${spent.toFixed(4)} / $${s.config.budgetUsd.toFixed(2)}).`,
        "paused",
      )
      return { block: false }
    }

    s.phase = "verifying"
    this.#onChange()

    try {
      const verdict = await runVerification({
        api: this.#api,
        config: s.config,
        lastMessageText: extractAssistantText(lastMessage),
        completeToolCalled: this.#completeClaimed,
        completeToolSummary: this.#completeSummary,
        signal,
      })

      if (signal.aborted) {
        this.pause("Interrupted by user (Esc).")
        return { block: false }
      }

      s.logs.push({
        iteration: s.iteration,
        timestamp: Date.now(),
        ok: verdict.ok,
        summary: verdict.summary,
        ...(verdict.details ? { details: verdict.details } : {}),
      })
      if (s.logs.length > 30) s.logs.splice(0, s.logs.length - 30)

      if (verdict.ok) {
        s.phase = "completed"
        s.completedSummary = this.#completeSummary ?? verdict.summary
        this.#refreshSpend()
        this.#persist()
        this.#api.notify(`Goal completed in ${s.iteration} iteration(s): ${s.completedSummary}`, "info")
        this.#resolveWaiters({
          id: s.id,
          status: "completed",
          iterations: s.iteration,
          summary: s.completedSummary,
          spentUsd: s.spentUsd,
        })
        this.#onChange()
        return { block: false }
      }

      // Reset completion claim so the next turn must re-verify & re-claim.
      this.#completeClaimed = false
      this.#completeSummary = undefined

      // Check max iteration cap.
      if (s.iteration >= s.config.maxIterations) {
        this.#pauseWith(
          `Reached max iterations (${s.iteration}/${s.config.maxIterations}). Last check: ${verdict.summary}`,
          "paused",
        )
        return { block: false }
      }

      // Stuck / no-progress detection with 1-shot reflection recovery.
      const diffHash = await workspaceDiffHash(this.#api, signal)
      const failHash = verdict.failureHash ?? "unknown"
      s.recentFailures.push({ hash: failHash, diffHash })
      if (s.recentFailures.length > STUCK_THRESHOLD) s.recentFailures.shift()

      const isStuck =
        s.recentFailures.length === STUCK_THRESHOLD &&
        s.recentFailures.every(
          (f) => f.hash === failHash && (diffHash === "no-git" || f.diffHash === diffHash),
        )

      if (isStuck) {
        if (!s.reflectionUsed) {
          s.reflectionUsed = true
          s.recentFailures = []
          s.phase = "running"
          this.#persist()
          this.#onChange()
          return {
            block: true,
            displayText: `Goal ${s.iteration}/${s.config.maxIterations}: stuck detected — changing approach`,
            reason: [
              `Stuck detection triggered: the same failure occurred ${STUCK_THRESHOLD} times in a row without progress.`,
              verdict.reason,
              "Stop repeating the same tactic. Step back, re-read the relevant source files from scratch, form a new hypothesis, and try a genuinely different approach.",
            ].join("\n\n"),
          }
        }
        this.#pauseWith(
          `Goal paused (stuck after strategy shift): ${verdict.summary}. Inspect logs and /goal resume when ready.`,
          "paused",
        )
        return { block: false }
      }

      s.phase = "running"
      this.#persist()
      this.#onChange()
      return {
        block: true,
        displayText: `Goal ${s.iteration}/${s.config.maxIterations}: ${verdict.summary}`,
        reason: `[Goal Iteration ${s.iteration + 1}/${s.config.maxIterations}]\n\n${verdict.reason}`,
      }
    } catch (err) {
      if (signal.aborted) {
        this.pause("Interrupted by user (Esc).")
        return { block: false }
      }
      const msg = err instanceof Error ? err.message : String(err)
      s.logs.push({
        iteration: s.iteration,
        timestamp: Date.now(),
        ok: false,
        summary: `Verifier error: ${msg}`,
      })
      this.#pauseWith(`Verifier failed unexpectedly: ${msg}`, "paused")
      return { block: false }
    }
  }

  /** Handle `turn.end` for user Esc aborts or budget exhaustion. */
  onTurnEnd(data: { reason: string; abortCause?: string }): void {
    const s = this.#state
    if (s?.config.mode !== "session") return
    if (s.phase !== "running" && s.phase !== "verifying") return
    if (data.reason === "aborted") {
      const msg =
        data.abortCause === "budget"
          ? "Paused: session budget exceeded."
          : "Paused: interrupted by user (Esc). Run /goal resume to continue."
      this.#pauseWith(msg, "paused")
    }
  }

  /** Fresh-context Ralph loop via OwnedConversation (each iteration starts clean from disk state). */
  async runFreshLoop(): Promise<GoalRunResult> {
    const s = this.#state
    if (!s) throw new Error("No active goal")
    const conversations = this.#api.conversations
    if (!conversations) {
      this.#pauseWith("Fresh mode requires host OwnedConversations support.", "failed")
      return {
        id: s.id,
        status: "failed",
        iterations: 0,
        summary: s.pauseReason ?? "Unavailable",
        spentUsd: 0,
      }
    }

    const abort = new AbortController()
    this.#freshAbort = abort
    const onUnload = () => abort.abort(new Error("unloaded"))
    this.#api.signal?.addEventListener("abort", onUnload, { once: true })

    let lastFailureReason = ""
    let freshCost = 0

    try {
      while (s.phase === "running" && !abort.signal.aborted) {
        if (s.iteration >= s.config.maxIterations) {
          this.#pauseWith(`Reached max iterations (${s.iteration}/${s.config.maxIterations}).`, "paused")
          break
        }
        if (s.config.budgetUsd !== undefined && freshCost >= s.config.budgetUsd) {
          this.#pauseWith(
            `Budget cap reached ($${freshCost.toFixed(4)} / $${s.config.budgetUsd.toFixed(2)}).`,
            "paused",
          )
          break
        }

        s.iteration++
        this.#completeClaimed = false
        this.#completeSummary = undefined
        this.#persist()
        this.#onChange()

        const conv = await conversations.openOrCreate(
          {
            key: `goal/${s.id}/iter-${s.iteration}`,
            name: `Goal ${s.id} #${s.iteration}`,
            cwd: this.#api.cwd,
            systemPrompt: this.buildSystemSection() ?? `Goal: ${s.config.prompt}`,
            callableTools: ["read", "edit", "write", "glob", "grep", "bash", "powershell", "goal_complete"],
            descendants: "inherit",
            ephemeral: true,
          },
          {
            askUser: async (questions, ctx) =>
              this.#api.ui.ask(questions, { sessionId: ctx.sessionId, signal: ctx.signal }),
          },
        )
        this.#freshConv = conv

        const progressPrompt = [
          `Fresh-context Ralph iteration ${s.iteration}/${s.config.maxIterations}.`,
          `Objective: ${s.config.prompt}`,
          "Criteria:",
          ...s.config.criteria.map((c) => `- [${c.done ? "x" : " "}] (${c.id}) ${c.text}`),
          lastFailureReason ? `Previous iteration verification feedback:\n${lastFailureReason}` : "",
          "Inspect the current workspace state, make concrete progress, verify your work, and call `goal_complete` once all criteria pass.",
        ]
          .filter(Boolean)
          .join("\n\n")

        let lastText = ""
        try {
          await conv.send(progressPrompt, { signal: abort.signal })
          const history = conv.history()
          const lastAssistant = history.findLast((m) => m.role === "assistant")
          if (lastAssistant && lastAssistant.role === "assistant") {
            lastText = extractAssistantText(lastAssistant)
          }
          freshCost += conv.usage().total.knownCostUsd
          this.#refreshSpend(freshCost)
        } finally {
          await conv.release().catch(() => {})
          if (this.#freshConv === conv) this.#freshConv = undefined
        }

        if (abort.signal.aborted) break

        s.phase = "verifying"
        this.#onChange()
        const verdict = await runVerification({
          api: this.#api,
          config: s.config,
          lastMessageText: lastText,
          completeToolCalled: this.#completeClaimed,
          completeToolSummary: this.#completeSummary,
          signal: abort.signal,
        })

        s.logs.push({
          iteration: s.iteration,
          timestamp: Date.now(),
          ok: verdict.ok,
          summary: verdict.summary,
          ...(verdict.details ? { details: verdict.details } : {}),
        })

        if (verdict.ok) {
          s.phase = "completed"
          s.completedSummary = this.#completeSummary ?? verdict.summary
          this.#persist()
          this.#api.notify(
            `Goal completed (fresh mode) in ${s.iteration} iteration(s): ${s.completedSummary}`,
            "info",
          )
          const result: GoalRunResult = {
            id: s.id,
            status: "completed",
            iterations: s.iteration,
            summary: s.completedSummary,
            spentUsd: s.spentUsd,
          }
          this.#resolveWaiters(result)
          this.#onChange()
          return result
        }

        const diffHash = await workspaceDiffHash(this.#api, abort.signal)
        const failHash = verdict.failureHash ?? "unknown"
        s.recentFailures.push({ hash: failHash, diffHash })
        if (s.recentFailures.length > STUCK_THRESHOLD) s.recentFailures.shift()
        const isStuck =
          s.recentFailures.length === STUCK_THRESHOLD &&
          s.recentFailures.every(
            (f) => f.hash === failHash && (diffHash === "no-git" || f.diffHash === diffHash),
          )
        if (isStuck) {
          if (!s.reflectionUsed) {
            s.reflectionUsed = true
            s.recentFailures = []
            lastFailureReason = `STUCK WARNING: Same failure repeated ${STUCK_THRESHOLD} times. Change strategy completely.\n\n${verdict.reason}`
          } else {
            this.#pauseWith(`Paused (stuck in fresh mode): ${verdict.summary}`, "paused")
            break
          }
        } else {
          lastFailureReason = verdict.reason
        }
        s.phase = "running"
        this.#persist()
        this.#onChange()
      }
    } finally {
      this.#api.signal?.removeEventListener("abort", onUnload)
      if (this.#freshAbort === abort) this.#freshAbort = undefined
    }

    const status =
      s.phase === "completed"
        ? "completed"
        : s.phase === "stopped"
          ? "stopped"
          : s.phase === "failed"
            ? "failed"
            : "paused"
    const res: GoalRunResult = {
      id: s.id,
      status,
      iterations: s.iteration,
      summary: s.completedSummary ?? s.pauseReason ?? "Goal stopped",
      spentUsd: s.spentUsd,
    }
    this.#resolveWaiters(res)
    return res
  }

  /** Programmatic service entry point (`goal.run`) for `project` or other extensions. */
  async runService(req: GoalRunRequest): Promise<GoalRunResult> {
    const config: GoalConfig = {
      prompt: req.prompt,
      mode: req.mode ?? "session",
      verifyCommands: req.verifyCommands ?? [],
      judge: req.judge ?? "none",
      maxIterations: req.maxIterations ?? 15,
      ...(req.budgetUsd !== undefined ? { budgetUsd: req.budgetUsd } : {}),
      requireCompleteTool: req.requireCompleteTool ?? true,
      criteria: (req.criteria?.length ? req.criteria : [req.prompt]).map((text, idx) => ({
        id: `c${idx + 1}`,
        text,
        done: false,
      })),
    }
    this.start(config)
    if (config.mode === "fresh") {
      return this.runFreshLoop()
    }
    const done = new Promise<GoalRunResult>((resolve) => this.#waiters.push(resolve))
    const session = this.#api.session()
    if (!session) throw new Error("No active session to drive goal.run")
    await session.send(config.prompt, { display: { text: `/goal ${config.prompt}`, origin: "goal" } })
    return done
  }

  #pauseWith(reason: string, phase: "paused" | "failed"): void {
    if (!this.#state) return
    this.#state.phase = phase
    this.#state.pauseReason = reason
    this.#persist()
    this.#api.notify(reason, phase === "failed" ? "error" : "warning")
    this.#resolveWaiters({
      id: this.#state.id,
      status: phase,
      iterations: this.#state.iteration,
      summary: reason,
      spentUsd: this.#state.spentUsd,
    })
    this.#onChange()
  }

  #resolveWaiters(result: GoalRunResult): void {
    for (const resolve of this.#waiters.splice(0)) resolve(result)
  }

  dispose(): void {
    this.#freshAbort?.abort(new Error("disposed"))
    void this.#freshConv?.release().catch(() => {})
    this.#freshConv = undefined
  }
}

export function readPersistedGoalFile(dataDir: string): GoalState | undefined {
  try {
    const raw = readFileSync(path.join(dataDir, "active-goal.json"), "utf8")
    return JSON.parse(raw) as GoalState
  } catch {
    return undefined
  }
}
