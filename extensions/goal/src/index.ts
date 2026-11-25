import {
  defineExtension,
  defineTool,
  type ExtensionAPI,
  type FrontendView,
  textResult,
  withSection,
} from "@amira/api"
import { GOAL_FLAGS, GOAL_SUBCOMMANDS, parseGoalArgs } from "./args.ts"
import { GoalEngine } from "./engine.ts"
import type { GoalConfig } from "./types.ts"
import { proposeCriteria } from "./verifiers.ts"
import { createGoalPanel, createGoalStatusItem, createGoalView, GOAL_VIEW_KIND } from "./view.ts"

const HELP_TEXT = [
  "Usage: /goal <objective> [options]",
  "",
  "Options:",
  "  --verify <cmd>         Shell command that must exit 0 (repeatable)",
  "  --mode session|fresh   Continue in main session (default) or fresh Ralph iterations",
  "  --judge none|llm|verifier  Optional semantic verifier (default: none)",
  "  --max <N>              Max iterations (1..100, default: 15)",
  "  --budget <USD>         Stop if spend reaches USD cap (e.g. --budget 2.5)",
  "  --now                  Skip criteria preview and start immediately",
  "  --no-complete-tool     Do not require explicit goal_complete tool call",
  "",
  "Subcommands:",
  "  /goal                  Open Goal dock",
  "  /goal status           Print current goal status & verify history",
  "  /goal pause | resume   Pause or resume the active goal",
  "  /goal stop [reason]    Stop the active goal",
  "  /goal edit add <text>  Add an acceptance criterion",
  "  /goal edit rm <id|#>   Remove an acceptance criterion",
].join("\n")

