import type { ExtensionAPI, PipeProcess } from "@amira/api"

/** Test-only protocol observer. Disables hotkeys; observes only processes this test starts. */
export function captureHelper(api: ExtensionAPI) {
  let pipe: PipeProcess | undefined
  let overlay: PipeProcess | undefined
  let pid = 0
  let overlayPid = 0
  let nextId = -1
  const pending = new Map<number, (value: { error?: string; result?: unknown }) => void>()
  const inspections: ((value: Record<string, unknown>) => void)[] = []
  const overlayEvents: string[] = []
  const actions: { id: number; kind: string; x: number; y: number; at: number }[] = []
  const glides: { id: number; at: number }[] = []
  const captured: ExtensionAPI = {
    ...api,
    openPipe(argv, options) {
      const isHelper = argv.some((arg) => arg.endsWith("uia.ps1"))
      const isOverlay = argv.some((arg) => arg.endsWith("overlay.ps1"))
      if (!isHelper && !isOverlay) return api.openPipe(argv, options)
      let buffer = ""
      const opened = api.openPipe([...argv, "-TestMode"], {
        ...options,
        onEvent(event) {
          if (event.type === "spawned") {
            if (isHelper) pid = event.pid
            else overlayPid = event.pid
          }
          if (event.type === "exit") {
            if (isHelper) {
              pid = 0
              for (const resolve of pending.values()) resolve({ error: "helper exited" })
              pending.clear()
            } else {
              overlayPid = 0
              for (const resolve of inspections) resolve({ error: "overlay exited" })
              inspections.length = 0
            }
          }
          if (event.type !== "stdout") {
            options.onEvent(event)
            return
          }
          buffer += event.data
          let newline = buffer.indexOf("\n")
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf("\n")
            if (!line) continue
            const response = JSON.parse(line) as {
              id: number
              event?: string
              error?: string
              result?: unknown
            }
            if (isOverlay && response.event === "inspection") {
              inspections.shift()?.(response as unknown as Record<string, unknown>)
              continue
            }
            if (isOverlay && response.event) overlayEvents.push(response.event)
            if (isHelper && response.event === "overlay")
              actions.push({
                ...(response as unknown as { id: number; kind: string; x: number; y: number }),
                at: Date.now(),
              })
            if (isOverlay && response.event === "glided") glides.push({ id: response.id, at: Date.now() })
            pending.get(response.id)?.(response)
            pending.delete(response.id)
            options.onEvent({ type: "stdout", data: `${line}\n` })
          }
        },
      })
      if (isHelper) pipe = opened
      else overlay = opened
      return opened
    },
  }
  return {
    api: captured,
    pid: () => pid,
    overlayPid: () => overlayPid,
    overlayEvents,
    actions,
    glides,
    crashHelper() {
      if (!pipe) throw new Error("No test helper pipe")
      pipe.close(0) // Exact test-started helper handle, never name/PID guessing.
    },
    simulateStop() {
      if (!overlay) throw new Error("No test overlay pipe")
      overlay.write('{"event":"simulate-stop"}\n')
    },
    inspectOverlay() {
      if (!overlay) throw new Error("No test overlay pipe")
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const complete = (value: Record<string, unknown>) => {
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => {
          const index = inspections.indexOf(complete)
          if (index >= 0) inspections.splice(index, 1)
          reject(new Error("Test overlay inspection timed out"))
        }, 5000)
        inspections.push(complete)
        overlay!.write('{"event":"inspect"}\n')
      })
    },
    raw(method: string, params: Record<string, unknown>) {
      if (!pipe) throw new Error("No test helper pipe")
      const id = nextId--
      return new Promise<{ error?: string; result?: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Test helper request timed out"))
        }, 10_000)
        pending.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        pipe!.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
  }
}
