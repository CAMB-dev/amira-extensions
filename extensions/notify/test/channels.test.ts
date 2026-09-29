import { expect, test } from "bun:test"
import {
  desktopChannel,
  desktopCommand,
  type Notification,
  redact,
  WINDOWS_SCRIPT,
  webhookChannel,
} from "../src/channels.ts"
import { fakeFetch, fakeRun } from "./fakes.ts"

const n: Notification = { kind: "turn", title: `Amira · proj "x"`, body: "Done after 2m 05s\n<b>&'$(evil)'" }
const signal = new AbortController().signal

test("Windows: a toast from Windows PowerShell, the text only in the environment", () => {
  const cmd = desktopCommand("win32", n, { PATH: "C:\\bin" })!
  expect(cmd.argv[0]).toBe("powershell.exe")
  expect(cmd.argv).toContain("-EncodedCommand")
  const script = Buffer.from(cmd.argv.at(-1)!, "base64").toString("utf16le")
  expect(script).toBe(WINDOWS_SCRIPT)
  // Nothing of the notification is in the command line.
  expect(cmd.argv.join(" ")).not.toContain("evil")
  expect(cmd.env).toMatchObject({ PATH: "C:\\bin", AMIRA_NOTIFY_TITLE: n.title, AMIRA_NOTIFY_BODY: n.body })
  // The XML is escaped in the script, and a balloon is the fallback.
  expect(script).toContain("SecurityElement]::Escape($t)")
  expect(script).toContain("ShowBalloonTip")
})

test("macOS: osascript, the text as arguments of the run handler", () => {
  const cmd = desktopCommand("darwin", n, {})!
  expect(cmd.argv.slice(0, 7)).toEqual([
    "osascript",
    "-e",
    "on run argv",
    "-e",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e",
    "end run",
  ])
  expect(cmd.argv.slice(7)).toEqual([n.title, n.body])
})

test("Linux: notify-send, options ended before the text", () => {
  const cmd = desktopCommand("linux", { ...n, body: "--help" }, {})!
  expect(cmd.argv).toEqual(["notify-send", "--app-name=Amira", "--", n.title, "--help"])
  expect(desktopCommand("aix", n, {})).toBeUndefined()
})

test("long text is cut, and an empty body is a space", () => {
  const cmd = desktopCommand("linux", { kind: "test", title: "t", body: "x".repeat(1000) }, {})!
  expect(cmd.argv.at(-1)!.length).toBe(300)
  expect(desktopCommand("linux", { kind: "test", title: "t", body: "" }, {})!.argv.at(-1)).toBe(" ")
})

