import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ModelRequest } from "@amira/ai"
import type { Run } from "../src/git.ts"
import { cleanup, git, harness, repo, returns, who } from "./harness.ts"

setDefaultTimeout(20_000)
afterEach(cleanup)

const text = (req: ModelRequest) =>
  req.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("")).join("\n")

const commitReply = (req: ModelRequest) =>
  who(req) === "commit"
    ? returns({ subject: "feat: add b", body: "Adds b.txt so there is a second file." })
    : { text: "?" }

/** The error a promise rejects with, as text. (expect().rejects stalls runCommand's worker in bun.) */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return String(err)
  }
  return "(no error)"
}

function stage(cwd: string, file = "b.txt", content = "two\n") {
  writeFileSync(path.join(cwd, file), content)
  git(cwd, "add", file)
}

test("/commit proposes a message from the staged diff and commits it once accepted", async () => {
  const cwd = repo()
  stage(cwd)
  const h = await harness({ cwd, reply: commitReply, dialogs: { select: ["Commit"] } })
  const out = await h.run("/commit")
  expect(out).toContain("Proposed commit message:")
  expect(out).toContain("    feat: add b")
  expect(out).toMatch(/Committed [0-9a-f]+ feat: add b\./)
  expect(git(cwd, "log", "-1", "--format=%B")).toBe("feat: add b\n\nAdds b.txt so there is a second file.")
  // The model saw the staged diff and the repository's style.
  const req = h.mock.requests.find((r) => who(r) === "commit")!
  expect(text(req)).toContain("+two")
  expect(text(req)).toContain("- feat: first")
  expect(h.asked).toEqual([{ kind: "select", title: "Commit with this message?" }])
  // git ran through the API's runner, and plain `git commit` (no --no-verify, no signing flags).
  const commitCall = h.ranArgv.find((a) => a[1] === "commit")!
  expect(commitCall.slice(0, 3)).toEqual(["git", "commit", "--file"])
  expect(commitCall).toHaveLength(4)
})

test("/commit: Edit message opens a form with the proposal; the edited text is committed", async () => {
  const cwd = repo()
  stage(cwd)
  const h = await harness({
    cwd,
    reply: commitReply,
    dialogs: { select: ["Edit message"], form: [{ subject: "Add b by hand", body: "" }] },
  })
  await h.run("/commit")
  const form = h.asked.find((a) => a.kind === "form")!
  expect(form.spec!.fields.map((f) => [f.id, "default" in f ? f.default : undefined])).toEqual([
    ["subject", "feat: add b"],
    ["body", "Adds b.txt so there is a second file."],
  ])
  expect(git(cwd, "log", "-1", "--format=%B")).toBe("Add b by hand")
})

test("/commit: Cancel, a cancelled form, or nobody to ask leave the index alone", async () => {
  const cwd = repo()
  stage(cwd)
  for (const dialogs of [
    { select: ["Cancel"] },
    { select: ["Edit message"], form: [undefined] },
    { select: [undefined] },
  ]) {
    const h = await harness({ cwd, reply: commitReply, dialogs })
    const out = await h.run("/commit")
    expect(out).toMatch(/Not committed/)
  }
  expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1")
  expect(git(cwd, "diff", "--cached", "--name-only")).toBe("b.txt")
})

test("/commit --yes commits without asking (print mode); a hint reaches the model", async () => {
  const cwd = repo()
  stage(cwd)
  const h = await harness({ cwd, reply: commitReply, frontend: "print" })
  await h.run("/commit --yes second file for the demo")
  expect(h.asked).toEqual([])
  expect(git(cwd, "log", "-1", "--format=%s")).toBe("feat: add b")
  expect(text(h.mock.requests.find((r) => who(r) === "commit")!)).toContain("second file for the demo")
})

