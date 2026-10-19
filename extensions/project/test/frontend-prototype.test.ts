import { expect, setDefaultTimeout, test } from "bun:test"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ConversationSpec } from "@amira/api"
import type { PrototypeManifestArtifact } from "../src/artifacts.ts"
import { DecisionStore } from "../src/store.ts"
import { confirmSkip, ESC, F6, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"
import { requireFrontendHost } from "./frontend-host.ts"

setDefaultTimeout(240_000)

type Frontend = Awaited<ReturnType<typeof frontend>>
const variants = [
  { id: "alpha", idea: "A compact local control", question: "Can one control explain the interaction?" },
  { id: "beta", idea: "A guided local control", question: "Does guidance clarify the interaction?" },
]

async function manifest(f: Frontend): Promise<PrototypeManifestArtifact> {
  const state = await f.store.read()
  const ref = state.artifacts.findLast((artifact) => artifact.kind === "prototype-manifest")
  expect(ref).toBeDefined()
  const artifact = await f.store.readArtifact(ref!)
  expect(artifact.kind).toBe("prototype-manifest")
  return artifact as PrototypeManifestArtifact
}

async function returnToMain(f: Frontend) {
  f.terminal.send(F6)
  await waitFor(
    () => !f.live().includes("main idle") && !f.live().includes("esc cancel command"),
    "return from native prototype focus and finish opening command",
    20_000,
  )
  await f.idle()
  f.terminal.send("\x15")
}

async function savedConversation(f: Frontend) {
  const home = path.join(f.root, "owned-home")
  const files = await readdir(home, { recursive: true })
  const specs = await Promise.all(
    files
      .filter((file) => file.endsWith(".spec.json"))
      .map(async (relative) => {
        const file = path.join(home, relative)
        const saved = JSON.parse(await readFile(file, "utf8")) as {
          id: string
          spec: ConversationSpec
          runtimeTools: string[]
        }
        return { ...saved, transcript: file.replace(/\.spec\.json$/, ".jsonl") }
      }),
  )
  const variants = specs.filter(
    (saved) => saved.spec.key === `${f.project.marker.id}/iteration/1/prototype/alpha`,
  )
  expect(variants).toHaveLength(1)
  const generations = specs.filter((saved) => saved.spec.key.includes("/generation/proposal-generation/"))
  expect(generations).toHaveLength(1)
  expect(generations[0]!.spec.callableTools).toEqual([])
  expect(generations[0]!.spec.writeRoots).toEqual([])
  return variants[0]!
}

async function propose(f: Frontend) {
  f.mock.push({ text: JSON.stringify(variants) })
  f.send("prototype")
  await f.dialog("Confirm prototype variants")
  expect(f.live()).toContain("Confirm variants")
  expect(f.live()).toContain("Edit variants")
  expect(f.live()).toContain("Cancel")
  expect(f.mock.requests).toHaveLength(1)
  expect(f.mock.requests[0]!.tools).toEqual([])
}

frontendSuite("frontend-prototype", () => {
  test(`fullscreen: native prototype composer uses real confined apply_patch, reports commands without running, and records a reasoned choice`, async () => {
    const f = await frontend()
    try {
      await new DecisionStore(f.project).record(
        [
          {
            question: "What should the prototype optimize?",
            options: [
              { label: "Local clarity", description: "Keep the control understandable offline." },
              { label: "Feature breadth", description: "Explore more functionality." },
            ],
          },
        ],
        [{ selected: ["Local clarity"] }],
        { sessionId: f.agent.sessionId, askId: "frontend-design-decision", language: "en" },
      )
      await confirmSkip(f)
      await propose(f)
      expect(JSON.stringify(f.mock.requests[0]!.messages)).toContain("Local clarity")
      f.terminal.send("\r")
      await f.dialog("Open a prototype variant")
      expect(f.all()).toContain("Prototype variants")
      expect(f.live()).toContain("alpha")
      expect(f.live()).toContain("beta")
      expect(f.live()).toContain("Keep list open")
      const planned = await manifest(f)
      expect(planned.variants.map((variant) => variant.id)).toEqual(["alpha", "beta"])
      expect(planned.variants.every((variant) => variant.status === "planned")).toBe(true)
      f.terminal.send("\r")
      await f.dismissed()
      await f.visible("main idle")
      expect(f.live()).toContain("Prototype alpha")
      expect(f.mock.requests).toHaveLength(1)
      const alpha = planned.variants[0]!
      const beta = planned.variants[1]!
      const saved = await savedConversation(f)
      expect(saved.spec.key).toBe(`${f.project.marker.id}/iteration/1/prototype/alpha`)
      expect(saved.spec.cwd).toBe(alpha.directory)
      expect(saved.spec.writeRoots).toEqual([alpha.directory])
      expect([...saved.spec.callableTools].sort()).toEqual([
        "apply_patch",
        "ask_user",
        "bash",
        "edit",
        "glob",
        "grep",
        "powershell",
        "read",
        "write",
      ])
      expect(saved.runtimeTools).toEqual([])
      const sibling = path.join(beta.directory, "sentinel.txt")
      const outside = path.join(f.project.root, "sentinel.txt")
      await writeFile(sibling, "sibling unchanged\n")
      await writeFile(outside, "project unchanged\n")
      const code = 'await Bun.write("ran.txt", "must not run");\n'
      f.mock.push(
        {
          toolCalls: [
            {
              name: "apply_patch",
              id: "inside",
              args: {
                patch: `*** Begin Patch\n*** Add File: main.ts\n+${code.trim()}\n*** End Patch`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "apply_patch",
              id: "sibling",
              args: {
                patch: `*** Begin Patch\n*** Update File: ${sibling}\n@@\n-sibling unchanged\n+ESCAPED\n*** End Patch`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "apply_patch",
              id: "outside",
              args: {
                patch: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-project unchanged\n+ESCAPED\n*** End Patch`,
              },
            },
          ],
        },
        {
          text: `Prototype alpha complete. Run bun main.ts.\n\n\`\`\`prototype-report\n${JSON.stringify({ runCommand: "bun main.ts", cwd: alpha.directory, prerequisites: [], notes: "One local control makes the interaction clear." })}\n\`\`\``,
        },
      )
      // Send a real human build request through the native composer, not handle.send().
      f.terminal.send(
        `${requireFrontendHost().harness.paste("Build the alpha prototype now and report its run command.")}\r`,
      )
      await f.dialog("Approve file tool")
      f.terminal.send("\x1b[B\r")
      await f.visible("Prototype alpha complete")
      await waitFor(() => f.mock.requests.length === 5, "prototype model/tool loop completed", 20_000)
      expect(await readFile(path.join(alpha.directory, "main.ts"), "utf8")).toBe(code)
      expect(await readFile(sibling, "utf8")).toBe("sibling unchanged\n")
      expect(await readFile(outside, "utf8")).toBe("project unchanged\n")
      const results = f.mock.requests.at(-1)!.messages.filter((message) => message.role === "toolResult")
      expect(results).toHaveLength(3)
      expect(results[0]!.isError).not.toBe(true)
      expect(results[1]!.isError).toBe(true)
      expect(results[2]!.isError).toBe(true)
      expect(JSON.stringify(results.slice(1))).toMatch(/writeRoots|write.root|ceiling/i)
      expect(await readFile(saved.transcript, "utf8")).toContain("Build the alpha prototype now")
      await returnToMain(f)
      await f.command("status", "Stage: prototype")
      expect(f.all()).toContain("Project Frontend · iteration 1 · prototype")
      const reported = await manifest(f)
      expect(reported.variants[0]).toMatchObject({
        status: "ready",
        runCommand: "bun main.ts",
        cwd: alpha.directory,
      })
      await f.command("prototype run alpha", [
        "Run this command yourself (not started)",
        "bun main.ts",
        `cwd: ${alpha.directory}`,
      ])
      expect(await readdir(alpha.directory)).not.toContain("ran.txt")
      expect(f.mock.requests).toHaveLength(5)
      // Reopening also completes durable controller bookkeeping. Await this
      // command's own output/completion instead of racing only the focus chrome.
      await f.command("prototype alpha", "File tools may write only inside this variant's directory.", 60_000)
      await f.visible("main idle")
      expect(f.mock.requests).toHaveLength(5)
      expect((await savedConversation(f)).id).toBe(saved.id)
      await returnToMain(f)
      f.send("prototype choose")
      await f.dialog("Choose a prototype variant", 60_000)
      expect(f.live()).toContain("None")
      f.terminal.send("\r")
      await f.dialog("Prototype selection reason")
      f.terminal.send(ESC)
      await f.dismissed()
      expect((await f.store.read()).prototypeChoice).toBeUndefined()
      f.send("prototype choose")
      await f.dialog("Choose a prototype variant", 60_000)
      f.terminal.send("\r")
      await f.dialog("Prototype selection reason")
      f.terminal.send("\r")
      await f.dialog("Why choose this prototype?")
      f.terminal.send(
        `${requireFrontendHost().harness.paste("The single control answers the interaction question.")}\r`,
      )
      await f.dialog("Choose the next step", 60_000)
      f.terminal.send("\r")
      await f.dialog("Confirm stage change")
      expect(f.live()).toContain("implement")
      f.terminal.send(ESC)
      await f.dismissed()
      await f.visible("prototype · awaiting confirmation")
      const chosen = await f.store.read()
      expect(chosen.prototypeChoice?.variantId).toBe("alpha")
      expect(chosen.summaryId).toBeDefined()
      expect(chosen.pending?.to).toBe("implement")
      const records = await new DecisionStore(f.project).records()
      expect(records.at(-1)?.reason).toBe("The single control answers the interaction question.")
      f.send("next")
      await f.dialog("Choose the next step", 60_000)
      f.terminal.send("\r")
      await f.dialog("Confirm stage change")
      expect(f.live()).toContain("implement")
      f.terminal.send(ESC)
      await f.dismissed()
      expect((await f.store.read()).stage).toBe("prototype")
      expect(f.mock.requests).toHaveLength(5)
      expect(await readdir(alpha.directory)).not.toContain("ran.txt")
    } finally {
      await f.cleanup()
    }
  })

  test(`fullscreen: cancelling proposals is inert, edited variants stay in the list, and None requires an explicit reason choice`, async () => {
    const f = await frontend()
    try {
      await confirmSkip(f)
      const before = await f.store.read()
      await propose(f)
      f.terminal.send(ESC)
      await f.dismissed()
      expect(await f.store.read()).toEqual(before)
      f.mock.push({ text: JSON.stringify(variants) })
      f.send("prototype")
      await f.dialog("Confirm prototype variants")
      f.terminal.send("\x1b[B\r")
      await f.dialog("Edit or remove variants (JSON array)")
      f.terminal.send("\x7f".repeat(JSON.stringify(variants).length))
      f.terminal.send(`${requireFrontendHost().harness.paste(JSON.stringify([variants[0]]))}\r`)
      await f.dialog("Confirm prototype variants")
      f.terminal.send("\r")
      await f.dialog("Open a prototype variant")
      expect(f.live()).toContain("alpha")
      expect(f.live()).not.toContain("beta")
      f.terminal.send("\x1b[B\r")
      await f.dismissed()
      expect(f.live()).not.toContain("main idle")
      expect((await manifest(f)).variants.map((variant) => variant.id)).toEqual(["alpha"])
      expect(f.mock.requests).toHaveLength(2)
      f.send("prototype choose")
      await f.dialog("Choose a prototype variant", 60_000)
      f.terminal.send(ESC)
      await f.dismissed()
      expect((await f.store.read()).prototypeChoice).toBeUndefined()
      f.send("prototype choose")
      await f.dialog("Choose a prototype variant", 60_000)
      f.terminal.send("\x1b[B\r")
      await f.dialog("Prototype selection reason")
      expect(f.live()).toContain("Enter reason")
      expect(f.live()).toContain("Skip reason")
      f.terminal.send("\r")
      await f.dialog("Why choose this prototype?")
      f.terminal.send(ESC)
      await f.dismissed()
      expect((await f.store.read()).prototypeChoice).toBeUndefined()
      expect(await new DecisionStore(f.project).records()).toEqual([])
      f.send("prototype choose")
      await f.dialog("Choose a prototype variant", 60_000)
      f.terminal.send("\x1b[B\r")
      await f.dialog("Prototype selection reason")
      f.terminal.send("\x1b[B\r")
      await f.dialog("Choose the next step", 60_000)
      f.terminal.send("\r")
      await f.dialog("Confirm stage change")
      f.terminal.send(ESC)
      await f.dismissed()
      expect((await f.store.read()).prototypeChoice?.variantId).toBeNull()
      const records = await new DecisionStore(f.project).records()
      expect(records).toHaveLength(1)
      expect(records[0]?.reason).toBeUndefined()
      expect(records[0]?.reasonSkipped).toBe(true)
      expect((await manifest(f)).chosen?.variantId).toBeNull()
      expect(f.mock.requests).toHaveLength(2)
    } finally {
      await f.cleanup()
    }
  })
})
