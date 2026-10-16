import type { OwnedConversation } from "@amira/api"

/** A stop is terminal for a batch, even though an owned handle itself can be restarted.
 * Observe only the coordinator, not a normally ended/drained child's events. */
export class ImplementationLifecycle {
  readonly controller = new AbortController()
  readonly tools: OwnedConversation
  private drained = false
  private readonly iterator: AsyncIterator<import("@amira/api").AnyEvent>
  private readonly observing: Promise<void>

  constructor(private readonly handle: OwnedConversation) {
    this.iterator = handle.events[Symbol.asyncIterator]()
    this.observing = this.observe()
    this.tools = new Proxy(handle, {
      get: (target, key) => {
        if (key === "runTool")
          return async (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
            this.check()
            this.drained = false
            const signal = options?.signal
              ? AbortSignal.any([options.signal, this.controller.signal])
              : this.controller.signal
            const result = await target.runTool(name, args, { signal })
            if ((result.details as { aborted?: boolean } | undefined)?.aborted)
              this.cancel("Implementation tool was stopped")
            this.check()
            return result
          }
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }

  cancel(reason: string): void {
    this.controller.abort(new Error(reason))
  }
  check(): void {
    if (!this.drained && this.handle.status().state === "stopped")
      this.cancel("Implementation coordinator was stopped")
    this.controller.signal.throwIfAborted()
  }
  async drain(): Promise<void> {
    this.check()
    await this.handle.stop("Implementation finished; drain before checks")
    // This one extension-initiated stop is not native cancellation. The first
    // subsequent tool consumes it; all later stopped states remain terminal.
    this.drained = true
    this.controller.signal.throwIfAborted()
  }
  async close(): Promise<void> {
    await this.iterator.return?.()
    await this.observing
  }
  private async observe(): Promise<void> {
    try {
      while (true) {
        const next = await this.iterator.next()
        if (next.done) return
        const event = next.value
        if (event.sessionId !== this.handle.id) continue
        if (event.type === "turn.end" && event.data.reason === "aborted")
          this.cancel("Implementation coordinator was stopped")
        if (
          event.type === "tool.execute.end" &&
          (event.data.rejected === "aborted" ||
            (event.data.result.details as { aborted?: boolean } | undefined)?.aborted)
        )
          this.cancel("Implementation tool was stopped")
        if (event.type === "session.end") this.cancel("Implementation conversation ended")
      }
    } catch (error) {
      this.cancel(`Implementation event stream failed: ${String(error)}`)
    }
  }
}
