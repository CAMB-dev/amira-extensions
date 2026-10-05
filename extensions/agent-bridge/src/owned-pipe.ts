import { spawn } from "node:child_process"
import { type OpenPipeOptions, openPipe, type PipeProcess } from "@amira/api"

/** The linked openPipe kills only the direct PID on Unix. Own a process group there. */
export function ownedPipe(argv: string[], options: OpenPipeOptions): PipeProcess {
  if (process.platform === "win32") return openPipe(argv, options)
  const [executable, ...args] = argv
  if (!executable) throw new Error("RPC executable is required")
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let exited = false
  let ended = false
  const killGroup = () => {
    // This process group was created by us; never signal an image name or a
    // discovered unrelated PID. Descendants inherit it unless they detach themselves.
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
  const finish = (code: number | null, error?: string) => {
    if (ended) return
    ended = true
    if (timer) clearTimeout(timer)
    options.onEvent({ type: "exit", code, ...(error ? { error } : {}) })
  }
  child.on("spawn", () => options.onEvent({ type: "spawned", pid: child.pid! }))
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (data: string) => {
    if (!ended) options.onEvent({ type: "stdout", data })
  })
  child.stderr.on("data", (data: string) => {
    if (!ended) options.onEvent({ type: "stderr", data })
  })
  child.stdin.on("error", () => {}) // Exit reports EPIPE; never crash the bridge.
  child.on("error", (error) => finish(null, error.message))
  child.on("exit", () => {
    exited = true
    try {
      killGroup()
    } catch (error) {
      finish(null, String(error))
    }
    // Do not wait for a deliberately detached descendant holding inherited stdio.
    timer = setTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
      finish(child.exitCode)
    }, 500)
  })
  child.on("close", (code) => finish(code))
  return {
    write(data) {
      if (!exited) child.stdin.write(data)
    },
    close(graceMs) {
      if (exited) return
      child.stdin.end()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          killGroup()
        } catch (error) {
          finish(null, String(error))
        }
      }, graceMs)
    },
  }
}
