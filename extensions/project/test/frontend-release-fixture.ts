import { expect } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "@amira/api"
import type { CostLedger } from "../src/cost.ts"
import type { IterationState } from "../src/stage.ts"
import { DecisionStore } from "../src/store.ts"
import { ESC, F6, frontend, waitFor } from "./frontend-harness.ts"
import { requireFrontendHost } from "./frontend-host.ts"
import { workflowFixture } from "./frontend-services-fixture.ts"
import { fixtureShell, specDraft } from "./implement-fixture.ts"

export type Frontend = Awaited<ReturnType<typeof frontend>>
export const paste = (text: string) => requireFrontendHost().harness.paste(text)
export const charge = (cost: number) => ({ input: 10, output: 5, cost })

/** A fake service contract, never the workflow provider implementation. */
export function releaseServices() {
  const workflow = workflowFixture()
  const stops: string[] = []
  const stop = workflow.runner.stop.bind(workflow.runner)
  workflow.runner.stop = (id) => {
    stops.push(id)
    return stop(id)
  }
  const commands: { command: string; cwd: string }[] = []
  const shell: ToolDefinition = {
    ...fixtureShell,
    execute(args, ctx) {
      const command = String(args.command)
      commands.push({ command, cwd: ctx.cwd })
      // Only deterministic project Git orchestration and our exact local check
      // reach a process. Even a regression cannot launch a remote or publisher.
      if (
        /\b(?:push|fetch|pull|clone|gh|curl|wget|npm|npx|bun|ssh|scp)\b/.test(command) ||
        /--force|--no-verify|--no-gpg-sign|hooksPath|gpgsign|HUSKY=0|reset --hard|branch -D/.test(command) ||
        /https?:|ssh:\/\//.test(command) ||
        !/^(?:cd |git )/.test(command)
      )
        throw new Error(`Offline release executor refused: ${command}`)
      return fixtureShell.execute(args, ctx)
    },
  }
  return { workflow, stops, commands, shell }
}

export function openRelease(services: ReturnType<typeof releaseServices>, existing?: Frontend) {
  return frontend(existing && { root: existing.root, file: existing.file }, [services.shell], {
    rows: 42,
    commandTimeoutMs: 180_000,
    extensions: [{ name: "workflow", extension: services.workflow.extension }],
  })
}

export function configure(f: Frontend) {
  f.agent.permissions.setMode("auto")
  f.host.setSettings({
    extensions: { [`frontend-${path.basename(f.root)}`]: { reviewerModel: "mock/reviewer" } },
  })
}

export async function ledger(f: Frontend): Promise<CostLedger> {
  return JSON.parse(await readFile(path.join(f.cwd, ".amira/project/costs.json"), "utf8"))
}

export async function stateWhen(f: Frontend, check: (state: IterationState) => boolean, label: string) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const state = await f.store.read()
    if (check(state)) return state
    await Bun.sleep(50)
  }
  throw new Error(`${label}\n${JSON.stringify(await f.store.read())}\n${f.live()}`)
}

export async function main(f: Frontend) {
  if (f.live().includes("main idle")) {
    f.terminal.send(F6)
    await waitFor(() => !f.live().includes("main idle"), "native return to main", 30_000)
  }
  await f.idle()
  f.terminal.send("\x15")
}

export async function confirm(f: Frontend, title: string, yes = true) {
  await f.dialog(title, 180_000)
  f.terminal.send(yes ? "\x1b[B\r" : "n")
}

export async function input(f: Frontend, title: string, value: string) {
  await f.dialog(title, 180_000)
  f.terminal.send(`${paste(value)}\r`)
}

export async function next(f: Frontend) {
  const calls = f.mock.requests.length
  f.send("next")
  await f.dialog("Choose the next step", 180_000)
  f.terminal.send("\r")
  await confirm(f, "Confirm stage change")
  await f.dismissed()
  expect(f.mock.requests).toHaveLength(calls)
  return f.store.read()
}

export async function decision(f: Frontend) {
  f.mock.push(
    {
      usage: charge(0.1),
      toolCalls: [
        {
          id: "release-design-decision",
          name: "record_decision",
          args: {
            questions: [
              {
                question: "Which offline delivery?",
                options: [
                  { label: "Local result", description: "Keep all work and delivery offline." },
                  { label: "Remote result", description: "Not selected in this fixture." },
                ],
              },
            ],
          },
        },
      ],
    },
    { text: "Release decision recorded", usage: charge(0) },
  )
  f.send("design")
  await f.visible("main idle")
  f.terminal.send(`${paste("Ask me to confirm an offline delivery.")}\r`)
  await confirm(f, "Approve file tool")
  await waitFor(() => f.host.ui.pending[0]?.kind === "ask", "human design question", 30_000)
  await f.visible("Which offline delivery?")
  f.terminal.send("\r")
  await f.visible("Release decision recorded")
  await main(f)
  const records = await new DecisionStore(f.project).records()
  expect(records.at(-1)?.answer.selected).toEqual(["Local result"])
  return records.at(-1)!.id
}

