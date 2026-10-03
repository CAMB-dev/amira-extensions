import { expect, test } from "bun:test"
import {
  type AgentNode,
  type FlowNode,
  formatDuration,
  runStateText,
  totals,
  treeLines,
} from "../src/progress.ts"

const agent = (call: number, status: AgentNode["status"]): AgentNode => ({
  kind: "agent",
  call,
  label: `agent ${call}`,
  status,
  tokens: 0,
})

test("a phase whose agents failed or were stopped does not read as done", () => {
  const flow: FlowNode = {
    kind: "workflow",
    name: "review",
    state: "error",
    phases: [
      { title: "Read", items: [agent(1, "done")] },
      { title: "Verify", items: [agent(2, "done"), agent(3, "error")] },
      { title: "Fix", items: [agent(4, "aborted")] },
      { title: "Report", items: [] },
    ],
  }
  const lines = treeLines(flow, 0)
  const phase = (title: string) => lines.find((l) => l.text.endsWith(title))!
  expect(phase("Read")).toEqual({ kind: "text", text: "├ ✓ Read" })
  expect(phase("Verify")).toEqual({ kind: "error", text: "├ ✗ Verify" })
  expect(phase("Fix")).toEqual({ kind: "warning", text: "├ ⊘ Fix" })
  // Never reached: the run failed before it.
  expect(phase("Report")).toEqual({ kind: "muted", text: "└ ◌ Report" })
  // The stopped agent's own mark is the one every screen uses.
  expect(lines.some((l) => l.text.includes("⊘ agent 4"))).toBe(true)
})

test("totals preserve unknown usage and count each status", () => {
  const statuses: AgentNode["status"][] = ["queued", "working", "done", "error", "aborted", "cached"]
  const flow: FlowNode = {
    kind: "workflow",
    name: "usage",
    state: "running",
    phases: [
      {
        title: "Work",
        items: statuses.map((status, index) => ({ ...agent(index, status), tokens: 10, cost: 0.01 })),
      },
    ],
  }
  expect(totals(flow)).toMatchObject({
    agents: 6,
    tokens: 60,
    byStatus: { queued: 1, working: 1, done: 1, error: 1, aborted: 1, cached: 1 },
  })
  expect(totals(flow).cost).toBeCloseTo(0.06)
  flow.phases[0]!.items.push({ ...agent(9, "error"), tokens: undefined })
  expect(totals(flow).tokens).toBeUndefined()
  expect(totals(flow).cost).toBeUndefined()
})

test("times are written as Amira writes them", () => {
  expect(formatDuration(12_000)).toBe("12s")
  expect(formatDuration(65_000)).toBe("1m 05s")
  expect(formatDuration(3_720_000)).toBe("1h 02m")
})

test("run and agent states are worded as every screen words them", () => {
  expect(runStateText("error")).toBe("failed")
  expect(runStateText("aborted")).toBe("stopped")
  expect(runStateText("done")).toBe("done")
})
