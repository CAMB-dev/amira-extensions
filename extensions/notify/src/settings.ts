/**
 * The extension's settings: `extensions.notify` in settings.json. Secrets (webhook URLs, bot
 * tokens) never go in the file: the settings name the environment variables that hold them.
 */

/** Notify only while the terminal is in the background, or always. */
export type When = "unfocused" | "always"

export type WebhookType = "telegram" | "discord" | "wecom" | "json"

/** A webhook, with the names of the environment variables holding its secrets. */
export type WebhookSettings =
  | { type: "telegram"; botTokenEnv: string; chatIdEnv?: string; chatId?: string; when?: When }
  | { type: "discord"; urlEnv: string; when?: When }
  /** A WeCom (企业微信) group robot: its whole webhook URL, or only its key. */
  | { type: "wecom"; urlEnv?: string; keyEnv?: string; when?: When }
  /** Any endpoint that takes a JSON POST; `tokenEnv` adds an `Authorization: Bearer` header. */
  | { type: "json"; urlEnv: string; tokenEnv?: string; when?: When }

export interface NotifySettings {
  /** Off: nothing is sent (`/notify test` still works). */
  enabled: boolean
  when: When
  /** A turn that ran at least this long notifies when it ends. */
  longTurnSeconds: number
  /** A question still open after this long notifies (0: at once). */
  dialogDelaySeconds: number
  /** Which moments notify. */
  events: { turn: boolean; dialog: boolean; background: boolean }
  /** Include the start of the reply (or of the question) in the notification. */
  preview: boolean
  /** The system's own notifications: Windows toasts, macOS Notification Center, notify-send. */
  desktop: { enabled: boolean; when?: When }
  webhooks: WebhookSettings[]
  /** At most `max` notifications within `perSeconds`; the ones over it are counted into the next. */
  rateLimit: { max: number; perSeconds: number }
  /** The same notification again within this long is dropped. */
  dedupeSeconds: number
}

