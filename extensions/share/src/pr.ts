import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext } from "@amira/api"
import { indent, tail } from "./commit.ts"
import { clipDiff, Git, type Run } from "./git.ts"
import { askModel } from "./model.ts"
import type { ShareSettings } from "./settings.ts"

export interface PrDraft {
  title: string
  body: string
}

export const PR_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The PR title: at most 72 characters" },
    body: { type: "string", description: "The PR description in GitHub Markdown" },
  },
  required: ["title", "body"],
  additionalProperties: false,
}

export interface BranchArgs {
  base?: string
  yes: boolean
  draft: boolean
}

/** `[base] [--draft] [--yes]` in any order. */
export function parseBranchArgs(args: string): BranchArgs {
  const out: BranchArgs = { yes: false, draft: false }
  for (const w of args.split(/\s+/).filter(Boolean)) {
    if (w === "--yes" || w === "-y") out.yes = true
    else if (w === "--draft") out.draft = true
    else if (w.startsWith("-")) throw new Error(`unknown option ${w}`)
    else if (out.base === undefined) out.base = w
    else throw new Error(`one base branch only, got "${out.base}" and "${w}"`)
  }
  return out
}

/** What the branch changed since it left `base`. */
export interface BranchChanges {
  branch: string
  base: string
  mergeBase: string
  commits: string
  stat: string
  diff: string
}

export async function branchChanges(git: Git, base: string): Promise<BranchChanges> {
  const branch = await git.branch()
  if (!branch) throw new Error("HEAD is detached; check out a branch first")
  const mergeBase = await git.out(["merge-base", "HEAD", base])
  const commits = await git.out([
    "log",
    "--no-merges",
    "--reverse",
    "--format=- %h %s%n%w(0,2,2)%b",
    `${mergeBase}..HEAD`,
  ])
  const stat = await git.out(["diff", "--stat", "--no-color", mergeBase, "HEAD"])
  const diff = await git.out(["diff", "--no-color", "--no-ext-diff", mergeBase, "HEAD"])
  return { branch, base, mergeBase, commits: commits.replace(/\n{3,}/g, "\n\n"), stat, diff }
}

const TEMPLATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
]

function readTemplate(root: string): string | undefined {
  for (const t of TEMPLATES) {
    const file = path.join(root, t)
    if (!existsSync(file)) continue
    try {
      return readFileSync(file, "utf8").slice(0, 8000)
    } catch {}
  }
  return undefined
}

/**
 * /pr: drafts a title and description from the branch's commits and diff against its base,
 * and, where `gh` is installed, creates the pull request once the user agrees (pushing the
 * branch first when it has no upstream or is ahead of it). Without gh it prints the text.
 */
