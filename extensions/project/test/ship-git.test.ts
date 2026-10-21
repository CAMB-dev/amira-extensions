import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { WorktreeArtifact } from "../src/artifacts.ts"
import { quote, type Shell } from "../src/iteration-git.ts"
import { runCandidateCheck } from "../src/ship-checkout.ts"
import {
  commitShipCandidate,
  mergeShipCandidate,
  pinShipGit,
  prepareShipCandidate,
  probeShipCheckout,
  probeShipCommit,
  runShipCheck,
  verifyShipCandidate,
  verifyShipIntegration,
  verifyUnchangedShipSource,
  verifyUnchangedShipTarget,
} from "../src/ship-git.ts"
import { ownedFixture } from "./owned-fixture.ts"

setDefaultTimeout(120_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
async function fixture(shell: Shell = "bash") {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "ship git's-")))
  homes.push(home)
  const repo = path.join(home, "repo")
  await mkdir(repo)
  const gitPath = Bun.which("git")!
  const bash =
    process.platform === "win32"
      ? (["../bin/bash.exe", "../../usr/bin/bash.exe", "../usr/bin/bash.exe"]
          .map((part) => path.resolve(path.dirname(gitPath), part))
          .find(existsSync) ?? "bash")
      : "bash"
  // Fixture-only config isolation: no user keys, hooks, credentials, global config or ~/.amira.
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "empty-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  })
  const commands: string[] = []
  async function execute(command: string, kind: Shell = shell) {
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
  async function git(root: string, args: string) {
    const result = await execute(`git -C ${quote(root, "bash")} ${args}`, "bash")
    if (result.isError) throw new Error(result.content[0]!.text)
    return result.content[0]!.text.trim()
  }
  await git(repo, "init -b main")
  await git(repo, 'config user.name "Offline Ship Fixture"')
  await git(repo, 'config user.email "ship@invalid.local"')
  await writeFile(path.join(repo, "approved.txt"), "base\n")
  await writeFile(path.join(repo, "unrelated.txt"), "base\n")
  await git(repo, "add -A")
  await git(repo, 'commit -m "base"')
  const base = await git(repo, "rev-parse HEAD")
  const root = path.join(home, ".amira-project-worktrees", "fixture", "iteration-1")
  await git(repo, `worktree add -b iteration ${quote(root, "bash")}`)
  const worktree: WorktreeArtifact = {
    kind: "iteration-worktree",
    status: "ready",
    repository: repo,
    root,
    cwd: root,
    branch: "iteration",
    base,
    excluded: "",
    confirmation: "Fixture",
    setupKey: "ship-fixture",
  }
  const handle = ownedFixture({ key: "ship-fixture", cwd: root })
  handle.runTool = async (name, args, options) => {
    if (options?.signal?.aborted)
      return { content: [], isError: true, details: { exitCode: null, aborted: true } }
    if (name !== shell) throw new Error("Unexpected tool")
    commands.push(String(args.command))
    return execute(String(args.command))
  }
  async function write(name: string, value: string, directory = root) {
    await writeFile(path.join(directory, name), value)
  }
  async function candidate(paths = ["approved.txt"]) {
    return prepareShipCandidate(handle, shell, await pinShipGit(handle, shell, worktree, repo), paths)
  }
  async function index() {
    return readFile(path.join((await probeShipCheckout(handle, shell, root)).gitDir, "index"))
  }
  async function hook(name: string, body: string) {
    const hooks = path.join(repo, ".git", "hooks")
    await writeFile(path.join(hooks, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  return { home, repo, root, base, worktree, handle, shell, git, write, candidate, index, hook, commands }
}

test("reviewed uncommitted files commit exactly; existing partial/unrelated staging stays byte-identical; ff and recovery probes", async () => {
  const f = await fixture()
  await f.write("approved.txt", "staged older\n")
  await f.git(f.root, "add approved.txt")
  await f.write("approved.txt", "reviewed newer\n")
  await f.write("unrelated.txt", "unrelated staged\n")
  await f.git(f.root, "add unrelated.txt")
  const unusual = "new 'quoted' $(file).txt"
  await f.write(unusual, "new reviewed\n")
  await f.write("not-reviewed.txt", "leave untracked\n")
  const before = await f.index()
  const candidate = await f.candidate(["approved.txt", unusual])
  expect(await f.index()).toEqual(before)
  const commit = await commitShipCandidate(f.handle, f.shell, candidate, "Ship exact reviewed work")
  expect(commit.tree).toBe(candidate.tree)
  expect(await f.index()).toEqual(before)
  expect(await f.git(f.root, `show ${commit.head}:approved.txt`)).toBe("reviewed newer")
  expect(await f.git(f.root, `show ${commit.head}:unrelated.txt`)).toBe("base")
  expect(await probeShipCommit(f.handle, f.shell, f.root, commit.head)).toEqual(commit)
  const integrated = await mergeShipCandidate(f.handle, f.shell, candidate, commit, "ff-only")
  expect(integrated.head).toBe(commit.head)
  expect(await verifyShipIntegration(f.handle, f.shell, candidate.pin, commit.head)).toEqual(integrated)
  expect(await f.index()).toEqual(before)
  expect(
    f.commands.every(
      (command) => !/--force|--no-verify|--no-gpg-sign|hooksPath|gpgsign=false|HUSKY=0/.test(command),
    ),
  ).toBe(true)
})

test("deletions are included only when explicitly reviewed", async () => {
  const f = await fixture()
  await rm(path.join(f.root, "approved.txt"))
  const candidate = await f.candidate()
  const commit = await commitShipCandidate(f.handle, f.shell, candidate, "Reviewed deletion")
  expect(await f.git(f.root, `ls-tree --name-only ${commit.head}`)).toBe("unrelated.txt")
})

test("dirty targets, source/index edits, and moved source/target reject before mutation", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n")
  await f.write("dirty.txt", "dirty", f.repo)
  await expect(f.candidate()).rejects.toThrow("Dirty ship target")
  await rm(path.join(f.repo, "dirty.txt"))
  const candidate = await f.candidate()
  await f.write("approved.txt", "changed after checks\n")
  await expect(verifyShipCandidate(f.handle, f.shell, candidate)).rejects.toThrow("candidate changed")
  await f.write("approved.txt", "reviewed\n")
  await f.git(f.root, "add approved.txt")
  await expect(commitShipCandidate(f.handle, f.shell, candidate, "No stale index")).rejects.toThrow(
    "candidate changed",
  )
  const current = await f.candidate()
  await f.git(f.repo, 'commit --allow-empty -m "target moved"')
  await expect(commitShipCandidate(f.handle, f.shell, current, "No moved target")).rejects.toThrow("moved")
  const next = await f.candidate()
  await f.git(f.root, 'commit --allow-empty -m "source moved"')
  await expect(commitShipCandidate(f.handle, f.shell, next, "No moved source")).rejects.toThrow("moved")
})

test("hook failure is not bypassed and leaves HEAD/index intact", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n")
  const candidate = await f.candidate()
  const before = await f.index()
  await f.hook("pre-commit", 'echo "fixture hook refuses" >&2; exit 1')
  await expect(commitShipCandidate(f.handle, f.shell, candidate, "Blocked")).rejects.toThrow(
    "fixture hook refuses",
  )
  expect(await f.git(f.root, "rev-parse HEAD")).toBe(f.base)
  expect(await f.index()).toEqual(before)
})

test("hook-modified tree is detected after the effect; read-only probes recover actual commit", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n")
  const candidate = await f.candidate()
  const before = await f.index()
  await f.hook("pre-commit", "printf 'hook changed\\n' > approved.txt\ngit add approved.txt")
  await expect(commitShipCandidate(f.handle, f.shell, candidate, "Hook alters")).rejects.toThrow(
    "Actual commit tree/parent differs",
  )
  const current = await probeShipCheckout(f.handle, f.shell, f.root)
  expect(current.head).not.toBe(f.base)
  expect((await probeShipCommit(f.handle, f.shell, f.root, current.head)).tree).not.toBe(candidate.tree)
  expect(await f.index()).toEqual(before)
})

