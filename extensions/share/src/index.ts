import type { CommandContext, ExtensionAPI } from "@amira/api"
import { runCommit } from "./commit.ts"
import { completeExport, runExport } from "./export.ts"
import { type Run, runner } from "./git.ts"
import { runPr } from "./pr.ts"
import { createRedactor, type Redactor } from "./redact.ts"
import { runReview } from "./review.ts"
import { readSettings, type ShareSettings } from "./settings.ts"

export { readSettings } from "./settings.ts"

export interface ShareOptions {
  /** Runs programs; default the API's runCommand (tests may pass their own). */
  run?: Run
  /** Default: a redactor over this process's environment. */
  redact?: Redactor
}

/**
 * Session export and git helpers: /export writes the session as Markdown or HTML, /commit
 * proposes a message for the staged changes, /pr drafts (and with gh opens) a pull request,
 * /review has a reviewer sub-agent look over the branch. Programs run only through the API.
 */
export function createShareExtension(opts: ShareOptions = {}) {
  return (api: ExtensionAPI) => {
    const run = opts.run ?? runner(api)
    let reported = false
    const settings = (): ShareSettings =>
      readSettings(api.settings.extensions?.share, (problem) => {
        // Once per load: the commands read settings on every run.
        if (reported) return
        reported = true
        api.reportError(problem)
      })
    let redactor = opts.redact
    const redact: Redactor = (text) => {
      if (!redactor) {
        const keyEnvs = Object.values(api.settings.providers ?? {}).flatMap((p) => [
          ...(p.apiKeyEnv ? [p.apiKeyEnv] : []),
          ...(p.apiKeyEnvFallbacks ?? []),
        ])
        redactor = createRedactor(process.env, keyEnvs)
      }
      return redactor(text)
    }
    const guarded =
      (fn: (args: string, ctx: CommandContext) => Promise<void>) =>
      async (args: string, ctx: CommandContext) => {
        try {
          await fn(args, ctx)
        } catch (err) {
          if (ctx.signal.aborted) {
            ctx.print("Stopped.", "warning")
            return
          }
          throw err
        }
      }

    api.registerCommand({
      name: "export",
      description: "Write this session (or --session <id>) as Markdown or self-contained HTML",
      args: {
        hint: "[md|html] [path] [--session <id>]",
        complete: (prefix, ctx) => completeExport(prefix, ctx),
      },
      run: guarded((args, ctx) => runExport(args, ctx, { settings: settings(), redact })),
    })
    api.registerCommand({
      name: "commit",
      description: "Propose a commit message for the staged changes, then commit",
      args: { hint: "[--yes] [what the change is about]" },
      run: guarded((args, ctx) => runCommit(args, ctx, { run, settings: settings() })),
    })
    api.registerCommand({
      name: "pr",
      description: "Draft a pull request for this branch; with gh, open it",
      args: { hint: "[base] [--draft] [--yes]" },
      run: guarded((args, ctx) => runPr(args, ctx, { run, settings: settings() })),
    })
    api.registerCommand({
      name: "review",
      description: "Have a reviewer sub-agent review this branch's changes",
      args: { hint: "[base]" },
      run: guarded((args, ctx) =>
        runReview(args, ctx, {
          run,
          settings: settings(),
          ...(api.settings.agents ? { agentModels: api.settings.agents } : {}),
        }),
      ),
    })
  }
}

export default createShareExtension()
