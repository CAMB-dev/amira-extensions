import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SpawnOptions } from "@amira/api"
import { BUILTIN_ROLES } from "../src/roles.ts"
import { WorkflowRun } from "../src/run.ts"
import { createWorktree, finishWorktree, type RunGit, type Worktree } from "../src/worktree.ts"
import { type Answer, fakeGroup } from "./fakes.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "wf-wt-"))
  dirs.push(d)
  return d
}

type Reply = { output?: string; ok?: boolean }

/** A RunGit that answers by the git subcommand and records every call. */
function scriptedGit(replies: Record<string, Reply | ((args: string[]) => Reply)>) {
  const calls: { args: string[]; cwd: string }[] = []
  const git: RunGit = async (args, cwd) => {
    calls.push({ args, cwd })
    const plain = args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c")
    const key = [`${plain[0]} ${plain[1] ?? ""}`.trim(), plain[0] ?? ""].find((k) => k in replies)
    const r = key === undefined ? {} : replies[key]
    const reply = typeof r === "function" ? r(args) : (r ?? {})
    return { output: reply.output ?? "", ok: reply.ok ?? true }
  }
  const ran = (...prefix: string[]) =>
    calls.some((c) => prefix.every((p, i) => c.args[i] === p) || c.args.join(" ").includes(prefix.join(" ")))
  return { git, calls, ran }
}

function worktree(root: string, dir: string): Worktree {
  return { root, dir, cwd: dir, base: "abc123", patch: `${dir}.diff` }
}

describe("createWorktree", () => {
  test("outside a repository, or in one without commits, there is no worktree", async () => {
    const none = scriptedGit({ "rev-parse": { ok: false } })
    expect(await createWorktree(none.git, { cwd: "/p", home: "/h", name: "wf_1_1" })).toEqual({
      error: "not a git repository",
    })
    const empty = scriptedGit({
      "rev-parse": (a) => (a.includes("--show-toplevel") ? { output: "/repo\n" } : { ok: false }),
    })
    expect(await createWorktree(empty.git, { cwd: "/repo", home: "/h", name: "wf_1_1" })).toEqual({
      error: "the repository has no commits yet",
    })
  })

  test("starts from a snapshot of the working tree, under ~/.amira/worktrees, keeping the subdirectory", async () => {
    const home = tmp()
    const root = path.join(home, "repo")
    const g = scriptedGit({
      "rev-parse": (a) => ({ output: a.includes("--show-toplevel") ? `${root}\n` : "head1\n" }),
      "stash create": { output: "snap1\n" },
    })
    const wt = await createWorktree(g.git, { cwd: path.join(root, "pkg", "a"), home, name: "wf_1_2" })
    if ("error" in wt) throw new Error(wt.error)
    expect(wt.base).toBe("snap1")
    expect(path.dirname(path.dirname(wt.dir))).toBe(path.join(home, "worktrees"))
    expect(path.basename(wt.dir)).toBe("wf_1_2")
    expect(wt.cwd).toBe(path.join(wt.dir, "pkg", "a"))
    expect(wt.patch).toBe(`${wt.dir}.diff`)
    const add = g.calls.find((c) => c.args[0] === "worktree")!
    expect(add.args).toEqual(["worktree", "add", "--detach", wt.dir, "snap1"])
    expect(add.cwd).toBe(path.normalize(root))
  })

  test("with nothing uncommitted it starts from HEAD; a failed add is reported", async () => {
    const g = scriptedGit({
      "rev-parse": (a) => ({ output: a.includes("--show-toplevel") ? "/repo\n" : "head1\n" }),
      "stash create": { output: "" },
      "worktree add": { ok: false, output: "fatal: already exists\n" },
    })
    const wt = await createWorktree(g.git, { cwd: "/repo", home: tmp(), name: "wf_1_3" })
    expect(wt).toEqual({ error: "git worktree add failed: fatal: already exists" })
    expect(g.calls.find((c) => c.args[0] === "worktree")!.args.at(-1)).toBe("head1")
  })
})