test("signer failure stops without unsigned fallback", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n")
  await f.git(f.repo, "config commit.gpgsign true")
  await f.git(f.repo, "config gpg.program fixture-nonexistent-signer")
  const candidate = await f.candidate()
  const before = await f.index()
  await expect(commitShipCandidate(f.handle, f.shell, candidate, "Signed or stop")).rejects.toThrow("sign")
  expect(await f.git(f.root, "rev-parse HEAD")).toBe(f.base)
  expect(await f.index()).toEqual(before)
  expect(f.commands.filter((command) => command.includes("git commit"))).toHaveLength(1)
})

test("normal divergent merge preserves repository hooks and reports the different integrated tree", async () => {
  const f = await fixture()
  await f.write("target-only.txt", "target\n", f.repo)
  await f.git(f.repo, "add target-only.txt")
  await f.git(f.repo, 'commit -m "target work"')
  await f.write("approved.txt", "source\n")
  const candidate = await f.candidate()
  const commit = await commitShipCandidate(f.handle, f.shell, candidate, "Source")
  await f.hook("pre-merge-commit", "printf 'ran' > .git-hook-proof")
  // Hook intentionally creates an untracked file, so the post-merge dirty check blocks.
  await expect(mergeShipCandidate(f.handle, f.shell, candidate, commit, "merge")).rejects.toThrow(
    "Dirty ship target",
  )
  expect(await readFile(path.join(f.repo, ".git-hook-proof"), "utf8")).toBe("ran")
  await rm(path.join(f.repo, ".git-hook-proof"))
  const merged = await verifyShipIntegration(f.handle, f.shell, candidate.pin, commit.head)
  expect(merged.parents).toEqual([candidate.pin.target.head, commit.head])
  expect(merged.tree).not.toBe(candidate.tree)
  await f.git(f.repo, 'commit --allow-empty -m "unapproved movement"')
  await expect(verifyShipIntegration(f.handle, f.shell, candidate.pin, commit.head)).rejects.toThrow(
    "moved beyond",
  )
})

