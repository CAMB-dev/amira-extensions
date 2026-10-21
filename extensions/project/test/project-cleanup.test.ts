import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import type { PrototypeManifestArtifact, WorktreeArtifact } from "../src/artifacts.ts"
import { quote, type Shell } from "../src/iteration-git.ts"
import { type CleanupApproval, type GitCleanupRecord, ProjectCleanup } from "../src/project-cleanup.ts"
import { Prototypes, prototypeComparison, prototypePanelText } from "../src/prototype.ts"
import { probeShipCheckout } from "../src/ship-git.ts"
import { specInputs } from "../src/spec.ts"
import {
  createProject,
  DecisionStore,
  HistoricalIterationReader,
  IterationStore,
  LifecycleStore,
  ProjectDocumentStore,
} from "../src/store.ts"
import { human } from "./iteration-binding-helper.ts"
import { ownedFixture } from "./owned-fixture.ts"

setDefaultTimeout(120_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const receipt = (subject: string): CleanupApproval => ({
  subject,
  sessionId: "human-main",
  date: "2026-10-21T00:00:00Z",
})
const lifecycleReceipt = { id: "close-1", sessionId: "human-main", date: "2026-10-21T00:00:00Z" }
async function fixture(
  shell: Shell = "bash",
  withChoice = false,
  variant: Partial<Pick<PrototypeManifestArtifact["variants"][number], "status" | "runCommand">> = {},
  archive = false,
) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "project cleanup's-")))
  homes.push(home)
  const repo = path.join(home, "repo")
  await mkdir(repo)
  let project = await createProject(repo, "Cleanup")
  const gitPath = Bun.which("git")!
  const bash =
    process.platform === "win32"
      ? (["../bin/bash.exe", "../../usr/bin/bash.exe", "../usr/bin/bash.exe"]
          .map((part) => path.resolve(path.dirname(gitPath), part))
          .find(existsSync) ?? "bash")
      : "bash"
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, "empty-gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(home, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_SSH_COMMAND: "false",
    GIT_TEMPLATE_DIR: path.join(home, "templates"),
  })
  await mkdir(env.GIT_TEMPLATE_DIR!)
  await writeFile(env.GIT_CONFIG_GLOBAL!, "")
  const commands: string[] = []
  let denyRemoval = false
  let live = false
  let unusedCalls = 0
  const execute = async (command: string, kind: Shell = shell) => {
    const child = Bun.spawn(
      kind === "bash"
        ? [bash, "-c", command]
        : ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: repo,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      content: [{ type: "text" as const, text: stdout + stderr }],
      details: { exitCode },
      isError: exitCode !== 0,
    }
  }
  const git = async (root: string, args: string) => {
    const result = await execute(`git -C ${quote(root, "bash")} ${args}`, "bash")
    if (result.isError) throw new Error(result.content[0]!.text)
    return result.content[0]!.text.trim()
  }
  await git(repo, "init -b main")
  await git(repo, 'config user.name "Offline Cleanup Fixture"')
  await git(repo, 'config user.email "cleanup@invalid.local"')
  await writeFile(path.join(repo, ".gitignore"), ".amira/\nignored/\n")
  await writeFile(path.join(repo, "code.txt"), "base\n")
  await git(repo, "add .gitignore code.txt")
  await git(repo, 'commit -m "base"')
  const base = await git(repo, "rev-parse HEAD")
  const root = path.join(home, ".amira-project-worktrees", project.marker.id, "iteration-1")
  const branch = `amira/project/cleanup-${project.marker.id}/iteration-1`
  await git(repo, `worktree add -b ${quote(branch, "bash")} ${quote(root, "bash")}`)
  const worktree: WorktreeArtifact = {
    kind: "iteration-worktree",
    status: "ready",
    repository: repo,
    root,
    cwd: root,
    branch,
    base,
    excluded: "",
    confirmation: "Fixture",
    setupKey: "cleanup-fixture",
  }
  const handle = ownedFixture({ key: "cleanup-fixture", cwd: repo })
  handle.runTool = async (name, args, options) => {
    if (name !== shell) throw new Error("Unexpected tool")
    commands.push(String(args.command))
    if (options?.signal?.aborted)
      return { content: [], isError: true, details: { exitCode: null, aborted: true } }
    if (denyRemoval && /git worktree remove|git branch -d|rm -r|Remove-Item/.test(String(args.command)))
      return {
        content: [{ type: "text", text: "Fixture permission denied" }],
        isError: true,
        details: { exitCode: 1 },
      }
    return execute(String(args.command))
  }
  const store = new IterationStore(project)
  const directory = await store.preparePrototypeDirectory("alpha")
  await writeFile(path.join(directory, "demo.ts"), "console.log('prototype')\n")
  const manifest = {
    kind: "prototype-manifest" as const,
    variants: [
      {
        id: "alpha",
        idea: "Compact view",
        question: "Easier to scan?",
        directory,
        runCommand: "bun demo.ts",
        cwd: directory,
        prerequisites: [],
        notes: "Keep findings",
        status: "ready" as const,
        ...variant,
      },
    ],
  }
  let revision = 0
  if (withChoice) {
    const summary = await store.saveArtifact(0, {
      kind: "stage-summary",
      stage: "design",
      language: "en",
      summary: "Design ready",
      outputs: [],
      suggestion: "Try prototypes",
    })
    let state = await store.dispatch(summary.state.revision, {
      type: "prepare-summary",
      expectedRevision: summary.state.revision,
      artifact: summary.artifact,
    })
    state = await store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: {
        id: "prototype-next",
        from: "design",
        to: "prototype",
        kind: "skip",
        summaryId: state.summaryId!,
        suggestion: "Try prototypes",
        skippedStages: ["design"],
      },
    })
    state = await store.dispatch(state.revision, {
      type: "confirm-transition",
      expectedRevision: state.revision,
      receipt: human(state, "prototype-next", "prototype"),
    })
    state = await store.dispatch(state.revision, {
      type: "start-work",
      expectedRevision: state.revision,
      attemptId: "prototype-work",
    })
    revision = state.revision
  }
  let saved = await store.saveArtifact(revision, manifest)
  if (withChoice) {
    saved = await store.recordPrototypeChoice(
      saved.state.revision,
      saved.artifact,
      {
        question: "Which prototype?",
        options: [
          { label: "alpha", description: "Compact view" },
          { label: "none", description: "Keep findings only" },
        ],
      },
      { selected: ["alpha"] },
      { sessionId: "human-main", askId: "choose-alpha", language: "en", reason: "Easier to scan" },
      "alpha",
    )
    await new DecisionStore(project).recover()
  }
  await writeFile(path.join(repo, ".amira", "project", "design.md"), "Permanent design\n")
  if (!withChoice)
    await writeFile(
      path.join(repo, ".amira", "project", "decisions.md"),
      "Permanent rationale and decisions\n",
    )
  const close = async () => {
    const lifecycle = new LifecycleStore(project)
    const state = await lifecycle.read()
    if (archive) {
      await lifecycle.transition(state.revision, { type: "archive-pending", receipt: lifecycleReceipt })
      project = await lifecycle.transition(state.revision + 1, {
        type: "archived",
        receipt: lifecycleReceipt,
      })
    } else {
      await lifecycle.transition(state.revision, {
        type: "ship",
        status: "skipped",
        receipt: lifecycleReceipt,
      })
      project = await lifecycle.transition(state.revision + 1, { type: "close", receipt: lifecycleReceipt })
    }
  }
  await close()
  const options = {
    assertUnused: async () => {
      unusedCalls++
      if (live) throw new Error("Live or unknown resource users")
    },
  }
  const cleanup = () => new ProjectCleanup(project, handle, shell, options)
  const record = async (): Promise<GitCleanupRecord> => ({
    iteration: 1,
    worktree,
    checkout: await probeShipCheckout(handle, shell, root),
    preserved: {
      ref: "refs/heads/main",
      head: await git(repo, "rev-parse main"),
      evidence: "Verified local integration receipt",
    },
  })
  const preview = async () => cleanup().previewGit(await record())
  const prototype = () => cleanup().previewPrototype(1, saved.artifact, "alpha")
  const readReceipts = () => new ProjectDocumentStore(project).read("cleanup.json")
  return {
    home,
    repo,
    root,
    branch,
    base,
    worktree,
    handle,
    commands,
    git,
    cleanup,
    record,
    preview,
    prototype,
    saved,
    directory,
    manifest,
    readReceipts,
    project: () => project,
    setLive: (value: boolean) => {
      live = value
    },
    denyRemoval: () => {
      denyRemoval = true
    },
    unusedCalls: () => unusedCalls,
  }
}
const removals = (commands: string[]) =>
  commands.filter((command) => /git worktree remove|git branch -d|rm -r|Remove-Item/.test(command))

