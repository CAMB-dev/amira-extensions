import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProject, discoverProject, LifecycleStore, Registry, readProject } from "../src/store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "project-archive-discovery-"))
  roots.push(root)
  return root
}
const receipt = { id: "end-project", sessionId: "main", date: "2026-10-21T00:00:00Z" }
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await snapshot(file)))
        result[`${entry.name}/${name}`] = content
    } else result[entry.name] = (await readFile(file)).toString("base64")
  }
  return result
}

test("archive-pending and archived markers hide stale registry projections without writes", async () => {
  const root = await directory()
  await mkdir(path.join(root, "project"))
  await mkdir(path.join(root, "visible"))
  const project = await createProject(path.join(root, "project"), "Hidden")
  const visible = await createProject(path.join(root, "visible"), "Visible")
  const registry = new Registry(path.join(root, "registry"))
  await registry.remember(project)
  await registry.remember(visible)
  await new LifecycleStore(project).transition(0, { type: "archive-pending", receipt })
  let before = await snapshot(root)
  expect((await registry.list()).map((entry) => entry.name)).toEqual(["Visible"])
  expect((await registry.list({ includeArchived: true })).map((entry) => entry.name).sort()).toEqual([
    "Hidden",
    "Visible",
  ])
  expect(await snapshot(root)).toEqual(before)
  await new LifecycleStore(project).transition(1, { type: "archived", receipt })
  before = await snapshot(root)
  expect((await registry.list()).map((entry) => entry.name)).toEqual(["Visible"])
  expect(await snapshot(root)).toEqual(before)
})

test("archived nearest discovery never substitutes an outer active project", async () => {
  const root = await directory()
  await createProject(root, "Outer")
  await mkdir(path.join(root, "inner"))
  const inner = await createProject(path.join(root, "inner"), "Inner")
  const cwd = path.join(inner.root, "nested")
  await mkdir(cwd)
  await new LifecycleStore(inner).transition(0, { type: "archive-pending", receipt })
  const archived = await new LifecycleStore(inner).transition(1, { type: "archived", receipt })
  const before = await snapshot(root)
  expect(await discoverProject(cwd)).toBeUndefined()
  expect(await discoverProject(cwd, { includeArchived: true })).toEqual(archived)
  expect(await snapshot(root)).toEqual(before)
})

test("a stale moved-root registry projection cannot resurrect an archived identity", async () => {
  const root = await directory()
  const oldRoot = path.join(root, "old")
  await mkdir(oldRoot)
  const project = await createProject(oldRoot, "Moved archive")
  const registry = new Registry(path.join(root, "registry"))
  await registry.remember(project)
  const movedRoot = path.join(root, "moved")
  await rename(oldRoot, movedRoot)
  const moved = await readProject(movedRoot, project.marker.id)
  await registry.remember(moved)
  await new LifecycleStore(moved).transition(0, { type: "archive-pending", receipt })
  await new LifecycleStore(moved).transition(1, { type: "archived", receipt })
  const before = await snapshot(root)
  expect(await registry.list()).toEqual([])
  const explicit = await registry.list({ includeArchived: true })
  expect(explicit).toHaveLength(1)
  expect(explicit[0]?.root).toBe(moved.root)
  expect(await snapshot(root)).toEqual(before)
}, 60000)

test("listing absent registry storage is inert", async () => {
  const root = await directory()
  const before = await snapshot(root)
  expect(await new Registry(path.join(root, "absent")).list({ includeArchived: true })).toEqual([])
  expect(await snapshot(root)).toEqual(before)
})
