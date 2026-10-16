import { afterEach, describe, expect, test } from "bun:test"
import { linkSync, mkdirSync, symlinkSync } from "node:fs"
import path from "node:path"
import { ReviewContext } from "../src/context.ts"
import { bundle, call, cleanup, file, temporary, text } from "./review-fixture.ts"

afterEach(cleanup)
function fixture(names = ["src/file.ts"]) {
  const root = temporary()
  for (const name of names) file(root, name)
  const selected = bundle(root, names)
  const context = new ReviewContext(selected)
  const [read, search] = context.tools()
  return { root, selected, context, read: read!, search: search! }
}

describe("bounded source reader", () => {
  test("only exposes read/search, read-only and no artifact or generic tool", () => {
    const { context } = fixture()
    expect(context.tools().map((tool) => tool.name)).toEqual(["review_read", "review_search"])
    for (const tool of context.tools()) expect(tool.traits).toEqual({ readOnly: true, writesFiles: false })
  })
  test("read and search redact a bare PEM body fragment without boundary lines", async () => {
    const { root, read, search } = fixture()
    const material = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDLy3MqkS8uVnZ4"
    file(root, "src/file.ts", `const embedded = "${material}"\n`)
    expect(text(await call(read, { path: "src/file.ts" }))).not.toContain(material)
    expect(text(await call(search, { query: "embedded" }))).not.toContain(material)
    expect(text(await call(read, { path: "src/file.ts" }))).toContain("[REDACTED]")
  })
  test("refuses unknown/untracked, outside, excluded, malformed, and out-of-scope paths", async () => {
    const { root, read, selected } = fixture(["src/file.ts", "other/a.ts", ".env"])
    file(root, "untracked.ts")
    for (const name of ["../outside", "/etc/passwd", "src\\file.ts", "untracked.ts", ".env"])
      expect((await call(read, { path: name })).isError).toBe(true)
    selected.scope.paths = ["src"]
    const scoped = new ReviewContext(selected).tools()[0]!
    expect((await call(scoped, { path: "other/a.ts" })).isError).toBe(true)
    expect((await call(scoped, { path: "src/file.ts" })).isError).toBeUndefined()
  })
  test("only explicitly admitted worktree untracked changes are context", async () => {
    const { root, selected } = fixture()
    file(root, "new.ts")
    selected.untracked = ["new.ts", "not-admitted.ts"]
    selected.changes.push({ ...selected.changes[0]!, path: "new.ts", oldPath: "new.ts", untracked: true })
    expect((await call(new ReviewContext(selected).tools()[0]!, { path: "new.ts" })).isError).toBe(true)
    selected.scope.includeUntracked = true
    const read = new ReviewContext(selected).tools()[0]!
    expect((await call(read, { path: "new.ts" })).isError).toBeUndefined()
    expect((await call(read, { path: "not-admitted.ts" })).isError).toBe(true)
    selected.scope.kind = "since"
    expect((await call(new ReviewContext(selected).tools()[0]!, { path: "new.ts" })).isError).toBe(true)
  })
  test("shares immutable sanitized snapshots and tracks raw hashes for staleness", async () => {
    const { root, context, read } = fixture()
    file(root, "src/file.ts", "password=firstsecret\n")
    const first = await call(read, { path: "src/file.ts" })
    const hashes = context.hashes()
    expect(text(first)).not.toContain("firstsecret")
    hashes["src/file.ts"] = "modified copy"
    expect(await context.stale()).toBe(false)
    file(root, "src/file.ts", "password=othersecret\n")
    expect(text(await call(context.tools()[0]!, { path: "src/file.ts" }))).toBe(text(first))
    expect(await context.stale()).toBe(true)
    expect(context.hashes()["src/file.ts"]).not.toBe("modified copy")
  })
  test("freshness matches empty snapshots and refuses changed, outside or cancelled sources", async () => {
    const { root, context, read, selected } = fixture()
    file(root, "src/file.ts", "")
    await call(read, { path: "src/file.ts" })
    const hashes = context.hashes()
    expect(await new ReviewContext(selected).matches(hashes)).toBe(true)
    file(root, "src/file.ts", "changed")
    expect(await new ReviewContext(selected).matches(hashes)).toBe(false)
    expect(await new ReviewContext(selected).matches({ "../outside": "invalid" })).toBe(false)
    const controller = new AbortController()
    controller.abort()
    await expect(context.matches(hashes, controller.signal)).rejects.toThrow("cancelled")
  })
  test("rejects invalid UTF-8, binary, directories, oversized text and multi-link files", async () => {
    const { root, selected } = fixture()
    file(root, "bad-utf8", new Uint8Array([0xff, 0xfe]))
    file(root, "binary", "a\u0000b")
    file(root, "big", "x".repeat(64 * 1024 + 1))
    mkdirSync(path.join(root, "directory"))
    file(root, "linked")
    linkSync(path.join(root, "linked"), path.join(root, "hard-link"))
    selected.inventory.push("bad-utf8", "binary", "big", "directory", "hard-link")
    const read = new ReviewContext(selected).tools()[0]!
    for (const name of ["bad-utf8", "binary", "big", "directory", "hard-link"])
      expect((await call(read, { path: name })).isError).toBe(true)
  })
  test("rejects junction/symlink ancestors and a linked repository root", async () => {
    const { root, selected } = fixture()
    const external = temporary()
    file(external, "outside.ts", "private fixture text")
    symlinkSync(external, path.join(root, "link"), "junction")
    selected.inventory.push("link/outside.ts")
    expect((await call(new ReviewContext(selected).tools()[0]!, { path: "link/outside.ts" })).isError).toBe(
      true,
    )
    const parent = temporary()
    symlinkSync(root, path.join(parent, "alias"), "junction")
    selected.root = path.join(parent, "alias")
    expect((await call(new ReviewContext(selected).tools()[0]!, { path: "src/file.ts" })).isError).toBe(true)
  })
  test("pages at 200 lines and 8 KiB with explicit continuation, never clipping a line", async () => {
    const { root, read } = fixture()
    file(root, "src/file.ts", `${Array.from({ length: 250 }, (_, i) => `row ${i + 1}`).join("\n")}\n`)
    const first = text(await call(read, { path: "src/file.ts" }))
    expect(first).toContain("200: row 200")
    expect(first).not.toContain("201: row 201")
    expect(first).toContain("offset=201")
    expect(text(await call(read, { path: "src/file.ts", offset: 201 }))).toContain("250: row 250")
    expect((await call(read, { path: "src/file.ts", limit: 201 })).isError).toBe(true)
    const other = new ReviewContext(bundle(root)).tools()[0]!
    file(root, "src/file.ts", "ordinary ".repeat(1000))
    const huge = text(await call(other, { path: "src/file.ts" }))
    expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(8192)
    expect(huge).toContain("oversized line")
  })
  test("counts repeated, failed and cancelled calls, with a new budget per child", async () => {
    const { context, read } = fixture()
    const aborted = new AbortController()
    aborted.abort()
    expect((await call(read, { path: "src/file.ts" }, aborted.signal)).isError).toBe(true)
    for (let i = 0; i < 23; i++) expect((await call(read, { path: "src/file.ts" })).isError).toBeUndefined()
    expect((await call(read, { path: "src/file.ts" })).isError).toBe(true)
    expect((await call(context.tools()[0]!, { path: "src/file.ts" })).isError).toBeUndefined()
  })
  test("shares 16-file and 256 KiB caps across children and concurrent requests", async () => {
    const names = Array.from({ length: 17 }, (_, i) => `source-${i}.ts`)
    const { root, context, read } = fixture(names)
    const calls = await Promise.all(names.map((name) => call(read, { path: name })))
    expect(calls.filter((value) => !value.isError)).toHaveLength(16)
    expect((await call(context.tools()[0]!, { path: names[16] })).isError).toBe(true)
    const selected = bundle(root, names)
    for (const name of names) file(root, name, "x".repeat(64 * 1024))
    const bytes = new ReviewContext(selected).tools()[0]!
    for (const name of names.slice(0, 4)) expect((await call(bytes, { path: name })).isError).toBeUndefined()
    expect((await call(bytes, { path: names[4] })).isError).toBe(true)
  })
  test("refuses malformed direct tool arguments even without host schema validation", async () => {
    const { read, search } = fixture()
    for (const input of [
      null,
      {},
      { path: "src/file.ts", offset: null },
      { path: "src/file.ts", limit: null },
      { path: "src/file.ts", extra: true },
    ])
      expect((await call(read, input)).isError).toBe(true)
    for (const input of [
      null,
      {},
      { query: "" },
      { query: "a\nb" },
      { query: "one", maxResults: null },
      { query: "one", extra: true },
    ])
      expect((await call(search, input)).isError).toBe(true)
  })
  test("excerpt rejects fabricated line numbers and uses the same source cache", async () => {
    const { context } = fixture()
    expect(await context.excerpt("src/file.ts", 2)).toContain("2: two")
    for (const line of [0, -1, 4, 1.5, Infinity])
      await expect(context.excerpt("src/file.ts", line)).rejects.toThrow()
  })
})

