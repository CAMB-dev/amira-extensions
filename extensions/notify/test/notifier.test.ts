import { expect, test } from "bun:test"
import type { Channel, Notification } from "../src/channels.ts"
import { Notifier } from "../src/notifier.ts"
import type { When } from "../src/settings.ts"
import { fakeTimers } from "./fakes.ts"

function recorder(name: string, when?: When, fail?: string) {
  const got: Notification[] = []
  const channel: Channel = {
    name,
    ...(when ? { when } : {}),
    async send(n) {
      if (fail) throw new Error(fail)
      got.push(n)
    },
  }
  return { channel, got }
}

function setup(o: { channels: Channel[]; when?: When; max?: number; per?: number; dedupe?: number }) {
  const t = fakeTimers()
  const state = { focused: undefined as boolean | undefined }
  const reports: string[] = []
  const notifier = new Notifier({
    channels: () => o.channels,
    when: () => o.when ?? "unfocused",
    focused: () => state.focused,
    rateLimit: () => ({ max: o.max ?? 5, perSeconds: o.per ?? 60 }),
    dedupeSeconds: () => o.dedupe ?? 30,
    report: (e) => void reports.push(e),
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  })
  return { notifier, t, state, reports }
}

const note = (body: string): Notification => ({ kind: "turn", title: "Amira · p", body })

test("unfocused: nothing while the terminal has focus; unknown focus counts as away", async () => {
  const a = recorder("a")
  const always = recorder("b", "always")
  const { notifier, state } = setup({ channels: [a.channel, always.channel] })
  await notifier.notify(note("1"))
  expect(a.got).toHaveLength(1)
  state.focused = true
  await notifier.notify(note("2"))
  expect(a.got).toHaveLength(1)
  // A channel set to "always" still gets it.
  expect(always.got.map((n) => n.body)).toEqual(["1", "2"])
  state.focused = false
  await notifier.notify(note("3"))
  expect(a.got.map((n) => n.body)).toEqual(["1", "3"])
})

test("always: sent while focused too, unless the channel says unfocused", async () => {
  const a = recorder("a")
  const away = recorder("b", "unfocused")
  const { notifier, state } = setup({ channels: [a.channel, away.channel], when: "always" })
  state.focused = true
  await notifier.notify(note("1"))
  expect(a.got).toHaveLength(1)
  expect(away.got).toHaveLength(0)
})

test("the same notification within dedupeSeconds is dropped", async () => {
  const a = recorder("a")
  const { notifier, t } = setup({ channels: [a.channel], dedupe: 30 })
  await notifier.notify(note("same"))
  await notifier.notify(note("same"))
  await notifier.notify(note("other"))
  expect(a.got.map((n) => n.body)).toEqual(["same", "other"])
  t.advance(30_000)
  await notifier.notify(note("same"))
  expect(a.got.map((n) => n.body)).toEqual(["same", "other", "same"])
})

test("past the rate limit notifications are held and sent as one once the window frees", async () => {
  const a = recorder("a")
  const { notifier, t } = setup({ channels: [a.channel], max: 2, per: 60, dedupe: 0 })
  await notifier.notify(note("1"))
  t.advance(10_000)
  await notifier.notify(note("2"))
  await notifier.notify(note("3"))
  await notifier.notify(note("4"))
  await notifier.notify(note("4"))
  expect(a.got.map((n) => n.body)).toEqual(["1", "2"])
  // The first one leaves the window 60 s after it went out.
  t.advance(49_999)
  await Bun.sleep(0)
  expect(a.got).toHaveLength(2)
  t.advance(1)
  await Bun.sleep(0)
  expect(a.got.map((n) => n.body)).toEqual(["1", "2", "4\n(and 1 more held back by the rate limit)"])
})

test("a held notification goes through the focus gate again when it is sent", async () => {
  const a = recorder("a")
  const { notifier, t, state } = setup({ channels: [a.channel], max: 1, per: 10 })
  await notifier.notify(note("1"))
  await notifier.notify(note("2"))
  state.focused = true
  t.advance(10_000)
  await Bun.sleep(0)
  expect(a.got.map((n) => n.body)).toEqual(["1"])
})

test("a failing channel is reported once per distinct error; the others still get it", async () => {
  const ok = recorder("ok")
  const bad = recorder("bad", undefined, "HTTP 500")
  const { notifier, reports } = setup({ channels: [bad.channel, ok.channel], dedupe: 0 })
  const r = await notifier.notify(note("1"))
  await notifier.notify(note("2"))
  expect(r).toEqual([
    { channel: "bad", ok: false, error: "HTTP 500" },
    { channel: "ok", ok: true },
  ])
  expect(ok.got).toHaveLength(2)
  expect(reports).toEqual(["notify: bad failed: HTTP 500"])
})

test("test() skips every gate and reports nothing", async () => {
  const a = recorder("a")
  const bad = recorder("bad", undefined, "nope")
  const { notifier, state, reports } = setup({ channels: [a.channel, bad.channel], max: 1 })
  state.focused = true
  await notifier.notify(note("x"))
  const r1 = await notifier.test(note("t"))
  const r2 = await notifier.test(note("t"))
  expect(a.got.map((n) => n.body)).toEqual(["t", "t"])
  expect(r2).toEqual(r1)
  expect(r1[1]).toEqual({ channel: "bad", ok: false, error: "nope" })
  expect(reports).toEqual([])
})

test("dispose drops what is held", async () => {
  const a = recorder("a")
  const { notifier, t } = setup({ channels: [a.channel], max: 1 })
  await notifier.notify(note("1"))
  await notifier.notify(note("2"))
  expect(t.pending()).toBe(1)
  notifier.dispose()
  expect(t.pending()).toBe(0)
})
