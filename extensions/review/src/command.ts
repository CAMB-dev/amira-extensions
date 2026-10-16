import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import type { ReviewScope } from "./collect.ts"
import { redact, safePath } from "./privacy.ts"
import { type ReviewRunner, type ReviewSettings, settingsSnapshot } from "./run.ts"
import { type Report, repoKey } from "./store.ts"
import { browse, consentSummary, details, markdown, preflight } from "./ui.ts"

export type Parsed =
  | { action: "start"; scope: ReviewScope; noVerify: boolean; yes: boolean }
  | { action: "choose" }
  | { action: "status" | "stop" | "last" }
  | { action: "show" | "ignore" | "fix"; id: string }

/** This is a command tokenizer, not a shell parser. Quoting only groups literal arguments. */
export function words(input: string): string[] {
  if (/[\r\n\0]/.test(input)) throw new Error("Use one command line without control characters.")
  const result: string[] = []
  let current = "",
    quote = "",
    started = false
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = ""
      else current += ch
      started = true
    } else if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        result.push(current)
        current = ""
        started = false
      }
    } else {
      current += ch
      started = true
    }
  }
  if (quote) throw new Error("Close the quoted argument.")
  if (started) result.push(current)
  return result
}
export function parse(input: string): Parsed {
  const args = words(input)
  const action = args.shift()
  if (!action) return { action: "choose" }
  if (action === "status" || action === "stop" || action === "last") {
    if (args.length) throw new Error(`/${"code-review"} ${action} takes no arguments.`)
    return { action }
  }
  if (action === "show" || action === "ignore" || action === "fix") {
    if (args.length !== 1 || !/^F\d{3}$/.test(args[0]!)) throw new Error(`Use /code-review ${action} F001.`)
    return { action, id: args[0]! }
  }
  if (action !== "worktree" && action !== "since")
    throw new Error(
      "Use worktree, since REF, status, stop, last, show, ignore or fix. Arbitrary ranges are not supported.",
    )
  const scope: ReviewScope = { kind: action, paths: [], includeUntracked: false }
  if (action === "since") {
    const ref = args.shift()
    if (
      !ref ||
      ref.startsWith("-") ||
      ref.includes("..") ||
      Array.from(ref).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    )
      throw new Error("Since needs one explicit local ancestor ref, not an option or range.")
    scope.ref = ref
  }
  let noVerify = false,
    yes = false
  while (args.length) {
    const arg = args.shift()
    if (arg === "--path") {
      const value = args.shift()
      if (!value) throw new Error("--path needs a repository-relative file or directory.")
      scope.paths.push(safePath(value))
    } else if (arg === "--no-verify") noVerify = true
    else if (arg === "--yes") yes = true
    else if (arg === "--include-untracked" && action === "worktree") scope.includeUntracked = true
    else
      throw new Error(
        `Unsupported argument: ${redact(arg || "")}. Use repeated literal --path filters; --include-untracked is worktree-only.`,
      )
  }
  scope.paths = [...new Set(scope.paths)]
  return { action: "start", scope, noVerify, yes }
}