test("default retains both Git resources and prototypes without a write or probe", async () => {
  const f = await fixture()
  const git = await f.preview()
  const prototype = await f.prototype()
  const count = f.commands.length
  expect(await f.cleanup().removeWorktree(git)).toBe("retained")
  expect(await f.cleanup().removeBranch(git)).toBe("retained")
  expect(await f.cleanup().removePrototype(prototype)).toBe("retained")
  expect(f.commands.length).toBe(count)
  expect(await f.readReceipts()).toBeUndefined()
  expect(existsSync(f.root)).toBe(true)
  expect(existsSync(f.directory)).toBe(true)
})

for (const shell of ["bash", "powershell"] as const) {
  test(`${shell}: separately confirmed exact worktree/branch removal uses only ordinary Git`, async () => {
    const f = await fixture(shell)
    const preview = await f.preview()
    expect(preview.files).toEqual([".gitignore", "code.txt"])
    await expect(f.cleanup().removeBranch(preview, receipt(preview.subjects.branch))).rejects.toThrow(
      "worktree first",
    )
    await expect(f.cleanup().removeWorktree(preview, receipt(preview.subjects.branch))).rejects.toThrow(
      "exact-operation",
    )
    expect(removals(f.commands)).toEqual([])
    expect(await f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))).toBe("removed")
    expect(existsSync(f.root)).toBe(false)
    expect(await f.git(f.repo, `rev-parse ${quote(f.branch, "bash")}`)).toBe(f.base)
    expect(await f.cleanup().removeBranch(preview)).toBe("retained")
    expect(await f.cleanup().removeBranch(preview, receipt(preview.subjects.branch))).toBe("removed")
    expect(await f.git(f.repo, "branch --list")).toBe("* main")
    expect(removals(f.commands)).toHaveLength(2)
    expect(f.commands.join("\n")).not.toMatch(
      /--force|\s-D\b|reset --hard|prune|--no-verify|gpgsign=false|hooksPath|HUSKY=0/,
    )
    expect(await readFile(path.join(f.repo, "code.txt"), "utf8")).toBe("base\n")
  })
}

