import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { PackageCommandContext } from "@amira/api"
import { ownedPipe } from "../src/owned-pipe.ts"
import { agentsDir, createState, secureStore } from "../src/storage.ts"
import { deferred, eventually, sandbox } from "./helpers.ts"

test.skipIf(process.platform !== "win32")(
  "Windows state inherits an owner-only protected directory ACL",
  async () => {
    const h = sandbox()
    const run: PackageCommandContext["runCommand"] = async (argv, options) => {
      const child = Bun.spawn(argv, {
        cwd: options.cwd,
        env: { ...process.env, AMIRA_HOME: h.home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        const [output, error, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return {
          output: output + error,
          exitCode,
          signalCode: null,
          truncated: false,
          timedOut: false,
          aborted: false,
          settled: true,
          contained: true,
        }
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      await secureStore(h.home, run)
      const state = createState(h.home, {
        cwd: h.cwd,
        mode: "default",
        idleMinutes: 30,
        requestTimeoutMinutes: 30,
      })
      const dir = agentsDir(h.home).replaceAll("'", "''")
      const result = await run(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
            `$d = [System.IO.Directory]::GetAccessControl('${dir}'); if (!$d.AreAccessRulesProtected) { throw 'inherited directory ACL' }; ` +
            `$f = [System.IO.File]::GetAccessControl('${dir}/${state.id}.json'); ` +
            `foreach ($r in $f.Access) { if ($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'another principal can read state' } }; 'owner only'`,
        ],
        { cwd: h.cwd, timeoutMs: 10_000, signal: new AbortController().signal },
      )
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain("owner only")
    } finally {
      h.cleanup()
    }
  },
  30_000,
)

test.skipIf(process.platform === "win32")(
  "Unix forced close terminates the owned RPC group and its descendant",
  async () => {
    const h = sandbox()
    const exited = deferred<void>()
    let pid = 0
    let descendant = 0
    let output = ""
    const running = (id: number) => {
      if (!id) return false
      try {
        process.kill(id, 0)
        if (
          process.platform === "linux" &&
          readFileSync(`/proc/${id}/stat`, "utf8").split(") ")[1]?.startsWith("Z")
        )
          return false
        return true
      } catch {
        return false
      }
    }
    const code = `const c = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdin:'ignore',stdout:'ignore',stderr:'ignore'}); console.log(c.pid); setInterval(() => {}, 1000)`
    const pipe = ownedPipe([process.execPath, "-e", code], {
      cwd: h.cwd,
      env: { ...process.env, AMIRA_HOME: h.home },
      onEvent(event) {
        if (event.type === "spawned") pid = event.pid
        if (event.type === "stdout") {
          output += event.data
          descendant = Number(output.trim())
        }
        if (event.type === "exit") exited.resolve()
      },
    })
    try {
      await eventually(() => descendant > 0, "descendant PID", 5000)
      expect(running(descendant)).toBe(true)
      pipe.close(0)
      await exited.promise
      await eventually(() => !running(pid) && !running(descendant), "owned group exit", 5000)
    } finally {
      pipe.close(0)
      // Only the process group created by this fixture, never an image-name kill.
      if (running(pid) || running(descendant)) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {}
      }
      h.cleanup()
    }
  },
  15_000,
)