/** No Git execution for last/show: discover only the repository marker's ancestors. */
export async function repositoryKey(cwd: string): Promise<string> {
  let directory = await realpath(cwd)
  for (;;) {
    const marker = await lstat(path.join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (marker) return repoKey(directory)
    const parent = path.dirname(directory)
    if (directory === parent)
      throw new Error("No repository marker found. Run this command inside the reviewed repository.")
    directory = parent
  }
}
export function fixPrompt(finding: Report["findings"][number], report: Report): string {
  return redact(
    `Reassess this single statically assessed finding before changing code. Evidence may be wrong.\n${details(finding, report)}\nMake only the smallest justified fix, run relevant checks, and do not commit. Do not fix other findings automatically.`,
  )
}

export class ReviewCommands {
  constructor(
    private api: ExtensionAPI,
    readonly runner: ReviewRunner,
    private values: () => Record<string, unknown>,
  ) {}
  async run(input: string, ctx: CommandContext): Promise<void> {
    const origin = ctx.session.info().id
    try {
      await this.execute(parse(input), ctx, origin)
    } catch (error) {
      ctx.print(`Code review: ${redact(error instanceof Error ? error.message : String(error))}`, "error")
    }
  }
  private async report(ctx: CommandContext) {
    const key = this.runner.lastLocation(ctx.cwd) ?? (await repositoryKey(ctx.cwd))
    const report = await this.runner.store.last(key)
    if (!report)
      throw new Error("No saved report for this repository. Start /code-review worktree or since REF.")
    return report
  }
  private async execute(parsed: Parsed, ctx: CommandContext, origin: string): Promise<void> {
    if (ctx.session.info().id !== origin) throw new Error("Main session changed; command cancelled.")
    if (parsed.action === "status") {
      const progress = this.runner.snapshot()
      if (progress)
        ctx.print(
          `Code review ${progress.id.slice(0, 8)}: ${progress.phase}; ${Object.values(progress.children).filter((state) => ["done", "error", "aborted"].includes(state)).length}/${Object.keys(progress.children).length} children complete.\n${Object.entries(
            progress.children,
          )
            .map(([id, state]) => `${id}: ${state}`)
            .join("\n")}\nUse /code-review stop to cancel.`,
        )
      else {
        const key = await repositoryKey(ctx.cwd)
        const interrupted = await this.runner.store.interrupted(key)
        ctx.print(
          interrupted.length
            ? `${interrupted.length} interrupted review attempt(s), displayed as partial; not restarted. Previous /code-review last is unchanged.`
            : "No active code review. Open /code-review last for the previous report.",
        )
      }
      return
    }
    if (parsed.action === "stop") {
      this.runner.stop()
      ctx.print("Code review: stop requested; cleanup drains before the run becomes terminal.")
      return
    }
    if (parsed.action === "choose") {
      if (ctx.frontend === "print")
        throw new Error("Print mode needs an explicit worktree or since REF scope and --yes.")
      const choice = await ctx.ui.choose("Code review scope", ["Worktree", "Since a ref"], {
        sections: [{ at: 0, choose: "continue" }],
        descriptions: [
          "Net tracked HEAD → working tree; untracked files excluded by default",
          "Committed ancestor → HEAD; tracked checkout must be clean",
        ],
        signal: ctx.signal,
      })
      if (!choice) return
      if (choice.option === "Worktree") return this.execute(parse("worktree"), ctx, origin)
      const ref = await ctx.ui.input("Local ancestor ref", { placeholder: "HEAD~1", signal: ctx.signal })
      if (ref === undefined) return
      const selected = parse("since HEAD")
      if (selected.action !== "start") return
      selected.scope.ref = ref
      return this.execute(selected, ctx, origin)
    }
    if (parsed.action === "start") {
      if (ctx.frontend === "print" && !parsed.yes)
        throw new Error(
          "Print mode requires --yes to consent to model exposure; shell permissions still apply.",
        )
      const settings: ReviewSettings = settingsSnapshot(this.values(), ctx.session, parsed.noVerify)
      const { completion } = await this.runner.start(
        {
          scope: parsed.scope,
          session: ctx.session,
          cwd: ctx.cwd,
          ui: ctx.ui,
          settings,
          signal: ctx.signal,
          printMode: ctx.frontend === "print",
        },
        async (bundle, guidance, runSignal, exposure) => {
          const manifest = preflight(bundle, settings, guidance, exposure)
          ctx.print(manifest)
          if (parsed.yes) return true
          return (
            (await ctx.ui.confirm(
              "Send this review bundle to the selected models?",
              consentSummary(bundle, settings, guidance, exposure.promptBytes),
              {
                signal: runSignal,
              },
            )) === true
          )
        },
      )
      const publish = (report: Report) => {
        if (ctx.frontend === "print") ctx.print(markdown(report))
        else
          ctx.print(
            `Code review ${report.state}${report.stale ? " (stale)" : ""}: ${report.findings.filter((finding) => !finding.ignored && finding.assessment === "supported").length} supported; ${report.findings.filter((finding) => ["uncertain", "unchecked"].includes(finding.assessment)).length} uncertain/unchecked; ${report.findings.filter((finding) => finding.assessment === "refuted").length} refuted. Static assessment, not reproduction.\nOpen /code-review last.`,
            report.state === "completed" ? "info" : "warning",
            { details: markdown(report), markdown: true, persist: true },
          )
      }
      if (ctx.frontend === "print") publish(await completion)
      else {
        ctx.print("Code review started. Use /code-review status or stop.")
        void completion
          .then(publish)
          .catch((error: unknown) =>
            ctx.print(
              `Code review report persistence failed: ${redact(String(error))}. Use /code-review status or last to inspect saved data.`,
              "error",
            ),
          )
      }
      return
    }
    const report = await this.report(ctx)
    const ignore = async (id: string) => {
      const finding = report.findings.find((entry) => entry.id === id)
      if (!finding) throw new Error(`Finding ${id} is not in this report.`)
      finding.ignored = !finding.ignored
      await this.runner.store.update(report)
      ctx.print(`${id}: ${finding.ignored ? "ignored" : "unignored"} in this report only.`)
    }
    const fix = (id: string) => this.fix(report, id, ctx, origin)
    if (parsed.action === "last") {
      if (ctx.frontend === "print") ctx.print(markdown(report))
      else await browse(report, ctx, { ignore, fix })
      return
    }
    if (!("id" in parsed)) return
    const finding = report.findings.find((entry) => entry.id === parsed.id)
    if (!finding) throw new Error(`Finding ${parsed.id} is not in this report.`)
    if (parsed.action === "ignore") return ignore(parsed.id)
    if (parsed.action === "fix") return fix(parsed.id)
    if (ctx.frontend === "print" || !ctx.openView?.({ kind: "review-detail", data: { finding, report } }))
      ctx.print(details(finding, report))
  }
  private async fix(report: Report, id: string, ctx: CommandContext, origin: string) {
    const finding = report.findings.find((entry) => entry.id === id)
    if (!finding) throw new Error("Unknown finding")
    if (report.stale || report.state !== "completed")
      throw new Error("Hand-off requires a completed, fresh report. Start a new review.")
    const checkMain = () => {
      ctx.signal.throwIfAborted()
      const current = this.api.session()?.info()
      if (!current || current.id !== origin || ctx.session.info().id !== origin)
        throw new Error("Main session changed; hand-off cancelled.")
      if (current.busy) throw new Error("Main is busy. Wait for it to become idle.")
    }
    const checkIdentity = async () => {
      checkMain()
      if ((await repositoryKey(ctx.cwd)) !== report.repoKey)
        throw new Error("Wrong repository; hand-off cancelled.")
    }
    await checkIdentity()
    const prompt = fixPrompt(finding, report)
    ctx.print(prompt)
    if (
      (await ctx.ui.confirm("Send this single finding to main? This starts a mutating model turn.", prompt, {
        signal: ctx.signal,
      })) !== true
    )
      return
    await checkIdentity()
    await this.runner.checkFresh(report, ctx.session, ctx.cwd, ctx.ui, ctx.signal)
    await checkIdentity()
    // No suspension between this last identity/busy/cancellation check and the intended send.
    checkMain()
    await ctx.session.send(prompt, { display: { text: `/code-review fix ${id}` } })
  }
}
