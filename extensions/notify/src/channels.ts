import type { RunCommandOptions, RunCommandResult } from "@amira/api"
import type { WebhookSettings, When } from "./settings.ts"

/** What moment a notification is about. */
export type NotificationKind = "turn" | "dialog" | "background" | "test"

export interface Notification {
  kind: NotificationKind
  /** e.g. "Amira · my-project" */
  title: string
  body: string
}

/** Somewhere notifications go: the desktop, or one webhook. */
export interface Channel {
  /** Names it to the user, e.g. "desktop (Windows toast)" or "discord". */
  name: string
  /** Overrides the general `when` for this channel. */
  when?: When
  /** Rejects with a message fit to show (secrets taken out). */
  send(n: Notification, signal: AbortSignal): Promise<void>
  /** What is missing to use it, e.g. an unset environment variable; undefined when ready. */
  missing?(): string | undefined
}

export type RunCommand = (argv: string[], options: RunCommandOptions) => Promise<RunCommandResult>
export type Fetch = (url: string, init: RequestInit) => Promise<Response>
export type Env = Record<string, string | undefined>

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** How long a desktop notification command may take; the balloon fallback waits a few seconds. */
const DESKTOP_TIMEOUT_MS = 20_000
const WEBHOOK_TIMEOUT_MS = 10_000

/**
 * Windows: a toast through the WinRT API, from Windows PowerShell 5.1 (every Windows 10 and
 * 11 has it; PowerShell 7 cannot load WinRT types this way), under PowerShell's own app id so
 * nothing needs registering. Where toasts are unavailable it falls back to a tray balloon.
 * The text comes in through environment variables, never through the script itself.
 */
export const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
$t = $env:AMIRA_NOTIFY_TITLE
$b = $env:AMIRA_NOTIFY_BODY
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $x = New-Object Windows.Data.Xml.Dom.XmlDocument
  $x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + [Security.SecurityElement]::Escape($t) + '</text><text>' + [Security.SecurityElement]::Escape($b) + '</text></binding></visual></toast>')
  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
  'toast'
} catch {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $i = New-Object System.Windows.Forms.NotifyIcon
  $i.Icon = [System.Drawing.SystemIcons]::Information
  $i.BalloonTipTitle = $t
  $i.BalloonTipText = $b
  $i.Visible = $true
  $i.ShowBalloonTip(8000)
  Start-Sleep -Seconds 6
  $i.Dispose()
  'balloon'
}`

/** PowerShell's -EncodedCommand takes the script as base64 of UTF-16LE. */
const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64")

/** The command that shows a desktop notification on this platform, or undefined where none is known. */
export function desktopCommand(
  platform: string,
  n: Notification,
  env: Env,
): { argv: string[]; env?: Env; label: string } | undefined {
  const title = clip(n.title, 120)
  // A balloon refuses empty text.
  const body = clip(n.body, 300) || " "
  switch (platform) {
    case "win32":
      return {
        label: "Windows toast",
        argv: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodePowerShell(WINDOWS_SCRIPT),
        ],
        env: { ...env, AMIRA_NOTIFY_TITLE: title, AMIRA_NOTIFY_BODY: body },
      }
    case "darwin":
      // The text goes in as arguments of the run handler, never into the script.
      return {
        label: "macOS Notification Center",
        argv: [
          "osascript",
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          title,
          body,
        ],
      }
    case "linux":
    case "freebsd":
    case "openbsd":
      return { label: "notify-send", argv: ["notify-send", "--app-name=Amira", "--", title, body] }
  }
}

/** The system's own notifications, shown by a short command run through the host (runCommand). */
export function desktopChannel(opts: {
  platform: string
  env: Env
  cwd: string
  run: RunCommand
  when?: When
}): Channel | undefined {
  const probe = desktopCommand(opts.platform, { kind: "test", title: "", body: "" }, opts.env)
  if (!probe) return
  return {
    name: `desktop (${probe.label})`,
    ...(opts.when ? { when: opts.when } : {}),
    async send(n, signal) {
      const cmd = desktopCommand(opts.platform, n, opts.env)!
      let result: RunCommandResult
      try {
        result = await opts.run(cmd.argv, {
          cwd: opts.cwd,
          timeoutMs: DESKTOP_TIMEOUT_MS,
          signal,
          ...(cmd.env ? { env: cmd.env } : {}),
        })
      } catch (err) {
        throw new Error(`${cmd.argv[0]} could not run: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (result.timedOut) throw new Error(`${cmd.argv[0]} took longer than ${DESKTOP_TIMEOUT_MS / 1000}s`)
      if (result.exitCode !== 0) {
        const out = clip(result.output.trim().replace(/\s+/g, " "), 200)
        const hint = cmd.argv[0] === "notify-send" ? " (is libnotify's notify-send installed?)" : ""
        throw new Error(
          `${cmd.argv[0]} exited with ${result.exitCode ?? result.signalCode}${hint}${out ? `: ${out}` : ""}`,
        )
      }
    },
  }
}