for (const change of [
  "dirty",
  "staged",
  "untracked",
  "ignored",
  "hidden-index",
  "empty-directory",
] as const) {
  test(`${change} content blocks worktree cleanup before any mutation`, async () => {
    const f = await fixture()
    if (change === "dirty" || change === "staged" || change === "hidden-index") {
      if (change === "hidden-index") await f.git(f.root, "update-index --assume-unchanged code.txt")
      await writeFile(path.join(f.root, "code.txt"), "must retain\n")
      if (change === "staged") await f.git(f.root, "add code.txt")
    } else if (change === "untracked") await writeFile(path.join(f.root, "new.txt"), "must retain")
    else {
      const directory = path.join(f.root, change === "ignored" ? "ignored" : "empty")
      await mkdir(directory)
      if (change === "ignored") await writeFile(path.join(directory, "secret"), "must retain")
    }
    await expect(f.preview()).rejects.toThrow(/blocks? cleanup/)
    expect(removals(f.commands)).toEqual([])
    expect(existsSync(f.root)).toBe(true)
    expect(await f.readReceipts()).toBeUndefined()
  })
}

test("unmerged index and in-progress operations block cleanup", async () => {
  const f = await fixture()
  const pin = await f.record()
  const gitDir = pin.checkout.gitDir
  await writeFile(path.join(gitDir, "MERGE_HEAD"), `${f.base}\n`)
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/operation blocks/)
  await rm(path.join(gitDir, "MERGE_HEAD"))
  const blob = await f.git(f.root, "rev-parse HEAD:code.txt")
  const info = path.join(f.home, "unmerged-index")
  await writeFile(
    info,
    `100644 ${blob} 1\tcode.txt\n100644 ${blob} 2\tcode.txt\n100644 ${blob} 3\tcode.txt\n`,
  )
  await f.git(f.root, "update-index --force-remove code.txt")
  await f.git(f.root, `update-index --index-info < ${quote(info, "bash")}`)
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/unmerged/)
  expect(removals(f.commands)).toEqual([])
})

