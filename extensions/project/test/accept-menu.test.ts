import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import type { CommandContext } from "@amira/api"
import { runStageCommand } from "../src/stage-commands.ts"
import { implement } from "./batch-test-helper.ts"
import { fixture } from "./implement-fixture.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(90_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await rm(f.home, { recursive: true, force: true })
})

for (const selection of [undefined, "Keep current stage", "Start acceptance review"]) {
  test(`confirmed acceptance menu: ${selection ?? "Escape"} is an explicit named action`, async () => {
    const f = await fixture({ initialized: false })
    fixtures.push(f)
    let state = await implement(f.store, await f.approve())
    const proposal = {
      id: "accept-menu",
      from: "implement" as const,
      to: "accept" as const,
      kind: "advance" as const,
      summaryId: state.summaryId!,
      suggestion: "Review this batch",
      skippedStages: [],
      context: { ...state.approvedContext!, changes: state.attempts.at(-1)!.changes },
    }
    state = await f.store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal,
    })
    state = await f.store.dispatch(state.revision, {
      type: "confirm-transition",
      expectedRevision: state.revision,
      receipt: { ...human(state, proposal.id, "accept"), context: proposal.context },
    })
    let started = 0
    const ctx = {
      ...f.ctx,
      ui: {
        ...f.ctx.ui,
        select: async (_title: string, choices: string[]) => {
          expect(choices).toEqual(["Start acceptance review", "Keep current stage"])
          return selection
        },
      },
    } as CommandContext
    await runStageCommand(
      "next",
      [],
      f.project,
      ctx,
      "en",
      () => {},
      async () => {},
      () => {},
      undefined,
      async () => {
        started++
      },
    )
    expect(started).toBe(selection === "Start acceptance review" ? 1 : 0)
    expect(await f.store.read()).toEqual(state)
  })
}
