import path from "node:path"
import type { AnyEvent, CommandCandidate, EventMap, Extension, ExtensionAPI } from "@amira/api"
import {
  type Channel,
  desktopChannel,
  type Env,
  type Fetch,
  type Notification,
  type RunCommand,
  webhookChannel,
} from "./channels.ts"
import { Notifier, type SendResult } from "./notifier.ts"
import { type NotifySettings, readSettings } from "./settings.ts"
import { Watcher } from "./watcher.ts"

export * from "./channels.ts"
export * from "./notifier.ts"
export * from "./settings.ts"
export * from "./watcher.ts"

/** What the extension uses from the outside world; tests pass fakes. */
export interface NotifyDeps {
  /** Default: the host's runCommand. */
  runCommand?: RunCommand
  fetch?: Fetch
  platform?: string
  env?: Env
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** The events the watcher follows. */
const WATCHED: (keyof EventMap)[] = [
  "session.start",
  "turn.start",
  "turn.end",
  "message.end",
  "subagent.start",
  "subagent.end",
  "group.start",
  "group.end",
  "ui.request",
  "ui.resolved",
]

const whenText = (s: NotifySettings) =>
  s.when === "always" ? "always" : "only while the terminal is in the background"

export function createNotifyExtension(deps: NotifyDeps = {}): Extension {
  return (api: ExtensionAPI) => {
    const settings = readSettings(api.settings.extensions?.notify, (p) => api.reportError(p))
    const env: Env = deps.env ?? process.env
    const run: RunCommand = deps.runCommand ?? ((argv, opts) => api.runCommand(argv, opts))
    const fetch: Fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init))
    const platform = deps.platform ?? process.platform
    const timers = {
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    }
    /** `/notify off` mutes this session without touching the settings. */
    let on = settings.enabled
    /** What the frontend last said (ui.focus); undefined until it says anything. */
    let focused: boolean | undefined

    const channels: Channel[] = []
    const desktop = settings.desktop.enabled
      ? desktopChannel({
          platform,
          env,
          cwd: api.cwd,
          run,
          ...(settings.desktop.when ? { when: settings.desktop.when } : {}),
        })
      : undefined
    if (desktop) channels.push(desktop)
    for (const hook of settings.webhooks) channels.push(webhookChannel(hook, { env, fetch }))

    const notifier = new Notifier({
      channels: () => channels,
      when: () => settings.when,
      focused: () => focused,
      rateLimit: () => settings.rateLimit,
      dedupeSeconds: () => settings.dedupeSeconds,
      report: (error) => api.reportError(error),
      ...(deps.now ? { now: deps.now } : {}),
      ...timers,
    })
    const title = `Amira · ${path.basename(api.cwd) || api.cwd}`
    const watcher = new Watcher({
      settings: () => settings,
      title,
      notify: (n) => {
        if (on) void notifier.notify(n)
      },
      ...timers,
    })

    for (const type of WATCHED) api.on(type, (e) => watcher.handle(e as AnyEvent))
    api.on("ui.focus", (e) => {
      focused = e.data.focused
    })
    api.on("session.end", (e) => {
      if (e.parentSessionId !== undefined) return
      watcher.dispose()
      notifier.dispose()
    })

    api.registerStatusItem({
      id: "notify",
      align: "right",
      order: 50,
      tone: "muted",
      // Shown only when muted for this session, so the user does not wonder why nothing arrives.
      text: () => (on || !settings.enabled ? undefined : "notify off"),
    })

    const focusText = () =>
      focused === undefined
        ? "the terminal has not reported its focus"
        : focused
          ? "the terminal has focus now"
          : "the terminal is in the background now"

    const describe = (): string => {
      const lines: string[] = []
      lines.push(
        on
          ? `Notifications are on, ${whenText(settings)} (${focusText()}).`
          : settings.enabled
            ? "Notifications are off for this session (/notify on turns them back on)."
            : 'Notifications are off ("extensions.notify.enabled": false).',
      )
      const what: string[] = []
      if (settings.events.turn) what.push(`turns longer than ${settings.longTurnSeconds}s`)
      if (settings.events.dialog)
        what.push(
          settings.dialogDelaySeconds
            ? `questions left open ${settings.dialogDelaySeconds}s`
            : "questions waiting for you",
        )
      if (settings.events.background) what.push("background agents, workflows and swarms ending")
      lines.push(`For: ${what.length ? what.join(", ") : "nothing (every event is off)"}.`)
      if (!channels.length) {
        lines.push(
          settings.desktop.enabled
            ? `No channel: there is no desktop notifier for ${platform}, and no webhook is set up.`
            : "No channel: the desktop is off and no webhook is set up.",
        )
      } else {
        lines.push("Channels:")
        for (const c of channels) {
          const missing = c.missing?.()
          const when = c.when && c.when !== settings.when ? ` (${c.when})` : ""
          lines.push(`  ${c.name}${when}${missing ? ` - not ready: ${missing}` : ""}`)
        }
      }
      lines.push(
        `At most ${settings.rateLimit.max} in ${settings.rateLimit.perSeconds}s; repeats within ${settings.dedupeSeconds}s are dropped.`,
      )
      return lines.join("\n")
    }

    const testResults = (results: SendResult[]) =>
      results.map((r) => `  ${r.channel}: ${r.ok ? "sent" : `failed - ${r.error}`}`).join("\n")

    api.registerCommand({
      name: "notify",
      description: "Notifications: show the setup, send a test, or turn them off and on for this session",
      args: {
        hint: "[test | on | off]",
        complete: (): CommandCandidate[] => [
          { value: "test", description: "send a test notification through every channel" },
          { value: "on", description: "turn notifications on for this session" },
          { value: "off", description: "turn notifications off for this session" },
        ],
      },
      async run(args, ctx) {
        switch (args.trim().toLowerCase()) {
          case "":
          case "status":
            ctx.print(describe())
            return
          case "on":
            on = true
            api.requestRender()
            ctx.print(`Notifications on for this session, ${whenText(settings)}.`)
            return
          case "off":
            on = false
            api.requestRender()
            ctx.print("Notifications off for this session.")
            return
          case "test": {
            if (!channels.length) {
              ctx.print(describe(), "warning")
              return
            }
            const n: Notification = {
              kind: "test",
              title,
              body: "Test notification from /notify test. If you see this, notifications work.",
            }
            const results = await notifier.test(n)
            const failed = results.some((r) => !r.ok)
            ctx.print(
              `${failed ? "Some channels failed" : "Sent"} (tests ignore focus, limits and /notify off):\n${testResults(results)}`,
              failed ? "warning" : "info",
            )
            return
          }
          default:
            throw new Error("usage: /notify [test | on | off]")
        }
      },
    })
  }
}

export default createNotifyExtension()