export async function proposePrototype(f: Frontend) {
  f.mock.push({
    usage: charge(0.1),
    text: JSON.stringify([
      { id: "local", idea: "One offline result", question: "Does one local result explain delivery?" },
    ]),
  })
  f.send("prototype")
  await f.dialog("Confirm prototype variants")
  expect(f.mock.requests.at(-1)!.tools).toEqual([])
  f.terminal.send("\r")
  await f.dialog("Open a prototype variant")
  f.terminal.send(ESC) // Proposal is durable; no prototype code or run command is executed.
  await f.dismissed()
  const state = await f.store.read()
  const manifest = await f.store.readArtifact(
    state.artifacts.findLast((ref) => ref.kind === "prototype-manifest")!,
  )
  expect(manifest).toMatchObject({
    kind: "prototype-manifest",
    variants: [{ id: "local", status: "planned" }],
  })
}

export async function approveSpec(f: Frontend, decisionId: string) {
  const draft = specDraft()
  draft.spec.decisionIds = [decisionId]
  draft.spec.items[0]!.decisionIds = [decisionId]
  // This command actually checks the complete deliverable, not merely Git's version.
  draft.spec.checks[0]!.command = 'test "$(cat result.txt)" = ready'
  f.mock.push({ text: JSON.stringify(draft), usage: charge(0.1) })
  f.send("spec")
  await f.dialog("Choose execution mode")
  expect(f.live()).toContain("Workflow")
  expect(f.live()).not.toContain("Swarm")
  f.terminal.send("\x1b[B\r")
  await f.dialog("Review implementation spec")
  expect(f.mock.requests.at(-1)!.tools).toEqual([])
  expect(JSON.stringify(f.mock.requests.at(-1)!.messages)).toContain(decisionId)
  f.terminal.send("\r")
  await f.dismissed()
  expect((await f.store.read()).approvedContext?.mode).toBe("workflow")
}

export async function implement(f: Frontend, services: ReturnType<typeof releaseServices>, content: string) {
  const before = services.workflow.runs.length
  f.mock.push(
    {
      usage: charge(0.05),
      toolCalls: [{ id: `release-write-${before}`, name: "write", args: { path: "result.txt", content } }],
    },
    { text: "Approved local result implemented; no prototype was copied.", usage: charge(0.05) },
  )
  f.send("implement")
  await waitFor(() => services.workflow.runs.length === before + 1, "fresh workflow run", 180_000)
  await f.idle()
  await f.visible("main idle")
  await main(f)
  const state = await stateWhen(f, (state) => state.pending?.to === "accept", "implementation settled")
  const run = services.workflow.runs.at(-1)!
  expect(run.request.cwd).not.toBe(f.cwd)
  expect(run.owner.sessionId).toBe(run.request.startedBy.sessionId)
  expect(await readFile(path.join(run.request.cwd, "result.txt"), "utf8")).toBe(content)
  expect(await Bun.file(path.join(f.cwd, "result.txt")).exists()).toBe(false)
  expect(state.attempts.at(-1)?.status).toBe("finished")
  return run.request.cwd
}

export async function accept(f: Frontend, outcome: "pass" | "fail") {
  const before = f.mock.requests.length
  f.mock.push(
    {
      usage: charge(0.05),
      toolCalls: [
        {
          id: `release-review-denied-write-${before}`,
          name: "write",
          args: { path: "reviewer-must-not-write.txt", content: "This must be denied.\n" },
        },
        {
          id: `release-review-${before}`,
          name: "project_record_acceptance",
          args: {
            items: [
              {
                itemId: "S1",
                status: outcome,
                evidence: ["Observed the isolated local result and C1 outcome"],
                reason: outcome === "pass" ? "Approved result present" : "Repair the local result",
              },
            ],
          },
        },
      ],
    },
    { text: `Independent review ${outcome}; not shipped.`, usage: charge(0.05) },
  )
  f.send("accept")
  await waitFor(() => f.mock.requests.length > before, "independent review started", 180_000)
  await f.idle()
  await f.visible("main idle")
  await main(f)
  const state = await stateWhen(
    f,
    (state) => state.stage === "accept" && ["summarized", "proposed"].includes(state.phase),
    "review settled",
  )
  const ref = state.artifacts.findLast((entry) => entry.kind === "acceptance")!
  const verdict = await f.store.readArtifact(ref)
  expect(verdict).toMatchObject({
    kind: "acceptance",
    outcome,
    reviewerModel: "mock/reviewer",
    implementerModels: ["mock/frontend"],
    sameModelFallback: false,
    checks: [{ checkId: "C1", status: outcome === "pass" ? "passed" : "failed" }],
  })
  expect(f.mock.requests[before]!.model.id).toBe("reviewer")
  // Tool schemas may be visible; the owned callable ceiling enforces authority.
  expect(JSON.stringify(f.mock.requests[before + 1]!.messages)).toContain("not callable")
  return { state, ref, verdict }
}

/** Archive inspection must not repair journals or rewrite even unchanged document bytes. */
export async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await files(file))) result[`${entry.name}/${name}`] = value
    } else {
      const stat = await Bun.file(file).stat()
      result[entry.name] = `${stat.mtimeMs}:${(await readFile(file)).toString("base64")}`
    }
  }
  return result
}