test("conflicts and unsupported explicit repairs are retained, never reset or delivered", async () => {
  const f = await fixture()
  await f.write("approved.txt", "target conflict\n", f.repo)
  await f.git(f.repo, "add approved.txt")
  await f.git(f.repo, 'commit -m "target"')
  await f.write("approved.txt", "source conflict\n")
  const candidate = await f.candidate()
  const commit = await commitShipCandidate(f.handle, f.shell, candidate, "Source")
  await expect(mergeShipCandidate(f.handle, f.shell, candidate, commit, "merge")).rejects.toThrow("CONFLICT")
  expect(await f.git(f.repo, "rev-parse MERGE_HEAD")).toBe(commit.head)
  expect(f.commands.some((command) => /merge --abort|reset|stash/.test(command))).toBe(false)
  // An explicit repair can have exactly the expected parents and still contain
  // unsupported delivered inputs. Preserve that commit, but never attest it.
  await f.write("approved.txt", "resolved\n", f.repo)
  await f.git(f.repo, "add approved.txt")
  await mkdir(path.join(f.repo, "module"))
  await f.git(f.repo, `update-index --add --cacheinfo 160000,${f.base},module`)
  await f.git(f.repo, 'commit -m "Explicit repair with unsupported gitlink"')
  const repaired = await f.git(f.repo, "rev-parse HEAD")
  expect(await f.git(f.repo, "status --porcelain=v1 --ignore-submodules=none")).toBe("")
  await expect(verifyShipIntegration(f.handle, f.shell, candidate.pin, commit.head)).rejects.toThrow(
    /submodules|special/,
  )
  expect(await f.git(f.repo, "rev-parse HEAD")).toBe(repaired)
  expect(f.commands.some((command) => /merge --abort|reset --hard|stash|--force/.test(command))).toBe(false)
})