test("clean committed submodule inputs block cleanup even after merge", async () => {
  const f = await fixture()
  await f.git(f.root, `update-index --add --cacheinfo 160000,${f.base},nested`)
  await f.git(f.root, 'commit -m "gitlink"')
  await mkdir(path.join(f.root, "nested"))
  await f.git(f.repo, `merge --ff-only ${quote(f.branch, "bash")}`)
  await expect(f.preview()).rejects.toThrow(/Submodule/)
  expect(removals(f.commands)).toEqual([])
})

test("unmerged commits or missing preservation evidence cannot authorize deletion", async () => {
  const f = await fixture()
  await f.git(f.root, 'commit --allow-empty -m "not merged"')
  await expect(f.preview()).rejects.toThrow(/Command stopped/)
  const pin = await f.record()
  pin.preserved.evidence = ""
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/preservation evidence/)
  pin.preserved.evidence = "not enough"
  pin.preserved.ref = `refs/heads/${f.branch}`
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/separate ref/)
  await f.git(f.repo, `symbolic-ref refs/heads/preserved-alias ${quote(`refs/heads/${f.branch}`, "bash")}`)
  pin.preserved = { ref: "refs/heads/preserved-alias", head: pin.checkout.head, evidence: "Not independent" }
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/symbolic alias/)
  expect(removals(f.commands)).toEqual([])
})

test("recorded common directory, branch, HEAD and filesystem identity are not rediscovered/adopted", async () => {
  const f = await fixture()
  const pin = await f.record()
  for (const changed of [
    { ...pin, checkout: { ...pin.checkout, common: path.join(f.home, "other") } },
    { ...pin, checkout: { ...pin.checkout, identity: "replaced" } },
    { ...pin, checkout: { ...pin.checkout, branch: "main" } },
    { ...pin, worktree: { ...pin.worktree, branch: "main" } },
  ])
    await expect(f.cleanup().previewGit(changed)).rejects.toThrow(/identity/)
  await f.git(f.root, 'commit --allow-empty -m "moved"')
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/identity/)
  expect(removals(f.commands)).toEqual([])
})

test("redirected worktree paths block cleanup, leaving the destination intact", async () => {
  const f = await fixture()
  const pin = await f.record()
  const moved = `${f.root}-original`
  await rename(f.root, moved)
  await symlink(moved, f.root, process.platform === "win32" ? "junction" : "dir")
  await expect(f.cleanup().previewGit(pin)).rejects.toThrow(/Redirected|redirected/)
  expect(removals(f.commands)).toEqual([])
  expect(existsSync(path.join(moved, "code.txt"))).toBe(true)
})

