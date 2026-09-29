import type { CommandContext } from "@amira/api"
import { clipDiff, Git, type Run } from "./git.ts"
import { askModel } from "./model.ts"
import { branchChanges, parseBranchArgs } from "./pr.ts"
import type { ShareSettings } from "./settings.ts"

export type Severity = "high" | "medium" | "low"

export interface Finding {
  severity: Severity
  file: string
  line?: number
  title: string
  detail: string
}

export interface Review {
  summary: string
  findings: Finding[]
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences: what the change does and how it holds up",
    },
    findings: {
      type: "array",
      description: "Real problems only, most severe first; empty when there are none",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          file: { type: "string", description: "Path relative to the repository root" },
          line: { type: "integer", description: "Line in the new version of the file, when there is one" },
          title: { type: "string", description: "The problem in one line" },
          detail: {
            type: "string",
            description:
              "Why it is wrong and a concrete input or sequence that triggers it; a fix when it is clear",
          },
        },
        required: ["severity", "file", "title", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
}

/** Tools the reviewer may use: reading and read-only shell commands (the prompt keeps it to those). */
export const REVIEW_TOOLS = ["read", "grep", "glob", "bash", "powershell"]

/**
 * /review [base]: a reviewer sub-agent reads the branch's diff against its base (or, when the
 * branch has no commits of its own, the uncommitted changes), may look at the code around it,
 * and hands back findings, which are printed most severe first.
 */
export async function runReview(
  args: string,
  ctx: CommandContext,
  deps: { run: Run; settings: ShareSettings; agentModels?: Record<string, { model?: string }> },
): Promise<void> {
  const opts = parseBranchArgs(args)
  if (opts.draft || opts.yes) throw new Error("usage: /review [base]")
  const git = new Git(deps.run, ctx.cwd, ctx.signal)
  const root = await git.root()
  if (!root) throw new Error("not inside a git repository")
  const base = await git.base(opts.base ?? deps.settings.base)
  const changes = await branchChanges(git, base)
  let what = `the changes on ${changes.branch} since it left ${base} (merge base ${changes.mergeBase.slice(0, 12)})`
  let diff = changes.diff
  let stat = changes.stat
  let how = `git diff ${changes.mergeBase.slice(0, 12)} HEAD`
  if (!diff.trim()) {
    diff = await git.out(["diff", "--no-color", "--no-ext-diff", "HEAD"])
    stat = await git.out(["diff", "--stat", "--no-color", "HEAD"])
    what = `the uncommitted changes on ${changes.branch} (it has no commits of its own since ${base})`
    how = "git diff HEAD"
  }
  if (!diff.trim()) {
    ctx.print(
      `Nothing to review: ${changes.branch} does not differ from ${base} and has no uncommitted changes.`,
    )
    return
  }
  const clipped = clipDiff(diff, deps.settings.maxDiffChars)
  const files = stat.split("\n").length - 1
  ctx.print(`Reviewing ${what}: ${files} file${files === 1 ? "" : "s"}. The reviewer runs as a sub-agent…`)
  const model = deps.settings.reviewModel ?? deps.agentModels?.reviewer?.model
  const answer = await askModel<Review>(ctx, {
    name: "review",
    title: `Review ${changes.branch}`,
    role: "reviewer",
    systemPrompt: reviewInstructions(),
    prompt: [
      `Review ${what}.`,
      changes.commits.trim() && how !== "git diff HEAD" ? `\nCommits:\n${changes.commits}` : "",
      `\nChanged files:\n${stat}`,
      `\nThe diff (${how}${clipped.clipped ? "; cut, run it yourself for the rest" : ""}):\n${clipped.text}`,
    ]
      .filter(Boolean)
      .join("\n"),
    schema: REVIEW_SCHEMA,
    tools: REVIEW_TOOLS,
    ...(model ? { model } : {}),
  })
  if (!answer.ok) throw new Error(`the review did not finish: ${answer.error}`)
  ctx.print(formatReview(answer.value, `${changes.branch} vs ${base}`))
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export function formatReview(r: Review, subject: string): string {
  const findings = [...(Array.isArray(r.findings) ? r.findings : [])].sort(
    (a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3),
  )
  const head =
    findings.length === 0
      ? `Review of ${subject}: no findings.`
      : `Review of ${subject}: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${counts(findings)}).`
  const lines = [head]
  if (r.summary?.trim()) lines.push("", r.summary.trim())
  findings.forEach((f, i) => {
    const where = f.line ? `${f.file}:${f.line}` : f.file
    lines.push("", `${i + 1}. [${f.severity}] ${where}: ${f.title.trim()}`)
    for (const l of f.detail.trim().split(/\r?\n/)) lines.push(l ? `   ${l}` : "")
  })
  return lines.join("\n")
}

function counts(findings: Finding[]): string {
  return (["high", "medium", "low"] as const)
    .map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ")
}

export function reviewInstructions(): string {
  return [
    "You are a code reviewer. Review the change you are given for real defects: bugs, unhandled edge cases, broken contracts between callers and callees, race conditions, security problems, missing error handling, and tests that do not test what they claim.",
    "Read the code around the change when the diff alone does not settle a question. Change nothing: no edits, and only shell commands that read (git diff, git show, git log, listing and printing files).",
    "Report only problems you can back with a concrete input or sequence of events that goes wrong. Leave out style, naming and taste. Say so when you find nothing; an empty list is a fine answer.",
    "Hand the review back with return_result.",
  ].join("\n")
}
