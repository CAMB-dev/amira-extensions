import { describe, expect, test } from "bun:test"
import type { CommandContext, SelectChoice, SelectSection } from "@amira/api"
import type { Bundle } from "../src/collect.ts"
import type { Finding } from "../src/findings.ts"
import type { Report } from "../src/store.ts"
import { browse, details, detailView, markdown, preflight, progressView } from "../src/ui.ts"

function finding(id = "F001", assessment: Finding["assessment"] = "supported"): Finding {
  return {
    id,
    path: "src/very-long-directory/another-long-directory/example.ts",
    side: "old",
    startLine: 12,
    endLine: 14,
    severity: "P2",
    category: "contract",
    summary: "Empty input violates the caller contract",
    scenario: "An empty request reaches the removed guard and throws.",
    evidence: [{ path: "src/caller.ts", side: "new", line: 8, reason: "Caller passes empty input." }],
    suggestedFix: "Restore the guard before destructuring.",
    rule: "REVIEW.md:2 — preserve empty inputs",
    sources: ["contracts", "correctness"],
    assessment,
    rationale: "The caller still permits an empty input.",
    ignored: false,
    excerpt: "const { item } = input;",
  }
}
function report(): Report {
  return {
    schemaVersion: 1,
    id: "94f43884-58b9-4a84-9420-1bbcd82f8020",
    repoKey: "a".repeat(64),
    root: "D:/repository",
    originSessionId: "main-session",
    ownerId: "owned-session",
    startedAt: "2026-10-16T10:00:00Z",
    endedAt: "2026-10-16T10:01:00Z",
    state: "completed",
    stale: false,
    scope: { kind: "worktree", paths: ["src"], includeUntracked: false },
    base: "b".repeat(40),
    head: "c".repeat(40),
    fingerprint: "d".repeat(64),
    snapshotHashes: { "src/caller.ts": "e".repeat(64) },
    included: ["src/example.ts"],
    untracked: [],
    excluded: [{ path: "package-lock.json", reason: "lockfile" }],
    redacted: ["src/example.ts"],
    guidance: ["REVIEW.md"],
    settings: {
      reviewerModel: "provider/reviewer",
      verifierModel: "provider/assessor",
      verify: true,
      maxParallel: 2,
      maxTokens: 120000,
      maxCostUsd: 2,
    },
    promptHashes: { correctness: "f".repeat(64) },
    findings: [finding()],
    limitations: ["The removed guard was assessed statically."],
    usage: null,
    childStates: { correctness: "done", contracts: "done" },
  }
}

type Picker = { title: string; options: string[]; sections: SelectSection[] }
type Answer = (picker: Picker) => SelectChoice | undefined
function fake(answers: Answer[], opts: { open?: boolean; frontend?: CommandContext["frontend"] } = {}) {
  const picks: Picker[] = [],
    prints: string[] = [],
    views: unknown[] = [],
    ignored: string[] = [],
    fixed: string[] = []
  const ctx = {
    frontend: opts.frontend ?? "rpc",
    signal: new AbortController().signal,
    ui: {
      async choose(title: string, options: string[], options2: { sections: SelectSection[] }) {
        const picker = { title, options, sections: options2.sections }
        picks.push(picker)
        return answers.shift()?.(picker)
      },
    },
    print(text: string) {
      prints.push(text)
    },
    session: {
      send() {
        throw new Error("UI must not send to main")
      },
    },
    ...(opts.open === undefined
      ? {}
      : {
          openView(view: unknown) {
            views.push(view)
            return opts.open
          },
        }),
  } as unknown as CommandContext
  return {
    ctx,
    picks,
    prints,
    views,
    ignored,
    fixed,
    actions: {
      ignore: async (id: string) => {
        ignored.push(id)
      },
      fix: async (id: string) => {
        fixed.push(id)
      },
    },
  }
}
const first: Answer = (p) => ({ option: p.options[0]! })
const action =
  (option: string): Answer =>
  () => ({ option })