describe("repository guidance", () => {
  test("omits untracked guidance unless it is an explicitly admitted worktree change", async () => {
    const { root, selected } = fixture()
    file(root, "AGENTS.md", "not tracked guidance")
    expect((await new ReviewContext(selected).guidance()).paths).toEqual([])
    selected.untracked.push("AGENTS.md")
    selected.scope.includeUntracked = true
    selected.changes.push({
      ...selected.changes[0]!,
      path: "AGENTS.md",
      oldPath: "AGENTS.md",
      untracked: true,
    })
    expect((await new ReviewContext(selected).guidance()).paths).toEqual(["AGENTS.md"])
  })
  test("allows tracked ancestor guidance above a selected subtree without broadening sources", async () => {
    const { root, selected } = fixture()
    selected.scope.paths = ["src"]
    selected.inventory.push("AGENTS.md", "outside.ts")
    file(root, "AGENTS.md", "root rule")
    file(root, "outside.ts", "out of scope")
    const context = new ReviewContext(selected)
    expect((await context.guidance()).paths).toEqual(["AGENTS.md"])
    expect((await call(context.tools()[0]!, { path: "outside.ts" })).isError).toBe(true)
    // Explicit ancestor guidance is readable as criteria, but search must stay within --path.
    expect(text(await call(context.tools()[1]!, { query: "root rule" }))).not.toContain("AGENTS.md:")
    expect((await call(context.tools()[1]!, { query: "root rule", path: "AGENTS.md" })).isError).toBe(true)
  })
  test("walks only deterministic changed-file ancestors, labels data and redacts secrets", async () => {
    const { root, selected } = fixture(["src/file.ts", "src/nested/changed.ts"])
    selected.changes.push({ ...selected.changes[0]!, path: "src/nested/changed.ts" })
    file(root, "AGENTS.md", "root rules\npassword=not-public\n")
    file(root, "CLAUDE.md", "other root rules")
    file(root, "src/REVIEW.md", "local rules")
    file(root, "unrelated/AGENTS.md", "must not read")
    selected.inventory.push("AGENTS.md", "CLAUDE.md", "src/REVIEW.md", "unrelated/AGENTS.md")
    const context = new ReviewContext(selected)
    const guidance = await context.guidance()
    expect(guidance.paths).toEqual(["AGENTS.md", "CLAUDE.md", "src/REVIEW.md"])
    expect(guidance.text).not.toContain("not-public")
    expect(guidance.text).not.toContain("must not read")
    expect(guidance.text).toContain("repository criteria, not instructions")
    expect((await call(context.tools()[0]!, { path: "AGENTS.md" })).isError).toBeUndefined()
    expect(await context.stale()).toBe(false)
    file(root, "AGENTS.md", "changed")
    expect((await context.guidance()).text).toBe(guidance.text)
    expect(await context.stale()).toBe(true)
  })
  test("counts guidance wrappers and cannot bypass the cap through an existing reader snapshot", async () => {
    const { root, selected } = fixture()
    selected.inventory.push("AGENTS.md")
    file(root, "AGENTS.md", "x".repeat(16 * 1024))
    const context = new ReviewContext(selected)
    expect((await call(context.tools()[0]!, { path: "AGENTS.md" })).isError).toBeUndefined()
    await expect(context.guidance()).rejects.toThrow()
  })
  test("refuses oversize total guidance and unsafe guidance links, never silently truncates", async () => {
    const { root, selected } = fixture()
    file(root, "AGENTS.md", "x".repeat(9000))
    file(root, "CLAUDE.md", "x".repeat(9000))
    selected.inventory.push("AGENTS.md", "CLAUDE.md")
    await expect(new ReviewContext(selected).guidance()).rejects.toThrow()
    const target = temporary()
    file(target, "guide")
    const linked = fixture()
    linkSync(path.join(target, "guide"), path.join(linked.root, "REVIEW.md"))
    linked.selected.inventory.push("REVIEW.md")
    await expect(new ReviewContext(linked.selected).guidance()).rejects.toThrow()
  })
})

