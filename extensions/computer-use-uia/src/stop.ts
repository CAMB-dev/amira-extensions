export const STOP_MESSAGE = "the user stopped desktop control"

/** The rendering process observes keys; this latch is independent of rendering and helpers. */
export class StopState {
  stopped = false

  stop(): boolean {
    const changed = !this.stopped
    this.stopped = true
    return changed
  }

  resume(): void {
    this.stopped = false
  }

  assertAction(): void {
    if (this.stopped) throw new Error(`${STOP_MESSAGE}; use /uia resume to re-enable actions`)
  }
}

export type OverlayReply =
  | { event: "ready"; class?: string; pid?: number }
  | { event: "stop" }
  | { event: "glided" | "armed"; id: number }
  | { event: "error"; error: string }

export function overlayReply(line: string): OverlayReply {
  const value = JSON.parse(line) as OverlayReply
  if (value?.event === "ready")
    return {
      event: "ready",
      ...(typeof value.class === "string" ? { class: value.class } : {}),
      ...(Number.isInteger(value.pid) && value.pid! > 0 ? { pid: value.pid } : {}),
    }
  if (value?.event === "stop") return { event: "stop" }
  if (["glided", "armed"].includes(value?.event) && "id" in value && Number.isInteger(value.id))
    return { event: value.event as "glided" | "armed", id: value.id }
  if (value?.event === "error" && typeof value.error === "string") return value
  throw new Error("Invalid overlay protocol response")
}
