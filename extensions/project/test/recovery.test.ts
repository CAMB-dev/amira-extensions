import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProject, DecisionStore } from "../src/store.ts"

test("manual reversion to a previous generated ledger is still a hand edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-ledger-reversion-"))
  try {
    const project = await createProject(root, "History")
    const store = new DecisionStore(project)
    const question = [
      {
        question: "Store?",
        options: [
          { label: "Local", description: "Offline but manual backup" },
          { label: "Remote", description: "Sync but needs server" },
        ],
      },
    ]
    await store.record(question, [{ selected: ["Local"] }], {
      sessionId: "design",
      askId: "first",
      language: "en",
    })
    const file = path.join(root, ".amira", "project", "decisions.md")
    const old = await readFile(file, "utf8")
    await store.record(question, [{ selected: ["Remote"] }], {
      sessionId: "design",
      askId: "second",
      language: "en",
      supersedes: ["D1"],
    })
    // Both the second Markdown write AND its manifest succeeded. A subsequent revert is a real edit.
    await writeFile(file, old)
    const recovery = await store.recover()
    expect(recovery.conflict).toBe(true)
    expect(await readFile(file, "utf8")).toBe(old)
    expect(await readFile(recovery.path, "utf8")).toContain("D2")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
