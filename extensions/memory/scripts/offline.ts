import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EventMap } from "@amira/api"

interface RpcLine {
  id?: unknown
  ok?: boolean
  type?: string
  seq?: number
  output?: string[]
  commands?: Array<{ name: string }>
  data?: Partial<EventMap["tool.execute.end"]> & { text?: string; reason?: string }
}

export interface Capture {
  memory: string
  systemPrompt: string
}

/** Real CLI, offline mock model, no approval requests, and a disposable home/cwd. */
export async function offlineDemo(
  core: string,
  log: (text: string) => void = () => {},
  mode: "default" | "plan" = "default",
) {
  const main = path.join(path.resolve(core), "packages", "cli", "src", "main.ts")
  if (!existsSync(main))
    throw new Error("Pass the path to a linked Amira checkout with its dependencies installed.")
  const root = mkdtempSync(path.join(os.tmpdir(), "amira-memory-offline-"))
  const home = path.join(root, "home")
  const cwd = path.join(root, "work")
  mkdirSync(home)
  mkdirSync(cwd)
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ sessions: { autoTitle: false } }))
  const replies = [
    {
      toolCalls: (mode === "plan" ? ["global", "project"] : ["project"]).map((scope) => ({
        name: "memory_write",
        args: {
          scope,
          name: "writing-style",
          type: "user",
          description: "Preferred writing style",
          body: "The user prefers brief explanations with concrete examples.",
        },
      })),
    },
    { text: mode === "plan" ? "The memory writes were refused." : "Saved the preference." },
    { text: "I checked the memory index on the next turn." },
  ]
  const child = Bun.spawn(
    [
      process.execPath,
      main,
      "--rpc",
      "-m",
      "mock/m",
      "--no-builtins",
      ...(mode === "plan" ? ["--permission-mode", "plan"] : []),
      "-e",
      path.resolve(import.meta.dir, "../src/index.ts"),
      "-e",
      path.resolve(import.meta.dir, "../test/fixtures/observe.ts"),
    ],
    {
      cwd,
      env: { ...process.env, AMIRA_HOME: home, AMIRA_TEST_MOCK: JSON.stringify(replies) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const lines: RpcLine[] = []
  const stderr = new Response(child.stderr).text()
  let readError: unknown
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 100_000)
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        if (line) {
          const value = JSON.parse(line) as RpcLine
          lines.push(value)
          if (value.type === "ui.request") {
            throw new Error(`Unexpected approval/UI request in ${mode} mode: ${line}`)
          }
        }
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    }
  })().catch((error: unknown) => {
    readError = error
    if (child.exitCode === null) child.kill()
  })
  let nextId = 0
  const send = (value: unknown) => {
    child.stdin.write(`${JSON.stringify(value)}\n`)
    child.stdin.flush()
  }
  const wait = async (match: (line: RpcLine) => boolean, label: string) => {
    const deadline = Date.now() + 90_000
    while (true) {
      if (readError) throw readError
      const found = lines.find(match)
      if (found) return found
      if (timedOut || Date.now() > deadline || child.exitCode !== null) {
        throw new Error(
          `Offline CLI did not produce ${label}.\n${JSON.stringify(lines)}\n${child.exitCode !== null ? await stderr : ""}`,
        )
      }
      await Bun.sleep(10)
    }
  }
  const response = (id: number) => wait((line) => line.id === id && line.ok !== undefined, `response ${id}`)
  const event = (type: string, after = 0) =>
    wait((line) => line.type === type && (line.seq ?? 0) > after, type)
  const command = async (text: string) => {
    const id = ++nextId
    send({ id, cmd: "command.run", text })
    const result = await response(id)
    if (!result.ok) throw new Error(`Offline command failed: ${JSON.stringify(result)}`)
    return (result.output ?? []).join("\n")
  }
  try {
    await event("session.start")
    log(`Temporary AMIRA_HOME created; using the offline mock model in ${mode} permission mode.`)
    const listId = ++nextId
    send({ id: listId, cmd: "command.list" })
    const listing = await response(listId)
    if (!listing.ok || !listing.commands?.some((item) => item.name === "memory")) {
      throw new Error(`Memory command was not listed: ${JSON.stringify(listing)}`)
    }
    send({ id: ++nextId, cmd: "prompt", text: "Remember my writing preference in memory." })
    const firstEnd = await event("turn.end")
    if (firstEnd.data?.reason !== "done") throw new Error("The first turn failed")
    send({ id: ++nextId, cmd: "prompt", text: "What preference is available on this next turn?" })
    const secondEnd = await event("turn.end", firstEnd.seq)
    if (secondEnd.data?.reason !== "done") throw new Error("The next turn failed")
    const captures: Capture[] = JSON.parse(await command("/memory-captures"))
    const latest = captures.at(-1)
    // The host trims section boundaries while assembling the final system prompt.
    if (!latest?.memory || !latest.systemPrompt.includes(latest.memory.trim())) {
      throw new Error("The next turn did not receive the memory section")
    }
    if (latest.memory.includes("writing-style.md") !== (mode === "default")) {
      throw new Error(`Unexpected next-turn memory index in ${mode} mode`)
    }
    const writes = lines.filter(
      (line) => line.type === "tool.execute.end" && line.data?.name === "memory_write",
    )
    if (writes.length !== (mode === "plan" ? 2 : 1)) throw new Error("Missing memory_write results")
    for (const write of writes) {
      const data = write.data!
      if (mode === "plan") {
        const text = data.result?.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
        if (
          data.rejected !== "blocked" ||
          !data.result?.isError ||
          !text?.includes('mode "plan" is read-only')
        ) {
          throw new Error(`Expected a plan-mode denial: ${JSON.stringify(write)}`)
        }
        log(`Host denied memory_write:\n${text}`)
      } else if (!data.result || data.result.isError || data.rejected || data.approval) {
        throw new Error(`Expected an autonomous memory_write: ${JSON.stringify(write)}`)
      }
    }
    if (mode === "default") log("memory_write completed without an approval request.")
    log(`Next-turn injected memory section:\n${latest.memory}`)
    // Read the extension's public paths instead of duplicating its identity/project-key calculation.
    const paths = await command("/memory path")
    const storage = (["global", "project"] as const).map((scope) => {
      const label = scope === "global" ? "Global: " : "Project: "
      const dir = paths
        .split("\n")
        .find((line) => line.startsWith(label))
        ?.slice(label.length)
      if (!dir) throw new Error(`Missing ${scope} memory path: ${paths}`)
      const relative = path.relative(path.join(home, "extension-data"), dir)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Memory path escaped temporary extension data: ${dir}`)
      }
      const exists = existsSync(dir)
      const entries = exists ? readdirSync(dir, { recursive: true }).map(String).sort() : []
      if (mode === "plan" && entries.length) {
        throw new Error(`Plan mode created memory files/index: ${JSON.stringify({ scope, entries })}`)
      }
      return { scope, dir, exists, entries }
    })
    const outputs: Record<string, string> = {}
    const steps: Array<{ command: string; output: string }> = []
    const commands =
      mode === "plan"
        ? ["/memory list", "/memory path"]
        : [
            "/memory list",
            "/memory show writing-style",
            "/memory edit writing-style",
            "/memory path",
            "/memory rm writing-style",
            "/memory rm writing-style --yes",
            "/memory list",
          ]
    for (const text of commands) {
      const output = await command(text)
      outputs[text] = output
      steps.push({ command: text, output })
      log(`${text}\n${output}`)
    }
    child.stdin.end()
    const [code, err] = await Promise.all([child.exited, stderr])
    await reading
    if (readError) throw readError
    if (code !== 0) throw new Error(`Offline CLI exited ${code}: ${err}`)
    // Recheck after listing and shutdown: neither may repair/create an index in plan mode.
    if (mode === "plan") {
      for (const store of storage) {
        store.exists = existsSync(store.dir)
        store.entries = store.exists ? readdirSync(store.dir, { recursive: true }).map(String).sort() : []
        if (store.entries.length) {
          throw new Error(`Plan mode created memory files/index: ${JSON.stringify(store)}`)
        }
      }
    }
    return {
      captures,
      outputs,
      steps,
      storage,
      commands: listing.commands,
      writes,
      approvals: lines.filter((line) => line.type === "ui.request"),
      notices: lines.filter((line) => line.type === "extension.notice"),
    }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill() // Only our owned child, never by image name.
    await child.exited
    await Promise.all([reading, stderr])
    rmSync(root, { recursive: true, force: true })
  }
}