test("live users, stale previews, changed preservation refs and aborted calls retain resources", async () => {
  const f = await fixture()
  const preview = await f.preview()
  f.setLive(true)
  await expect(f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))).rejects.toThrow(
    "Live",
  )
  f.setLive(false)
  await writeFile(path.join(f.root, "code.txt"), "changed after approval")
  await expect(f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))).rejects.toThrow(
    /blocks cleanup/,
  )
  await writeFile(path.join(f.root, "code.txt"), "base\n")
  await f.git(f.repo, 'commit --allow-empty -m "preservation ref moved"')
  await expect(f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))).rejects.toThrow(
    /preservation ref moved/,
  )
  const aborted = new ProjectCleanup(f.project(), f.handle, "bash", {
    assertUnused: async () => {},
    signal: AbortSignal.abort(),
  })
  await expect(aborted.previewGit(await f.record())).rejects.toThrow()
  expect(removals(f.commands)).toEqual([])
  expect(await f.readReceipts()).toBeUndefined()
  const prototype = await f.prototype()
  const lateLive = new ProjectCleanup(f.project(), f.handle, "bash", {
    assertUnused: async () => {
      if (existsSync(path.join(f.repo, ".amira", "project", "cleanup.json")))
        throw new Error("Live user appeared after intent publication")
    },
  })
  await expect(lateLive.removePrototype(prototype, receipt(prototype.subject))).rejects.toThrow(
    "after intent",
  )
  expect(removals(f.commands)).toEqual([])
  expect((await f.cleanup().prototypeCode(1, f.saved.artifact)).variants[0]!.runnable).toBe(false)
})

test("a live cleanup tool owner cannot remove its own worktree", async () => {
  const f = await fixture()
  const pin = await f.record()
  for (const cwd of [f.root, path.join(f.root, "..worker")]) {
    const handle = { ...f.handle, cwd }
    const cleanup = new ProjectCleanup(f.project(), handle, "bash", { assertUnused: async () => {} })
    await expect(cleanup.previewGit(pin)).rejects.toThrow("tool owner is a live user")
  }
  expect(removals(f.commands)).toEqual([])
})

test("permission failure records uncertainty and never retries with force or filesystem fallback", async () => {
  const f = await fixture()
  const preview = await f.preview()
  f.denyRemoval()
  await expect(f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))).rejects.toThrow(
    "permission denied",
  )
  const saved = (await f.readReceipts()) as { removals: { status: string }[] }
  expect(saved.removals[0]!.status).toBe("uncertain")
  await expect(f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))).rejects.toThrow(
    "never replay",
  )
  expect(removals(f.commands)).toHaveLength(1)
  expect(existsSync(f.root)).toBe(true)
})

test("branch movement, new worktree users and repository movement block independently approved branch deletion", async () => {
  const f = await fixture()
  const preview = await f.preview()
  await f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))
  const other = path.join(f.home, "new-user")
  await f.git(f.repo, `worktree add ${quote(other, "bash")} ${quote(f.branch, "bash")}`)
  await expect(f.cleanup().removeBranch(preview, receipt(preview.subjects.branch))).rejects.toThrow(
    "live worktree",
  )
  await f.git(f.repo, `worktree remove ${quote(other, "bash")}`)
  const moved = await f.git(f.repo, 'commit-tree HEAD^{tree} -p HEAD -m "branch moved"')
  await f.git(f.repo, `update-ref ${quote(`refs/heads/${f.branch}`, "bash")} ${moved}`)
  await expect(f.cleanup().removeBranch(preview, receipt(preview.subjects.branch))).rejects.toThrow(
    "branch moved",
  )
  await f.git(f.repo, `update-ref ${quote(`refs/heads/${f.branch}`, "bash")} ${f.base}`)
  await f.git(f.repo, 'commit --allow-empty -m "repository moved"')
  await expect(f.cleanup().removeBranch(preview, receipt(preview.subjects.branch))).rejects.toThrow(
    "repository identity",
  )
  expect(removals(f.commands)).toHaveLength(1)
})