test("/commit with nothing staged says so and never asks the model", async () => {
  const cwd = repo()
  writeFileSync(path.join(cwd, "b.txt"), "unstaged\n")
  const h = await harness({ cwd, reply: commitReply })
  expect(await h.run("/commit")).toMatch(/Nothing is staged/)
  expect(h.mock.requests).toHaveLength(0)
})

test("/commit refuses when the staged changes moved while the user read the proposal", async () => {
  const cwd = repo()
  stage(cwd)
  const h = await harness({ cwd, reply: commitReply })
  // Stage more between the proposal and the answer.
  h.ctx.ui.select = async () => {
    stage(cwd, "c.txt", "three\n")
    return "Commit"
  }
  expect(await h.run("/commit")).toMatch(/staged changes changed since the message was drafted/)
  expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1")
})

test("/commit runs the user's hooks: a failing pre-commit hook stops the commit and is reported", async () => {
  const cwd = repo()
  stage(cwd)
  const hook = path.join(cwd, ".git", "hooks", "pre-commit")
  writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n")
  chmodSync(hook, 0o755)
  const h = await harness({ cwd, reply: commitReply, dialogs: { select: ["Commit"] } })
  const out = await h.run("/commit")
  expect(out).toContain("git commit failed")
  expect(out).toContain("hook says no")
  expect(out).toContain("feat: add b")
  expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1")
})

test("/commit follows extensions.share.conventional", async () => {
  const cwd = repo()
  stage(cwd)
  for (const [setting, wants] of [
    [true, "Use Conventional Commits"],
    [false, "Follow the style of the recent subjects"],
  ] as const) {
    const h = await harness({
      cwd,
      reply: commitReply,
      settings: { extensions: { share: { conventional: setting } } },
      dialogs: { select: ["Cancel"] },
    })
    await h.run("/commit")
    expect(h.mock.requests.find((r) => who(r) === "commit")!.systemPrompt).toContain(wants)
  }
})

/** A repository with a feature branch two commits ahead of main. */
function branchRepo(): string {
  const cwd = repo()
  git(cwd, "checkout", "-q", "-b", "feat/b")
  writeFileSync(path.join(cwd, "b.txt"), "two\n")
  git(cwd, "add", "b.txt")
  git(cwd, "commit", "-q", "-m", "feat: add b")
  writeFileSync(path.join(cwd, "a.txt"), "one\nmore\n")
  git(cwd, "commit", "-q", "-am", "fix: more a")
  return cwd
}

const prReply = (req: ModelRequest) =>
  who(req) === "pr"
    ? returns({ title: "Add b and more a", body: "## Summary\n- adds b\n- extends a" })
    : { text: "?" }

/** Stands in for gh: `installed` or not; records its calls. */
function fakeGh(installed: boolean, calls: string[][]): (real: Run) => Run {
  return (real) => async (argv, o) => {
    if (argv[0] !== "gh") return real(argv, o)
    calls.push(argv)
    if (!installed) return { ok: false, output: "not found", exitCode: null, timedOut: false }
    if (argv[1] === "--version") return { ok: true, output: "gh version 2.0.0", exitCode: 0, timedOut: false }
    return { ok: true, output: "https://github.com/o/r/pull/7", exitCode: 0, timedOut: false }
  }
}

test("/pr without gh prints the draft from the branch's commits and diff", async () => {
  const cwd = branchRepo()
  const calls: string[][] = []
  const h = await harness({ cwd, reply: prReply, run: fakeGh(false, calls) })
  const out = await h.run("/pr")
  expect(out).toContain("Pull request draft (feat/b → main)")
  expect(out).toContain("    Add b and more a")
  expect(out).toContain("gh (GitHub CLI) is not installed")
  const req = text(h.mock.requests.find((r) => who(r) === "pr")!)
  expect(req).toContain("feat: add b")
  expect(req).toContain("fix: more a")
  expect(req).toContain("+more")
  expect(h.asked).toEqual([])
})

