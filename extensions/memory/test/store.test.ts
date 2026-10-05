import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { MemoryStore, projectKey } from "../src/store.ts"
import { fact, gitResult, sandbox, signal } from "./helpers.ts"

test("main checkout, subdirectories and linked worktrees share a safe readable key", async () => {
  const h = sandbox()
  try {
    const main = path.join(h.cwd, "Readable Project")
    const sub = path.join(main, "src")
    const linked = path.join(h.cwd, "linked")
    mkdirSync(sub, { recursive: true })
    mkdirSync(linked)
    const key = await projectKey(main, gitResult(".git\n", 0), signal())
    expect(key).toMatch(/^readable-project-[a-f0-9]{12}$/)
    expect(await projectKey(sub, gitResult("../.git\n", 0), signal())).toBe(key)
    expect(await projectKey(linked, gitResult(path.join(main, ".git"), 0), signal())).toBe(key)
    const failed = await projectKey(main, gitResult("fatal: not a repository", 128), signal())
    expect(failed).toBe(key)
    expect(await projectKey(linked, gitResult(), signal())).not.toBe(key)
    const sameBase = path.join(h.root, "other", "Readable Project")
    mkdirSync(sameBase, { recursive: true })
    expect(await projectKey(sameBase, gitResult(), signal())).not.toBe(key)
    expect(
      await projectKey(
        main,
        async (argv, options) => {
          expect(argv).toEqual(["git", "rev-parse", "--git-common-dir"])
          expect(options.cwd).toBe(main)
          expect(options.stdoutOnly).toBe(true)
          throw new Error("git missing")
        },
        signal(),
      ),
    ).toBe(failed)
  } finally {
    h.cleanup()
  }
})

test("create, replace and delete keep the authoritative index synchronized", async () => {
  const h = sandbox()
  try {
    const store = new MemoryStore(h.dataDir, "project", "example-012345678abc")
    expect(store.dir).toBe(path.join(h.dataDir, "projects", "example-012345678abc"))
    expect((await store.snapshot()).memories).toEqual([])
    expect(existsSync(store.dir)).toBe(false)
    const saved = await store.write(fact(), 0, signal())
    expect((await store.read(saved.name)).text).toBe(saved.text)
    const indexFile = path.join(store.dir, "MEMORY.md")
    expect(readFileSync(indexFile, "utf8")).toContain(
      "[writing-style](writing-style.md) — Preferred writing style",
    )
    const updated = await store.write(
      { ...fact(), description: "Updated preference", body: "The user now prefers more detail." },
      0,
      signal(),
    )
    expect((await store.read(updated.name)).text).toBe(updated.text)
    expect((await store.snapshot()).memories).toHaveLength(1)
    expect(readFileSync(indexFile, "utf8")).not.toContain("Preferred writing style")
    expect((await store.snapshot()).needsRepair).toBe(false)
    await store.delete(updated.name, 0, signal())
    expect((await store.snapshot()).memories).toHaveLength(0)
    expect(readFileSync(indexFile, "utf8")).not.toContain("writing-style")
    expect(readdirSync(store.dir)).toEqual(["MEMORY.md"])
    expect(readdirSync(h.cwd)).toEqual([])
  } finally {
    h.cleanup()
  }
})

test("missing, damaged and externally stale indexes recover without read side effects", async () => {
  const h = sandbox()
  try {
    const store = new MemoryStore(h.dataDir, "global", "test")
    mkdirSync(store.dir)
    const { serialize } = await import("../src/format.ts")
    writeFileSync(store.file("writing-style"), serialize(fact()).text)
    const first = await store.snapshot()
    expect(first.needsRepair).toBe(true)
    expect(first.index).toContain("writing-style")
    expect(existsSync(path.join(store.dir, "MEMORY.md"))).toBe(false)
    writeFileSync(path.join(store.dir, "MEMORY.md"), "damaged index with untrusted content")
    const before = readdirSync(store.dir)
    expect((await store.snapshot()).index).toBe(first.index)
    await store.read("writing-style")
    expect(readdirSync(store.dir)).toEqual(before)
    expect(readFileSync(path.join(store.dir, "MEMORY.md"), "utf8")).toBe(
      "damaged index with untrusted content",
    )
    await store.write(fact("second-memory"), 0, signal())
    expect((await store.snapshot()).needsRepair).toBe(false)
    const newText = serialize({ ...fact(), description: "Manually changed hook" }).text
    writeFileSync(store.file("writing-style"), newText)
    expect((await store.snapshot()).index).toContain("Manually changed hook")
    expect(readFileSync(path.join(store.dir, "MEMORY.md"), "utf8")).not.toContain("Manually changed hook")
    writeFileSync(path.join(store.dir, "invalid.md"), "not frontmatter")
    expect((await store.snapshot()).invalid).toBe(1)
  } finally {
    h.cleanup()
  }
})