/** Replaces every secret in `text` with "***", so errors never show a token or a webhook URL. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***")
  return out
}

/** Posts JSON; resolves with the parsed reply (or undefined for an empty one), rejects on HTTP errors. */
async function postJson(
  fetch: Fetch,
  url: string,
  payload: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)]),
  })
  const text = await res.text().catch(() => "")
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${clip(text.replace(/\s+/g, " "), 200)}` : ""}`)
  if (!text) return
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}

/** Plain text of a notification for chat services: the title, then the body. */
const plain = (n: Notification, max: number) => clip(`${n.title}\n${n.body}`, max)

/** One webhook, reading its secrets from the environment each time it sends. */
export function webhookChannel(hook: WebhookSettings, opts: { env: Env; fetch: Fetch }): Channel {
  const { env, fetch } = opts
  const need = (name: string | undefined) => (name ? env[name]?.trim() || undefined : undefined)
  const unset = (...names: (string | undefined)[]) => {
    const missing = names.filter((n): n is string => !!n && !need(n))
    return missing.length ? `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set` : undefined
  }
  const when = hook.when ? { when: hook.when } : {}
  /** Runs a send, taking every secret it used out of any error. */
  const guarded = async (secrets: (string | undefined)[], run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      const msg =
        err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err)
      throw new Error(redact(msg, secrets))
    }
  }
  /** A channel that first checks its environment variables are there. */
  const make = (
    name: string,
    missing: () => string | undefined,
    send: (n: Notification, signal: AbortSignal) => Promise<void>,
  ): Channel => ({
    name,
    ...when,
    missing,
    async send(n, signal) {
      const problem = missing()
      if (problem) throw new Error(problem)
      await send(n, signal)
    },
  })
  switch (hook.type) {
    case "telegram":
      return make(
        "telegram",
        () => unset(hook.botTokenEnv, hook.chatId ? undefined : hook.chatIdEnv),
        async (n, signal) => {
          const token = need(hook.botTokenEnv)!
          const chat = hook.chatId ?? need(hook.chatIdEnv)!
          await guarded([token], async () => {
            const reply = asRecord(
              await postJson(
                fetch,
                `https://api.telegram.org/bot${token}/sendMessage`,
                { chat_id: chat, text: plain(n, 4000), disable_web_page_preview: true },
                signal,
              ),
            )
            if (reply.ok !== true)
              throw new Error(String(reply.description ?? "Telegram refused the message"))
          })
        },
      )
    case "discord":
      return make(
        "discord",
        () => unset(hook.urlEnv),
        async (n, signal) => {
          const url = need(hook.urlEnv)!
          await guarded([url], async () => {
            await postJson(
              fetch,
              url,
              {
                username: "Amira",
                content: clip(`**${n.title}**\n${n.body}`, 1900),
                allowed_mentions: { parse: [] },
              },
              signal,
            )
          })
        },
      )
    case "wecom":
      return make(
        "wecom",
        () => (need(hook.urlEnv) || need(hook.keyEnv) ? undefined : unset(hook.urlEnv ?? hook.keyEnv)),
        async (n, signal) => {
          const key = need(hook.keyEnv)
          const url =
            need(hook.urlEnv) ??
            `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key ?? "")}`
          await guarded([url, key], async () => {
            // The robot takes at most 2048 bytes of text; Chinese takes 3 bytes a character.
            const reply = asRecord(
              await postJson(fetch, url, { msgtype: "text", text: { content: plain(n, 600) } }, signal),
            )
            if (reply.errcode !== undefined && reply.errcode !== 0)
              throw new Error(`WeCom refused the message: ${String(reply.errmsg ?? reply.errcode)}`)
          })
        },
      )
    case "json":
      return make(
        "json webhook",
        () => unset(hook.urlEnv, hook.tokenEnv),
        async (n, signal) => {
          const url = need(hook.urlEnv)!
          const token = need(hook.tokenEnv)
          await guarded([url, token], async () => {
            await postJson(
              fetch,
              url,
              { source: "amira", kind: n.kind, title: n.title, body: n.body, at: new Date().toISOString() },
              signal,
              token ? { authorization: `Bearer ${token}` } : {},
            )
          })
        },
      )
  }
}