export default defineExtension((api: ExtensionAPI) => {
  const openDock = (): boolean => {
    const view: FrontendView = { kind: GOAL_VIEW_KIND, placement: "dock", data: {} }
    return api.openView?.(view) ?? false
  }

  const engine = new GoalEngine(api, () => {
    api.requestRender()
  })

  const resumeInCurrentMode = async () => {
    try {
      const resumed = engine.resume()
      if (resumed.config.mode === "fresh") {
        void engine.runFreshLoop()
        return
      }
      const session = api.session()
      if (!session) return
      await session.send(
        `Resume active goal (${resumed.id}): ${resumed.config.prompt}\nCheck current progress and continue until verified, then call \`goal_complete\`.`,
        { display: { text: `/goal resume (${resumed.id})`, origin: "goal" } },
      )
    } catch (err) {
      api.notify(err instanceof Error ? err.message : String(err), "warning")
    }
  }

  api.registerStatusItem(createGoalStatusItem(engine))
  api.registerPanel(createGoalPanel(engine))
  api.registerView(
    createGoalView(engine, {
      onPause: () => engine.pause("Paused from Goal dock."),
      onResume: () => void resumeInCurrentMode(),
      onStop: () => void engine.stop("Stopped from Goal dock."),
    }),
  )

  api.registerTool(
    defineTool<{
      summary: string
      criteria?: { id: string; done: boolean; evidence?: string }[]
    }>({
      name: "goal_complete",
      description:
        "Signal that the active /goal objective and all acceptance criteria are genuinely finished and verified. Host verification commands/judges still run before stopping.",
      mainOnly: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: { type: "string", description: "Concise summary of what was accomplished and verified." },
          criteria: {
            type: "array",
            description: "Optional status updates for each acceptance criterion by id.",
            items: {
              type: "object",
              required: ["id", "done"],
              properties: {
                id: { type: "string" },
                done: { type: "boolean" },
                evidence: { type: "string" },
              },
            },
          },
        },
      },
      async execute({ summary, criteria }) {
        return textResult(engine.claimComplete(summary, criteria))
      },
    }),
  )

  api.intercept("system.build", (value) => {
    const section = engine.buildSystemSection()
    if (!section) return { action: "pass" }
    return { action: "modify", value: { sections: withSection(value.sections, "goal", section) } }
  })

  api.intercept(
    "turn.beforeEnd",
    async (value, ctx) => {
      const decision = await engine.onBeforeTurnEnd(value.lastMessage, ctx.signal)
      if (!decision.block) return { action: "pass" }
      value.displayText = decision.displayText
      value.displayOrigin = "goal"
      return { action: "block", reason: decision.reason }
    },
    { priority: 50, timeoutMs: 180_000 },
  )

  api.on("turn.end", (event) => {
    if (event.parentSessionId !== undefined) return
    engine.onTurnEnd(event.data)
  })

  api.on("session.start", () => {
    engine.restoreFromSession()
  })

  api.registerCommand({
    name: "goal",
    description: "Run an autonomous goal-driven loop until all verification checks pass",
    args: {
      hint: '<objective> [--verify "<cmd>"] [--mode session|fresh] [--judge llm|verifier] [--max N]',
      complete(text) {
        const trimmed = text.trimStart()
        const lastSpace = trimmed.lastIndexOf(" ")
        const prefix = lastSpace === -1 ? "" : trimmed.slice(0, lastSpace + 1)
        const token = lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1)
        const pool = lastSpace === -1 ? [...GOAL_SUBCOMMANDS, ...GOAL_FLAGS] : [...GOAL_FLAGS]
        return pool
          .filter((item) => item.label.startsWith(token))
          .map((item) => ({
            value: `${prefix}${item.text}`,
            label: item.label,
            description: item.description,
          }))
      },
    },
    async run(args, ctx) {
      let parsed: ReturnType<typeof parseGoalArgs>
      try {
        parsed = parseGoalArgs(args)
      } catch (err) {
        ctx.print(err instanceof Error ? err.message : String(err), "error")
        return
      }

      if (parsed.kind === "help") {
        ctx.print(HELP_TEXT, "info")
        return
      }
      if (parsed.kind === "dock") {
        const opened = ctx.openView?.({ kind: GOAL_VIEW_KIND, placement: "dock", data: {} }) ?? openDock()
        if (!opened) {
          const snap = engine.snapshot()
          ctx.print(
            snap
              ? `Goal ${snap.id} [${snap.phase}] ${snap.iteration}/${snap.maxIterations}: ${snap.prompt}`
              : 'No active goal. Start one with: /goal "<objective>" --verify "<cmd>"',
            "info",
          )
        }
        return
      }
      if (parsed.kind === "status") {
        const snap = engine.snapshot()
        if (!snap) {
          ctx.print("No active goal.", "info")
          return
        }
        const lines = [
          `Goal ${snap.id} [${snap.phase}] (${snap.mode}, ${snap.iteration}/${snap.maxIterations}, $${snap.spentUsd.toFixed(4)})`,
          `Objective: ${snap.prompt}`,
          ...snap.criteria.map((c) => `  ${c.done ? "✓" : "○"} (${c.id}) ${c.text}`),
          ...(snap.pauseReason ? [`Note: ${snap.pauseReason}`] : []),
          ...(snap.lastLog ? [`Last verify (#${snap.lastLog.iteration}): ${snap.lastLog.summary}`] : []),
        ]
        ctx.print(lines.join("\n"), "info")
        return
      }
      if (parsed.kind === "pause") {
        engine.pause("Paused by /goal pause.")
        ctx.print("Goal paused.", "info")
        return
      }
      if (parsed.kind === "stop") {
        await engine.stop(parsed.reason ?? "Stopped by /goal stop.")
        ctx.print("Goal stopped.", "info")
        return
      }
      if (parsed.kind === "resume") {
        await resumeInCurrentMode()
        return
      }
      if (parsed.kind === "edit") {
        if (parsed.action === "add") {
          const added = engine.addCriterion(parsed.value)
          ctx.print(`Added criterion (${added.id}): ${added.text}`, "info")
        } else if (parsed.action === "rm") {
          ctx.print(
            engine.removeCriterion(parsed.value)
              ? `Removed criterion ${parsed.value}.`
              : `Criterion "${parsed.value}" not found.`,
            "info",
          )
        } else {
          ctx.print(
            engine.toggleCriterion(parsed.value)
              ? `Toggled criterion ${parsed.value}.`
              : `Criterion "${parsed.value}" not found.`,
            "info",
          )
        }
        return
      }

      // Start flow: zero-friction when --verify / --now is provided; otherwise propose criteria & confirm once.
      let criteria = [{ id: "c1", text: parsed.prompt, done: false }]
      let verifyCommands = [...parsed.verifyCommands]
      const shouldPropose =
        !parsed.noChecklist &&
        verifyCommands.length === 0 &&
        api.frontend === "tui" &&
        parsed.prompt.length >= 16

      if (shouldPropose) {
        const proposed = await proposeCriteria(api, parsed.prompt, ctx.signal)
        criteria = proposed.criteria
        const preview = [
          `Objective: ${parsed.prompt}`,
          "",
          "Proposed criteria:",
          ...criteria.map((c) => `  ○ (${c.id}) ${c.text}`),
          ...(proposed.suggestedVerify.length
            ? ["", `Suggested --verify: ${proposed.suggestedVerify.join(" ; ")}`]
            : []),
        ].join("\n")
        const choice = await api.ui.select(
          "Start Goal with proposed criteria?",
          [
            ...(proposed.suggestedVerify.length ? ["Start with criteria & suggested verify"] : []),
            "Start with criteria",
            "Cancel",
          ],
          { signal: ctx.signal },
        )
        if (!choice || choice === "Cancel") {
          ctx.print("Goal start cancelled.", "info")
          return
        }
        if (choice === "Start with criteria & suggested verify") {
          verifyCommands = [...proposed.suggestedVerify]
        }
        ctx.print(preview, "info")
      }

      const config: GoalConfig = {
        prompt: parsed.prompt,
        mode: parsed.mode,
        verifyCommands,
        judge: parsed.judge,
        maxIterations: parsed.maxIterations,
        ...(parsed.budgetUsd !== undefined ? { budgetUsd: parsed.budgetUsd } : {}),
        requireCompleteTool: parsed.requireCompleteTool,
        criteria,
      }

      const state = engine.start(config)
      ctx.openView?.({ kind: GOAL_VIEW_KIND, placement: "dock", data: {} })
      ctx.print(
        `Started goal ${state.id} (${config.mode} mode, max ${config.maxIterations} iterations${
          verifyCommands.length ? `, ${verifyCommands.length} verify check(s)` : ""
        }).`,
        "info",
      )

      if (config.mode === "fresh") {
        const result = await engine.runFreshLoop()
        ctx.print(
          `Goal ${result.id} finished [${result.status}] in ${result.iterations} iteration(s): ${result.summary}`,
          "info",
        )
        return
      }

      await ctx.session.send(config.prompt, {
        display: { text: `/goal ${config.prompt}`, origin: "goal" },
      })
    },
  })

  api.provideService("goal.run", (req) => engine.runService(req))
  api.provideService("goal.status", () => engine.snapshot())
  api.provideService("goal.stop", (reason) => engine.stop(reason))

  api.onUnload(() => {
    engine.dispose()
  })
})