describe("review UI", () => {
  test("preflight names only admitted untracked content and gives exposure/cap warnings", () => {
    const r = report()
    const bundle: Bundle = {
      root: r.root,
      repoKey: r.repoKey,
      scope: { ...r.scope, includeUntracked: true },
      base: r.base,
      head: r.head,
      fingerprint: r.fingerprint,
      changes: [
        {
          path: "src/admitted.ts",
          oldPath: "src/admitted.ts",
          status: "A",
          patch: "+[REDACTED]",
          hunks: [],
          untracked: true,
          metadataOnly: false,
        },
      ],
      untracked: ["src/admitted.ts", "src/not-admitted.ts"],
      excluded: [],
      inventory: ["src/caller.ts"],
      patch: "+[REDACTED]",
      added: 1,
      removed: 0,
    }
    const text = preflight(bundle, r.settings, ["REVIEW.md"])
    for (const expected of [
      "src/admitted.ts",
      "provider/reviewer",
      "provider/assessor",
      "120000",
      "USD 2",
      "24 bounded read/search",
      "review_search",
      "REVIEW.md",
      "best effort",
      "separate permission",
      "not reservations",
    ])
      expect(text).toContain(expected)
    expect(text).not.toContain("src/not-admitted.ts")
    expect(text).toContain("Selected files: 1; added lines: 1; removed lines: 0")
  })

  test("Enter always reaches an action picker; no-view fallback prints full finding details", async () => {
    const r = report(),
      f = fake([first, action("Show details")])
    await browse(r, f.ctx, f.actions)
    expect(f.picks[1]?.title).toBe("Actions for F001")
    expect(f.prints).toEqual([details(r.findings[0]!, r)])
    for (const text of [
      "Failure scenario",
      "Evidence",
      "Suggested direction",
      "Independent assessment",
      "Saved context excerpt",
      "src/caller.ts:8",
      "old side",
      "REVIEW.md:2",
    ])
      expect(f.prints[0]).toContain(text)
    expect(f.fixed).toEqual([])
    expect(f.views).toEqual([])
  })

  test("false openView uses the same complete textual fallback", async () => {
    const r = report(),
      f = fake([first, action("Show details")], { open: false })
    await browse(r, f.ctx, f.actions)
    expect(f.views).toHaveLength(1)
    expect(f.prints).toEqual([details(r.findings[0]!, r)])
  })

  test("opens a detail view only after the explicit details action", async () => {
    const r = report(),
      f = fake([first, action("Show details")], { open: true })
    await browse(r, f.ctx, f.actions)
    expect(f.views).toEqual([{ kind: detailView().kind, data: { finding: r.findings[0], report: r } }])
    expect(f.picks).toHaveLength(2)
    expect(f.prints).toEqual([])
    const cancelled = fake([])
    await browse(r, cancelled.ctx, cancelled.actions)
    expect(cancelled.views).toEqual([])
  })

  test("groups supported, uncertain/unchecked and ignored while refutations start collapsed", async () => {
    const r = report()
    r.findings = [
      finding(),
      finding("F002", "uncertain"),
      finding("F003", "unchecked"),
      { ...finding("F004"), ignored: true },
      finding("F005", "refuted"),
    ]
    const f = fake([
      (p) => {
        expect(p.sections.map((s) => s.title)).toEqual([
          "Supported",
          "Uncertain / unchecked",
          "Ignored",
          "Report",
        ])
        expect(p.options.some((label) => label.startsWith("F005"))).toBe(false)
        expect(p.options[0]).toContain("F001 [P2] supported")
        expect(p.options[0]).toContain(r.findings[0]!.path)
        return { option: p.options.find((label) => label.startsWith("Show refuted"))! }
      },
      (p) => {
        expect(p.sections.map((s) => s.title)).toContain("Refuted")
        expect(p.options.some((label) => label.startsWith("F005 [P2] refuted"))).toBe(true)
        return undefined
      },
    ])
    await browse(r, f.ctx, f.actions)
    expect(f.fixed).toEqual([])
  })

  test("portable ignore/unignore actions persist through supplied callback only", async () => {
    const r = report(),
      f = fake([first, action("Ignore finding"), first, action("Unignore finding")])
    await browse(r, f.ctx, f.actions)
    expect(f.ignored).toEqual(["F001", "F001"])
    expect(r.findings[0]?.ignored).toBe(false)
    expect(f.fixed).toEqual([])
  })

  test("ignore failure does not mutate the browser's local state", async () => {
    const r = report(),
      f = fake([first, action("Ignore finding")])
    await expect(
      browse(r, f.ctx, {
        ...f.actions,
        ignore: async () => {
          r.findings[0]!.ignored = true
          throw new Error("save failed")
        },
      }),
    ).rejects.toThrow("save failed")
    expect(r.findings[0]?.ignored).toBe(false)
  })

  test("hand-off is a single explicit delegated action, never direct session.send", async () => {
    const r = report(),
      f = fake([first, action("Hand off to main")])
    await browse(r, f.ctx, f.actions)
    expect(f.fixed).toEqual(["F001"])
    expect(f.ignored).toEqual([])
  })

  test("section key actions retain the portable Enter fallback", async () => {
    const r = report(),
      f = fake([(p) => ({ option: p.options[0]!, key: "p" })])
    await browse(r, f.ctx, f.actions)
    expect(f.prints).toEqual([details(r.findings[0]!, r)])
    expect(f.picks[1]?.title).not.toBe("Actions for F001")
  })

  test("print full report includes all assessments, coverage and metadata, not only details", async () => {
    const r = report()
    r.state = "partial"
    r.stale = true
    r.findings.push({ ...finding("F002", "refuted"), ignored: true })
    const f = fake([first, action("Print full report")])
    await browse(r, f.ctx, f.actions)
    expect(f.prints).toEqual([markdown(r)])
    for (const value of [
      "Coverage is incomplete",
      "F002",
      "refuted",
      "ignored",
      "Reported usage",
      "Unknown / not reported",
      "Source snapshot hashes",
      "Prompt hashes",
      "package-lock.json",
      "Child states",
      "Settings",
      "Origin session",
      "Limitations",
    ])
      expect(f.prints[0]).toContain(value)
    const printed = fake([], { frontend: "print" })
    await browse(r, printed.ctx, printed.actions)
    expect(printed.prints).toEqual([markdown(r)])
    expect(printed.picks).toEqual([])
  })

  test("details/report/view redact credentials and controls and preserve long paths at narrow widths", () => {
    const r = report(),
      finding = r.findings[0]!
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz"
    finding.scenario = `\x1b[31mDanger ${secret}\u202e`
    finding.excerpt = `password=${secret}\nsecond line`
    const d = details(finding, r),
      full = markdown(r)
    for (const text of [d, full]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain("\x1b")
      expect(text).not.toContain("\u202e")
      expect(text).toContain("REDACTED")
    }
    const view = detailView()
    expect(view.follow).toBe(false)
    expect(view.keys).toBeUndefined()
    const lines = view.render!({ finding, report: r }, { width: 10, now: 0 })
    const text = lines.map((line) => ("text" in line ? line.text : "")).join("\n")
    expect(text).toContain(finding.path)
    expect(text).not.toContain(secret)
    expect(
      lines
        .filter((line) => "text" in line && line.text.includes(finding.path))
        .every((line) => "wrap" in line && line.wrap),
    ).toBe(true)
  })
})

test("live progress renders workflow children and settlement without closing or cancelling work", () => {
  let active = true
  const view = progressView(() =>
    active
      ? {
          id: "review-id",
          origin: "main",
          phase: "reviewing",
          children: { "change group 1": "working", "correctness/security": "done" },
        }
      : undefined,
  )
  const rows = view.render!({}, { width: 80 } as never)
  expect(JSON.stringify(rows)).toContain("change group 1: working")
  expect(JSON.stringify(rows)).toContain("/code-review stop")
  expect(view.keys).toBeUndefined()
  expect(view.onClose).toBeUndefined() // Native Escape only closes the read-only view.
  active = false
  expect(JSON.stringify(view.render!({}, { width: 80 } as never))).toContain("Review settled")
})
