import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { MemoryStore } from "../src/store.ts"
import { sandbox } from "./helpers.ts"

test("two independent processes serialize writes, replacements, deletes and index repair", async () => {
  const h = sandbox()
  const store = new MemoryStore(h.dataDir, "global", "test")
  mkdirSync(store.dir)
  writeFileSync(path.join(store.dir, "MEMORY.md"), "damaged")
  const children = ["alpha", "beta"].map((id) => {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures", "writer.ts"), h.home, id, h.root],
      {
        cwd: h.cwd,
        env: { ...process.env, AMIRA_HOME: h.home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    return { child, out: new Response(child.stdout).text(), err: new Response(child.stderr).text() }
  })
  const timer = setTimeout(() => {
    for (const { child } of children) child.kill()
  }, 100_000)
  try {
    const deadline = Date.now() + 30_000
    while (!["alpha", "beta"].every((id) => existsSync(path.join(h.root, `${id}.ready`)))) {
      if (Date.now() > deadline) throw new Error("Writers did not reach the start barrier")
      await Bun.sleep(10)
    }
    writeFileSync(path.join(h.root, "start"), "go")
    for (const { child, out, err } of children) {
      const [code, stdout, stderr] = await Promise.all([child.exited, out, err])
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
    }
    const snapshot = await store.snapshot()
    expect(snapshot.memories).toHaveLength(25)
    expect(snapshot.invalid).toBe(0)
    expect(snapshot.needsRepair).toBe(false)
    expect(readFileSync(path.join(store.dir, "MEMORY.md"), "utf8")).toBe(snapshot.index)
    expect(new Set(snapshot.memories.map((m) => m.name)).size).toBe(25)
    expect(
      snapshot.memories.every((m) => m.body === "The user prefers examples too." || m.name === "shared"),
    ).toBe(true)
    expect(readdirSync(store.dir).filter((name) => name.startsWith("."))).toEqual([])
  } finally {
    clearTimeout(timer)
    for (const { child } of children) {
      if (child.exitCode === null) child.kill()
    }
    await Promise.all(children.map(({ child }) => child.exited))
    h.cleanup()
  }
}, 120_000)
