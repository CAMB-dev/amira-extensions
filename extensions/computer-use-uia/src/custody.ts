import type { ExtensionAPI, PipeProcess } from "@amira/api"

export interface CustodyOffer {
  job: string
  transfer: string
  session: string
  pid: number
  started: string
  handle: number
  writerPid: number
  writerStarted: string
}

type Host = Pick<ExtensionAPI, "openPipe" | "cwd" | "reportError">
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Independent private pipe owner. Never reconstruct cleanup authority from a journal. */
export class SessionCustody {
  readonly session = crypto.randomUUID()
  identity?: { pid: number; started: string }
  private pipe?: PipeProcess
  private state: "new" | "starting" | "running" | "stopping" | "exited" = "new"
  private readonly exited = Promise.withResolvers<void>()
  private readonly pending = new Map<
    string,
    {
      offer: CustodyOffer
      resolve(): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly retained = new Map<string, CustodyOffer>()
  private readonly commands = new Map<
    string,
    {
      identity: Record<string, unknown>
      reply: "root-recorded" | "stopped"
      resolve(reply: Record<string, unknown>): void
      reject(error: Error): void
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  private failure?: Error
  private ending = false
  private readonly transfers = new Set<string>()

  constructor(
    private readonly host: Host,
    private readonly timeoutMs: number,
    private readonly onLost: () => void = () => {},
  ) {
    void this.exited.promise.catch(() => {})
  }

  async start(lifetimePid: number, lifetimeStarted: string): Promise<void> {
    if (this.state === "running") return
    if (this.state !== "new") throw new Error("UIA custody owner is unavailable; restart the session")
    this.state = "starting"
    const ready = Promise.withResolvers<void>()
    let pid: number | undefined
    let buffer = ""
    let drained = false
    const timer = setTimeout(
      () => ready.reject(new Error("UIA custody owner failed to start")),
      this.timeoutMs,
    )
    try {
      this.pipe = this.host.openPipe(
        [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          `${import.meta.dir}/../helper/custody.ps1`,
          "-LifetimePid",
          String(lifetimePid),
          "-LifetimeStarted",
          lifetimeStarted,
        ],
        {
          cwd: this.host.cwd,
          onEvent: (event) => {
            if (event.type === "spawned") pid = event.pid
            if (event.type === "stderr") this.host.reportError(`computer-use-uia: ${event.data.trim()}`)
            if (event.type === "stdout" && this.state !== "exited") {
              buffer += event.data
              if (buffer.length > 64_000) {
                ready.reject(new Error("UIA custody response exceeded the limit"))
                return
              }
              let newline = buffer.indexOf("\n")
              while (newline >= 0) {
                const line = buffer.slice(0, newline).trim()
                buffer = buffer.slice(newline + 1)
                newline = buffer.indexOf("\n")
                if (!line) continue
                try {
                  const reply = JSON.parse(line)
                  if (reply.session !== this.session) continue
                  if (reply.event === "custody-ready" && this.state === "starting") {
                    if (
                      reply.pid !== pid ||
                      typeof reply.started !== "string" ||
                      !/^[1-9]\d*$/.test(reply.started)
                    )
                      throw new Error("Invalid custody owner identity")
                    this.identity = { pid: reply.pid, started: reply.started }
                    this.state = "running"
                    ready.resolve()
                  } else if (reply.event === "custody-drained") {
                    drained = reply.incomplete === false
                  } else if (reply.event === "retained" || reply.event === "custody-error") {
                    const pending = this.pending.get(reply.transfer)
                    if (
                      !pending ||
                      !Object.entries(pending.offer).every(([key, value]) => reply[key] === value)
                    )
                      continue
                    this.pending.delete(reply.transfer)
                    clearTimeout(pending.timer)
                    if (reply.event === "retained") {
                      this.retained.set(pending.offer.job, pending.offer)
                      pending.resolve()
                    } else pending.reject(new Error("UIA custody transfer was rejected; launch refused"))
                  } else if (["root-recorded", "stopped", "command-error"].includes(reply.event)) {
                    const pending = this.commands.get(reply.request)
                    if (
                      !pending ||
                      !Object.entries(pending.identity).every(([key, value]) => reply[key] === value) ||
                      (reply.event !== pending.reply && reply.event !== "command-error") ||
                      (reply.event === "stopped" && typeof reply.incomplete !== "boolean")
                    )
                      continue
                    this.commands.delete(reply.request)
                    clearTimeout(pending.timer)
                    if (reply.event === "command-error")
                      pending.reject(new Error("UIA custody command rejected"))
                    else pending.resolve(reply)
                  }
                } catch {
                  ready.reject(new Error("Invalid UIA custody response"))
                }
              }
            }
            if (event.type === "exit") {
              const stopping = this.state === "stopping"
              this.state = "exited"
              const error = new Error("UIA custody owner exited; cleanup authority unavailable")
              ready.reject(this.ending ? new Error("UIA custody startup cancelled") : error)
              for (const pending of this.pending.values()) {
                clearTimeout(pending.timer)
                pending.reject(error)
              }
              this.pending.clear()
              for (const pending of this.commands.values()) {
                clearTimeout(pending.timer)
                pending.reject(error)
              }
              this.commands.clear()
              if (drained && event.code === 0 && !event.error) this.exited.resolve()
              else {
                this.failure = error
                this.exited.reject(error)
              }
              if (!stopping) this.onLost()
            }
          },
        },
      )
      this.pipe.write(`${JSON.stringify({ event: "custody-session", session: this.session })}\n`)
      await ready.promise
    } catch (error) {
      // stop() can finish a successfully drained owner before readiness arrives.
      // Startup cancellation must not overwrite its clean terminal state.
      if (this.ending) throw new Error("UIA custody startup cancelled")
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.state = "stopping"
      this.pipe?.close(15_000)
      if (!this.pipe) {
        this.state = "exited"
        this.exited.reject(this.failure)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async retain(offer: CustodyOffer): Promise<void> {
    if (this.state !== "running" || this.failure)
      throw new Error("UIA custody owner is unavailable; launch refused")
    if (
      offer.session !== this.session ||
      !uuid.test(offer.transfer) ||
      !/^amira-uia-job-[0-9a-f-]{36}$/.test(offer.job) ||
      !Number.isInteger(offer.pid) ||
      offer.pid <= 0 ||
      typeof offer.started !== "string" ||
      !/^[1-9]\d*$/.test(offer.started) ||
      !Number.isSafeInteger(offer.handle) ||
      offer.handle <= 0 ||
      this.transfers.has(offer.transfer) ||
      !Number.isInteger(offer.writerPid) ||
      offer.writerPid <= 0 ||
      typeof offer.writerStarted !== "string" ||
      !/^[1-9]\d*$/.test(offer.writerStarted)
    )
      throw new Error("Invalid custody transfer; launch refused")
    // Strip transport metadata: a job-custody offer's event is not part of the
    // authenticated identity, and the owner's reply necessarily changes it.
    const { job, transfer, session, pid, started, handle, writerPid, writerStarted } = offer
    offer = { job, transfer, session, pid, started, handle, writerPid, writerStarted }
    const retained = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      this.pending.delete(offer.transfer)
      retained.reject(new Error("UIA custody acknowledgement timed out; launch refused"))
    }, this.timeoutMs)
    this.transfers.add(offer.transfer)
    this.pending.set(offer.transfer, { offer: { ...offer }, ...retained, timer })
    this.pipe!.write(`${JSON.stringify({ ...offer, event: "retain" })}\n`)
    return retained.promise
  }

  /** Record the verified suspended root before the watchdog is allowed to resume it. */
  async rememberRoot(job: string, pid: number, started: string): Promise<void> {
    const offer = this.retained.get(job)
    if (
      !offer ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof started !== "string" ||
      !/^[1-9]\d*$/.test(started)
    )
      throw new Error("Invalid custody root; launch refused")
    await this.command("root", { job, transfer: offer.transfer, pid, started })
  }

  /** Apply the same per-member rule to every retained watchdog generation. */
  async stopHeadless(): Promise<boolean> {
    if (this.state === "new" || this.state === "starting") return false // No launch can run before readiness.
    const result = await this.command("stop", {})
    return result.incomplete as boolean
  }

  private command(event: "root" | "stop", fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.state !== "running" || this.failure)
      return Promise.reject(new Error("UIA custody owner is unavailable"))
    const request = crypto.randomUUID()
    const identity = { ...fields, request, session: this.session }
    const pending = Promise.withResolvers<Record<string, unknown>>()
    // Stop completion is gated by the client's bounded wait, retaining late acknowledgements
    // so a slow cleanup can recover. Root timeout must never allow the root to resume.
    const timer =
      event === "root"
        ? setTimeout(() => {
            this.commands.delete(request)
            pending.reject(new Error("UIA custody root acknowledgement timed out; launch refused"))
          }, this.timeoutMs)
        : undefined
    this.commands.set(request, {
      identity,
      reply: event === "root" ? "root-recorded" : "stopped",
      ...pending,
      timer,
    })
    this.pipe!.write(`${JSON.stringify({ ...identity, event })}\n`)
    return pending.promise
  }

  async stop(): Promise<void> {
    if (this.state === "new") return
    if (this.state !== "exited" && this.state !== "stopping") {
      this.ending = true
      this.state = "stopping"
      // Do NOT call close(grace): its forced kill could abandon cleanup authority
      // while producer retirement is unconfirmed. Keep the owner alive to retry.
      this.pipe?.write(`${JSON.stringify({ event: "end", session: this.session })}\n`)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.exited.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("UIA custody cleanup timed out; retained owner is retrying")),
            Math.min(15_000, this.timeoutMs),
          )
        }),
      ])
      if (this.failure) throw this.failure
    } finally {
      clearTimeout(timer)
    }
  }
}
