import { mock } from "bun:test"
import { emptyUsage, type TraceSummary, type UiContext, type UiControl, type UiState } from "@amira/api"
import type { DashboardAction, DashboardDetails, DashboardSnapshot, DashboardSource } from "../src/source.ts"
import type { DashboardViewData } from "../src/view.ts"

export const NOW = Date.parse("2026-10-03T09:02:00.000Z")

export function viewFixture() {
  const snapshot: DashboardSnapshot = {
    workspace: "acme/checkout",
    note: "Own reported usage only; missing costs are unknown.",
    phases: [
      {
        id: "implementation",
        name: "Implementation",
        groups: [
          {
            id: "workers",
            name: "Checkout workers",
            ref: "checkout-v2",
            agents: [
              {
                id: "payments",
                name: "Payment validation",
                task: "Validate payment amounts and add regression coverage for partial refunds.",
                status: "running",
                startedAt: NOW - 90_000,
                cost: 0.125,
                progress: 0.6,
                language: "TypeScript",
                files: [
                  {
                    path: "src/payments.ts",
                    diff: [
                      { kind: "diff-hunk", text: "@@ -1 +1 @@" },
                      { kind: "diff-remove", text: "return amount >= 0" },
                      { kind: "diff-add", text: "return Number.isFinite(amount) && amount >= 0" },
                    ],
                  },
                  { path: "test/payments.test.ts" },
                ],
                actions: ["pause", "stop", "request-changes"],
              },
              {
                id: "receipts",
                name: "Receipt templates",
                task: "Check the receipt template while awaiting product approval.",
                status: "paused",
                startedAt: NOW - 75_000,
                files: [{ path: "templates/receipt.html" }],
                actions: ["resume", "stop"],
              },
            ],
          },
        ],
      },
      {
        id: "review",
        name: "Review",
        groups: [
          {
            id: "workers",
            name: "Security review",
            agents: [
              {
                id: "audit",
                name: "Refund audit",
                task: "Review authorization checks on refund requests.",
                status: "done",
                startedAt: NOW - 120_000,
                durationMs: 45_000,
                cost: 0.04,
                progress: 1,
                files: [],
                actions: [],
              },
            ],
          },
        ],
      },
    ],
  }
  const stats: TraceSummary = {
    start: NOW - 90_000,
    end: NOW,
    wallTimeMs: 90_000,
    modelTimeMs: 30_000,
    modelWaitMs: 4_000,
    modelStreamMs: 25_000,
    modelUnknownMs: 1_000,
    toolTimeMs: 20_000,
    toolDurationMs: 25_000,
    approvalWaitMs: 5_000,
    idleMs: 3_000,
    usage: { ...emptyUsage(), cost: 0.125 },
    subagentUsage: emptyUsage(),
    totalUsage: { ...emptyUsage(), cost: 0.125 },
    tools: {
      bash: {
        count: 2,
        totalMs: 25_000,
        avgMs: 12_500,
        maxMs: 15_000,
        outcomes: { ok: 1, error: 1, denied: 0, aborted: 0, invalid: 0, "unknown-tool": 0 },
      },
    },
    failures: [
      {
        type: "tool",
        at: NOW - 20_000,
        toolCallId: "check-payments",
        name: "bash",
        outcome: "error",
        message: "Refund regression failed before the fix.",
      },
    ],
    retries: 1,
    subagents: [],
  }
  const details: Record<string, DashboardDetails> = {
    payments: {
      summary: [
        { kind: "text", text: "Amount validation is implemented; regression tests are in progress." },
      ],
      logs: [
        { kind: "text", text: "Read src/payments.ts" },
        { kind: "error", text: "Refund regression failed before the fix." },
      ],
      stats,
    },
    receipts: { summary: [{ kind: "text", text: "Waiting for approval." }], logs: [] },
    audit: { summary: [{ kind: "success", text: "No authorization issues found." }], logs: [] },
  }
  const act = mock(
    (_id: string, action: DashboardAction, _text?: string): string | Promise<string> => `Accepted ${action}.`,
  )
  const source: DashboardSource = {
    id: "fixture",
    label: "Checkout run",
    snapshot: () => snapshot,
    details: (id) => details[id],
    act,
  }
  const data: DashboardViewData = { source, selected: "payments", tab: "summary" }
  const state: UiState = {
    selected: { timeline: "agent:payments", actions: "open-diff" },
    expanded: {
      timeline: [
        "phase:implementation",
        "group:implementation:workers",
        "agent:payments",
        "agent:receipts",
        "phase:review",
        "group:review:workers",
        "agent:audit",
      ],
    },
    activeTabs: { detail: "summary" },
    scroll: { logs: { top: 0, following: true } },
    inputValues: {},
    focused: "timeline",
  }
  const control = {
    close: mock(() => {}),
    requestRender: mock(() => {}),
    print: mock(() => {}),
    prompt: mock(async (_title: string): Promise<string | undefined> => "Please cover negative refunds."),
    confirm: mock(async (_question: string, _options?: { yes?: string; no?: string }) => true),
    setState: mock((patch: Partial<UiState>) => {
      Object.assign(state, patch)
    }),
    focus: mock((id: string) => {
      state.focused = id
    }),
  } satisfies UiControl
  const context = (width = 180): UiContext => ({ width, now: NOW, state })
  return { data, snapshot, details, stats, act, state, control, context }
}