for (const shell of ["bash", "powershell"] as const) {
  test(`${shell}: prototype deletion retains permanent manifests, rationale and decisions and suppresses runnable claims`, async () => {
    const f = await fixture(shell)
    const reader = new HistoricalIterationReader(f.project(), 1)
    const before = await reader.readArtifact(f.saved.artifact)
    expect((await f.cleanup().prototypeCode(1, f.saved.artifact)).variants[0]!.runnable).toBe(true)
    const preview = await f.prototype()
    expect(preview.files).toEqual(["demo.ts"])
    expect(await f.cleanup().removePrototype(preview, receipt(preview.subject))).toBe("removed")
    expect(existsSync(f.directory)).toBe(false)
    expect(await reader.readArtifact(f.saved.artifact)).toEqual(before)
    expect(await readFile(path.join(f.repo, ".amira", "project", "design.md"), "utf8")).toBe(
      "Permanent design\n",
    )
    expect(await readFile(path.join(f.repo, ".amira", "project", "decisions.md"), "utf8")).toBe(
      "Permanent rationale and decisions\n",
    )
    await mkdir(f.directory)
    await writeFile(path.join(f.directory, "demo.ts"), "do not resurrect removed prototype")
    const status = await f.cleanup().prototypeCode(1, f.saved.artifact)
    expect(status.evidence).toEqual(f.manifest)
    expect(prototypePanelText(status.evidence, "en", true, status.variants)).toContain("alpha: removed")
    const comparison = await prototypeComparison(status.evidence, "en", status.variants)
    expect(comparison).toContain("removed")
    expect(comparison).not.toContain(f.manifest.variants[0]!.runCommand!)
    expect(status.variants[0]).toEqual({
      id: "alpha",
      status: "removed",
      removalStatus: "removed",
      runnable: false,
      directory: null,
      cwd: null,
      runCommand: null,
    })
    await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow()
    expect(removals(f.commands)).toHaveLength(1)
  })
}

test("uncertain prototype removal is never runnable and cannot be automatically replayed", async () => {
  const f = await fixture()
  const preview = await f.prototype()
  f.denyRemoval()
  await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow(
    "permission denied",
  )
  expect(existsSync(f.directory)).toBe(true)
  const status = (await f.cleanup().prototypeCode(1, f.saved.artifact)).variants[0]!
  expect(status).toEqual({
    id: "alpha",
    status: "unavailable",
    removalStatus: "uncertain",
    runnable: false,
    directory: null,
    cwd: null,
    runCommand: null,
  })
  await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow("never replay")
  expect(removals(f.commands)).toHaveLength(1)
})

async function unfinishedCleanup(
  status: "planned" | "building" | "failed",
  removal: "requested" | "uncertain",
) {
  const f = await fixture("bash", false, { status }, true)
  const preview = await f.prototype()
  f.handle.runTool = async () => {
    await rm(path.join(f.directory, "demo.ts"))
    return {
      content: [{ type: "text", text: "Fixture partial deletion" }],
      isError: true,
      details: { exitCode: 1 },
    }
  }
  await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow(
    "partial deletion",
  )
  if (removal === "requested")
    await new ProjectDocumentStore(f.project()).update(
      "cleanup.json",
      (value) => {
        const saved = value as { removals: { status: string }[] }
        saved.removals[0]!.status = "requested"
        return saved
      },
      { administrative: true },
    )
  expect(existsSync(f.directory)).toBe(true)
  expect(existsSync(path.join(f.directory, "demo.ts"))).toBe(false)
  const receipts = (await f.readReceipts()) as { removals: { status: string }[] }
  expect(receipts.removals[0]!.status).toBe(removal)
  const code = await f.cleanup().prototypeCode(1, f.saved.artifact)
  expect(code.evidence).toEqual(f.manifest)
  expect(code.variants[0]).toEqual({
    id: "alpha",
    status: "unavailable",
    removalStatus: removal,
    runnable: false,
    directory: null,
    cwd: null,
    runCommand: null,
  })
  return { f, code }
}

async function runDisplay(f: Awaited<ReturnType<typeof fixture>>) {
  const lifecycle = new LifecycleStore(f.project())
  const state = await lifecycle.read()
  await lifecycle.transition(state.revision, { type: "restore", receipt: lifecycleReceipt })
  const project = await lifecycle.transition(state.revision + 1, {
    type: "continue",
    receipt: lifecycleReceipt,
  })
  const print = mock((_text: string) => {})
  const api = { apiVersion: "0.1.65", conversations: {} } as ExtensionAPI
  const ctx = { print, focusConversation: () => true } as unknown as CommandContext
  const run = () =>
    new Prototypes(api).run(
      ["run", "alpha"],
      project,
      ctx,
      "en",
      () => {},
      () => {},
      async () => {},
    )
  return { run, print }
}

