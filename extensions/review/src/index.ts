import type { Extension } from "@amira/api"
import { ReviewCommands } from "./command.ts"
import { ReviewRunner, settingFields } from "./run.ts"
import { detailView, progressView } from "./ui.ts"

const extension: Extension = (api) => {
  const settings = api.settings.declare({ fields: settingFields })
  const runner = new ReviewRunner(api)
  const commands = new ReviewCommands(api, runner, () => settings.get())
  api.registerCommand({
    name: "code-review",
    description: "Experimental bounded independent static code review",
    args: {
      hint: "[worktree | since REF | pr NUMBER/URL | --deep | status | stop | last | show | ignore | fix]",
    },
    run: (args, ctx) => commands.run(args, ctx),
  })
  api.registerView(detailView())
  api.registerView(progressView(() => runner.snapshot()))
  api.registerStatusItem({
    id: "review-status",
    priority: 20,
    text: () => {
      const progress = runner.snapshot()
      if (!progress) return undefined
      const states = Object.values(progress.children)
      const complete = states.filter((state) => ["done", "error", "aborted"].includes(state)).length
      return `Review ${progress.phase} ${complete}/${states.length}`
    },
  })
  api.on("session.end", (event) => {
    if (runner.snapshot()?.origin === event.sessionId) runner.stop("Origin session ended or switched")
  })
  api.on("session.start", (event) => {
    const origin = runner.snapshot()?.origin
    if (origin && origin !== event.sessionId && !event.parentSessionId) runner.stop("Origin session switched")
  })
  api.onUnload(() => runner.stop("Extension unloaded"))
  api.onExit(async () => {
    runner.stop("Host exiting")
    await runner.settled()
  })
}
export default extension
