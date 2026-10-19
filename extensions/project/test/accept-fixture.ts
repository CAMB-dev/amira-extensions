import { expect, mock } from "bun:test"
import type {
  ConversationRuntime,
  ConversationSpec,
  OwnedConversation,
  ToolContext,
  ToolResult,
} from "@amira/api"
import { ACCEPT_RECORD, Acceptances } from "../src/accept.ts"
import { fixture, localShell } from "./implement-fixture.ts"
import { human } from "./iteration-binding-helper.ts"

export async function acceptanceFixture(options: { contributors?: string[]; extraCheck?: boolean } = {}) {
  const f = await fixture()
  if (options.extraCheck) {
    f.drafts[0]!.spec.checks.push({ id: "C2", cwd: ".", command: "git diff --quiet" })
    f.drafts[0]!.spec.items[0]!.checkIds.push("C2")
  }
  await f.approve()
  f.answers.push(true)
  await f.implementations.run(f.project, f.ctx, "en", () => {})
  await f.settled()
  let state = await f.store.read()
  if (options.contributors) {
    const ref = state.artifacts.findLast((entry) => entry.kind === "batch-result")!
    const result = await f.store.readArtifact(ref)
    if (result.kind !== "batch-result") throw new Error("Missing implementation result")
    state = (
      await f.store.saveArtifact(state.revision, { ...result, implementerModels: options.contributors })
    ).state
  }
  state = await f.store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, state.pending!.id, "accept"),
  })
  const specs: ConversationSpec[] = []
  const seeds: string[] = []
  const calls: { command: string; key: string }[] = []
  const records: ToolResult[] = []
  let report: unknown = {
    items: [
      {
        itemId: "S1",
        status: "pass",
        evidence: ["result.txt:1 contains ready"],
        reason: "Observed required output",
      },
    ],
  }
  let beforeReport: (() => Promise<void>) | undefined
  let commandResult: ((command: string) => ToolResult | undefined) | undefined
  const handles: OwnedConversation[] = []
  const releases: ReturnType<typeof mock<() => Promise<void>>>[] = []
  const available = ["mock/reviewer", "mock/actual-implementer", "mock/second-implementer"]
  f.ctx.session.models = () => available
  f.api.conversations!.openOrCreate = async (spec: ConversationSpec, runtime: ConversationRuntime) => {
    specs.push(spec)
    // Accounting decorates the host handle in place; keep the original release spy.
    const release = mock(async () => {})
    releases.push(release)
    const handle = {
      id: `review-${specs.length}`,
      ...spec,
      history: () => [],
      data: { read: () => [], append: () => {} },
      status: () => ({ state: "idle", busy: false }),
      events: { async *[Symbol.asyncIterator]() {} },
      runTool: mock(async (_name: string, args: Record<string, unknown>) => {
        const command = String(args.command)
        calls.push({ command, key: spec.key })
        return commandResult?.(command) ?? localShell(command, spec.cwd)
      }),
      send: mock(async (seed: string) => {
        seeds.push(seed)
        if (beforeReport) await beforeReport()
        const tool = runtime.extraTools?.find((tool) => tool.name === ACCEPT_RECORD)
        expect(tool).toBeDefined()
        if (report !== undefined)
          records.push(
            await tool!.execute(
              report as Record<string, unknown>,
              {
                cwd: spec.cwd,
                session: { sessionId: handle.id },
                signal: new AbortController().signal,
              } as ToolContext,
            ),
          )
      }),
      stop: mock(async () => {}),
      release,
    } as unknown as OwnedConversation
    handles.push(handle)
    return handle
  }
  const acceptances = new Acceptances(f.api)
  return {
    ...f,
    acceptances,
    reviewSpecs: specs,
    seeds,
    reviewCalls: calls,
    records,
    reviewHandles: handles,
    reviewReleases: releases,
    report: (value: unknown) => {
      report = value
    },
    beforeReport: (fn: () => Promise<void>) => {
      beforeReport = fn
    },
    commandResult: (fn: (command: string) => ToolResult | undefined) => {
      commandResult = fn
    },
    async verdict() {
      const current = await f.store.read()
      const ref = current.artifacts.findLast((entry) => entry.kind === "acceptance")
      if (!ref) throw new Error(`Missing acceptance: ${f.notifications.join("\n")}`)
      const verdict = await f.store.readArtifact(ref)
      if (verdict.kind !== "acceptance") throw new Error("Missing acceptance")
      return verdict
    },
  }
}