test("/pr with gh pushes a branch without upstream and creates the PR after confirmation", async () => {
  const cwd = branchRepo()
  const remote = path.join(path.dirname(cwd), "remote.git")
  git(path.dirname(cwd), "init", "-q", "--bare", remote)
  git(cwd, "remote", "add", "origin", remote)
  git(cwd, "push", "-q", "origin", "main")
  const calls: string[][] = []
  const h = await harness({
    cwd,
    reply: prReply,
    run: fakeGh(true, calls),
    dialogs: { select: ["Push and create draft PR"] },
  })
  const out = await h.run("/pr main --draft")
  expect(h.asked[0]!.title).toMatch(/feat\/b has no upstream; it will be pushed to origin/)
  expect(out).toContain("Created https://github.com/o/r/pull/7")
  expect(git(remote, "rev-parse", "feat/b")).toBe(git(cwd, "rev-parse", "HEAD"))
  const create = calls.find((c) => c[1] === "pr")!
  expect(create.slice(0, 5)).toEqual(["gh", "pr", "create", "--title", "Add b and more a"])
  expect(create).toContain("--draft")
  expect(create[create.indexOf("--base") + 1]).toBe("main")
  expect(create[create.indexOf("--head") + 1]).toBe("feat/b")
})

test("/pr: Cancel creates nothing; on the base branch it refuses", async () => {
  const cwd = branchRepo()
  const calls: string[][] = []
  const h = await harness({ cwd, reply: prReply, run: fakeGh(true, calls), dialogs: { select: ["Cancel"] } })
  expect(await h.run("/pr")).toContain("Not created.")
  expect(calls.some((c) => c[1] === "pr")).toBe(false)
  git(cwd, "checkout", "-q", "main")
  expect(await failure(h.run("/pr"))).toMatch(/the base branch/)
})

const reviewReply = (req: ModelRequest) =>
  who(req) === "review"
    ? returns({
        summary: "Adds b and extends a.",
        findings: [
          { severity: "low", file: "a.txt", title: "Trailing line", detail: "Nitpick." },
          {
            severity: "high",
            file: "b.txt",
            line: 1,
            title: "Wrong number",
            detail: "b says two.\nIt should say 2.",
          },
        ],
      })
    : { text: "?" }

test("/review has a reviewer sub-agent look at the branch diff and prints findings, most severe first", async () => {
  const cwd = branchRepo()
  const h = await harness({ cwd, reply: reviewReply })
  const out = await h.run("/review main")
  expect(out).toContain("Review of feat/b vs main: 2 findings (1 high, 1 low).")
  expect(out.indexOf("[high] b.txt:1: Wrong number")).toBeLessThan(out.indexOf("[low] a.txt: Trailing line"))
  expect(out).toContain("   It should say 2.")
  const req = h.mock.requests.find((r) => who(r) === "review")!
  expect(text(req)).toContain("+more")
  // Read-only tools only (of those registered), plus the tool to hand back the result.
  expect(req.tools.map((t) => t.name)).toEqual(["return_result"])
})

test("/review falls back to uncommitted changes, and says when there is nothing", async () => {
  const cwd = repo()
  const h = await harness({ cwd, reply: reviewReply })
  expect(await h.run("/review")).toMatch(/Nothing to review/)
  writeFileSync(path.join(cwd, "a.txt"), "changed\n")
  const out = await h.run("/review")
  expect(out).toContain("Reviewing the uncommitted changes on main")
  expect(text(h.mock.requests.find((r) => who(r) === "review")!)).toContain("+changed")
})

test("the model's failure is reported, and outside a repository the commands say so", async () => {
  const cwd = repo()
  stage(cwd)
  const h = await harness({ cwd, reply: () => ({ error: { message: "boom" } }) })
  expect(await failure(h.run("/commit"))).toMatch(/no commit message/)
  const outside = await harness({ cwd: path.dirname(path.dirname(cwd)), reply: commitReply })
  expect(await failure(outside.run("/review"))).toMatch(/not inside a git repository/)
})
