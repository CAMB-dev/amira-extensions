import type { ExtensionAPI, PipeProcess } from "@amira/api"

/** Observe only our helper's protocol/process; never enumerate desktop windows. */
export function captureHelper(api: ExtensionAPI) {
  let pipe: PipeProcess | undefined
  let pid = 0
  let nextId = -1
  const pending = new Map<number, (value: { error?: string; result?: unknown }) => void>()
  const captured: ExtensionAPI = {
    ...api,
    openPipe(argv, options) {
      if (!argv.some((arg) => arg.endsWith("uia.ps1"))) return api.openPipe(argv, options)
      let buffer = ""
      pipe = api.openPipe(argv, {
        ...options,
        onEvent(event) {
          if (event.type === "stderr" && event.data.includes("[DEBUG-uia-key]")) console.error(event.data.trim())
          if (event.type === "spawned") pid = event.pid
          if (event.type === "exit") {
            pid = 0
            for (const resolve of pending.values()) resolve({ error: "helper exited" })
            pending.clear()
          }
          if (event.type === "stdout") {
            buffer += event.data
            let newline = buffer.indexOf("\n")
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              newline = buffer.indexOf("\n")
              if (!line) continue
              const response = JSON.parse(line) as { id: number; error?: string; result?: unknown }
              pending.get(response.id)?.(response)
              pending.delete(response.id)
            }
          }
          options.onEvent(event)
        },
      })
      return pipe
    },
  }
  return {
    api: captured,
    pid: () => pid,
    raw(method: string, params: Record<string, unknown>) {
      if (!pipe) throw new Error("No owned helper pipe")
      const id = nextId--
      return new Promise<{ error?: string; result?: unknown }>((resolve) => {
        pending.set(id, resolve)
        pipe!.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
  }
}