export async function runPr(
  args: string,
  ctx: CommandContext,
  deps: { run: Run; settings: ShareSettings },
): Promise<void> {
  const opts = parseBranchArgs(args)
  const git = new Git(deps.run, ctx.cwd, ctx.signal)
  const root = await git.root()
  if (!root) throw new Error("not inside a git repository")
  const base = await git.base(opts.base ?? deps.settings.base)
  const changes = await branchChanges(git, base)
  const baseName = await git.branchName(base)
  if (changes.branch === baseName || changes.branch === base)
    throw new Error(`you are on ${changes.branch}, the base branch; check out the branch to open a PR for`)
  if (!changes.commits.trim()) {
    ctx.print(
      `${changes.branch} has no commits that ${base} does not have; nothing to open a PR for.`,
      "warning",
    )
    return
  }
  const template = readTemplate(root)
  const clipped = clipDiff(changes.diff, deps.settings.maxDiffChars)
  ctx.print(`Drafting a pull request for ${changes.branch} → ${baseName}…`)
  const answer = await askModel<PrDraft>(ctx, {
    name: "pr draft",
    title: "PR description",
    systemPrompt: prInstructions(),
    prompt: [
      `Branch ${changes.branch}, to be merged into ${baseName}.`,
      `\nCommits:\n${changes.commits}`,
      template ? `\nThe repository's pull request template; follow its sections:\n${template}` : "",
      `\nChanged files (git diff --stat):\n${changes.stat}`,
      `\nThe diff:\n${clipped.text}`,
    ]
      .filter(Boolean)
      .join("\n"),
    schema: PR_SCHEMA,
    ...(deps.settings.model ? { model: deps.settings.model } : {}),
  })
  if (!answer.ok) throw new Error(`no PR draft: ${answer.error}`)
  let draft: PrDraft = {
    title: answer.value.title.replace(/\s+/g, " ").trim(),
    body: answer.value.body.replace(/\r\n?/g, "\n").trim(),
  }
  if (!draft.title) throw new Error("the model proposed an empty title")
  ctx.print(`Pull request draft (${changes.branch} → ${baseName}):\n\n${showDraft(draft)}`)

  const gh = await deps.run(["gh", "--version"], { cwd: root, signal: ctx.signal, timeoutMs: 20_000 })
  if (!gh.ok) {
    ctx.print(
      "gh (GitHub CLI) is not installed, so the PR was not created; the text above is ready to paste.",
    )
    return
  }
  const push = await pushState(git, changes.branch)
  const create = opts.draft ? "Create draft PR" : "Create PR"
  const go = push.needed ? `Push and ${create.charAt(0).toLowerCase()}${create.slice(1)}` : create
  if (!opts.yes) {
    const pushNote = push.needed ? ` (${push.why}; it will be pushed to ${push.remote})` : ""
    const choice = await ctx.ui.select(
      `Open this pull request on GitHub${pushNote}?`,
      [go, "Edit…", "Cancel"],
      {
        signal: ctx.signal,
      },
    )
    if (choice === undefined) {
      ctx.print("Not created: nobody could confirm. /pr --yes creates it.", "warning")
      return
    }
    if (choice === "Cancel") {
      ctx.print("Not created.")
      return
    }
    if (choice === "Edit…") {
      const edited = await editDraft(ctx, draft, go)
      if (!edited) {
        ctx.print("Not created.")
        return
      }
      draft = edited
    }
  }
  if (push.needed) {
    if (!push.remote)
      throw new Error("the branch has no upstream and the repository has no remote to push to")
    ctx.print(`Pushing ${changes.branch} to ${push.remote}…`)
    const pushed = await git.exec(["push", "--set-upstream", push.remote, changes.branch], {
      timeoutMs: 5 * 60_000,
    })
    if (!pushed.ok) {
      ctx.print(`git push failed:\n${tail(pushed.output)}`, "error")
      return
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "amira-pr-"))
  const file = path.join(dir, "BODY.md")
  try {
    writeFileSync(file, `${draft.body}\n`)
    const argv = [
      "gh",
      "pr",
      "create",
      "--title",
      draft.title,
      "--body-file",
      file,
      "--base",
      baseName,
      "--head",
      changes.branch,
    ]
    if (opts.draft) argv.push("--draft")
    const r = await deps.run(argv, { cwd: root, signal: ctx.signal, timeoutMs: 2 * 60_000 })
    if (!r.ok) {
      ctx.print(`gh pr create failed:\n${tail(r.output)}`, "error")
      return
    }
    const url = /https?:\/\/\S+/.exec(r.output)?.[0]
    ctx.print(url ? `Created ${url}` : `Created the pull request.\n${tail(r.output, 5)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether the branch must be pushed before gh can open a PR for it, and where to. */
async function pushState(
  git: Git,
  branch: string,
): Promise<{ needed: boolean; why?: string; remote?: string }> {
  const upstream = await git.exec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    stdoutOnly: true,
  })
  const remotes = await git.remotes()
  const fallback = remotes.includes("origin") ? "origin" : remotes[0]
  if (!upstream.ok || !upstream.output) {
    return { needed: true, why: `${branch} has no upstream`, ...(fallback ? { remote: fallback } : {}) }
  }
  const remote = remotes.find((r) => upstream.output.startsWith(`${r}/`)) ?? fallback
  const ahead = await git.exec(["rev-list", "--count", "@{u}..HEAD"], { stdoutOnly: true })
  const n = ahead.ok ? Number(ahead.output) : 0
  if (n > 0)
    return {
      needed: true,
      why: `${n} commit${n === 1 ? " is" : "s are"} not pushed`,
      ...(remote ? { remote } : {}),
    }
  return { needed: false }
}

async function editDraft(ctx: CommandContext, d: PrDraft, submit: string): Promise<PrDraft | undefined> {
  const values = await ctx.ui.form(
    {
      title: "Pull request",
      fields: [
        { id: "title", type: "text", label: "Title", default: d.title, required: true, maxLength: 256 },
        { id: "body", type: "textarea", label: "Description", default: d.body, rows: 14 },
      ],
      submitLabel: submit,
    },
    { signal: ctx.signal },
  )
  if (!values) return undefined
  const title = String(values.title ?? "").trim()
  if (!title) return undefined
  return { title, body: String(values.body ?? "").trim() }
}

function showDraft(d: PrDraft): string {
  return `${indent(d.title)}\n\n${indent(d.body || "(no description)")}`
}

export function prInstructions(): string {
  return [
    "You write pull request titles and descriptions. Read the commits and the diff and describe the change as a whole, for a reviewer.",
    "Title: at most 72 characters, specific, no trailing period. Keep a Conventional Commits prefix only if the commits use one.",
    "Description in GitHub Markdown: a short summary of what changes and why, then the notable points as bullets (behaviour changes, risks, follow-ups). Mention how it was tested only if the commits or diff show it.",
    "When a pull request template is given, fill in its sections instead.",
    "Do not invent issue numbers, links or results you were not shown. No closing sign-off.",
    "Hand the draft back with return_result.",
  ].join("\n")
}
