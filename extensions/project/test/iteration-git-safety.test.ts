import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { quote } from "../src/iteration-git.ts"
import { runSpec } from "../src/spec.ts"
import { IterationStore, readProject } from "../src/store.ts"
import { pinWorktreeDestination, projectComponent } from "../src/worktree-paths.ts"
import { fixture, git } from "./implement-fixture.ts"

setDefaultTimeout(120_000)
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.implementations.quiesce(f.project)
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function setup() {
  const f = await fixture()
  fixtures.push(f)
  return f
}

for (const level of ["parent", "project"] as const) {
  test(`a pre-existing destination ${level} junction is rejected before worktree add or branch creation`, async () => {
    const f = await setup()
    const target = path.join(f.repo, "redirected-checkout")
    await mkdir(target)
    const parent = path.join(f.home, ".amira-project-worktrees")
    if (level === "project") await mkdir(parent)
    const link = level === "parent" ? parent : path.join(parent, f.project.marker.id)
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
    await f.approve()
    f.answers.push(true)
    await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
      /redirect|canonical|destination/i,
    )
    expect(f.commands.some((entry) => entry.command.includes("git worktree add"))).toBe(false)
    expect(await git(f.repo, 'branch --list "amira/project/*"')).toBe("")
    expect(await Bun.file(path.join(target, "iteration-1", ".git")).exists()).toBe(false)
    await rm(link)
  })
}

test("destination ancestor pins reject an ordinary directory replaced during base confirmation", async () => {
  const f = await setup()
  const parent = path.join(f.home, ".amira-project-worktrees")
  await mkdir(parent)
  await f.approve()
  f.answers.push(async () => {
    await rename(parent, `${parent}.original`)
    await mkdir(parent)
    return true
  })
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(/replaced|identity/i)
  expect(f.commands.some((entry) => entry.command.includes("git worktree add"))).toBe(false)
})

test("a slash-leading persisted project ID cannot choose a worktree path or ref structure", async () => {
  const f = await setup()
  const selected = path.join(f.home, "id-selected")
  const markerFile = path.join(f.root, ".amira", "project.json")
  const marker = JSON.parse(await readFile(markerFile, "utf8"))
  marker.id = selected.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/")
  await writeFile(markerFile, JSON.stringify(marker))
  const project = await readProject(f.root)
  f.answers.push("Approve spec and batch plan")
  await runSpec(
    f.api,
    project,
    f.ctx,
    "en",
    () => {},
    async () => {},
  )
  f.answers.push("Use displayed commit and explicitly exclude ALL local changes")
  await f.implementations.run(project, f.ctx, "en", () => {})
  await f.settled()
  const store = new IterationStore(project)
  const state = await store.read()
  const saved = await store.readArtifact(
    state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!,
  )
  if (saved.kind !== "iteration-worktree") throw new Error("Missing worktree")
  const relative = path.relative(path.join(f.home, ".amira-project-worktrees"), saved.root)
  expect(relative.startsWith("..")).toBe(false)
  expect(path.isAbsolute(relative)).toBe(false)
  expect(relative.split(path.sep)).toHaveLength(2)
  expect(saved.branch.split("/")).toHaveLength(4)
  expect(await Bun.file(path.join(selected, "iteration-1", ".git")).exists()).toBe(false)
})

async function submodule(f: Awaited<ReturnType<typeof fixture>>, ignore: string) {
  const source = path.join(f.home, "local-submodule-source")
  await mkdir(source)
  await git(source, "init")
  await git(source, 'config user.name "Submodule Fixture"')
  await git(source, 'config user.email "submodule@invalid.local"')
  await git(source, "config commit.gpgsign false")
  await writeFile(path.join(source, "tracked.txt"), "base\n")
  await git(source, 'add -A && git commit -m "Local submodule base"')
  await git(f.repo, `-c protocol.file.allow=always submodule add ${quote(source, "bash")} lib`)
  await git(f.repo, 'commit -m "Local submodule fixture"')
  await git(f.repo, `config submodule.lib.ignore ${ignore}`)
  return path.join(f.repo, "lib")
}

for (const [ignore, contents] of [
  ["all", "mixed"],
  ["dirty", "mixed"],
  ["untracked", "untracked"],
  ["all", "head"],
] as const) {
  test(`submodule ignore=${ignore} cannot hide ${contents} inputs from the dirty-tree gate`, async () => {
    const f = await setup()
    const lib = await submodule(f, ignore)
    if (contents === "mixed") {
      await writeFile(path.join(lib, "tracked.txt"), "staged\n")
      await git(lib, "add tracked.txt")
      await writeFile(path.join(lib, "tracked.txt"), "unstaged\n")
    }
    if (contents === "head") {
      await git(lib, 'config user.name "Submodule Fixture"')
      await git(lib, 'config user.email "submodule@invalid.local"')
      await git(lib, "config commit.gpgsign false")
      await writeFile(path.join(lib, "tracked.txt"), "new head\n")
      await git(lib, 'add -A && git commit -m "Submodule HEAD changed"')
    } else await writeFile(path.join(lib, "untracked.txt"), "not committed\n")
    await f.approve()
    f.answers.push("Stop and resolve local changes")
    await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow("Git setup stopped")
    expect(f.dialogs).toContain("Dirty tree blocks implementation")
    expect(f.prints.join("\n")).toContain("lib")
    expect(f.commands.some((entry) => entry.command.includes("git worktree add"))).toBe(false)
    f.answers.push("Use displayed commit and explicitly exclude ALL local changes")
    await f.implementations.run(f.project, f.ctx, "en", () => {})
    await f.settled()
    const state = await f.store.read()
    const saved = await f.store.readArtifact(
      state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")!,
    )
    expect(saved.kind === "iteration-worktree" && saved.excluded.includes("lib")).toBe(true)
  })
}

test("the confirmation recheck also ignores submodule ignore settings", async () => {
  const f = await setup()
  const lib = await submodule(f, "all")
  await f.approve()
  f.answers.push(async () => {
    await writeFile(path.join(lib, "appeared-during-confirmation.txt"), "must block\n")
    return true
  })
  await expect(f.implementations.run(f.project, f.ctx, "en", () => {})).rejects.toThrow(
    "changed during confirmation",
  )
  expect(f.commands.some((entry) => entry.command.includes("git worktree add"))).toBe(false)
})

for (const id of [
  "/outside",
  "../outside",
  "..\\outside",
  "C:\\outside",
  "file:stream",
  "con",
  "MixedCase",
  "..",
  ".",
]) {
  test(`opaque project ID ${JSON.stringify(id)} is a single safe deterministic component`, () => {
    const component = projectComponent(id)
    expect(component).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
    expect(component).not.toBe(id)
    expect(projectComponent(id)).toBe(component)
    expect(component.toLowerCase()).not.toBe(projectComponent(`${id}different`).toLowerCase())
  })
}
test("canonical external paths outside the designated parent are independently refused", async () => {
  const f = await setup()
  await expect(
    pinWorktreeDestination(f.repo, path.join(f.home, "other", "safe-id", "iteration-1")),
  ).rejects.toThrow("designated")
})
