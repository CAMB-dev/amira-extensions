import { expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { SpecArtifact } from "../src/artifacts.ts"
import type { IterationState } from "../src/stage.ts"
import { DecisionStore } from "../src/store.ts"
import { ESC, F6, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"
import { requireFrontendHost } from "./frontend-host.ts"
import { workflowFixture } from "./frontend-services-fixture.ts"
import { git, specDraft } from "./implement-fixture.ts"

setDefaultTimeout(1_800_000)
type Frontend = Awaited<ReturnType<typeof frontend>>
const paste = (text: string) => requireFrontendHost().harness.paste(text)

async function stateWhen(f: Frontend, check: (state: IterationState) => boolean, label: string) {
  for (let attempt = 0; attempt < 4800; attempt++) {
    const state = await f.store.read()
    if (check(state)) return state
    if (state.status === "interrupted")
      throw new Error(`${label}: interrupted\n${JSON.stringify(state)}\n${f.live()}`)
    await Bun.sleep(25)
  }
  throw new Error(`${label}\n${JSON.stringify(await f.store.read())}\n${f.live()}`)
}

async function main(f: Frontend) {
  f.terminal.send(F6)
  await waitFor(() => !f.live().includes("main idle"), "native return to main", 30_000)
  await f.idle()
  f.terminal.send("\x15")
}

async function decision(f: Frontend, supersedes?: string) {
  const marker = supersedes ? "Corrected human decision recorded" : "Initial human decision recorded"
  const question = supersedes ? "Which corrected local result?" : "Which local result?"
  f.mock.push(
    {
      toolCalls: [
        {
          id: `decision-${f.mock.requests.length}`,
          name: "record_decision",
          args: {
            questions: [
              {
                question,
                options: [
                  {
                    label: supersedes ? "Corrected result" : "Ready result",
                    description: "Keep the result entirely offline.",
                  },
                  { label: "Remote result", description: "Not selected in this isolated fixture." },
                ],
              },
            ],
            ...(supersedes ? { supersedes: [supersedes] } : {}),
          },
        },
      ],
    },
    { text: marker },
  )
  f.send("design")
  await f.visible("main idle")
  f.terminal.send(`${paste("Ask me to confirm the local result.")}\r`)
  await f.dialog("Approve file tool")
  f.terminal.send("\x1b[B\r")
  await waitFor(
    () => f.host.ui.pending.length === 1 && f.host.ui.pending[0]?.kind === "ask",
    "human design question",
    30_000,
  )
  await f.visible(question)
  f.terminal.send("\r")
  await f.visible(marker)
  await main(f)
  const records = await new DecisionStore(f.project).records()
  const record = records.at(-1)!
  expect(record.answer.selected).toEqual([supersedes ? "Corrected result" : "Ready result"])
  if (supersedes) expect(record.supersedes).toEqual([supersedes])
  return record.id
}

async function approveNext(f: Frontend) {
  const calls = f.mock.requests.length
  f.send("next")
  await f.dialog("Choose the next step")
  f.terminal.send("\r")
  await f.dialog("Confirm stage change")
  f.terminal.send("\x1b[B\r")
  await f.dismissed()
  expect(f.mock.requests).toHaveLength(calls)
  return f.store.read()
}

async function prototype(f: Frontend) {
  f.mock.push({
    text: JSON.stringify([
      { id: "local", idea: "One offline control", question: "Does one control explain the result?" },
    ]),
  })
  f.send("prototype")
  await f.dialog("Confirm prototype variants")
  f.terminal.send("\r")
  await f.dialog("Open a prototype variant")
  f.terminal.send("\r")
  await f.dismissed()
  await f.visible("main idle")
  const planned = await f.store.read()
  const plan = await f.store.readArtifact(
    planned.artifacts.findLast((entry) => entry.kind === "prototype-manifest")!,
  )
  if (plan.kind !== "prototype-manifest") throw new Error("Missing planned prototype")
  const cwd = plan.variants[0]!.directory
  f.mock.push(
    {
      toolCalls: [
        {
          id: "prototype-write",
          name: "write",
          args: { path: "main.ts", content: 'console.log("disposable prototype")\n' },
        },
      ],
    },
    {
      text: `Offline prototype ready.\n\`\`\`prototype-report\n${JSON.stringify({ runCommand: "bun main.ts", cwd, prerequisites: [], notes: "A single control explains the result." })}\n\`\`\``,
    },
  )
  f.terminal.send(
    `${paste("Build the disposable prototype and report, but do not execute its run command.")}\r`,
  )
  await f.dialog("Approve file tool")
  f.terminal.send("\x1b[B\r")
  await f.visible("Offline prototype ready")
  await main(f)
  const state = await f.store.read()
  const manifest = await f.store.readArtifact(
    state.artifacts.findLast((entry) => entry.kind === "prototype-manifest")!,
  )
  if (manifest.kind !== "prototype-manifest") throw new Error("Missing prototype manifest")
  expect(await readFile(path.join(manifest.variants[0]!.directory, "main.ts"), "utf8")).toContain(
    "disposable prototype",
  )
  await f.command("prototype run local", ["Run this command yourself (not started)", "bun main.ts"])
  f.send("prototype choose")
  await f.dialog("Choose a prototype variant")
  f.terminal.send("\r")
  await f.dialog("Prototype selection reason")
  f.terminal.send("\x1b[B\r") // Explicit human skip-reason, not a generated reason.
  await f.dialog("Choose the next step")
  f.terminal.send(ESC)
  await f.dismissed()
  expect((await f.store.read()).prototypeChoice?.variantId).toBe("local")
}

function draft(decisionId: string) {
  const value = specDraft()
  value.spec.decisionIds = [decisionId]
  value.spec.items[0]!.decisionIds = [decisionId]
  value.spec.items[0]!.ui = true
  value.spec.items.push({
    ...structuredClone(value.spec.items[0]!),
    id: "S2",
    description: "Write the second local result",
    decisionIds: [],
    ui: false,
    acceptanceCriteria: ["second.txt contains ready"],
  })
  value.batches.push({ id: "B2", itemIds: ["S2"], decisionIds: [], files: ["second.txt"] })
  return value
}

async function approveSpec(
  f: Frontend,
  value: ReturnType<typeof draft> | { spec: SpecArtifact; batches: ReturnType<typeof draft>["batches"] },
) {
  f.mock.push({ text: JSON.stringify(value) })
  f.send("spec")
  await f.dialog("Choose execution mode")
  expect(f.live()).toContain("Workflow")
  expect(f.live()).toContain("Single agent")
  expect(f.live()).not.toContain("Swarm")
  expect((await f.store.read()).approvedContext?.spec?.revision).not.toBe(value.spec.revision)
  f.terminal.send("\x1b[B\r") // Single, Workflow: explicitly select Workflow.
  await f.dialog("Review implementation spec")
  expect(f.all()).toContain("Batch plan")
  f.terminal.send("\r")
  await f.dismissed()
  const state = await f.store.read()
  expect(state.approvedContext?.mode).toBe("workflow")
  expect(state.approvedContext?.spec?.revision).toBe(value.spec.revision)
  return state
}

async function implement(
  f: Frontend,
  workflow: ReturnType<typeof workflowFixture>,
  file: string,
  content: string,
  first = false,
) {
  const before = workflow.runs.length
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.mock.push(
    {
      text: "Working on the exact approved item in its iteration checkout.",
      hold: { chunks: 1, until: held },
      toolCalls: [{ id: `write-${before}`, name: "write", args: { path: file, content } }],
    },
    { text: "Approved item implemented. No prototype code was copied." },
  )
  try {
    f.send("implement")
    if (first) {
      await f.dialog("Use committed base")
      f.terminal.send("\x1b[B\r")
    }
    await waitFor(() => workflow.runs.length === before + 1, "fresh bound workflow run", 60_000)
    await f.idle()
    await f.visible("main idle")
    const running = await f.store.read()
    expect(running.status).toBe("working")
    const run = workflow.runs.at(-1)!
    expect(run.request.cwd).not.toBe(f.cwd)
    expect(run.request.cwd.startsWith(f.root)).toBe(true)
    expect(run.owner.sessionId).toBe(run.request.startedBy.sessionId)
    expect(run.snapshot.children).toHaveLength(1)
    expect(f.live()).toContain(`Implement ${running.approvedContext?.batchId}`)
    await main(f)
    release()
    const done = await stateWhen(
      f,
      (state) => state.pending?.to === "accept",
      "workflow implementation settled",
    )
    expect(await readFile(path.join(run.request.cwd, file), "utf8")).toBe(content)
    expect(await Bun.file(path.join(f.cwd, file)).exists()).toBe(false)
    const artifact = await f.store.readArtifact(
      done.artifacts.findLast((entry) => entry.kind === "batch-result")!,
    )
    expect(artifact).toMatchObject({ kind: "batch-result", implementerModels: ["mock/frontend"] })
    return run.request.cwd
  } finally {
    release()
  }
}

async function accept(f: Frontend, itemId: string, outcome: "pass" | "fail") {
  const before = f.mock.requests.length
  f.mock.push(
    {
      toolCalls: [
        {
          id: `accept-${before}`,
          name: "project_record_acceptance",
          args: {
            items: [
              {
                itemId,
                status: outcome,
                evidence: ["Observed the exact local result"],
                reason: outcome === "pass" ? "Approved result present" : "The local result needs repair",
              },
            ],
          },
        },
      ],
    },
    { text: `Independent acceptance ${outcome}; no merge performed.` },
  )
  f.send("accept")
  await waitFor(() => f.mock.requests.length > before, "independent reviewer started", 180_000)
  await f.idle()
  await f.visible("main idle")
  await main(f)
  const state = await stateWhen(
    f,
    (state) => state.stage === "accept" && ["summarized", "proposed"].includes(state.phase),
    "acceptance summary",
  )
  const ref = state.artifacts.findLast((entry) => entry.kind === "acceptance")!
  const verdict = await f.store.readArtifact(ref)
  expect(verdict).toMatchObject({
    kind: "acceptance",
    outcome,
    reviewerModel: "mock/reviewer",
    implementerModels: ["mock/frontend"],
  })
  return { state, ref, verdict }
}

async function trial(f: Frontend) {
  const calls = f.mock.requests.length
  f.send("next")
  await f.dialog("Record manual UI trial")
  f.terminal.send("\r")
  await f.dialog("Confirm manual trial record")
  f.terminal.send("\x1b[B\r")
  await f.dismissed()
  expect((await f.store.read()).manualTrial?.status).toBe("tried")
  expect(f.mock.requests).toHaveLength(calls)
}

frontendSuite("frontend-services", () => {
  test("fullscreen offline: cancelling mode choice cannot approve or launch a service", async () => {
    const workflow = workflowFixture()
    const f = await frontend(undefined, [], {
      rows: 36,
      commandTimeoutMs: 180_000,
      extensions: [{ name: "workflow", extension: workflow.extension }],
    })
    try {
      for (const stage of ["design", "prototype"]) {
        f.send(`skip ${stage}`)
        await f.dialog("Confirm stage change")
        f.terminal.send("\x1b[B\r")
        await f.dismissed()
      }
      const skipped = await f.store.read()
      expect(skipped.skips.map((entry) => entry.stage)).toEqual(["design", "prototype"])
      expect(f.mock.requests).toHaveLength(0)
      f.mock.push({ text: JSON.stringify(specDraft()) })
      f.send("spec")
      await f.dialog("Choose execution mode")
      expect(f.live()).toContain("Single agent")
      expect(f.live()).toContain("Workflow")
      expect(f.live()).not.toContain("Swarm")
      f.terminal.send(ESC)
      await f.dismissed()
      const state = await f.store.read()
      expect(state.approvedContext).toBeUndefined()
      expect(state.receipts).toEqual(skipped.receipts)
      expect(state.attempts).toEqual([])
      expect(workflow.runs).toEqual([])
      expect(f.mock.requests).toHaveLength(1)
    } finally {
      await f.cleanup()
    }
  })

  test("fullscreen offline: incompatible optional services leave the single-agent approval path intact", async () => {
    const f = await frontend(undefined, [], {
      rows: 36,
      extensions: [
        {
          name: "workflow",
          extension: (api) => {
            api.provideService("workflow.runner", {
              start: () => {
                throw new Error("Legacy service must not launch")
              },
            })
          },
        },
      ],
    })
    try {
      f.mock.push({ text: JSON.stringify(specDraft()) })
      f.send("spec")
      await f.dialog("Review implementation spec")
      expect(f.all()).not.toContain("Choose execution mode")
      f.terminal.send("\r")
      await f.dismissed()
      expect((await f.store.read()).approvedContext?.mode).toBe("single")
      expect(f.mock.requests).toHaveLength(1)
    } finally {
      await f.cleanup()
    }
  })

  test("fullscreen offline: real prototype, workflow batches, failed review repair, manual trial and mapped revisit correction", async () => {
    const workflow = workflowFixture()
    const f = await frontend(undefined, [], {
      rows: 36,
      commandTimeoutMs: 180_000,
      extensions: [{ name: "workflow", extension: workflow.extension }],
    })
    try {
      f.agent.permissions.setMode("auto")
      f.host.setSettings({
        extensions: { [`frontend-${path.basename(f.root)}`]: { reviewerModel: "mock/reviewer" } },
      })
      await git(f.cwd, "init")
      await git(f.cwd, 'config user.name "Offline Services Frontend"')
      await git(f.cwd, 'config user.email "services@invalid.local"')
      await git(f.cwd, "config commit.gpgsign false")
      await git(f.cwd, "add -A")
      await git(f.cwd, 'commit -m "Offline services baseline"')
      const initialDecision = await decision(f)
      f.send("next")
      await f.dialog("Prepare the design summary?")
      f.terminal.send("\x1b[B\r")
      await f.dialog("Choose the next step")
      f.terminal.send(ESC)
      await f.dismissed()
      const summarized = await f.store.read()
      expect(summarized.summaryId).toBeDefined()
      expect(summarized.receipts).toEqual([])
      await approveNext(f)
      expect((await f.store.read()).stage).toBe("prototype")
      await prototype(f)
      const original = draft(initialDecision)
      await approveSpec(f, original)
      expect(workflow.runs).toHaveLength(0)
      const cwd = await implement(f, workflow, "result.txt", "needs-repair\n", true)
      await approveNext(f)
      const failed = await accept(f, "S1", "fail")
      expect(failed.state.completion).toBeUndefined()
      await approveNext(f)
      expect((await f.store.read()).approvedContext?.batchId).toBe("B1")
      expect(await implement(f, workflow, "result.txt", "ready\n")).toBe(cwd)
      await approveNext(f)
      const passed = await accept(f, "S1", "pass")
      expect(passed.state.manualTrial?.status).toBe("pending")
      await trial(f)
      const nextBatch = await approveNext(f)
      expect(nextBatch.approvedContext?.batchId).toBe("B2")
      expect(nextBatch.completion).toBeUndefined()
      expect(workflow.runs).toHaveLength(2)
      expect(await implement(f, workflow, "second.txt", "ready\n")).toBe(cwd)
      await approveNext(f)
      await accept(f, "S2", "pass")
      const completed = await approveNext(f)
      expect(completed.completion).toBe("accepted")
      expect(completed.batchResolutions?.map((entry) => entry.batchId)).toEqual(["B1", "B2"])
      expect(await f.store.readArtifact(failed.ref)).toEqual(failed.verdict)
      f.send("revisit design")
      await f.dialog("Revisit design?")
      f.terminal.send("\r")
      await f.dialog("Confirm stage change")
      f.terminal.send("\x1b[B\r")
      await f.dismissed()
      expect((await f.store.read()).stage).toBe("design")
      const correctedDecision = await decision(f, initialDecision)
      const corrected = structuredClone(original)
      corrected.spec.revision = 2
      corrected.spec.decisionIds = [correctedDecision]
      corrected.spec.items[0]!.decisionIds = [correctedDecision]
      corrected.spec.items[0]!.description = "Write the corrected approved local result"
      corrected.spec.items[0]!.acceptanceCriteria = ["result.txt contains corrected"]
      const correctionDraft = {
        ...corrected,
        spec: {
          ...corrected.spec,
          items: corrected.spec.items.map((item) => ({ ...item, previousItemId: item.id })),
        },
        batches: [corrected.batches[0]!],
      }
      const correctedState = await approveSpec(f, correctionDraft)
      expect(correctedState.corrections.at(-1)?.impact).toBe("mapped")
      const correctedPlan = await f.store.readArtifact(
        correctedState.artifacts.findLast((entry) => entry.kind === "batch-plan")!,
      )
      expect(correctedPlan).toMatchObject({ kind: "batch-plan", preservedItems: [{ itemId: "S2" }] })
      expect(correctedState.approvedContext?.batchId).not.toBe("B1")
      expect(await implement(f, workflow, "result.txt", "corrected\n")).toBe(cwd)
      await approveNext(f)
      await accept(f, "S1", "pass")
      await trial(f)
      const final = await approveNext(f)
      expect(final.completion).toBe("accepted")
      expect(workflow.runs).toHaveLength(4)
      expect(await readFile(path.join(cwd, "second.txt"), "utf8")).toBe("ready\n")
      expect(await f.store.readArtifact(failed.ref)).toEqual(failed.verdict)
      expect(final.artifacts.slice(0, completed.artifacts.length)).toEqual(completed.artifacts)
      await f.command("status", ["Accepted", "Manual trial: tried"], 90_000)
    } catch (error) {
      console.error("Offline full-flow failure before cleanup:", error, f.live())
      throw error
    } finally {
      await f.cleanup()
    }
  })
})
