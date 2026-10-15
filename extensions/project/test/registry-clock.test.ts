import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProject, Registry, readProject } from "../src/store.ts"

test("an explicitly reopened healthy project wins over a stale same-ID future-clock registry entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-registry-clock-"))
  try {
    const old = path.join(root, "old")
    await mkdir(old)
    const project = await createProject(old, "Moved")
    const data = path.join(root, "data")
    await mkdir(data)
    await writeFile(
      path.join(data, "registry.json"),
      JSON.stringify([
        { id: project.marker.id, root: old, name: "Moved", lastUsed: "2999-01-01T00:00:00.000Z" },
      ]),
    )
    const moved = path.join(root, "moved")
    await rename(old, moved)
    const registry = new Registry(data)
    await registry.remember(await readProject(moved))
    expect(await registry.list()).toEqual([expect.objectContaining({ id: project.marker.id, root: moved })])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