describe("finishWorktree", () => {
  test("no changes: the worktree is removed, merged or not", async () => {
    for (const merge of [true, false]) {
      const g = scriptedGit({ "diff --cached": (a) => ({ output: a.includes("--name-only") ? "" : "" }) })
      const wt = worktree("/repo", "/h/worktrees/p/wf_1_1")
      expect(await finishWorktree(g.git, wt, merge)).toBe("worktree: no changes")
      expect(g.ran("worktree", "remove", "--force", wt.dir)).toBe(true)
      expect(g.ran("apply")).toBe(false)
    }
  })

  test("finished with changes that apply: merged into the working tree, then removed", async () => {
    const g = scriptedGit({
      diff: (a) => ({ output: a.includes("--name-only") ? "a.ts\nb.ts\n" : "" }),
    })
    const wt = worktree("/repo", "/h/worktrees/p/wf_1_2")
    expect(await finishWorktree(g.git, wt, true)).toBe("worktree merged: a.ts, b.ts")
    // The diff is taken against the worktree's base, and applied in the main tree.
    const diff = g.calls.find((c) => c.args[0] === "diff" && c.args.includes("--binary"))!
    expect(diff.args.at(-1)).toBe("abc123")
    expect(diff.args).toContain(`--output=${wt.patch}`)
    const apply = g.calls.find((c) => c.args[0] === "apply")!
    expect(apply.cwd).toBe("/repo")
    expect(apply.args.at(-1)).toBe(wt.patch)
    expect(g.ran("worktree", "remove", "--force", wt.dir)).toBe(true)
  })

  test("a patch that does not apply keeps the worktree and names the patch", async () => {
    const g = scriptedGit({
      diff: (a) => ({ output: a.includes("--name-only") ? "a.ts\n" : "" }),
      apply: { ok: false, output: "error: patch failed: a.ts:1\nmore\n" },
    })
    const wt = worktree("/repo", "/h/worktrees/p/wf_1_3")
    const line = await finishWorktree(g.git, wt, true)
    expect(line).toBe(
      `worktree NOT merged (error: patch failed: a.ts:1); its changes stay in ${wt.dir}, patch ${wt.patch}`,
    )
    expect(g.ran("worktree", "remove")).toBe(false)
  })

  test("an agent that did not finish keeps its changes in the worktree, unapplied", async () => {
    const g = scriptedGit({ diff: (a) => ({ output: a.includes("--name-only") ? "a.ts\n" : "" }) })
    const wt = worktree("/repo", "/h/worktrees/p/wf_1_4")
    expect(await finishWorktree(g.git, wt, false)).toBe(
      `worktree kept at ${wt.dir} (1 files changed; the agent did not finish)`,
    )
    expect(g.ran("apply")).toBe(false)
    expect(g.ran("worktree", "remove")).toBe(false)
  })

  test("a failed git diff leaves everything where it is", async () => {
    const g = scriptedGit({ diff: { ok: false } })
    const wt = worktree("/repo", "/h/worktrees/p/wf_1_5")
    expect(await finishWorktree(g.git, wt, true)).toMatch(/git diff failed/)
    expect(g.ran("apply")).toBe(false)
    expect(g.ran("worktree", "remove")).toBe(false)
  })

  test("when git cannot remove the worktree, its directory (only) is deleted and git prunes", async () => {
    const home = tmp()
    const dir = path.join(home, "worktrees", "p", "wf_1_6")
    const sibling = path.join(home, "worktrees", "p", "wf_1_7")
    for (const d of [dir, sibling]) {
      mkdirSync(d, { recursive: true })
      writeFileSync(path.join(d, "f.txt"), "x")
    }
    writeFileSync(`${dir}.diff`, "")
    const g = scriptedGit({
      diff: { output: "" },
      "worktree remove": { ok: false, output: "fatal: locked" },
    })
    expect(await finishWorktree(g.git, worktree(path.join(home, "repo"), dir), false)).toBe(
      "worktree: no changes",
    )
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(`${dir}.diff`)).toBe(false)
    expect(existsSync(path.join(sibling, "f.txt"))).toBe(true)
    expect(g.ran("worktree", "prune")).toBe(true)
  })
})

// ---- against a real repository ----

const gitBin = Bun.which("git")

/** Runs git the way the extension's runCommand does: output is stdout plus (unless stdoutOnly) stderr. */
const realGit: RunGit = async (args, cwd, stdoutOnly = false) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return {
    output: p.stdout.toString() + (stdoutOnly ? "" : p.stderr.toString()),
    ok: p.exitCode === 0,
  }
}

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

function repo() {
  const base = tmp()
  const root = path.join(base, "repo")
  const home = path.join(base, "home")
  mkdirSync(root, { recursive: true })
  mkdirSync(home, { recursive: true })
  sh(root, "init", "-q")
  sh(root, "config", "core.autocrlf", "false")
  writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n")
  sh(root, "add", "-A")
  sh(root, "commit", "-q", "--no-gpg-sign", "-m", "init")
  return { root, home }
}

const read = (f: string) => readFileSync(f, "utf8")

