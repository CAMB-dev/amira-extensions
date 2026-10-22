import { agentsOf } from "../src/source.ts"
import { viewFixture } from "./view-fixture.ts"

/** Project-shaped cached data, without importing a project or runner provider. */
export function projectFixture() {
  const fixture = viewFixture()
  fixture.data.source.id = "project.checkout"
  fixture.data.source.label = "Checkout project"
  fixture.snapshot.workspace = "acme/checkout"
  fixture.snapshot.note = "Own reported usage only. Stage rollups are in Documents; unknown is not zero."
  fixture.snapshot.warning = "Budget stop: implementation needs approval. Use /project to continue."
  fixture.snapshot.phases = [
    {
      id: "iteration-2",
      name: "Iteration 2",
      groups: [
        {
          id: "stages",
          name: "Stages",
          agents: [
            {
              id: "checkout.i2.spec.r3",
              name: "legacy spec row",
              card: { kind: "stage", label: "Spec" },
              task: "Approved specification",
              status: "done",
              cost: 0.125,
              files: [{ path: "spec.md" }],
              actions: [],
            },
            {
              id: "checkout.i2.implement.r4",
              name: "legacy implementation row",
              card: { kind: "stage", label: "Implement" },
              task: "Batch 2 blocked by budget stop",
              status: "failed",
              files: [],
              actions: [],
            },
            {
              id: "checkout.i2.ship.r1",
              name: "legacy ship row",
              card: { kind: "stage", label: "Ship" },
              task: "Awaiting human approval",
              status: "queued",
              files: [],
              actions: [],
            },
          ],
        },
      ],
    },
  ]
  for (const id of Object.keys(fixture.details)) delete fixture.details[id]
  for (const agent of agentsOf(fixture.snapshot)) {
    fixture.details[agent.id] = {
      summary: [{ kind: "text", text: agent.task }],
      logs: [{ kind: "text", text: "Cached stage evidence" }],
      notes: [{ kind: "muted", text: "Iteration known subtotal: $0.125; incomplete pricing." }],
      tabs: [
        {
          key: "documents",
          label: "Documents",
          render: () => [{ kind: "text", text: "spec.md | batch-2.md | ship-plan.md" }],
        },
      ],
    }
  }
  const first = agentsOf(fixture.snapshot)[0]!
  fixture.data.selected = first.id
  fixture.state.selected.timeline = `agent:${first.id}`
  fixture.state.expanded.timeline = [
    "phase:iteration-2",
    ...agentsOf(fixture.snapshot).map((agent) => `agent:${agent.id}`),
  ]
  return fixture
}
