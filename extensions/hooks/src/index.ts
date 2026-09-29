import path from "node:path"
import type {
  CommandCandidate,
  CommandContext,
  Extension,
  ExtensionAPI,
  Intercept,
  InterceptContext,
  InterceptorMap,
  NoticeLevel,
  TextBlock,
} from "@amira/api"
import { EVENT_LABEL, type Hook, type HookEvent, type LoadedHooks, loadHooks } from "./config.ts"
import { callMatches, editedFile, fileMatches, toolMatches } from "./match.ts"
import { type HookRun, lastLines, outcome, type RunCommand, runHook, seconds } from "./runner.ts"
import type { ShellDeps } from "./shell.ts"
import { trust, trustFile, trustState, untrust } from "./trust.ts"
import { hookLine, runLine, VIEW_KIND, type ViewData, view } from "./view.ts"

export * from "./config.ts"
export * from "./match.ts"
export * from "./runner.ts"
export * from "./shell.ts"
export * from "./trust.ts"

/** Runs kept for /hooks. */
export const MAX_RUNS = 50
/** Lines of a failing hook's output shown in its notice. */
export const NOTICE_LINES = 5
/** Interceptors wait for the user's answer and for hooks, which have timeouts of their own. */
const INTERCEPT_TIMEOUT_MS = 24 * 60 * 60_000
type AfterToolValue = InterceptorMap["tool.call.after"]
/** Tools whose successful calls count as edits for onlyAfterEdits. */
const EDIT_TOOLS = ["edit", "write"]

export interface HooksDeps {
  /** How shells are found (tests). */
  shell?: ShellDeps
  /** The environment hooks start from. Default process.env. */
  env?: Record<string, string | undefined>
  /** Default the API's runCommand. */
  runCommand?: RunCommand
  now?: () => number
}

/**
 * Where the project's hooks stand: none, allowed, waiting for the user's answer (asked at the
 * first session start, or when a hook would first run), or off for this session.
 */
export type TrustStatus = "none" | "trusted" | "pending" | "declined" | "unanswered"

