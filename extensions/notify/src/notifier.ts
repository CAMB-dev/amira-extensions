import type { Channel, Notification } from "./channels.ts"
import type { When } from "./settings.ts"

export interface NotifierOptions {
  channels: () => Channel[]
  /** The general `when`; channels may override it. */
  when: () => When
  /** Whether the user's terminal has focus; undefined while unknown (counts as away). */
  focused: () => boolean | undefined
  rateLimit: () => { max: number; perSeconds: number }
  dedupeSeconds: () => number
  /** Reports a channel's failure; the same failure of a channel is reported once. */
  report: (error: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface SendResult {
  channel: string
  ok: boolean
  error?: string
  /** Not sent: the channel only notifies while the terminal is in the background. */
  skipped?: boolean
}

/**
 * Sends notifications to the channels, with the gates in front: a channel that only notifies
 * a user who is away skips while the terminal has focus, the same notification within
 * `dedupeSeconds` is dropped, and past the rate limit notifications are held back and counted
 * into one summary sent as soon as the limit allows.
 */
export class Notifier {
  #opts: NotifierOptions
  #now: () => number
  /** When each notification in the rate window went out. */
  #sent: number[] = []
  /** Last time each notification (by its text) went out, for dedupe. */
  #seen = new Map<string, number>()
  /** Held back by the rate limit: the latest one, and how many in all. */
  #held: { last: Notification; key: string; count: number } | undefined
  #heldTimer: unknown
  /** Failures reported so far, by channel, so a broken webhook does not report every time. */
  #reported = new Map<string, string>()
  /** Sends are never cut short by the notifier; each channel has its own timeout. */
  readonly #signal = new AbortController().signal

  constructor(opts: NotifierOptions) {
    this.#opts = opts
    this.#now = opts.now ?? Date.now
  }

  /** Which channels would take a notification now. */
  #due(): Channel[] {
    const focused = this.#opts.focused()
    return this.#opts.channels().filter((c) => (c.when ?? this.#opts.when()) === "always" || focused !== true)
  }

  /**
   * Sends `n` through the gates. Resolves once every channel is done; failures are reported,
   * not thrown.
   */
  async notify(n: Notification): Promise<SendResult[]> {
    const channels = this.#due()
    if (!channels.length) return []
    const now = this.#now()
    const key = `${n.kind}\n${n.title}\n${n.body}`
    const dedupeMs = this.#opts.dedupeSeconds() * 1000
    for (const [k, at] of this.#seen) if (now - at >= dedupeMs) this.#seen.delete(k)
    if (this.#seen.has(key)) return []
    const { max, perSeconds } = this.#opts.rateLimit()
    const windowMs = perSeconds * 1000
    this.#sent = this.#sent.filter((t) => now - t < windowMs)
    if (this.#sent.length >= max) {
      const held = this.#held
      if (!held || held.key !== key) this.#held = { last: n, key, count: (held?.count ?? 0) + 1 }
      this.#scheduleHeld(this.#sent[0]! + windowMs - now)
      return []
    }
    this.#seen.set(key, now)
    this.#sent.push(now)
    return this.#dispatch(n, channels)
  }

  /** Sends to every channel at once, past every gate: for `/notify test`. */
  test(n: Notification): Promise<SendResult[]> {
    return this.#dispatch(n, this.#opts.channels(), false)
  }

  /**
   * Stops sending: held notifications are dropped. Sends under way are left to finish (the
   * last notification of a print run goes out as the session ends).
   */
  dispose(): void {
    this.#held = undefined
    if (this.#heldTimer !== undefined) (this.#opts.clearTimer ?? clearTimeout)(this.#heldTimer as never)
    this.#heldTimer = undefined
  }

  #scheduleHeld(ms: number) {
    if (this.#heldTimer !== undefined) return
    const set = this.#opts.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t))
    this.#heldTimer = set(
      () => {
        this.#heldTimer = undefined
        const held = this.#held
        this.#held = undefined
        if (!held) return
        const more = held.count > 1 ? `\n(and ${held.count - 1} more held back by the rate limit)` : ""
        // Goes through the gates again: the user may have come back meanwhile.
        void this.notify({ ...held.last, body: `${held.last.body}${more}` })
      },
      Math.max(0, ms),
    )
  }

  async #dispatch(n: Notification, channels: Channel[], reportFailures = true): Promise<SendResult[]> {
    const signal = this.#signal
    return Promise.all(
      channels.map(async (c): Promise<SendResult> => {
        try {
          await c.send(n, signal)
          this.#reported.delete(c.name)
          return { channel: c.name, ok: true }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          if (reportFailures && this.#reported.get(c.name) !== error) {
            this.#reported.set(c.name, error)
            this.#opts.report(`notify: ${c.name} failed: ${error}`)
          }
          return { channel: c.name, ok: false, error }
        }
      }),
    )
  }
}
