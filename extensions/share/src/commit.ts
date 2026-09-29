import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext } from "@amira/api"
import { clipDiff, Git, type Run } from "./git.ts"
import { askModel } from "./model.ts"
import type { ShareSettings } from "./settings.ts"

export interface CommitMessage {
  subject: string
  body?: string
}

export const COMMIT_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description: "The subject line: imperative, at most 72 characters, no period",
    },
    body: {
      type: "string",
      description:
        "Optional body: why the change was made and anything notable, wrapped at 72 columns; empty when the subject says it all",
    },
  },
  required: ["subject"],
  additionalProperties: false,
}

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?: /

/** Whether most recent subjects follow Conventional Commits. */
export function usesConventional(subjects: string[]): boolean {
  if (subjects.length < 3) return false
  return subjects.filter((s) => CONVENTIONAL.test(s)).length * 2 > subjects.length
}

/** Subject and body as git wants them: trimmed, one blank line between, a newline at the end. */
export function formatMessage(m: CommitMessage): string {
  const subject = m.subject.replace(/\s+/g, " ").trim()
  const body = (m.body ?? "").replace(/\r\n?/g, "\n").trim()
  return body ? `${subject}\n\n${body}\n` : `${subject}\n`
}

/** A model's answer, cleaned of what models tend to add (fences, quotes, a "Subject:" label). */
export function cleanMessage(m: CommitMessage): CommitMessage {
  const strip = (s: string) =>
    s
      .replace(/^```\w*\n?|\n?```$/g, "")
      .replace(/^(subject|title)\s*:\s*/i, "")
      .trim()
  let subject = strip(m.subject).replace(/^["'`]+|["'`]+$/g, "")
  let body = strip(m.body ?? "")
  // A subject of several lines: the rest belongs to the body.
  const nl = subject.indexOf("\n")
  if (nl >= 0) {
    body = `${subject.slice(nl + 1).trim()}${body ? `\n\n${body}` : ""}`
    subject = subject.slice(0, nl).trim()
  }
  return { subject: subject.replace(/\.$/, ""), ...(body ? { body } : {}) }
}

export interface CommitArgs {
  yes: boolean
  hint: string
}

export function parseCommitArgs(args: string): CommitArgs {
  const words = args.split(/\s+/).filter(Boolean)
  const yes = words.some((w) => w === "--yes" || w === "-y")
  return { yes, hint: words.filter((w) => w !== "--yes" && w !== "-y").join(" ") }
}

/**
 * /commit: proposes a message for what is staged, lets the user take, edit or drop it, and
 * commits with plain `git commit`, so the user's hooks and signing apply as always.
 */
export async function runCommit(
  args: string,
  ctx: CommandContext,
  deps: { run: Run; settings: ShareSettings },
): Promise<void> {
  const { yes, hint } = parseCommitArgs(args)
  const git = new Git(deps.run, ctx.cwd, ctx.signal)
  const root = await git.root()
  if (!root) throw new Error("not inside a git repository")
  const stat = await git.out(["diff", "--cached", "--stat", "--no-color"])
  if (!stat.trim()) {
    ctx.print(
      "Nothing is staged. Stage what belongs in the commit with git add, then run /commit again.",
      "warning",
    )
    return
  }
  const diff = await git.out(["diff", "--cached", "--no-color", "--no-ext-diff"])
  const log = await git.exec(["log", "-n", "15", "--format=%s"], { stdoutOnly: true })
  const subjects = log.ok ? log.output.split(/\r?\n/).filter(Boolean) : []
  const conventional =
    deps.settings.conventional === "auto" ? usesConventional(subjects) : deps.settings.conventional
  const branch = await git.branch()
  const clipped = clipDiff(diff, deps.settings.maxDiffChars)

  ctx.print(`Drafting a commit message for ${countFiles(stat)} staged…`)
  const answer = await askModel<CommitMessage>(ctx, {
    name: "commit message",
    title: "Commit message",
    systemPrompt: commitInstructions(conventional),
    prompt: [
      hint ? `The user says about this change: ${hint}\n` : "",
      branch ? `Branch: ${branch}` : "",
      subjects.length
        ? `Recent commit subjects, for the style:\n${subjects.map((s) => `- ${s}`).join("\n")}\n`
        : "",
      `Staged changes (git diff --cached --stat):\n${stat}\n`,
      `The staged diff:\n${clipped.text}`,
    ]
      .filter(Boolean)
      .join("\n"),
    schema: COMMIT_SCHEMA,
    ...(deps.settings.model ? { model: deps.settings.model } : {}),
  })
  if (!answer.ok) throw new Error(`no commit message: ${answer.error}`)
  let message = cleanMessage(answer.value)
  if (!message.subject) throw new Error("the model proposed an empty subject")

  ctx.print(`Proposed commit message:\n\n${indent(formatMessage(message))}`)
  if (!yes) {
    const choice = await ctx.ui.select("Commit with this message?", ["Commit", "Edit message", "Cancel"], {
      signal: ctx.signal,
    })
    if (choice === undefined) {
      ctx.print(
        "Not committed: nobody could confirm. /commit --yes commits with the proposed message.",
        "warning",
      )
      return
    }
    if (choice === "Cancel") {
      ctx.print("Not committed.")
      return
    }
    if (choice === "Edit message") {
      const edited = await editMessage(ctx, message)
      if (!edited) {
        ctx.print("Not committed.")
        return
      }
      message = edited
    }
  }

  // What is staged may have changed while the user read the proposal.
  const now = await git.out(["diff", "--cached", "--no-color", "--no-ext-diff"])
  if (now !== diff) {
    ctx.print(
      `The staged changes changed since the message was drafted; not committed. Run /commit again.\nThe message was:\n\n${indent(formatMessage(message))}`,
      "warning",
    )
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), "amira-commit-"))
  const file = path.join(dir, "COMMIT_MSG")
  try {
    writeFileSync(file, formatMessage(message))
    // No --no-verify and no signing flags: the user's hooks and commit.gpgsign apply.
    const r = await git.exec(["commit", "--file", file], { timeoutMs: 10 * 60_000 })
    if (!r.ok) {
      const why = r.timedOut ? "it took longer than 10 minutes" : tail(r.output)
      ctx.print(
        `git commit failed:\n${why}\n\nThe message was:\n\n${indent(formatMessage(message))}`,
        "error",
      )
      return
    }
    const made = await git.exec(["log", "-1", "--format=%h %s"], { stdoutOnly: true })
    ctx.print(`Committed ${made.ok ? made.output : message.subject}.`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function editMessage(ctx: CommandContext, m: CommitMessage): Promise<CommitMessage | undefined> {
  const values = await ctx.ui.form(
    {
      title: "Commit message",
      fields: [
        { id: "subject", type: "text", label: "Subject", default: m.subject, required: true, maxLength: 200 },
        { id: "body", type: "textarea", label: "Body", default: m.body ?? "", rows: 10 },
      ],
      submitLabel: "Commit",
    },
    { signal: ctx.signal },
  )
  if (!values) return undefined
  const subject = String(values.subject ?? "").trim()
  if (!subject) return undefined
  const body = String(values.body ?? "").trim()
  return { subject, ...(body ? { body } : {}) }
}

export function commitInstructions(conventional: boolean): string {
  return [
    "You write git commit messages. Read the staged diff and describe the change as a whole.",
    "Subject: imperative mood, at most 72 characters, no trailing period.",
    conventional
      ? 'Use Conventional Commits for the subject: "type(scope): summary", with type one of feat, fix, docs, style, refactor, perf, test, build, ci, chore; the scope is optional.'
      : "Follow the style of the recent subjects you are shown; do not add a type prefix unless they use one.",
    "Body: leave it empty for a small, obvious change. Otherwise explain what changed and why in a few short lines or bullets, wrapped at 72 columns. Do not list every file.",
    "Never add trailers (Signed-off-by, Co-Authored-By), issue numbers you were not given, or Markdown headings.",
    "Hand the message back with return_result.",
  ].join("\n")
}

function countFiles(stat: string): string {
  const m = /(\d+) files? changed/.exec(stat)
  const n = m ? Number(m[1]) : 1
  return `${n} file${n === 1 ? "" : "s"}`
}

export function indent(text: string): string {
  return text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l ? `    ${l}` : ""))
    .join("\n")
}

/** The last lines of git's output, where the reason usually is. */
export function tail(output: string, lines = 30): string {
  const all = output.split(/\r?\n/)
  return (all.length > lines ? ["…", ...all.slice(-lines)] : all).join("\n")
}