describe.skipIf(!gitBin)("with git", () => {
  test("an agent's worktree starts with uncommitted changes, and its own changes merge back", async () => {
    const { root, home } = repo()
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\nfour (uncommitted)\n")
    const wt = await createWorktree(realGit, { cwd: root, home, name: "wf_r_1" })
    if ("error" in wt) throw new Error(wt.error)
    expect(read(path.join(wt.dir, "a.txt"))).toContain("four (uncommitted)")
    writeFileSync(path.join(wt.dir, "a.txt"), "ONE\ntwo\nthree\nfour (uncommitted)\n")
    writeFileSync(path.join(wt.dir, "new.txt"), "new\n")
    const line = await finishWorktree(realGit, wt, true)
    expect(line).toMatch(/^worktree merged: /)
    expect(line).toContain("new.txt")
    expect(read(path.join(root, "a.txt"))).toBe("ONE\ntwo\nthree\nfour (uncommitted)\n")
    expect(read(path.join(root, "new.txt"))).toBe("new\n")
    expect(existsSync(wt.dir)).toBe(false)
    expect(existsSync(wt.patch)).toBe(false)
    expect(sh(root, "worktree", "list")).not.toContain("wf_r_1")
  }, 30_000)

  test("a conflicting change stays in the worktree, with its patch", async () => {
    const { root, home } = repo()
    const wt = await createWorktree(realGit, { cwd: root, home, name: "wf_r_2" })
    if ("error" in wt) throw new Error(wt.error)
    writeFileSync(path.join(wt.dir, "a.txt"), "uno\ntwo\nthree\n")
    writeFileSync(path.join(root, "a.txt"), "eins\ntwo\nthree\n")
    const line = await finishWorktree(realGit, wt, true)
    expect(line).toMatch(/^worktree NOT merged/)
    expect(read(path.join(root, "a.txt"))).toBe("eins\ntwo\nthree\n")
    expect(read(path.join(wt.dir, "a.txt"))).toBe("uno\ntwo\nthree\n")
    expect(read(wt.patch)).toContain("+uno")
  })

  test('agent(..., { isolation: "worktree" }) works in its own checkout, merged when it finishes', async () => {
    const { root, home } = repo()
    const seen: string[] = []
    const answer = (o: SpawnOptions): Answer => {
      seen.push(o.cwd ?? "")
      writeFileSync(path.join(o.cwd!, `${o.title}.txt`), `${o.title}\n`)
      return { text: "wrote it" }
    }
    const group = fakeGroup({ name: "wf" }, answer)
    const run = new WorkflowRun({
      id: "wf_iso",
      dir: path.join(home, "runs", "wf_iso"),
      source: `export const meta = { name: "iso", description: "d", phases: [] }
        return await parallel(["x", "y"].map((l) => () => agent("write " + l, { label: l, isolation: "worktree" })))`,
      origin: "inline",
      args: null,
      group,
      cwd: root,
      home,
      roles: () => new Map(BUILTIN_ROLES.map((r) => [r.name, r])),
      git: realGit,
      loadWorkflow: () => undefined,
      onChange: () => {},
    })
    run.start()
    await run.done
    expect(run.error).toBeUndefined()
    expect(run.result).toEqual(["wrote it", "wrote it"])
    for (const cwd of seen)
      expect(path.relative(path.join(home, "worktrees"), cwd).startsWith("..")).toBe(false)
    expect(read(path.join(root, "x.txt"))).toBe("x\n")
    expect(read(path.join(root, "y.txt"))).toBe("y\n")
    expect(group.spawned[0]!.systemPrompt).toContain("your own git worktree")
    expect(sh(root, "worktree", "list").trim().split("\n")).toHaveLength(1)
  }, 30_000)
})

test("a run stopped while an agent's worktree is being made removes that worktree", async () => {
  let run!: WorkflowRun
  const g = scriptedGit({
    "rev-parse": (a) => ({ output: a.includes("--show-toplevel") ? "/repo\n" : "head1\n" }),
    "stash create": { output: "" },
    "worktree add": () => {
      run.stop()
      return {}
    },
    diff: { output: "" },
  })
  const group = fakeGroup({ name: "wf" }, () => ({ text: "never" }))
  run = new WorkflowRun({
    id: "wf_stop",
    dir: path.join(tmp(), "wf_stop"),
    source: `export const meta = { name: "s", description: "d", phases: [] }
      return await agent("edit", { isolation: "worktree" })`,
    origin: "inline",
    args: null,
    group,
    cwd: "/repo",
    home: tmp(),
    roles: () => new Map(),
    git: g.git,
    loadWorkflow: () => undefined,
    onChange: () => {},
  })
  run.start()
  await run.done
  for (let i = 0; i < 100 && !g.ran("worktree", "remove"); i++) await Bun.sleep(5)
  expect(run.status).toBe("stopped")
  expect(group.spawned).toHaveLength(0)
  expect(g.ran("worktree", "remove", "--force")).toBe(true)
})