export const DEFAULTS: NotifySettings = {
  enabled: true,
  when: "unfocused",
  longTurnSeconds: 30,
  dialogDelaySeconds: 2,
  events: { turn: true, dialog: true, background: true },
  preview: true,
  desktop: { enabled: true },
  webhooks: [],
  rateLimit: { max: 5, perSeconds: 60 },
  dedupeSeconds: 30,
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Fields that would hold a secret in the file itself: refused, with a pointer to the *Env one. */
const SECRET_FIELDS: Record<string, string> = {
  url: "urlEnv",
  token: "tokenEnv",
  botToken: "botTokenEnv",
  key: "keyEnv",
  webhook: "urlEnv",
}

const isWhen = (v: unknown): v is When => v === "unfocused" || v === "always"

/** Reads `extensions.notify`; values that do not fit are reported and ignored. */
export function readSettings(raw: unknown, report: (problem: string) => void = () => {}): NotifySettings {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: NotifySettings = structuredClone(DEFAULTS)
  const at = (k: string) => `"extensions.notify.${k}"`
  const bool = (k: string, v: unknown, set: (b: boolean) => void) => {
    if (v === undefined) return
    if (typeof v === "boolean") set(v)
    else report(`${at(k)} must be true or false`)
  }
  const seconds = (k: string, v: unknown, min: number, set: (n: number) => void) => {
    if (v === undefined) return
    if (typeof v === "number" && Number.isFinite(v) && v >= min) set(v)
    else report(`${at(k)} must be a number of seconds, at least ${min}`)
  }
  bool("enabled", s.enabled, (b) => (out.enabled = b))
  if (s.when !== undefined) {
    if (isWhen(s.when)) out.when = s.when
    else report(`${at("when")} must be "unfocused" or "always"`)
  }
  seconds("longTurnSeconds", s.longTurnSeconds, 0, (n) => (out.longTurnSeconds = n))
  seconds("dialogDelaySeconds", s.dialogDelaySeconds, 0, (n) => (out.dialogDelaySeconds = n))
  seconds("dedupeSeconds", s.dedupeSeconds, 0, (n) => (out.dedupeSeconds = n))
  bool("preview", s.preview, (b) => (out.preview = b))
  if (s.events !== undefined) {
    if (s.events && typeof s.events === "object" && !Array.isArray(s.events)) {
      const e = s.events as Record<string, unknown>
      for (const k of ["turn", "dialog", "background"] as const)
        bool(`events.${k}`, e[k], (b) => (out.events[k] = b))
    } else report(`${at("events")} must be an object such as {"turn": true, "dialog": false}`)
  }
  if (s.desktop !== undefined) {
    if (typeof s.desktop === "boolean") out.desktop = { enabled: s.desktop }
    else if (s.desktop && typeof s.desktop === "object" && !Array.isArray(s.desktop)) {
      const d = s.desktop as Record<string, unknown>
      bool("desktop.enabled", d.enabled, (b) => (out.desktop.enabled = b))
      if (d.when !== undefined) {
        if (isWhen(d.when)) out.desktop.when = d.when
        else report(`${at("desktop.when")} must be "unfocused" or "always"`)
      }
    } else report(`${at("desktop")} must be true, false or {"enabled": …, "when": …}`)
  }
  if (s.rateLimit !== undefined) {
    const r = s.rateLimit as Record<string, unknown> | null
    const max = r && typeof r === "object" ? r.max : undefined
    const per = r && typeof r === "object" ? r.perSeconds : undefined
    if (max !== undefined && !(typeof max === "number" && Number.isInteger(max) && max >= 1))
      report(`${at("rateLimit.max")} must be a whole number of at least 1`)
    else if (typeof max === "number") out.rateLimit.max = max
    if (per !== undefined && !(typeof per === "number" && Number.isFinite(per) && per > 0))
      report(`${at("rateLimit.perSeconds")} must be a number of seconds above 0`)
    else if (typeof per === "number") out.rateLimit.perSeconds = per
  }
  if (s.webhooks !== undefined) {
    if (!Array.isArray(s.webhooks)) report(`${at("webhooks")} must be a list`)
    else
      s.webhooks.forEach((w, i) => {
        const hook = readWebhook(w, `webhooks[${i}]`, (p) => report(`${at(p.path)} ${p.problem}`))
        if (hook) out.webhooks.push(hook)
      })
  }
  return out
}

function readWebhook(
  raw: unknown,
  path: string,
  report: (p: { path: string; problem: string }) => void,
): WebhookSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    report({
      path,
      problem: 'must be an object such as {"type": "discord", "urlEnv": "DISCORD_WEBHOOK_URL"}',
    })
    return
  }
  const w = raw as Record<string, unknown>
  for (const [field, instead] of Object.entries(SECRET_FIELDS)) {
    if (w[field] !== undefined) {
      report({
        path: `${path}.${field}`,
        problem: `is not read: secrets stay out of settings files. Put it in an environment variable and name that in "${instead}"`,
      })
      return
    }
  }
  let bad = false
  /** Reads an environment variable's name; a URL or token in its place is refused, not echoed. */
  const env = (field: string, required: boolean): string | undefined => {
    const v = w[field]
    if (v === undefined) {
      if (required) {
        report({ path: `${path}.${field}`, problem: "is required: the environment variable holding it" })
        bad = true
      }
      return
    }
    if (typeof v === "string" && ENV_NAME.test(v)) return v
    report({
      path: `${path}.${field}`,
      problem: "must be the name of an environment variable (letters, digits, _), not the value itself",
    })
    bad = true
  }
  let when: When | undefined
  if (w.when !== undefined) {
    if (isWhen(w.when)) when = w.when
    else report({ path: `${path}.when`, problem: 'must be "unfocused" or "always"' })
  }
  const extra = when ? { when } : {}
  switch (w.type) {
    case "telegram": {
      const botTokenEnv = env("botTokenEnv", true)
      const chatIdEnv = env("chatIdEnv", false)
      let chatId: string | undefined
      if (w.chatId !== undefined) {
        if (typeof w.chatId === "string" || typeof w.chatId === "number") chatId = String(w.chatId)
        else {
          report({ path: `${path}.chatId`, problem: "must be a chat id such as 123456789 or @channel" })
          bad = true
        }
      }
      if (!chatId && !chatIdEnv && !bad) {
        report({ path, problem: 'needs "chatId" or "chatIdEnv": the chat to send to' })
        bad = true
      }
      if (bad || !botTokenEnv) return
      return {
        type: "telegram",
        botTokenEnv,
        ...(chatIdEnv ? { chatIdEnv } : {}),
        ...(chatId ? { chatId } : {}),
        ...extra,
      }
    }
    case "discord": {
      const urlEnv = env("urlEnv", true)
      return bad || !urlEnv ? undefined : { type: "discord", urlEnv, ...extra }
    }
    case "wecom": {
      const urlEnv = env("urlEnv", false)
      const keyEnv = env("keyEnv", false)
      if (!urlEnv && !keyEnv && !bad) {
        report({ path, problem: 'needs "urlEnv" (the robot\'s webhook URL) or "keyEnv" (its key)' })
        bad = true
      }
      if (bad) return
      return { type: "wecom", ...(urlEnv ? { urlEnv } : {}), ...(keyEnv ? { keyEnv } : {}), ...extra }
    }
    case "json": {
      const urlEnv = env("urlEnv", true)
      const tokenEnv = env("tokenEnv", false)
      if (bad || !urlEnv) return
      return { type: "json", urlEnv, ...(tokenEnv ? { tokenEnv } : {}), ...extra }
    }
    default:
      report({ path: `${path}.type`, problem: 'must be "telegram", "discord", "wecom" or "json"' })
  }
}