test("the desktop channel runs the command through runCommand and reports failures", async () => {
  const ok = fakeRun()
  const c = desktopChannel({ platform: "linux", env: {}, cwd: "/w", run: ok.run })!
  expect(c.name).toBe("desktop (notify-send)")
  await c.send(n, signal)
  expect(ok.calls[0]!.argv[0]).toBe("notify-send")
  expect(ok.calls[0]!.opts).toMatchObject({ cwd: "/w", timeoutMs: 20_000 })

  const missing = fakeRun({ exitCode: 127, output: "notify-send: not found" })
  const bad = desktopChannel({ platform: "linux", env: {}, cwd: "/w", run: missing.run })!
  await expect(bad.send(n, signal)).rejects.toThrow(
    /exited with 127 \(is libnotify's notify-send installed\?\): notify-send: not found/,
  )

  const slow = desktopChannel({
    platform: "win32",
    env: {},
    cwd: "/w",
    run: fakeRun({ timedOut: true, exitCode: null }).run,
  })!
  await expect(slow.send(n, signal)).rejects.toThrow(/took longer than 20s/)

  const throws = desktopChannel({
    platform: "darwin",
    env: {},
    cwd: "/w",
    run: async () => {
      throw new Error("spawn failed")
    },
  })!
  await expect(throws.send(n, signal)).rejects.toThrow("osascript could not run: spawn failed")
  expect(desktopChannel({ platform: "aix", env: {}, cwd: "/w", run: ok.run })).toBeUndefined()
})

test("telegram: sendMessage with the bot token from the environment", async () => {
  const f = fakeFetch(() => ({ body: { ok: true } }))
  const env = { TG_TOKEN: "123:secret-token", TG_CHAT: "42" }
  const c = webhookChannel(
    { type: "telegram", botTokenEnv: "TG_TOKEN", chatIdEnv: "TG_CHAT" },
    { env, fetch: f.fetch },
  )
  expect(c.missing!()).toBeUndefined()
  await c.send(n, signal)
  expect(f.calls[0]!.url).toBe("https://api.telegram.org/bot123:secret-token/sendMessage")
  expect(f.calls[0]!.body).toEqual({
    chat_id: "42",
    text: `${n.title}\n${n.body}`,
    disable_web_page_preview: true,
  })
})

test("telegram: a refusal is an error, with the token taken out", async () => {
  const token = "123:secret-token"
  const f = fakeFetch(() => ({ status: 401, body: { ok: false, description: `Unauthorized for ${token}` } }))
  const c = webhookChannel(
    { type: "telegram", botTokenEnv: "TG", chatId: "@me" },
    { env: { TG: token }, fetch: f.fetch },
  )
  const err = await c.send(n, signal).catch((e: Error) => e.message)
  expect(err).toContain("HTTP 401")
  expect(err).not.toContain(token)
  expect(err).toContain("***")
  const refused = fakeFetch(() => ({ body: { ok: false, description: "Bad Request: chat not found" } }))
  const c2 = webhookChannel(
    { type: "telegram", botTokenEnv: "TG", chatId: "1" },
    { env: { TG: token }, fetch: refused.fetch },
  )
  await expect(c2.send(n, signal)).rejects.toThrow("Bad Request: chat not found")
})

test("discord: content with the title in bold, no mentions", async () => {
  const f = fakeFetch(() => ({ status: 204 }))
  const url = "https://discord.com/api/webhooks/1/abc"
  const c = webhookChannel({ type: "discord", urlEnv: "DC" }, { env: { DC: url }, fetch: f.fetch })
  await c.send({ ...n, body: "@everyone look" }, signal)
  expect(f.calls[0]!.url).toBe(url)
  expect(f.calls[0]!.body).toEqual({
    username: "Amira",
    content: `**${n.title}**\n@everyone look`,
    allowed_mentions: { parse: [] },
  })
  expect(f.calls[0]!.headers["content-type"]).toBe("application/json")
})

test("wecom: the robot's key or URL; errcode is checked", async () => {
  const f = fakeFetch(() => ({ body: { errcode: 0, errmsg: "ok" } }))
  const c = webhookChannel({ type: "wecom", keyEnv: "WK" }, { env: { WK: "k-1/2" }, fetch: f.fetch })
  await c.send(n, signal)
  expect(f.calls[0]!.url).toBe("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k-1%2F2")
  expect(f.calls[0]!.body).toEqual({ msgtype: "text", text: { content: `${n.title}\n${n.body}` } })

  const url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=zzzz"
  const bad = fakeFetch(() => ({ body: { errcode: 93000, errmsg: `invalid webhook url ${url}` } }))
  const c2 = webhookChannel({ type: "wecom", urlEnv: "WU" }, { env: { WU: url }, fetch: bad.fetch })
  const err = await c2.send(n, signal).catch((e: Error) => e.message)
  expect(err).toBe("WeCom refused the message: invalid webhook url ***")
})

test("json: the notification as JSON, with a bearer token when named", async () => {
  const f = fakeFetch()
  const c = webhookChannel(
    { type: "json", urlEnv: "HOOK", tokenEnv: "HOOK_TOKEN" },
    { env: { HOOK: "https://example.test/hook", HOOK_TOKEN: "tok-123" }, fetch: f.fetch },
  )
  expect(c.name).toBe("json webhook")
  await c.send(n, signal)
  expect(f.calls[0]!.headers.authorization).toBe("Bearer tok-123")
  expect(f.calls[0]!.body).toMatchObject({ source: "amira", kind: "turn", title: n.title, body: n.body })
  expect(typeof f.calls[0]!.body.at).toBe("string")
})

test("unset environment variables: missing() says which, and send fails without a request", async () => {
  const f = fakeFetch()
  const c = webhookChannel(
    { type: "json", urlEnv: "HOOK", tokenEnv: "TOKEN" },
    { env: { HOOK: "  " }, fetch: f.fetch },
  )
  expect(c.missing!()).toBe("HOOK, TOKEN are not set")
  await expect(c.send(n, signal)).rejects.toThrow("HOOK, TOKEN are not set")
  const w = webhookChannel({ type: "wecom", urlEnv: "WU", keyEnv: "WK" }, { env: {}, fetch: f.fetch })
  expect(w.missing!()).toBe("WU is not set")
  const t = webhookChannel({ type: "telegram", botTokenEnv: "TG", chatId: "1" }, { env: {}, fetch: f.fetch })
  expect(t.missing!()).toBe("TG is not set")
  expect(f.calls).toHaveLength(0)
})

test("network failures and timeouts are errors without the URL", async () => {
  const url = "https://discord.com/api/webhooks/9/very-secret"
  const c = webhookChannel(
    { type: "discord", urlEnv: "DC" },
    {
      env: { DC: url },
      fetch: async () => {
        throw new Error(`Unable to connect. Is the computer able to access the url? ${url}`)
      },
    },
  )
  const err = await c.send(n, signal).catch((e: Error) => e.message)
  expect(err).not.toContain("very-secret")
  const slow = webhookChannel(
    { type: "discord", urlEnv: "DC" },
    {
      env: { DC: url },
      fetch: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
    },
  )
  await expect(slow.send(n, signal)).rejects.toThrow("timed out")
})

test("redact leaves short values alone", () => {
  expect(redact("a b abc abcd", ["abcd", "a", undefined])).toBe("a b abc ***")
})