for (const status of ["planned", "building", "failed"] as const) {
  for (const removal of ["requested", "uncertain"] as const) {
    test(`${status}: ${removal} partial cleanup hides historical panel and comparison pointers`, async () => {
      const { f, code } = await unfinishedCleanup(status, removal)
      const comparison = await prototypeComparison(code.evidence, "en", code.variants)
      expect({
        panel: prototypePanelText(code.evidence, "en", true, code.variants),
        showsCwd: comparison.includes("cwd ("),
        showsRunCommand: comparison.includes(f.manifest.variants[0]!.runCommand!),
      }).toEqual({ panel: "alpha: unavailable", showsCwd: false, showsRunCommand: false })
      expect(comparison).toContain("unavailable")
      expect(comparison).not.toContain(f.directory)
      expect(comparison).not.toContain(f.manifest.variants[0]!.runCommand!)
      expect(comparison).not.toContain("files changed")
    })

    test(`${status}: ${removal} partial cleanup blocks run-command display`, async () => {
      const { f } = await unfinishedCleanup(status, removal)
      const display = await runDisplay(f)
      await expect(display.run()).rejects.toThrow("historical, not runnable")
      expect(display.print).not.toHaveBeenCalled()
    })
  }

  test(`${status}: untouched unfinished code keeps its build status and comparison`, async () => {
    const f = await fixture("bash", false, { status, runCommand: null }, true)
    const code = await f.cleanup().prototypeCode(1, f.saved.artifact)
    expect(code.variants[0]!.runnable).toBe(false)
    expect(prototypePanelText(code.evidence, "en", true, code.variants)).toBe(`alpha: ${status}`)
    const comparison = await prototypeComparison(code.evidence, "en", code.variants)
    expect(comparison).toContain(`Compact view · ${status} · 1 files changed`)
    expect(comparison).toContain("cwd (project-relative):")
    expect(comparison).toContain("Run command not reported yet")
    expect(comparison).not.toContain("Code removed or unavailable")
    const display = await runDisplay(f)
    await expect(display.run()).rejects.toThrow("has not reported a valid run command")
    expect(display.print).not.toHaveBeenCalled()
    expect(await f.readReceipts()).toBeUndefined()
  })
}

test("prototype content changes, symlinks and forged permanent paths cannot expand deletion scope", async () => {
  const f = await fixture()
  const preview = await f.prototype()
  await writeFile(path.join(f.directory, "demo.ts"), "new content")
  await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow(
    "preview changed",
  )
  await symlink(path.join(f.repo, "code.txt"), path.join(f.directory, "outside.txt"))
  await expect(f.prototype()).rejects.toThrow(/redirected/)
  await rm(path.join(f.directory, "outside.txt"))
  const forged = { ...preview, directory: path.join(f.repo, ".amira", "project") }
  await expect(f.cleanup().removePrototype(forged, receipt(forged.subject))).rejects.toThrow(
    "preview changed",
  )
  expect(removals(f.commands)).toEqual([])
})

test("archived cleanup is administrative, while open active iterations cannot be cleaned", async () => {
  const f = await fixture()
  const lifecycle = new LifecycleStore(f.project())
  const state = await lifecycle.read()
  await lifecycle.transition(state.revision, { type: "archive-pending", receipt: lifecycleReceipt })
  const archived = await lifecycle.transition(state.revision + 1, {
    type: "archived",
    receipt: lifecycleReceipt,
  })
  const cleanup = new ProjectCleanup(archived, f.handle, "bash", { assertUnused: async () => {} })
  const preview = await cleanup.previewPrototype(1, f.saved.artifact, "alpha")
  expect(await cleanup.removePrototype(preview, receipt(preview.subject))).toBe("removed")
  const restored = await lifecycle.transition(state.revision + 2, {
    type: "restore",
    receipt: lifecycleReceipt,
  })
  const next = await new LifecycleStore(restored).transition(state.revision + 3, {
    type: "next-iteration",
    receipt: lifecycleReceipt,
  })
  const open = new ProjectCleanup(next, f.handle, "bash", { assertUnused: async () => {} })
  await expect(open.previewPrototype(2, f.saved.artifact, "alpha")).rejects.toThrow("closed iteration")
})

