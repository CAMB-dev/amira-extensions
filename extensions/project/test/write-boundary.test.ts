import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProject, saveResearchNote, writeDocument } from "../src/store.ts"

for (const boundary of ["root", "ancestor"] as const) {
  test(`moving the captured ${boundary} itself outside and junctioning it back cannot redirect either writer`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "project-moved-boundary-"))
    try {
      const parent = path.join(home, "captured")
      const root = path.join(parent, "project")
      await mkdir(root, { recursive: true })
      const project = await createProject(root, "Captured identity")
      const outside = path.join(home, "outside")
      await mkdir(outside)
      const moved = path.join(outside, "relocated")
      const replaced = boundary === "root" ? root : parent
      // This is the SAME original tree/inode, not a copy with a different marker identity.
      await rename(replaced, moved)
      await symlink(moved, replaced, process.platform === "win32" ? "junction" : "dir")
      const movedRoot = boundary === "root" ? moved : path.join(moved, "project")
      const documents = path.join(movedRoot, ".amira", "project")
      await expect(writeDocument(project, "design.md", "OUTSIDE WRITE")).rejects.toThrow()
      await expect(saveResearchNote(project, "Outside note", "OUTSIDE WRITE")).rejects.toThrow()
      expect(await readFile(path.join(documents, "design.md"), "utf8")).toBe("")
      expect(await readdir(path.join(documents, "research"))).toEqual([])
      await rm(replaced)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}