const pass = { action: "pass" } as const

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function createHooksExtension(deps: HooksDeps = {}): Extension {
  return (api: ExtensionAPI) => {
    // tool.call.after, notify, onExit and runCommand's stdin came with API 0.1.2.
    if (typeof api.notify !== "function" || typeof api.onExit !== "function")
      throw new Error("the hooks extension needs a newer Amira (extension API with notify and onExit)")
    const cwd = api.cwd
    const home = api.home
    const now = deps.now ?? Date.now
    const runCommand: RunCommand = deps.runCommand ?? ((argv, opts) => api.runCommand(argv, opts))
    let loaded: LoadedHooks
    let trustStatus: TrustStatus = "none"
    /** The project's hooks changed since the user trusted them. */
    let changed = false
    let asking: Promise<boolean> | undefined
    /** Closes the open trust question when the hooks are read again (it was about the old ones). */
    let askAbort: AbortController | undefined
    /** Counts reads of the hook files, so an answer about older hooks is not applied to newer ones. */
    let generation = 0
    let off = false
    let seq = 0
    const runs: HookRun[] = []
    const running = new Map<number, string>()
    /** Notices of after-edit hooks, shown once the call they ran for is shown. */
    const heldNotices = new Map<string, { text: string; level: NoticeLevel }[]>()
    /** A file was edited or written since the main session's last turn ended. */
    let edited = false
    /** After-turn hooks still running, so a quick next turn does not start them twice. */
    const busy = new Set<Hook>()
    let sessionId: string | undefined
    /** Hooks running in the background (after turn, session start), which exit waits for. */
    const pending = new Set<Promise<unknown>>()
    /** Stops those when Amira exits. */
    const lifetime = new AbortController()
    const background = (work: () => Promise<unknown>) => {
      const p = work()
        .catch((err) => api.reportError(`hooks: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => pending.delete(p))
      pending.add(p)
    }

    const load = () => {
      loaded = loadHooks(cwd, home)
      for (const p of loaded.problems) api.reportError(`hooks: ${p}`)
      changed = false
      if (!loaded.projectHash) trustStatus = "none"
      else {
        const state = trustState(home, cwd, loaded.projectHash, loaded.options.trustedProjects)
        trustStatus = state === "trusted" ? "trusted" : "pending"
        changed = state === "changed"
      }
      generation++
      asking = undefined
      askAbort?.abort()
      askAbort = undefined
    }
    load()

    const projectHooks = () => loaded.hooks.filter((h) => h.origin === "project")
    const projectFiles = () =>
      loaded.files.project.map((f) => path.relative(cwd, f).replaceAll("\\", "/")).join(", ")

    /**
     * Asks the user once whether the project's hooks may run; resolves whether they may. The
     * question is not tied to the turn that first needed it: an interrupt leaves it open.
     */
    const ensureTrust = (): Promise<boolean> => {
      if (trustStatus === "none" || trustStatus === "trusted")
        return Promise.resolve(trustStatus === "trusted")
      if (trustStatus !== "pending") return Promise.resolve(false)
      asking ??= (async () => {
        const hash = loaded.projectHash!
        const gen = generation
        const abort = new AbortController()
        askAbort = abort
        const list = projectHooks()
          .map(
            (h) =>
              `  ${EVENT_LABEL[h.event]} · ${h.name}: ${h.command ?? `${h.action}${h.reason ? ` (${h.reason})` : ""}`}`,
          )
          .join("\n")
        const files = projectFiles()
        const answer = await api.ui.confirm(
          changed ? "This project's hooks changed. Run them?" : "Run this project's hooks?",
          `${files} ${changed ? "now asks" : "asks"} Amira to run commands on your machine, with your permissions:\n${list}\n\nYes remembers these hooks for this project; when they change you are asked again.`,
          { signal: abort.signal },
        )
        // The hooks were read again meanwhile (/hooks reload, trust, untrust): this answer was
        // about the hooks as they were, so it counts for nothing; ask about the current ones.
        if (gen !== generation) return ensureTrust()
        if (answer !== true) {
          trustStatus = answer === false ? "declined" : "unanswered"
          api.notify(
            answer === false
              ? "Project hooks are off for this session; /hooks trust turns them on."
              : `This project's hooks did not run: nobody could confirm them (${files}). Run /hooks trust in the TUI to allow them.`,
            answer === false ? "info" : "warning",
          )
          return false
        }
        trustStatus = "trusted"
        try {
          trust(home, cwd, hash)
        } catch (err) {
          api.reportError(
            `hooks: could not remember the trust in ${trustFile(home)}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return true
      })()
      return asking
    }

    /** The hooks for an event that may run now: the user's, and the project's once trusted. */
    const active = async (event: HookEvent): Promise<Hook[]> => {
      if (off || !loaded.options.enabled) return []
      const of = () => loaded.hooks.filter((h) => h.event === event)
      if (!of().some((h) => h.origin === "project")) return of()
      const trusted = await ensureTrust()
      // Read after the answer: the files may have been read again while it was open.
      return trusted ? of() : of().filter((h) => h.origin === "user")
    }

    const remember = (run: HookRun) => {
      runs.push(run)
      if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS)
    }

    const run = async (
      hook: Hook,
      o: {
        vars: Record<string, string | undefined>
        input: Record<string, unknown>
        target?: string
        signal?: AbortSignal
      },
    ): Promise<HookRun> => {
      const id = ++seq
      running.set(id, hook.name)
      api.requestRender()
      try {
        const r = await runHook(hook, {
          runCommand,
          projectDir: cwd,
          vars: { AMIRA_SESSION_ID: sessionId, ...o.vars },
          input: { sessionId, ...o.input },
          signal: o.signal ?? new AbortController().signal,
          maxOutputChars: loaded.options.maxOutputChars,
          id,
          ...(o.target !== undefined ? { target: o.target } : {}),
          ...(deps.shell ? { shell: deps.shell } : {}),
          ...(deps.env ? { baseEnv: deps.env } : {}),
          now,
        })
        remember(r)
        return r
      } finally {
        running.delete(id)
        api.requestRender()
      }
    }

    /** A rule of a before-tool hook that decided without a command, kept with the runs. */
    const ruleHit = (hook: Hook, target: string, verdict: string, ok: boolean) =>
      remember({
        id: ++seq,
        hook,
        target,
        startedAt: now(),
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        aborted: false,
        output: verdict,
        cut: 0,
        ok,
        verdict,
      })

    const noticeOf = (r: HookRun, note = ""): { text: string; level: NoticeLevel } | undefined => {
      const head = `hook ${r.hook.name}${r.target ? ` · ${r.target}` : ""} · ${outcome(r)} · ${seconds(r.durationMs)}${note}`
      if (r.ok) return loaded.options.showSuccess ? { text: head, level: "success" } : undefined
      return {
        text: [head, ...lastLines(r.output, NOTICE_LINES).map((l) => clip(l, 200))].join("\n"),
        level: "warning",
      }
    }
    const show = (n: { text: string; level: NoticeLevel } | undefined) => {
      if (n) api.notify(n.text, n.level)
    }

    const relPath = (file: string) => {
      const rel = path.relative(cwd, file)
      return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file).replaceAll("\\", "/")
    }

    // ---- before tool: rules and commands that may block a call or ask the user first ----

    const askUser = async (
      hook: Hook,
      call: InterceptorMap["tool.call.before"],
      reason: string | undefined,
      signal: AbortSignal,
    ): Promise<Intercept<InterceptorMap["tool.call.before"]>> => {
      const args = JSON.stringify(call.args)
      const answer = await api.ui.confirm(
        `Allow ${call.name}? (hook ${hook.name})`,
        `${reason ?? `The hook "${hook.name}" asks before this call.`}\n${clip(args, 300)}`,
        { signal },
      )
      if (answer === true) {
        ruleHit(hook, call.name, "allowed by the user", true)
        return pass
      }
      ruleHit(hook, call.name, answer === false ? "the user said no" : "nobody answered", false)
      return {
        action: "block",
        reason: `${answer === false ? "the user did not allow it" : "nobody could confirm it"} (hook "${hook.name}"${reason ? `: ${reason}` : ""})`,
      }
    }

    api.intercept(
      "tool.call.before",
      async (call, ctx) => {
        const hooks = (await active("beforeTool")).filter((h) => callMatches(h, call.name, call.args))
        for (const hook of hooks) {
          if (hook.action === "block") {
            ruleHit(hook, call.name, "blocked", false)
            return {
              action: "block",
              reason: `${hook.reason ?? "a hook rule forbids it"} (hook "${hook.name}")`,
            }
          }
          if (hook.action === "ask") {
            const verdict = await askUser(hook, call, hook.reason, ctx.signal)
            if (verdict.action !== "pass") return verdict
            continue
          }
          const r = await run(hook, {
            vars: { AMIRA_TOOL: call.name, AMIRA_TOOL_CALL_ID: call.toolCallId },
            input: {
              sessionId: ctx.sessionId,
              tool: call.name,
              toolCallId: call.toolCallId,
              args: call.args,
            },
            target: call.name,
            signal: ctx.signal,
          })
          // A guard that could not even start (no shell, a bad cwd) must not wave calls through.
          if (r.error && !ctx.signal.aborted) {
            return {
              action: "block",
              reason: `the hook "${hook.name}" could not run (${r.error}), so the call was not made; /hooks off turns hooks off`,
            }
          }
          const decision = decisionOf(r)
          if (decision.decision === "block") {
            return {
              action: "block",
              reason: `${decision.reason ?? `blocked by the hook "${hook.name}"`} (hook "${hook.name}")`,
            }
          }
          if (decision.decision === "ask") {
            const verdict = await askUser(hook, call, decision.reason, ctx.signal)
            if (verdict.action !== "pass") return verdict
            continue
          }
          // A hook that failed or timed out lets the call through, but says so.
          if (!r.ok && !ctx.signal.aborted) show(noticeOf(r, " · the call went ahead"))
        }
        return pass
      },
      { timeoutMs: INTERCEPT_TIMEOUT_MS },
    )

    // ---- after edit: formatters and linters on the changed file ----

    const afterTool = async (
      call: AfterToolValue,
      ctx: InterceptContext,
    ): Promise<Intercept<AfterToolValue>> => {
      if (call.result.isError || call.rejected) return pass
      if (EDIT_TOOLS.includes(call.name)) edited = true
      const hooks = (await active("afterEdit")).filter((h) => toolMatches(h.tools, call.name))
      if (!hooks.length) return pass
      // Relative paths are the calling session's (a sub-agent may work in a worktree).
      const file = editedFile(call.args, call.result.details, call.cwd)
      if (!file) return pass
      const target = relPath(file)
      const feedback: TextBlock[] = []
      for (const hook of hooks.filter((h) => fileMatches(h.files, file, cwd))) {
        if (ctx.signal.aborted) break
        const r = await run(hook, {
          vars: { AMIRA_TOOL: call.name, AMIRA_TOOL_CALL_ID: call.toolCallId, AMIRA_FILE: file },
          input: { sessionId: ctx.sessionId, tool: call.name, toolCallId: call.toolCallId, file },
          target,
          signal: ctx.signal,
        })
        const send = hook.feedback === "always" || (hook.feedback === "onError" && !r.ok)
        if (send) {
          feedback.push({
            type: "text",
            text: `[hook "${hook.name}" after ${call.name === "write" ? "writing" : "editing"} ${target}: ${outcome(r)}]\n${r.output || "(no output)"}`,
          })
        }
        const n = noticeOf(r, send && !r.ok ? " · sent to the model" : "")
        if (n) {
          const key = `${ctx.sessionId}:${call.toolCallId}`
          heldNotices.set(key, [...(heldNotices.get(key) ?? []), n])
        }
      }
      if (!feedback.length) return pass
      return {
        action: "modify",
        value: { ...call, result: { ...call.result, content: [...call.result.content, ...feedback] } },
      }
    }
    // Default priority: before handlers that read the file (the lsp extension's diagnostics).
    api.intercept("tool.call.after", afterTool, { timeoutMs: INTERCEPT_TIMEOUT_MS })

    // The call's own line comes first, then what its hooks did.
    api.on("tool.execute.end", (e) => {
      const key = `${e.sessionId}:${e.data.toolCallId}`
      const held = heldNotices.get(key)
      if (!held) return
      heldNotices.delete(key)
      for (const n of held) show(n)
    })

    // ---- after turn, session start and end ----

    api.on("turn.end", (e) => {
      if (e.parentSessionId !== undefined) return
      // Anything a turn's calls left unshown (they never ended) is shown now.
      for (const [key, held] of heldNotices) {
        heldNotices.delete(key)
        for (const n of held) show(n)
      }
      const wasEdited = edited
      edited = false
      background(async () => {
        const hooks = (await active("afterTurn")).filter(
          (h) => h.on.includes(e.data.reason) && (!h.onlyAfterEdits || wasEdited) && !busy.has(h),
        )
        for (const hook of hooks) {
          busy.add(hook)
          try {
            const r = await run(hook, {
              vars: { AMIRA_TURN_END: e.data.reason },
              input: { sessionId: e.sessionId, turn: { reason: e.data.reason, edited: wasEdited } },
              signal: lifetime.signal,
            })
            show(noticeOf(r))
          } finally {
            busy.delete(hook)
          }
        }
      })
    })

    api.on("session.start", (e) => {
      if (e.parentSessionId !== undefined) return
      sessionId = e.sessionId
      const reason = e.data.reason
      // The project's hooks are asked about as the session starts, not in the middle of a turn;
      // the user's own session-start hooks do not wait for the answer.
      if (!off && loaded.options.enabled) background(() => ensureTrust())
      background(async () => {
        const hooks = (await active("sessionStart")).filter(
          (h) => !h.reasons.length || h.reasons.includes(reason),
        )
        for (const hook of hooks) {
          const r = await run(hook, {
            vars: { AMIRA_SESSION_START: reason },
            input: { sessionId: e.sessionId, reason },
            target: reason,
            signal: lifetime.signal,
          })
          show(noticeOf(r))
        }
      })
    })

    api.onExit(async (signal) => {
      // Hooks still running (after the last turn, e.g. in print mode) get the same time to finish.
      signal.addEventListener("abort", () => lifetime.abort(), { once: true })
      const hooks =
        off || !loaded.options.enabled
          ? []
          : // Asking at exit would hold it up: only hooks allowed already run.
            loaded.hooks.filter(
              (h) => h.event === "sessionEnd" && (h.origin === "user" || trustStatus === "trusted"),
            )
      await Promise.all([...pending, ...hooks.map((hook) => run(hook, { vars: {}, input: {}, signal }))])
    })

    // ---- what the user sees: a status item while hooks run, /hooks, the runs view ----

    api.registerStatusItem({
      id: "hooks",
      align: "right",
      tone: "muted",
      text: () => {
        if (!running.size) return undefined
        const names = [...new Set(running.values())]
        return `hook ${clip(names.join(", "), 30)}…`
      },
    })

    api.registerView(view)

    const viewData = (): ViewData => ({ runs })

    const trustLine = (): string => {
      const files = projectFiles()
      switch (trustStatus) {
        case "none":
          return "Project hooks: none."
        case "trusted":
          return `Project hooks (${files}): trusted.`
        case "pending":
          return `Project hooks (${files}): ${changed ? "changed since you trusted them" : "not trusted yet"}; /hooks trust allows them.`
        case "declined":
          return `Project hooks (${files}): off for this session; /hooks trust allows them.`
        case "unanswered":
          return `Project hooks (${files}): not confirmed; /hooks trust allows them.`
      }
    }

    const listText = (): string => {
      const out: string[] = []
      if (!loaded.options.enabled) out.push("Hooks are turned off (extensions.hooks.enabled: false).")
      else if (off) out.push("Hooks are off for this session; /hooks on turns them back on.")
      if (!loaded.hooks.length) {
        out.push(
          "No hooks. Add them under extensions.hooks in ~/.amira/settings.json, or in .amira/hooks.json for this project.",
        )
      } else {
        for (const event of [
          "sessionStart",
          "beforeTool",
          "afterEdit",
          "afterTurn",
          "sessionEnd",
        ] as HookEvent[]) {
          const hooks = loaded.hooks.filter((h) => h.event === event)
          if (!hooks.length) continue
          out.push(EVENT_LABEL[event])
          for (const h of hooks) out.push(`  ${hookLine(h)}`)
        }
        out.push(trustLine())
      }
      if (runs.length) {
        out.push("", "Recent runs")
        for (const r of runs.slice(-10)) out.push(`  ${runLine(r)}`)
        out.push("/hooks runs shows their output.")
      }
      return out.join("\n")
    }

    const runsText = (): string => {
      if (!runs.length) return "No hook has run yet."
      const out: string[] = []
      for (const r of runs.slice(-10)) {
        out.push(runLine(r))
        const lines = r.verdict ? [] : r.output.split("\n").slice(-20)
        for (const l of lines) if (l.trim()) out.push(`  ${l}`)
      }
      return out.join("\n")
    }

    const SUBCOMMANDS: CommandCandidate[] = [
      { value: "runs", description: "Recent runs with their output" },
      { value: "trust", description: "Allow this project's hooks (as they are now)" },
      { value: "untrust", description: "Stop allowing this project's hooks" },
      { value: "reload", description: "Read the hook files again" },
      { value: "off", description: "Turn hooks off for this session" },
      { value: "on", description: "Turn hooks back on" },
    ]

    api.registerCommand({
      name: "hooks",
      description: "Hooks: what runs on which event, and recent runs",
      args: { hint: "[runs|trust|untrust|reload|off|on]", complete: () => SUBCOMMANDS },
      run: async (args: string, ctx: CommandContext) => {
        const sub = args.trim().toLowerCase()
        switch (sub) {
          case "":
            ctx.print(listText())
            return
          case "runs":
            if (ctx.openView && runs.length) ctx.openView({ kind: VIEW_KIND, data: viewData() })
            else ctx.print(runsText())
            return
          case "trust": {
            load()
            if (!loaded.projectHash) {
              ctx.print("This project has no hooks of its own.")
              return
            }
            try {
              trust(home, cwd, loaded.projectHash)
            } catch (err) {
              ctx.print(
                `Could not write ${trustFile(home)}: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              )
              return
            }
            trustStatus = "trusted"
            changed = false
            ctx.print(`Trusted this project's hooks (${projectHooks().length}); they run from now on.`)
            return
          }
          case "untrust": {
            const was = untrust(home, cwd)
            load()
            if (trustStatus === "pending") trustStatus = "declined"
            ctx.print(
              was || loaded.projectHash
                ? `This project's hooks no longer run${loaded.options.trustedProjects.length && trustStatus === "trusted" ? " (but the project is listed under extensions.hooks.trustedProjects in your settings)" : ""}.`
                : "This project's hooks were not trusted.",
            )
            return
          }
          case "reload":
            load()
            ctx.print(
              `Read the hooks again: ${loaded.hooks.length} hook${loaded.hooks.length === 1 ? "" : "s"}.`,
            )
            return
          case "off":
            off = true
            ctx.print("Hooks are off for this session.")
            return
          case "on":
            off = false
            ctx.print("Hooks are on.")
            return
          default:
            ctx.print(
              `Unknown subcommand "${args.trim()}". Try /hooks, /hooks runs, trust, untrust, reload, off or on.`,
              "error",
            )
        }
      },
    })
  }
}