test("selected prototype deletion retains immutable manifest, selected-variant rationale and full decision history", async () => {
  const f = await fixture("bash", true)
  const reader = new HistoricalIterationReader(f.project(), 1)
  const before = await reader.readArtifact(f.saved.artifact)
  const decisions = await new DecisionStore(f.project()).records()
  expect(decisions[0]!.rationale).toBe("Easier to scan")
  expect(decisions[0]!.prototypeChoice?.variantId).toBe("alpha")
  const markdown = await readFile(path.join(f.repo, ".amira", "project", "decisions.md"), "utf8")
  const preview = await f.prototype()
  await f.cleanup().removePrototype(preview, receipt(preview.subject))
  expect(await reader.readArtifact(f.saved.artifact)).toEqual(before)
  expect(await new DecisionStore(f.project()).records()).toEqual(decisions)
  expect(await readFile(path.join(f.repo, ".amira", "project", "decisions.md"), "utf8")).toBe(markdown)
  expect((await f.cleanup().prototypeCode(1, f.saved.artifact)).variants[0]!.runCommand).toBeNull()
  const inputs = await specInputs(f.project(), await reader.read())
  expect(inputs.prototype?.pointer).toBeNull()
  expect(inputs.prototype?.codeStatus).toBe("removed")
  expect(inputs.prototype?.conclusion?.id).toBe(decisions[0]!.id)
})

test("ordinary branch -d failure is retained as partial cleanup without -D fallback", async () => {
  const f = await fixture()
  await f.git(f.root, 'commit --allow-empty -m "preserved but not merged to main"')
  await f.git(f.root, "tag preserved-iteration")
  const record = await f.record()
  record.preserved = {
    ref: "refs/tags/preserved-iteration",
    head: record.checkout.head,
    evidence: "Permanent local preservation tag receipt",
  }
  const preview = await f.cleanup().previewGit(record)
  await f.cleanup().removeWorktree(preview, receipt(preview.subjects.worktree))
  await expect(f.cleanup().removeBranch(preview, receipt(preview.subjects.branch))).rejects.toThrow(
    /not fully merged/,
  )
  expect(await f.git(f.repo, `rev-parse ${quote(f.branch, "bash")}`)).toBe(record.checkout.head)
  const saved = (await f.readReceipts()) as { removals: { status: string }[] }
  expect(saved.removals.map((row) => row.status)).toEqual(["removed", "uncertain"])
  expect(removals(f.commands)).toHaveLength(2)
  expect(f.commands.join("\n")).not.toMatch(/--force|\s-D\b/)
})

test("requested crash receipts suppress runnable claims and reject replay before effects", async () => {
  const f = await fixture()
  const preview = await f.prototype()
  await new ProjectDocumentStore(f.project()).update(
    "cleanup.json",
    () => ({
      schemaVersion: 1,
      projectId: f.project().marker.id,
      removals: [
        {
          subject: preview.subject,
          scope: { iteration: 1, kind: "prototype", path: f.directory },
          approval: receipt(preview.subject),
          preview,
          status: "requested",
        },
      ],
    }),
    { administrative: true },
  )
  const code = await f.cleanup().prototypeCode(1, f.saved.artifact)
  expect(code.variants[0]!.status).toBe("unavailable")
  expect(code.variants[0]!.runnable).toBe(false)
  await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow("never replay")
  expect(removals(f.commands)).toEqual([])
})

test("malformed removal evidence fails closed and is preserved byte-for-byte", async () => {
  const f = await fixture()
  const file = path.join(f.repo, ".amira", "project", "cleanup.json")
  const bytes = '{"schemaVersion":999,"projectId":"foreign","removals":[]}'
  await writeFile(file, bytes)
  await expect(f.cleanup().prototypeCode(1, f.saved.artifact)).rejects.toThrow("Malformed cleanup")
  const preview = await f.prototype()
  await expect(f.cleanup().removePrototype(preview, receipt(preview.subject))).rejects.toThrow(
    "Malformed cleanup",
  )
  expect(await readFile(file, "utf8")).toBe(bytes)
  expect(removals(f.commands)).toEqual([])
})
