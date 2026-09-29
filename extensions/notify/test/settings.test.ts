import { expect, test } from "bun:test"
import { DEFAULTS, readSettings } from "../src/settings.ts"

const read = (raw: unknown) => {
  const problems: string[] = []
  const s = readSettings(raw, (p) => void problems.push(p))
  return { s, problems }
}

test("defaults", () => {
  const { s, problems } = read(undefined)
  expect(s).toEqual(DEFAULTS)
  expect(problems).toEqual([])
  expect(s.when).toBe("unfocused")
  expect(s.desktop.enabled).toBe(true)
})

test("values are read; ones that do not fit are reported and ignored", () => {
  const { s, problems } = read({
    enabled: "yes",
    when: "always",
    longTurnSeconds: 5,
    dialogDelaySeconds: -1,
    events: { dialog: false },
    desktop: { enabled: true, when: "always" },
    rateLimit: { max: 0, perSeconds: 30 },
    preview: false,
  })
  expect(s.enabled).toBe(true)
  expect(s.when).toBe("always")
  expect(s.longTurnSeconds).toBe(5)
  expect(s.dialogDelaySeconds).toBe(2)
  expect(s.events).toEqual({ turn: true, dialog: false, background: true })
  expect(s.desktop).toEqual({ enabled: true, when: "always" })
  expect(s.rateLimit).toEqual({ max: 5, perSeconds: 30 })
  expect(s.preview).toBe(false)
  expect(problems).toEqual([
    '"extensions.notify.enabled" must be true or false',
    '"extensions.notify.dialogDelaySeconds" must be a number of seconds, at least 0',
    '"extensions.notify.rateLimit.max" must be a whole number of at least 1',
  ])
  expect(read({ desktop: false }).s.desktop).toEqual({ enabled: false })
})

test("webhooks name environment variables", () => {
  const { s, problems } = read({
    webhooks: [
      { type: "telegram", botTokenEnv: "TG_TOKEN", chatId: 12345 },
      { type: "discord", urlEnv: "DISCORD_WEBHOOK_URL", when: "always" },
      { type: "wecom", keyEnv: "WECOM_KEY" },
      { type: "json", urlEnv: "HOOK", tokenEnv: "HOOK_TOKEN" },
    ],
  })
  expect(problems).toEqual([])
  expect(s.webhooks).toEqual([
    { type: "telegram", botTokenEnv: "TG_TOKEN", chatId: "12345" },
    { type: "discord", urlEnv: "DISCORD_WEBHOOK_URL", when: "always" },
    { type: "wecom", keyEnv: "WECOM_KEY" },
    { type: "json", urlEnv: "HOOK", tokenEnv: "HOOK_TOKEN" },
  ])
})

test("a secret in the settings file is refused and never echoed", () => {
  const secretUrl = "https://discord.com/api/webhooks/1/SECRET"
  const { s, problems } = read({
    webhooks: [
      { type: "discord", url: secretUrl },
      { type: "discord", urlEnv: secretUrl },
      { type: "telegram", botToken: "123:SECRET", chatId: "1" },
      { type: "json", urlEnv: "HOOK", token: "SECRET" },
    ],
  })
  expect(s.webhooks).toEqual([])
  expect(problems).toHaveLength(4)
  expect(problems[0]).toContain('webhooks[0].url" is not read: secrets stay out of settings files')
  expect(problems[0]).toContain('"urlEnv"')
  expect(problems[1]).toContain("must be the name of an environment variable")
  expect(problems[2]).toContain('"botTokenEnv"')
  expect(problems[3]).toContain('"tokenEnv"')
  expect(problems.join("\n")).not.toContain("SECRET")
})

test("incomplete webhooks are reported and skipped", () => {
  const { s, problems } = read({
    webhooks: [
      { type: "telegram", botTokenEnv: "TG" },
      { type: "wecom" },
      { type: "discord" },
      { type: "slack", urlEnv: "X" },
      "nope",
    ],
  })
  expect(s.webhooks).toEqual([])
  expect(problems).toEqual([
    '"extensions.notify.webhooks[0]" needs "chatId" or "chatIdEnv": the chat to send to',
    `"extensions.notify.webhooks[1]" needs "urlEnv" (the robot's webhook URL) or "keyEnv" (its key)`,
    '"extensions.notify.webhooks[2].urlEnv" is required: the environment variable holding it',
    '"extensions.notify.webhooks[3].type" must be "telegram", "discord", "wecom" or "json"',
    '"extensions.notify.webhooks[4]" must be an object such as {"type": "discord", "urlEnv": "DISCORD_WEBHOOK_URL"}',
  ])
})
