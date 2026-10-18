import type { CommandContext, SelectSection, ViewDefinition, ViewLine } from "@amira/api"
import { type Bundle, reviewCaps } from "./collect.ts"
import { DEEP_PARALLEL, groupChanges } from "./deep.ts"
import type { Finding } from "./findings.ts"
import { modelScope, redact } from "./privacy.ts"
import type { Progress } from "./run.ts"
import type { Report, ReviewSettings } from "./store.ts"

const VIEW = "review-detail"
const STATIC =
  "Supported means independently assessed from static evidence, not reproduced or tested. A clean report is not an acceptance gate."
const PRIVACY =
  "Secret detection is best effort. Submitted code and guidance may persist in provider/host transcripts and tool artifacts; pruning reports does not delete those histories."
const safe = (value: unknown) => redact(String(value)).replace(/\r\n?/g, "\n")
const inline = (value: unknown) => safe(value).replaceAll("\n", " ")
const md = (value: unknown) => safe(value).replace(/[\\`*_{}[\]<>#+!|]/g, "\\$&")
const json = (value: unknown) =>
  value === undefined || value === null ? "Unknown / not reported" : JSON.stringify(value, null, 2)
const list = (values: string[]) =>
  values.length ? values.map((value) => `- ${md(value)}`).join("\n") : "- None"

function scopeText(scope: Report["scope"], base: string): string {
  return `${scope.kind === "worktree" ? "Worktree (net HEAD to working tree)" : scope.kind === "pr" ? `GitHub PR ${scope.ref}` : "Committed changes since an explicit ancestor"}; ${JSON.stringify(modelScope(scope, base))}`
}

export function consentSummary(
  bundle: Bundle,
  settings: ReviewSettings,
  guidance: string[],
  promptBytes?: number,
): string {
  const admitted = bundle.changes.filter((change) => change.untracked).length
  const scope = modelScope(bundle.scope, bundle.base)
  return [
    `Scope: ${scope.kind}${scope.base ? `; resolved base: ${scope.base}` : ""}; literal filters: ${scope.paths.join(", ") || "repository"}.`,
    `Reviewer: ${settings.reviewerModel}; assessor: ${settings.verifierModel}.`,
    `Plan: ${reviewerPlan(bundle)}${settings.verify ? " + at most 1 independent assessor" : "; assessment disabled"}.`,
    `Selected: ${bundle.changes.length} files; +${bundle.added}/-${bundle.removed} lines; ${Buffer.byteLength(bundle.patch)} sanitized patch bytes.`,
    `Prepared reviewer prompts: ${promptBytes ?? "unknown"} bytes before host schema/envelope; source reads add exposure.`,
    `Untracked admitted: ${admitted} (${bundle.scope.includeUntracked ? "explicitly enabled" : "off"}); excluded: ${bundle.excluded.length}.`,
    `Included: ${
      bundle.changes
        .slice(0, 4)
        .map((change) => change.path)
        .join(", ") || "none"
    }${bundle.changes.length > 4 ? "; see full manifest for remaining paths" : ""}.`,
    `Guidance: ${guidance.join(", ") || "none"}.`,
    `Budget: ${bundle.scope.deep ? DEEP_PARALLEL : settings.maxParallel} parallel; ${settings.maxTokens} group tokens; USD ${settings.maxCostUsd} reported cost; 10 minutes.`,
    `Caps: ${reviewCaps(bundle.scope).files} files / ${reviewCaps(bundle.scope).lines.toLocaleString("en-US")} lines / ${reviewCaps(bundle.scope).patchBytes / 1024} KiB patch; 16 KiB guidance; source snapshots: 16 files / 256 KiB.`,
    bundle.scope.kind === "pr"
      ? "PR diff only: no remote full-source snapshots or local checkout context; secrets outside the diff cannot be inspected."
      : "Privacy collection requires complete old/new sources: 64 KiB each / 256 KiB total, or stops.",
    "Private reads/search only: no shell, tests, network, writes or delegation in children.",
    "Static assessment is not reproduction. Narrowed scope can miss cross-scope defects.",
    "Secret detection is best effort. Host/provider transcripts persist independently of reports.",
    "Consent exposes this scope to these models; it does not grant shell permissions or reserve spend.",
    "Complete included/excluded/redacted path manifest is printed above; cancel to inspect it before continuing.",
  ]
    .map(inline)
    .join("\n")
}

/** Consent manifest only: does not collect, spawn, send to main, or open a view. */
export function preflight(
  bundle: Bundle,
  settings: ReviewSettings,
  guidance: string[],
  exposure?: { promptBytes: number; redacted: string[] },
): string {
  const { added, removed } = bundle
  const redacted = [
    ...new Set([
      ...bundle.changes.filter((change) => change.patch.includes("[REDACTED]")).map((change) => change.path),
      ...(exposure?.redacted ?? []),
    ]),
  ]
  return [
    "# Code review exposure preview",
    `Scope: ${md(scopeText(bundle.scope, bundle.base))}`,
    `Repository: ${md(bundle.root)}`,
    `Base: ${md(bundle.base)}; HEAD: ${md(bundle.head)}`,
    `Selected files: ${bundle.changes.length}; added lines: ${added}; removed lines: ${removed}; sanitized patch bytes: ${Buffer.byteLength(bundle.patch, "utf8")}. These are not exact model token or price estimates.`,
    `Prepared reviewer prompt bytes (both tasks and fixed role, excluding host schema/envelope): ${exposure?.promptBytes ?? "not reported"}. Assessor candidates and bounded source reads add exposure; bytes are not exact tokens or prices.`,
    "## Included paths",
    list(bundle.changes.map((change) => change.path)),
    "## Explicitly admitted untracked paths",
    list(bundle.changes.filter((change) => change.untracked).map((change) => change.path)),
    "Untracked files not explicitly admitted are outside this review and its context reads.",
    "## Excluded paths",
    bundle.excluded.length
      ? list(bundle.excluded.map((entry) => `${entry.path}: ${entry.reason}`))
      : "- None",
    "## Redacted patch paths",
    list(redacted),
    "## Guidance paths",
    list(guidance),
    `Reviewer model: ${md(settings.reviewerModel)}; verifier model: ${md(settings.verifierModel)}.`,
    `Planned agents: ${reviewerPlan(bundle)}${settings.verify ? " + at most 1 independent assessor when findings exist" : "; independent assessment disabled (findings remain unchecked)"}.`,
    `Run caps: ${bundle.scope.deep ? DEEP_PARALLEL : settings.maxParallel} parallel children; ${settings.maxTokens} group tokens; USD ${settings.maxCostUsd} reported-cost budget; 10-minute deadline. Budgets are observed, not reservations: in-flight work can overrun and unknown pricing is not zero.`,
    `Admission caps: ${reviewCaps(bundle.scope).files} changed files; ${reviewCaps(bundle.scope).lines.toLocaleString("en-US")} added + removed lines; ${reviewCaps(bundle.scope).patchBytes / 1024} KiB combined complete patch / 32 KiB per file; 16 KiB guidance; 10,000 context paths / 1 MiB inventory; 16 extra source files / 64 KiB each / 256 KiB total; 24 bounded read/search calls per child (200 lines / 8 KiB per response).`,
    bundle.scope.kind === "pr"
      ? "PR diff only: remote full-source snapshots and guidance are unavailable. Local files are not PR context; secrets outside the diff cannot be inspected."
      : "Complete old/new privacy sources: 64 KiB each / 256 KiB total. Missing, oversized or mismatched source refuses the run before spawning; PEM spans are sanitized before projection onto hunks.",
    "Reviewers can use only bounded private review_read and literal review_search over approved scope, plus return_result. No shell, network, tests, delegation or writes.",
    STATIC,
    PRIVACY,
    "Only the listed scope is reviewed; filtering or excluded content can hide cross-file interactions. Read-only Git may still require separate permission approval. Confirming exposure does not grant those permissions.",
  ].join("\n\n")
}

type DetailBlock = { heading: string; text: string }
function blocks(finding: Finding, report: Report): DetailBlock[] {
  return [
    {
      heading: `${finding.id}: ${finding.summary}`,
      text: `${finding.severity} · ${finding.category} · ${finding.assessment}${finding.ignored ? " · ignored" : ""}\n${finding.path}:${finding.startLine}-${finding.endLine} (${finding.side} side)`,
    },
    {
      heading: "Report context",
      text: `Review ${report.id} · ${report.state}${report.stale ? " · STALE: refresh the review before hand-off" : ""}\nRepository: ${report.root}\nScope: ${scopeText(report.scope, report.base)}\nBase: ${report.base}\nHEAD: ${report.head}\nStarted: ${report.startedAt}\nEnded: ${report.endedAt ?? "Not recorded"}`,
    },
    { heading: "Failure scenario", text: finding.scenario },
    {
      heading: "Evidence",
      text: finding.evidence.length
        ? finding.evidence.map((e) => `${e.path}:${e.line} (${e.side} side): ${e.reason}`).join("\n")
        : "No evidence recorded.",
    },
    { heading: "Suggested direction", text: finding.suggestedFix },
    { heading: "Documented rule", text: finding.rule ?? "No rule citation recorded." },
    {
      heading: "Independent assessment",
      text: `${finding.assessment}: ${finding.rationale ?? "No independent rationale recorded."}\n${STATIC}`,
    },
    {
      heading: "Sources and duplicates",
      text: `Sources: ${finding.sources.join(", ")}\nDuplicate of: ${finding.duplicateOf ?? "None"}\nIgnored in this report: ${finding.ignored ? "yes" : "no"}`,
    },
    { heading: "Saved context excerpt", text: finding.excerpt ?? "No saved context excerpt." },
  ]
}

export function details(finding: Finding, report: Report): string {
  return blocks(finding, report)
    .map((block) => `## ${md(block.heading)}\n\n${md(block.text)}`)
    .join("\n\n")
}

/** Full export, including ignored/refuted findings, scope, provenance and incomplete coverage. */
export function markdown(report: Report): string {
  const counts = ["supported", "uncertain", "unchecked", "refuted"]
    .map((assessment) => `${report.findings.filter((f) => f.assessment === assessment).length} ${assessment}`)
    .join(", ")
  return [
    `# Code review ${md(report.id)}`,
    `State: ${md(report.state)}; stale: ${report.stale ? "yes — refresh before hand-off" : "no"}. ${report.state !== "completed" ? "Coverage is incomplete; this is not a successful clean review." : ""}`,
    `Findings: ${report.findings.length} (${counts}); ${report.findings.filter((f) => f.ignored).length} ignored.`,
    STATIC,
    "## Scope and identity",
    `Schema version: ${report.schemaVersion}\n\nRepository: ${md(report.root)}\n\nRepository key: ${md(report.repoKey)}\n\nOrigin session: ${md(report.originSessionId)}\n\nOwner: ${md(report.ownerId)}\n\nScope: ${md(scopeText(report.scope, report.base))}\n\nBase: ${md(report.base)}\n\nHEAD: ${md(report.head)}\n\nFingerprint: ${md(report.fingerprint)}\n\nStarted: ${md(report.startedAt)}\n\nEnded: ${md(report.endedAt ?? "Not recorded")}`,
    "## Included paths",
    list(report.included),
    "## Explicitly admitted untracked paths",
    list(report.untracked.filter((path) => report.included.includes(path))),
    "## Observed untracked paths",
    list(report.untracked),
    "## Excluded paths",
    list(report.excluded.map((entry) => `${entry.path}: ${entry.reason}`)),
    "## Redacted paths",
    list(report.redacted),
    "## Guidance paths",
    list(report.guidance),
    "## Settings",
    md(json(report.settings)),
    "## Reported usage",
    md(json(report.usage)),
    "Usage is the host-reported group value (not added again to child totals). Missing usage/pricing is unknown, not zero; partial runs may have incomplete accounting.",
    "## Child states",
    md(json(report.childStates)),
    "## Prompt hashes",
    md(json(report.promptHashes)),
    "## Source snapshot hashes (not source content)",
    md(json(report.snapshotHashes)),
    "## Limitations",
    list(report.limitations),
    "## Findings",
    report.findings.length
      ? report.findings.map((finding) => details(finding, report)).join("\n\n---\n\n")
      : "No findings recorded. This does not establish complete coverage or the absence of defects.",
    "## Privacy and reopening",
    PRIVACY,
    "Reopen saved findings with /code-review last. A hand-off to main requires an explicit single-finding action and confirmation; it starts a model turn, not an automatic fix.",
  ].join("\n\n")
}

export function detailView(): ViewDefinition<{ finding: Finding; report: Report }> {
  return {
    kind: VIEW,
    follow: false,
    title: ({ finding }) => `Code review ${inline(finding.id)}`,
    render: ({ finding, report }): ViewLine[] =>
      blocks(finding, report).flatMap((block) => [
        { kind: "accent", text: inline(block.heading), wrap: true },
        ...safe(block.text)
          .split("\n")
          .map((text): ViewLine => ({ kind: "text", text, wrap: true })),
        { kind: "text", text: "" },
      ]),
  }
}

export async function browse(
  report: Report,
  ctx: CommandContext,
  actions: { ignore: (id: string) => Promise<void>; fix: (id: string) => Promise<void> },
): Promise<void> {
  if (ctx.frontend === "print") {
    ctx.print(markdown(report))
    return
  }
  let showRefuted = false
  while (!ctx.signal.aborted) {
    const options: string[] = []
    const sections: SelectSection[] = []
    const byLabel = new Map<string, Finding>()
    const groups = [
      ["Supported", report.findings.filter((f) => !f.ignored && f.assessment === "supported")],
      [
        "Uncertain / unchecked",
        report.findings.filter(
          (f) => !f.ignored && (f.assessment === "uncertain" || f.assessment === "unchecked"),
        ),
      ],
      ["Ignored", report.findings.filter((f) => f.ignored && f.assessment !== "refuted")],
      ["Refuted", showRefuted ? report.findings.filter((f) => f.assessment === "refuted") : []],
    ] as const
    for (const [title, findings] of groups) {
      if (!findings.length) continue
      sections.push({
        at: options.length,
        title,
        choose: "actions",
        keys: [
          { key: "d", label: "details" },
          { key: "p", label: "print finding" },
          { key: "i", label: "ignore/unignore" },
          { key: "f", label: "hand off to main" },
        ],
      })
      for (const finding of findings) {
        const label = inline(
          `${finding.id} [${finding.severity}] ${finding.assessment}${finding.ignored ? " ignored" : ""} ${finding.path}:${finding.startLine} (${finding.side}) — ${finding.summary}`,
        )
        options.push(label)
        byLabel.set(label, finding)
      }
    }
    sections.push({ at: options.length, title: "Report", choose: "choose" })
    const toggle = `${showRefuted ? "Hide" : "Show"} refuted findings (${report.findings.filter((f) => f.assessment === "refuted").length})`
    options.push("Print full report", toggle)
    const choice = await ctx.ui.choose(
      `Code review: ${report.state}${report.stale ? " · stale" : ""} · ${report.findings.length} findings`,
      options,
      { sections, signal: ctx.signal },
    )
    if (!choice || ctx.signal.aborted) return
    if (choice.option === "Print full report") {
      ctx.print(markdown(report))
      continue
    }
    if (choice.option === toggle) {
      showRefuted = !showRefuted
      continue
    }
    const finding = byLabel.get(choice.option)
    if (!finding) return
    let action: string | undefined = (
      {
        d: "Show details",
        p: "Print finding",
        i: finding.ignored ? "Unignore finding" : "Ignore finding",
        f: "Hand off to main",
      } as Record<string, string>
    )[choice.key ?? ""]
    if (!action) {
      const picked = await ctx.ui.choose(
        `Actions for ${inline(finding.id)}`,
        [
          "Show details",
          "Print finding",
          "Print full report",
          finding.ignored ? "Unignore finding" : "Ignore finding",
          "Hand off to main",
        ],
        { sections: [{ at: 0, title: "Finding actions" }], signal: ctx.signal },
      )
      action = picked?.option
    }
    if (!action || ctx.signal.aborted) continue
    if (action === "Show details") {
      if (!ctx.openView?.({ kind: VIEW, data: { finding, report } })) ctx.print(details(finding, report))
      else return // Opening is explicit; do not immediately overlay the new view with another picker.
    } else if (action === "Print finding") ctx.print(details(finding, report))
    else if (action === "Print full report") ctx.print(markdown(report))
    else if (action === "Ignore finding" || action === "Unignore finding") {
      const previous = finding.ignored
      try {
        await actions.ignore(finding.id)
      } catch (error) {
        finding.ignored = previous
        throw error
      }
      // Callers can persist using a cloned report. Update the local browser only after success.
      finding.ignored = !previous
    } else if (action === "Hand off to main") await actions.fix(finding.id)
  }
}

function reviewerPlan(bundle: Bundle): string {
  return bundle.scope.deep
    ? `${groupChanges(bundle).length} group reviewers + 2 full-bundle lenses via workflow.runner`
    : "2 fresh reviewers"
}

/** Host-scrolled live progress. Closing the view never changes execution. */
export function progressView(snapshot: () => Progress | undefined): ViewDefinition {
  return {
    kind: "review-progress",
    follow: false,
    title: () => "Code review progress",
    render: () => {
      const progress = snapshot()
      if (!progress)
        return [
          { kind: "text", text: "Review settled. Open /code-review last for saved findings.", wrap: true },
        ]
      return [
        { kind: "accent", text: `${inline(progress.id.slice(0, 8))}: ${inline(progress.phase)}`, wrap: true },
        ...Object.entries(progress.children).map(
          ([label, state]): ViewLine => ({
            kind: "text",
            text: `${inline(label)}: ${inline(state)}`,
            wrap: true,
          }),
        ),
        {
          kind: "text",
          text: "Closing this view leaves the review running. Use /code-review stop to cancel and drain.",
          wrap: true,
        },
      ]
    },
  }
}