test("subagents and unknown callers cannot mutate or repair storage", async () => {
  const h = sandbox()
  try {
    const store = new MemoryStore(h.dataDir, "global", "test")
    for (const depth of [1, 2, undefined]) {
      await expect(store.write(fact(), depth, signal())).rejects.toThrow("Subagents are read-only")
      await expect(store.delete("writing-style", depth, signal())).rejects.toThrow("Subagents are read-only")
      expect(existsSync(store.dir)).toBe(false)
    }
    await store.write(fact(), 0, signal())
    const index = path.join(store.dir, "MEMORY.md")
    writeFileSync(index, "damaged")
    await expect(store.write(fact(), 1, signal())).rejects.toThrow()
    await store.snapshot()
    expect(readFileSync(index, "utf8")).toBe("damaged")
    expect(existsSync(path.join(store.dir, ".memory.lock"))).toBe(false)
  } finally {
    h.cleanup()
  }
})

test("bad names, secrets and aborted writes create no storage", async () => {
  const h = sandbox()
  try {
    const store = new MemoryStore(h.dataDir, "global", "test")
    await expect(store.write(fact("../escape"), 0, signal())).rejects.toThrow()
    await expect(store.write({ ...fact(), body: "password=secret" }, 0, signal())).rejects.toThrow()
    const abort = new AbortController()
    abort.abort()
    await expect(store.write(fact(), 0, abort.signal)).rejects.toThrow()
    expect(existsSync(store.dir)).toBe(false)
    expect(() => new MemoryStore(h.dataDir, "project", "../escape")).toThrow()
  } finally {
    h.cleanup()
  }
})

test("global and project collisions are independent", async () => {
  const h = sandbox()
  try {
    const global = new MemoryStore(h.dataDir, "global", "test")
    const project = new MemoryStore(h.dataDir, "project", "test")
    expect(global.dir).toBe(path.join(h.dataDir, "global"))
    expect(project.dir).toBe(path.join(h.dataDir, "projects", "test"))
    await global.write(fact(), 0, signal())
    await project.write({ ...fact(), body: "A project-specific fact." }, 0, signal())
    expect((await global.read("writing-style")).body).not.toBe((await project.read("writing-style")).body)
    await project.delete("writing-style", 0, signal())
    expect((await global.read("writing-style")).name).toBe("writing-style")
  } finally {
    h.cleanup()
  }
})

test("atomic writes use only reported temp names and never overwrite abandoned temps", async () => {
  const h = sandbox()
  try {
    const store = new MemoryStore(h.dataDir, "global", "test")
    await store.write(fact(), 0, signal())
    const temps = store.writtenPaths("writing-style", "write").filter((file) => file.endsWith(".tmp"))
    expect(temps).toHaveLength(2)
    for (const temp of temps) {
      writeFileSync(temp, "abandoned; do not overwrite")
      await expect(store.write(fact(), 0, signal())).rejects.toThrow()
      expect(readFileSync(temp, "utf8")).toBe("abandoned; do not overwrite")
      expect((await store.read("writing-style")).body).toBe(fact().body)
      expect(existsSync(path.join(store.dir, ".memory.lock"))).toBe(false)
      unlinkSync(temp)
      await store.write(fact(), 0, signal())
    }
    const indexTemp = store.writtenPaths("writing-style", "delete").find((file) => file.endsWith(".tmp"))!
    writeFileSync(indexTemp, "abandoned index")
    await expect(store.delete("writing-style", 0, signal())).rejects.toThrow()
    expect(readFileSync(indexTemp, "utf8")).toBe("abandoned index")
    expect(existsSync(store.file("writing-style"))).toBe(false)
    expect((await store.snapshot()).needsRepair).toBe(true)
    unlinkSync(indexTemp)
    await store.write(fact(), 0, signal())
    expect((await store.snapshot()).needsRepair).toBe(false)
    expect(readdirSync(store.dir).sort()).toEqual(["MEMORY.md", "writing-style.md"])
  } finally {
    h.cleanup()
  }
})

test("directory symlinks/junctions cannot redirect storage into a repository", async () => {
  const h = sandbox()
  try {
    const store = new MemoryStore(h.dataDir, "global", "test")
    symlinkSync(h.cwd, store.dir, process.platform === "win32" ? "junction" : "dir")
    await expect(store.write(fact(), 0, signal())).rejects.toThrow("real directories")
    await expect(store.snapshot()).rejects.toThrow("real directories")
    expect(readdirSync(h.cwd)).toEqual([])
  } finally {
    h.cleanup()
  }
})
