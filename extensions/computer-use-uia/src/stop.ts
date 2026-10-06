export const STOP_MESSAGE = "the user stopped desktop control"

/** The rendering process observes keys; this latch is independent of rendering and helpers. */
export class StopState {
  stopped = false
  private escapeAt?: number

  stop(): boolean {
    const changed = !this.stopped
    this.stopped = true
    return changed
  }

  escape(now: number): boolean {
    if (this.escapeAt !== undefined && now - this.escapeAt <= 500) {
      this.escapeAt = undefined
      return this.stop()
    }
    this.escapeAt = now
    return false
  }

  resume(): void {
    this.stopped = false
    this.escapeAt = undefined
  }

  assertAction(): void {
    if (this.stopped) throw new Error(`${STOP_MESSAGE}; use /uia resume to re-enable actions`)
  }
}

export type OverlayReply = { event: "ready" | "stop" } | { event: "glided"; id: number }

export function overlayReply(line: string): OverlayReply {
  const value = JSON.parse(line) as OverlayReply
  if (value?.event === "ready" || value?.event === "stop") return { event: value.event }
  if (value?.event === "glided" && Number.isInteger(value.id)) return { event: value.event, id: value.id }
  throw new Error("Invalid overlay protocol response")
}