/**
 * What a before-tool hook's command decided: exit code 2 blocks, with its output as the reason;
 * exit 0 lets the call through, unless it printed a JSON object such as
 * {"decision": "block" | "ask" | "allow", "reason": "..."}. Anything else lets it through.
 */
export function decisionOf(r: HookRun): { decision: "block" | "ask" | "allow"; reason?: string } {
  const reason = r.output.trim() ? clip(r.output.trim(), 1000) : undefined
  if (r.exitCode === 2 && !r.timedOut && !r.aborted)
    return reason ? { decision: "block", reason } : { decision: "block" }
  if (!r.ok) return { decision: "allow" }
  const json = parseDecision(r.output)
  if (json) return json
  return { decision: "allow" }
}

function parseDecision(output: string): { decision: "block" | "ask" | "allow"; reason?: string } | undefined {
  const text = output.trim()
  const candidates = [text, text.split("\n").at(-1) ?? ""]
  for (const c of candidates) {
    if (!c.startsWith("{")) continue
    try {
      const v = JSON.parse(c) as { decision?: unknown; reason?: unknown }
      const d = v.decision === "approve" ? "allow" : v.decision
      if (d !== "block" && d !== "ask" && d !== "allow") continue
      return typeof v.reason === "string" && v.reason.trim()
        ? { decision: d, reason: v.reason.trim() }
        : { decision: d }
    } catch {}
  }
  return undefined
}

export default createHooksExtension()
