import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

interface RpcLine {
  id?: unknown
  ok?: boolean
  type?: string
  seq?: number
  output?: string[]
  data?: { requestId?: string; title?: string; text?: string; reason?: string }
}

export interface Capture {
  memory: string
  systemPrompt: string
}

/** Real CLI, offline mock model, explicit RPC approval, and a disposable home/cwd. */
export async function offlineDemo(core: string, log: (text: string) => void = () => {}) {
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
      toolCalls: [
        {
          name: "memory_write",
          args: {
            scope: "project",
            name: "writing-style",
            type: "user",
            description: "Preferred writing style",
            body: "The user prefers brief explanations with concrete examples.",
          },
        },
      ],
    },
    { text: "Saved the preference." },
    { text: "I can recall the preference on the next turn." },
  ]
  const child = Bun.spawn(
    [
      process.execPath,
      main,
      "--rpc",
      "-m",
      "mock/m",
      "--no-builtins",
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
        if (line) lines.push(JSON.parse(line) as RpcLine)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    }
  })().catch((error: unknown) => {
    readError = error
  })
  let nextId = 0
  const send = (value: unknown) => {
    child.stdin.write(`${JSON.stringify(value)}\n`)
    child.stdin.flush()
  }
  const wait = async (match: (line: RpcLine) => boolean, label: string) => {
    const deadline = Date.now() + 90_000
    while (true) {
      const found = lines.find(match)
      if (found) return found
      if (readError) throw readError
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
    log("Temporary AMIRA_HOME created; using the offline mock model.")
    send({ id: ++nextId, cmd: "prompt", text: "Remember my writing preference in project memory." })
    const approval = await event("ui.request")
    if (approval.data?.title !== "Allow memory_write?") throw new Error("Unexpected approval request")
    log("The host requires approval for memory_write; explicitly approving this demo call.")
    send({ id: ++nextId, cmd: "ui.respond", requestId: approval.data.requestId, value: true })
    const firstEnd = await event("turn.end")
    if (firstEnd.data?.reason !== "done") throw new Error("The first turn failed")
    send({ id: ++nextId, cmd: "prompt", text: "What preference is available on this next turn?" })
    const secondEnd = await event("turn.end", firstEnd.seq)
    if (secondEnd.data?.reason !== "done") throw new Error("The next turn failed")
    const captures: Capture[] = JSON.parse(await command("/memory-captures"))
    const latest = captures.at(-1)
    // The host trims section boundaries while assembling the final system prompt.
    if (!latest?.memory.includes("writing-style.md") || !latest.systemPrompt.includes(latest.memory.trim())) {
      throw new Error("The next turn did not receive the saved memory index")
    }
    log(`Next-turn injected memory section:\n${latest.memory}`)
    const outputs: Record<string, string> = {}
    const steps: Array<{ command: string; output: string }> = []
    for (const text of [
      "/memory list",
      "/memory show writing-style",
      "/memory edit writing-style",
      "/memory path",
      "/memory rm writing-style",
      "/memory rm writing-style --yes",
      "/memory list",
    ]) {
      const output = await command(text)
      outputs[text] = output
      steps.push({ command: text, output })
      log(`${text}\n${output}`)
    }
    child.stdin.end()
    const [code, err] = await Promise.all([child.exited, stderr])
    await reading
    if (code !== 0) throw new Error(`Offline CLI exited ${code}: ${err}`)
    return {
      captures,
      outputs,
      steps,
      approved: true,
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