test("unsafe paths, directories, ignored files and unsupported submodules fail closed", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n")
  const pin = await pinShipGit(f.handle, f.shell, f.worktree, f.repo)
  for (const name of ["../outside", ".", ".git/config", ":(glob)*", "a\\b", "bad\nname", ""]) {
    await expect(prepareShipCandidate(f.handle, f.shell, pin, [name])).rejects.toThrow("Unsafe ship path")
  }
  await f.write(".gitignore", "ignored.txt\n")
  await f.write("ignored.txt", "secret")
  await expect(prepareShipCandidate(f.handle, f.shell, pin, ["ignored.txt"])).rejects.toThrow("exact tracked")
  await mkdir(path.join(f.root, "folder"))
  await expect(prepareShipCandidate(f.handle, f.shell, pin, ["folder"])).rejects.toThrow("exact tracked")
  await f.git(f.root, `update-index --add --cacheinfo 160000,${f.base},submodule`)
  await expect(f.candidate()).rejects.toThrow("submodules")
})

test("owned check evidence records exact cwd and failure/cancellation; checks never imply approval", async () => {
  const f = await fixture()
  const checkout = await probeShipCheckout(f.handle, f.shell, f.root)
  const failed = await runShipCheck(f.handle, f.shell, checkout, ".", "printf 'suite failed'; exit 7")
  expect(failed).toMatchObject({ ok: false, exitCode: 7, cwd: f.root, output: "suite failed" })
  const controller = new AbortController()
  controller.abort()
  expect(
    await runShipCheck(f.handle, f.shell, checkout, ".", "exit 0", controller.signal).catch(
      () => "cancelled",
    ),
  ).toBe("cancelled")
  await expect(runShipCheck(f.handle, f.shell, checkout, "..", "exit 0")).rejects.toThrow("escapes")
})

test("plan denial never falls back; unchanged source/target support negative reconciliation", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n")
  const candidate = await f.candidate()
  const original = f.handle.runTool.bind(f.handle)
  const denied: string[] = []
  f.handle.runTool = async (name, args, options) => {
    const command = String(args.command)
    if (command.includes("git commit")) {
      denied.push(command)
      return {
        content: [{ type: "text", text: "Plan permission denies mutation" }],
        isError: true,
        details: { exitCode: null },
      }
    }
    return original(name, args, options)
  }
  await expect(commitShipCandidate(f.handle, f.shell, candidate, "Must remain uncommitted")).rejects.toThrow(
    "Plan permission denies",
  )
  expect(await f.git(f.root, "rev-parse HEAD")).toBe(f.base)
  expect(denied).toHaveLength(1)
  await verifyUnchangedShipSource(f.handle, f.shell, candidate.pin)
  await verifyUnchangedShipTarget(f.handle, f.shell, candidate.pin)
  expect(
    denied.every(
      (command) => !/--force|--no-verify|--no-gpg-sign|gpgsign=false|hooksPath|HUSKY=0/.test(command),
    ),
  ).toBe(true)
})