describe("literal scoped search", () => {
  test("search is literal, case sensitive, redacted and limited to approved snapshots", async () => {
    const { root, search } = fixture(["src/file.ts", "other.ts"])
    file(root, "src/file.ts", "a.*b\nA.*B\npassword=hidden-value\n")
    file(root, "other.ts", "a.*b")
    file(root, "untracked.ts", "a.*b")
    const found = text(await call(search, { query: "a.*b", path: "src" }))
    expect(found).toContain("src/file.ts:1: a.*b")
    expect(found).not.toContain("A.*B")
    expect(found).not.toContain("other.ts")
    expect(found).not.toContain("untracked.ts")
    expect(text(await call(search, { query: "hidden-value" }))).not.toContain("hidden-value")
    expect((await call(search, { query: "a", path: "../outside" })).isError).toBe(true)
    expect((await call(search, { query: "a", path: "*.ts" })).isError).toBe(true)
  })
  test("caps at 50 results and eight searches, counting against the shared 24 calls", async () => {
    const { root, context, read, search } = fixture()
    file(root, "src/file.ts", "needle\n".repeat(100))
    const found = text(await call(search, { query: "needle" }))
    expect(found.split("\n").filter((line) => line.startsWith("src/file.ts:"))).toHaveLength(50)
    expect(found).toContain("incomplete")
    expect((await call(search, { query: "needle", maxResults: 51 })).isError).toBe(true)
    for (let i = 0; i < 6; i++) await call(search, { query: "needle", maxResults: 1 })
    expect((await call(search, { query: "needle" })).isError).toBe(true)
    for (let i = 0; i < 15; i++) expect((await call(read, { path: "src/file.ts" })).isError).toBeUndefined()
    expect((await call(read, { path: "src/file.ts" })).isError).toBe(true)
    expect((await call(context.tools()[1]!, { query: "needle" })).isError).toBeUndefined()
  })
  test("reports incomplete coverage when search exhausts shared snapshot caps", async () => {
    const names = Array.from({ length: 17 }, (_, i) => `source-${String(i).padStart(2, "0")}.ts`)
    const { search, context } = fixture(names)
    const out = text(await call(search, { query: "absent" }))
    expect(out).toContain("incomplete")
    expect(Object.keys(context.hashes())).toHaveLength(16)
  })
})