test("isolated source checks cannot pass using excluded dirty files and remove only their own checkout", async () => {
  const f = await fixture()
  await f.write("approved.txt", "accepted\n")
  await f.write("unrelated.txt", "excluded-dependency\n")
  await f.git(f.root, "add unrelated.txt")
  const candidate = await f.candidate()
  const index = await f.index()
  const checkRoot = path.join(f.home, "candidate-checks")
  const result = await runCandidateCheck(
    f.handle,
    f.shell,
    candidate,
    checkRoot,
    ".",
    "grep -q excluded-dependency unrelated.txt",
  )
  expect(result).toMatchObject({
    ok: false,
    exitCode: 1,
    tree: candidate.tree,
    checkoutRoot: checkRoot,
    cwd: checkRoot,
  })
  expect(existsSync(checkRoot)).toBe(false)
  expect(await f.index()).toEqual(index)
  expect(await readFile(path.join(f.root, "unrelated.txt"), "utf8")).toBe("excluded-dependency\n")
  expect(await f.git(f.root, "rev-parse HEAD")).toBe(candidate.pin.source.head)
  expect(f.commands.some((command) => command.includes("git worktree add --detach --no-checkout"))).toBe(true)
  expect(f.commands.some((command) => command.includes("git worktree remove"))).toBe(true)
  expect(
    f.commands.every(
      (command) => !/--force|--no-verify|--no-gpg-sign|reset --hard|hooksPath|HUSKY=0/.test(command),
    ),
  ).toBe(true)
})

test("isolated successful receipts bind tree and cwd; dirty or cleanup-denied worktrees stay blocked and retained", async () => {
  const f = await fixture()
  await f.write("approved.txt", "accepted\n")
  const candidate = await f.candidate()
  const checkRoot = path.join(f.home, "candidate-checks")
  const index = await f.index()
  const passed = await runCandidateCheck(
    f.handle,
    f.shell,
    candidate,
    checkRoot,
    ".",
    "grep -q accepted approved.txt",
  )
  expect(passed).toMatchObject({ ok: true, tree: candidate.tree, cwd: checkRoot })
  expect(existsSync(checkRoot)).toBe(false)
  const dirty = await runCandidateCheck(
    f.handle,
    f.shell,
    candidate,
    checkRoot,
    ".",
    "printf changed > approved.txt",
  )
  expect(dirty.ok).toBe(false)
  expect(dirty.output).toContain("retained")
  expect(existsSync(checkRoot)).toBe(true)
  expect(await f.index()).toEqual(index)
  expect(await readFile(path.join(f.root, "approved.txt"), "utf8")).toBe("accepted\n")
  await expect(runCandidateCheck(f.handle, f.shell, candidate, checkRoot, ".", "exit 0")).rejects.toThrow(
    "already exists",
  )
  const cleanupRoot = path.join(f.home, "cleanup-denied")
  const original = f.handle.runTool.bind(f.handle)
  f.handle.runTool = async (name, args, options) =>
    String(args.command).includes("git worktree remove")
      ? {
          content: [{ type: "text", text: "Cleanup policy denial" }],
          isError: true,
          details: { exitCode: null },
        }
      : original(name, args, options)
  const denied = await runCandidateCheck(f.handle, f.shell, candidate, cleanupRoot, ".", "exit 0")
  expect(denied).toMatchObject({ ok: false, tree: candidate.tree })
  expect(denied.output).toContain("Cleanup policy denial")
  expect(existsSync(cleanupRoot)).toBe(true)
  expect(await f.index()).toEqual(index)
})

test("PowerShell quoting and temporary-index environment also preserve the real index", async () => {
  if (!Bun.which("pwsh")) return
  const f = await fixture("powershell")
  await f.write("approved.txt", "reviewed\n")
  const before = await f.index()
  const candidate = await f.candidate()
  const checkRoot = path.join(f.home, "PowerShell check's")
  const checked = await runCandidateCheck(f.handle, f.shell, candidate, checkRoot, ".", "git diff --quiet")
  expect(checked).toMatchObject({ ok: true, tree: candidate.tree, cwd: checkRoot })
  expect(existsSync(checkRoot)).toBe(false)
  expect(await f.index()).toEqual(before)
  const commit = await commitShipCandidate(f.handle, f.shell, candidate, "PowerShell exact candidate")
  expect(commit.tree).toBe(candidate.tree)
  expect(await f.index()).toEqual(before)
}, 300_000)
