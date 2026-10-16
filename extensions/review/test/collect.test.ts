import { afterAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ArtifactInfo, OwnedConversation, ToolDefinition, ToolResult } from "@amira/api"
import {
  artifactTool,
  collect,
  fingerprint,
  type ReviewScope,
  type Shell,
  selectShell,
} from "../src/collect.ts"
import { ReviewContext } from "../src/context.ts"

const home = mkdtempSync(join(tmpdir(), "review-collect-home-"))
const previousHome = process.env.AMIRA_HOME
process.env.AMIRA_HOME = home
const directories: string[] = [home]
const bash: Shell = { name: "bash", kind: "bash" }
const signal = () => new AbortController().signal
const worktree = (paths: string[] = [], includeUntracked = false): ReviewScope => ({
  kind: "worktree",
  paths,
  includeUntracked,
})
const since = (ref: string, paths: string[] = []): ReviewScope => ({
  kind: "since",
  ref,
  paths,
  includeUntracked: false,
})

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Fixture git ${args.join(" ")}: ${err}`)
  return out.trimEnd()
}
async function put(root: string, path: string, text: string | Uint8Array) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}
async function repo(files: Record<string, string> = { "tracked.ts": "before\n" }, commit = true) {
  const root = await mkdtemp(join(tmpdir(), "review-collect-'é-"))
  directories.push(root)
  await git(root, "init", "-b", "main")
  await git(root, "config", "user.name", "Review Tests")
  await git(root, "config", "user.email", "review@example.invalid")
  await git(root, "config", "core.autocrlf", "false")
  await git(root, "config", "core.filemode", "true")
  await git(root, "config", "commit.gpgsign", "false")
  for (const [path, text] of Object.entries(files)) await put(root, path, text)
  if (commit) {
    await git(root, "add", "--all")
    await git(root, "commit", "-m", "fixture")
  }
  return root
}

function result(raw: string, kind: Shell["kind"] = "bash", code = 0): ToolResult {
  const printed = raw.trimEnd()
  return {
    content: [
      {
        type: "text",
        text: `${kind === "powershell" ? "Shell: PowerShell 7\n\n" : ""}${printed || "(no output)"}\n\nExit code: ${code}`,
      },
    ],
    isError: code !== 0,
    details: {
      exitCode: code,
      shellKind: kind,
      timedOut: false,
      aborted: false,
      settled: true,
      outputLines: printed ? printed.split("\n").length : 0,
    },
  }
}

type FakeOptions = {
  shell?: Shell
  artifact?: "complete" | "incomplete" | "pruned" | "foreign" | "missing-store" | "oversized" | "missing-file"
  intercept?: (command: string, call: number) => ToolResult | undefined | Promise<ToolResult | undefined>
}
function owned(cwd: string, options: FakeOptions = {}) {
  const shell = options.shell ?? bash
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const artifacts = new Map<string, ArtifactInfo>()
  const owner = {
    id: "test-owner",
    cwd,
    async runTool(
      name: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<ToolResult> {
      calls.push({ name, args })
      opts?.signal?.throwIfAborted()
      if (name === "review_artifact") {
        return artifactTool().execute(args, {
          cwd,
          signal: opts?.signal ?? signal(),
          toolCallId: "artifact-call",
          update() {},
          session: {
            sessionId: "test-owner",
            depth: 0,
            maxDepth: 1,
            model: { provider: "test", model: "none" },
            deferredTools: () => [],
            loadTools: () => [],
            outputs:
              options.artifact === "missing-store"
                ? undefined
                : {
                    limits: { saveAbove: 0, previewChars: 1 },
                    find: (id: string) => artifacts.get(id),
                    async save() {
                      throw new Error("Not used by the owner-only reader")
                    },
                  },
          },
        })
      }
      if (name !== shell.name)
        throw new Error(`Unexpected tool ${name}; no raw command fallback is available`)
      expect(args.timeout).toBe(30_000)
      expect(args.background).toBe(false)
      const command = String(args.command)
      const intercepted = await options.intercept?.(command, calls.length)
      if (intercepted) return intercepted
      const executable = Bun.which(shell.kind === "bash" ? "bash" : "pwsh")
      if (!executable) throw new Error("Test shell is unavailable")
      const argv =
        shell.kind === "bash"
          ? [executable, "--noprofile", "--norc", "-c", command]
          : [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      const child = Bun.spawn(argv, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AMIRA_HOME: home },
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const raw = err + out
      const response = result(raw, shell.kind, code)
      if (options.artifact && code === 0) {
        const id = `a_${calls.length.toString(16)}`
        const path = join(home, `output-${id}.txt`)
        const printed = raw.trimEnd()
        await writeFile(path, printed)
        artifacts.set(id, {
          id,
          path: options.artifact === "missing-file" ? `${path}-absent` : path,
          tool: shell.name,
          sessionId: options.artifact === "foreign" ? "another-session" : "test-owner",
          chars: printed.length,
          bytes: options.artifact === "oversized" ? 3 * 1024 * 1024 : Buffer.byteLength(printed),
          lines: printed.split("\n").length,
          complete: options.artifact !== "incomplete",
          ...(options.artifact === "pruned" ? { pruned: new Date().toISOString() } : {}),
          createdAt: new Date().toISOString(),
        })
        response.content = [
          {
            type: "text",
            text: "An artifact preview that is deliberately not parseable as Git output.\n\nExit code: 0",
          },
        ]
        response.details = { ...(response.details as object), artifact: id }
      }
      return response
    },
  } as unknown as OwnedConversation
  return { owner, calls }
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = previousHome
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })))
})

describe("owned Git collection", () => {
  test("projects complete old/new PEM spans onto middle-only hunks, even with short wrapped bodies", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString()
    const body = pem
      .split("\n")
      .filter((line) => line && !line.startsWith("-----"))
      .join("")
    const wrapped = body.match(/.{1,20}/g)!
    const source = [
      "export const embedded = `",
      "-----BEGIN PRIVATE KEY-----",
      ...wrapped,
      "-----END PRIVATE KEY-----",
      "`",
      "",
    ].join("\n")
    const root = await repo({ "config.ts": source })
    const middle = Math.floor(wrapped.length / 2)
    await put(root, "config.ts", source.replace(wrapped[middle]!, `${wrapped[middle]!} `))
    const bundle = await collect(owned(root).owner, bash, worktree(), signal())
    expect(bundle.patch).not.toContain("BEGIN PRIVATE KEY")
    expect(bundle.patch).not.toContain(wrapped[middle]!)
    expect(bundle.patch).not.toContain(wrapped[middle - 1]!)
    for (const bodyLine of wrapped) expect(bundle.patch).not.toContain(bodyLine)
    expect(bundle.patch).toContain("-[REDACTED]")
    expect(bundle.patch).toContain("+[REDACTED]")
    await git(root, "add", "config.ts")
    await git(root, "commit", "-qm", "temporary PEM whitespace fixture")
    const committed = await collect(owned(root).owner, bash, since("HEAD~1"), signal())
    expect(committed.patch).not.toContain(wrapped[middle]!)
    expect(committed.patch).not.toContain(wrapped[middle - 1]!)
  }, 60000)

  test("refuses a small patch when complete privacy source is oversized or unavailable", async () => {
    const source = "ordinary source line\n".repeat(4000)
    const root = await repo({ "config.ts": source })
    await put(root, "config.ts", `changed line\n${source.slice(source.indexOf("\n") + 1)}`)
    const oversized = owned(root)
    await expect(collect(oversized.owner, bash, worktree(), signal())).rejects.toThrow(
      "Complete source for privacy exceeds 64 KiB",
    )
    expect(oversized.calls.some((call) => String(call.args.command).includes("'cat-file' 'blob'"))).toBe(
      false,
    )
    const small = await repo({ "config.ts": "before\n" })
    await put(small, "config.ts", "after\n")
    const unavailable = owned(small, {
      intercept: (command) =>
        command.includes("'cat-file' 'blob'")
          ? result("missing object\n\n__AMIRA_REVIEW_END__", "bash", 128)
          : undefined,
    })
    await expect(collect(unavailable.owner, bash, worktree(), signal())).rejects.toThrow("Git collection")
  }, 60000)

  test("file-scoped admitted untracked changes retain ancestor guidance and fingerprint its content", async () => {
    const root = await repo({
      "src/REVIEW.md": "Preserve the project contract.\n",
      "tracked.ts": "unchanged\n",
    })
    await put(root, "src/new.ts", "export const created = true\n")
    const { owner } = owned(root)
    const selected = worktree(["src/new.ts"], true)
    const bundle = await collect(owner, bash, selected, signal())
    expect(bundle.changes.map((change) => change.path)).toEqual(["src/new.ts"])
    expect((await new ReviewContext(bundle).guidance()).paths).toEqual(["src/REVIEW.md"])
    await put(root, "src/REVIEW.md", "Changed review criteria.\n")
    expect(await fingerprint(owner, bash, bundle, signal())).not.toBe(bundle.fingerprint)
    const excluded = await collect(owner, bash, worktree(["src/new.ts"]), signal())
    expect(excluded.changes).toHaveLength(0)
  }, 60000)

  test("reviews net HEAD-to-worktree, not the concatenated staged and unstaged patches", async () => {
    const root = await repo()
    await put(root, "tracked.ts", "intermediate\n")
    await git(root, "add", "tracked.ts")
    await put(root, "tracked.ts", "after\n")
    const { owner, calls } = owned(root)
    const bundle = await collect(owner, bash, worktree(), signal())
    expect(bundle.patch).toContain("-before\n+after\n")
    expect(bundle.patch).not.toContain("intermediate")
    expect(bundle.added).toBe(1)
    expect(bundle.removed).toBe(1)
    expect(bundle.changes[0]!.hunks).toEqual([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }])
    expect(calls.length).toBeGreaterThan(10)
    expect(calls.every((call) => call.name === "bash")).toBe(true)
    expect(calls.every((call) => String(call.args.command).includes("GIT_NO_LAZY_FETCH='1'"))).toBe(true)
    expect(calls.every((call) => String(call.args.command).includes("GIT_ALLOW_PROTOCOL=''"))).toBe(true)
    expect(await fingerprint(owner, bash, bundle, signal())).toBe(bundle.fingerprint)
    await put(root, "tracked.ts", "other\n")
    expect(await fingerprint(owner, bash, bundle, signal())).not.toBe(bundle.fingerprint)
  }, 60_000)

  test("lists index-only intermediate changes without reviewing them, and fingerprints the index", async () => {
    const root = await repo()
    await put(root, "tracked.ts", "intermediate\n")
    await git(root, "add", "tracked.ts")
    await put(root, "tracked.ts", "before\n")
    const { owner } = owned(root)
    const bundle = await collect(owner, bash, worktree(), signal())
    expect(bundle.changes).toEqual([])
    await git(root, "add", "tracked.ts")
    expect(await fingerprint(owner, bash, bundle, signal())).not.toBe(bundle.fingerprint)
  }, 60_000)

  test("handles staged additions/deletions, empty additions, complete no-newline hunks and final whitespace", async () => {
    const root = await repo({ "deleted.ts": "old", "space.ts": "old\n\n" })
    await rm(join(root, "deleted.ts"))
    await put(root, "new.ts", "new")
    await put(root, "empty.ts", "")
    await put(root, "space.ts", "next\n\n")
    await git(root, "add", "--all")
    const bundle = await collect(owned(root).owner, bash, worktree(), signal())
    expect(bundle.changes.find((entry) => entry.path === "deleted.ts")?.hunks).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 },
    ])
    expect(bundle.changes.find((entry) => entry.path === "new.ts")?.patch).toContain(
      "\\ No newline at end of file",
    )
    expect(bundle.changes.find((entry) => entry.path === "empty.ts")?.metadataOnly).toBe(true)
    expect(bundle.changes.find((entry) => entry.path === "space.ts")?.patch).toEndWith(" \n")
    expect(bundle.added).toBe(2)
    expect(bundle.removed).toBe(2)
  }, 60_000)

  test("literal path filtering works from subdirectories with spaces, apostrophes, and Unicode", async () => {
    const root = await repo({ "nested/it's é.ts": "old\n", "other.ts": "old\n" })
    await put(root, "nested/it's é.ts", "new\n")
    await put(root, "other.ts", "new\n")
    const bundle = await collect(owned(join(root, "nested")).owner, bash, worktree(["nested"]), signal())
    expect(bundle.inventory).toEqual(["nested/it's é.ts"])
    expect(bundle.changes.map((entry) => entry.path)).toEqual(["nested/it's é.ts"])
  }, 60_000)

  test("narrow scopes retain tracked ancestor guidance without outside source inventory and fingerprint its edits", async () => {
    const root = await repo({
      "src/file.ts": "old\n",
      "AGENTS.md": "root rules\n",
      "outside.ts": "outside\n",
    })
    await put(root, "src/file.ts", "new\n")
    const { owner } = owned(root)
    const bundle = await collect(owner, bash, worktree(["src"]), signal())
    expect(bundle.inventory).toContain("AGENTS.md")
    expect(bundle.inventory).not.toContain("outside.ts")
    await put(root, "AGENTS.md", "changed criteria\n")
    expect(await fingerprint(owner, bash, bundle, signal())).not.toBe(bundle.fingerprint)
  }, 60000)

  test("pins an ancestor once, supports detached HEAD, and refuses dirty since scope", async () => {
    const root = await repo()
    const base = await git(root, "rev-parse", "HEAD")
    await git(root, "branch", "it's-é")
    await put(root, "tracked.ts", "committed\n")
    await git(root, "commit", "-am", "second fixture")
    await git(root, "checkout", "--detach", "HEAD")
    const { owner, calls } = owned(root)
    const bundle = await collect(owner, bash, since("it's-é"), signal())
    expect(bundle.base).toBe(base)
    expect(bundle.head).not.toBe(base)
    expect(bundle.patch).toContain("+committed")
    expect(calls.filter((call) => String(call.args.command).includes("'--end-of-options'")).length).toBe(1)
    await put(root, "tracked.ts", "dirty\n")
    await expect(collect(owner, bash, since(base), signal())).rejects.toThrow("clean tracked")
  }, 60_000)

  test("refuses non-ancestor refs and unborn HEAD", async () => {
    const root = await repo()
    await git(root, "checkout", "-b", "other")
    await put(root, "tracked.ts", "other branch\n")
    await git(root, "commit", "-am", "other fixture")
    const other = await git(root, "rev-parse", "HEAD")
    await git(root, "checkout", "main")
    await expect(collect(owned(root).owner, bash, since(other), signal())).rejects.toThrow("ancestor")
    const unborn = await repo({}, false)
    await expect(collect(owned(unborn).owner, bash, worktree(), signal())).rejects.toThrow("Unborn HEAD")
  }, 60_000)

  test("untracked content defaults to omitted and is separately listed; opt-in uses the same privacy and hunk rules", async () => {
    const root = await repo()
    await put(root, "new.txt", "line one\nline two")
    await put(root, ".env", "PASSWORD=do-not-expose\n")
    await put(root, ".gitignore", "ignored.txt\n")
    await put(root, "ignored.txt", "ignored\n")
    const { owner } = owned(root)
    const omitted = await collect(owner, bash, worktree(), signal())
    expect(omitted.changes).toEqual([])
    expect(omitted.untracked).toContain("new.txt")
    expect(omitted.untracked).not.toContain("ignored.txt")
    const included = await collect(owner, bash, worktree([], true), signal())
    expect(included.changes.find((entry) => entry.path === "new.txt")?.untracked).toBe(true)
    expect(included.changes.find((entry) => entry.path === "new.txt")?.hunks).toEqual([
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
    ])
    expect(included.excluded.find((entry) => entry.path === ".env")?.reason).toBe("secret-bearing path")
    expect(included.patch).not.toContain("do-not-expose")
    await put(root, "new.txt", "same counts\nnew bytes")
    expect(await fingerprint(owner, bash, included, signal())).not.toBe(included.fingerprint)
  }, 60_000)

  test("excludes binary, lockfiles, secret paths and both sides of rename-as-delete/add", async () => {
    const root = await repo({
      "old.ts": "before\n",
      ".env": "OLD=value\n",
      "bun.lock": "old\n",
      "binary.dat": "text\n",
    })
    await git(root, "mv", "old.ts", "renamed.ts")
    await put(root, ".env", "PASSWORD=secret\n")
    await put(root, "bun.lock", "new\n")
    await put(root, "binary.dat", new Uint8Array([0, 1, 2]))
    const bundle = await collect(owned(root).owner, bash, worktree(), signal())
    expect(bundle.changes.map((entry) => [entry.path, entry.status])).toEqual([
      ["old.ts", "D"],
      ["renamed.ts", "A"],
    ])
    expect(bundle.excluded.map((entry) => entry.path)).toEqual([".env", "binary.dat", "bun.lock"])
    expect(bundle.inventory).not.toContain(".env")
  }, 60_000)

  test("redacts a multiline private key without damaging diff prefixes or hunk coordinates", async () => {
    const root = await repo()
    await put(
      root,
      "tracked.ts",
      "-----BEGIN PRIVATE KEY-----\nvery-secret-payload\n-----END PRIVATE KEY-----\n",
    )
    const bundle = await collect(owned(root).owner, bash, worktree(), signal())
    expect(bundle.patch).not.toContain("very-secret-payload")
    expect(bundle.patch).toContain("+[REDACTED]\n+[REDACTED]\n+[REDACTED]\n")
    expect(bundle.changes[0]!.hunks[0]!.newCount).toBe(3)
  }, 60_000)

  test("resolves complete artifacts only through the owner-runtime bridge, never a preview", async () => {
    const root = await repo()
    await put(root, "tracked.ts", "after\n")
    const { owner, calls } = owned(root, { artifact: "complete" })
    const bundle = await collect(owner, bash, worktree(), signal())
    expect(bundle.patch).toContain("+after")
    expect(calls.some((call) => call.name === "review_artifact")).toBe(true)
    for (const fault of [
      "incomplete",
      "pruned",
      "foreign",
      "missing-store",
      "oversized",
      "missing-file",
    ] as const) {
      await expect(
        collect(owned(root, { artifact: fault }).owner, bash, worktree(), signal()),
      ).rejects.toThrow("artifact")
    }
  }, 60_000)

  test("denials, failed saves, nonzero exits, dialect changes, timeouts and open pipes fail closed", async () => {
    const root = await repo()
    const failures: ToolResult[] = [
      { content: [{ type: "text", text: "Permission denied" }], isError: true },
      result("oops", "bash", 2),
      result("oops", "powershell"),
      { ...result("oops"), details: { ...(result("oops").details as object), timedOut: true } },
      { ...result("oops"), details: { ...(result("oops").details as object), aborted: true } },
      { ...result("oops"), details: { ...(result("oops").details as object), settled: false } },
      result("[Output too long: 99 characters, 1 lines. It could not be saved (disk full)]"),
    ]
    for (const failure of failures) {
      const { owner, calls } = owned(root, { intercept: () => failure })
      await expect(collect(owner, bash, worktree(), signal())).rejects.toThrow()
      expect(calls).toHaveLength(1)
    }
    const controller = new AbortController()
    controller.abort(new Error("cancelled fixture"))
    const fake = owned(root)
    await expect(collect(fake.owner, bash, worktree(), controller.signal)).rejects.toThrow(
      "cancelled fixture",
    )
    expect(fake.calls).toHaveLength(0)
  }, 60_000)

  test("enforces changed-line and file caps before patch reads, and never truncates a large patch", async () => {
    const root = await repo()
    await put(root, "tracked.ts", "new\n".repeat(2_001))
    const fake = owned(root)
    await expect(collect(fake.owner, bash, worktree(), signal())).rejects.toThrow("2,000")
    expect(fake.calls.every((call) => !String(call.args.command).includes("'--full-index'"))).toBe(true)
    await put(root, "tracked.ts", `${"x".repeat(33 * 1024)}\n`)
    await expect(collect(owned(root).owner, bash, worktree(), signal())).rejects.toThrow("32 KiB")
    await put(root, "tracked.ts", "before\n")
    for (let i = 0; i < 33; i++) await put(root, `new-${i}.ts`, "new\n")
    await expect(collect(owned(root).owner, bash, worktree([], true), signal())).rejects.toThrow("32 files")
  }, 60_000)

  test("rejects oversized inventories before patch reads and supports an empty change", async () => {
    const root = await repo()
    const { owner } = owned(root)
    const empty = await collect(owner, bash, worktree(), signal())
    expect(empty.patch).toBe("")
    expect(empty.changes).toEqual([])
    const fake = owned(root, {
      intercept: (command) =>
        command.includes("'--cached'")
          ? result(`${Array.from({ length: 10_001 }, (_, i) => `p${i}\0`).join("")}\n__AMIRA_REVIEW_END__\n`)
          : undefined,
    })
    await expect(collect(fake.owner, bash, worktree(), signal())).rejects.toThrow("10,000")
  }, 60_000)

  test("rejects ranges, option refs, unsafe pathspecs and control encodings before running Git", async () => {
    const fake = owned(home)
    for (const scope of [
      since("-HEAD"),
      since("HEAD~1..HEAD"),
      since("HEAD\nstatus"),
      worktree(["../outside"]),
      worktree([":(glob)*"]),
      worktree(["--output=outside"]),
      worktree(["x\ny"]),
      { ...since("HEAD"), includeUntracked: true },
    ]) {
      await expect(collect(fake.owner, bash, scope, signal())).rejects.toThrow()
    }
    expect(fake.calls).toHaveLength(0)
  })

  test("keeps complete independent hunks and rejects truncated or path-mismatched patches", async () => {
    const root = await repo({
      "tracked.ts": Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(""),
    })
    const original = await readFile(join(root, "tracked.ts"), "utf8")
    await put(
      root,
      "tracked.ts",
      original.replace("line 2\n", "changed 2\n").replace("line 35\n", "changed 35\n"),
    )
    const bundle = await collect(owned(root).owner, bash, worktree(), signal())
    expect(bundle.changes[0]!.hunks).toEqual([
      { oldStart: 1, oldCount: 5, newStart: 1, newCount: 5 },
      { oldStart: 32, oldCount: 7, newStart: 32, newCount: 7 },
    ])
    for (const patch of [
      "diff --git a/tracked.ts b/tracked.ts\n--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1,2 +1,2 @@\n-line 1\n+changed\n",
      "diff --git a/elsewhere.ts b/elsewhere.ts\n",
      "diff --git a/tracked.ts b/tracked.ts\n@@ -1 +1 @@\n-old\n+new\n",
    ]) {
      const fake = owned(root, {
        intercept: (command) =>
          command.includes("'--full-index'") ? result(`${patch}\n__AMIRA_REVIEW_END__\n`) : undefined,
      })
      await expect(collect(fake.owner, bash, worktree(), signal())).rejects.toThrow()
    }
  }, 60_000)

  test("detects same-count edits made during patch retrieval and refuses executable Git filters", async () => {
    const root = await repo()
    await put(root, "tracked.ts", "first\n")
    const fake = owned(root, {
      intercept: async (command) => {
        if (command.includes("'--full-index'")) await put(root, "tracked.ts", "later\n")
        return undefined
      },
    })
    await expect(collect(fake.owner, bash, worktree(), signal())).rejects.toThrow("changed during collection")
    await git(root, "config", "filter.trip.clean", "echo UNEXPECTED")
    const filtered = owned(root)
    await expect(collect(filtered.owner, bash, worktree(), signal())).rejects.toThrow("clean/process filters")
    expect(filtered.calls.every((call) => !String(call.args.command).includes("'status'"))).toBe(true)
  }, 60_000)

  test("enforces the complete combined patch cap", async () => {
    const root = await repo({ "one.ts": "old\n", "two.ts": "old\n", "three.ts": "old\n" })
    for (const path of ["one.ts", "two.ts", "three.ts"]) await put(root, path, `${"x".repeat(24 * 1024)}\n`)
    await expect(collect(owned(root).owner, bash, worktree(), signal())).rejects.toThrow("64 KiB")
  }, 60_000)

  test("mode-only files are listed; symlink and submodule modes never retrieve patches", async () => {
    const root = await repo()
    const old = await git(root, "rev-parse", "HEAD:tracked.ts")
    for (const mode of ["100755", "120000", "160000"]) {
      const fake = owned(root, {
        intercept: (command) => {
          if (command.includes("'--raw'"))
            return result(`:100644 ${mode} ${old} ${old} T\0tracked.ts\0\n__AMIRA_REVIEW_END__\n`)
          if (command.includes("'--numstat'")) return result("0\t0\ttracked.ts\0\n__AMIRA_REVIEW_END__\n")
          if (command.includes("'--full-index'"))
            return result(
              "diff --git a/tracked.ts b/tracked.ts\nold mode 100644\nnew mode 100755\n\n__AMIRA_REVIEW_END__\n",
            )
          return undefined
        },
      })
      const bundle = await collect(fake.owner, bash, worktree(), signal())
      if (mode === "100755") expect(bundle.changes[0]!.metadataOnly).toBe(true)
      else {
        expect(bundle.changes).toEqual([])
        expect(bundle.excluded[0]!.reason).toBe(mode === "120000" ? "symlink" : "submodule")
        expect(fake.calls.some((call) => String(call.args.command).includes("'--full-index'"))).toBe(false)
      }
    }
  }, 60_000)

  test("rejects an actual unmerged temporary index", async () => {
    const root = await repo()
    await git(root, "checkout", "-b", "other")
    await put(root, "tracked.ts", "other\n")
    await git(root, "commit", "-am", "other fixture")
    await git(root, "checkout", "main")
    await put(root, "tracked.ts", "main\n")
    await git(root, "commit", "-am", "main fixture")
    await expect(git(root, "merge", "other")).rejects.toThrow("Fixture git")
    await expect(collect(owned(root).owner, bash, worktree(), signal())).rejects.toThrow("Unmerged index")
  }, 60_000)

  test.skipIf(process.platform === "win32")(
    "never follows an opted-in untracked symlink",
    async () => {
      const root = await repo()
      const outside = await repo({ "outside.ts": "not-in-this-repository\n" })
      await symlink(join(outside, "outside.ts"), join(root, "linked.ts"))
      const bundle = await collect(owned(root).owner, bash, worktree([], true), signal())
      expect(bundle.changes).toEqual([])
      expect(bundle.excluded.find((entry) => entry.path === "linked.ts")?.reason).toContain("symlink")
      expect(bundle.patch).not.toContain("not-in-this-repository")
    },
    60_000,
  )

  test("runtime shell classification is required, not inferred from tool names or static traits", async () => {
    const tool = { name: "bash", shellKind: async () => "powershell", exposure: "active" } as ToolDefinition
    expect(await selectShell([tool])).toEqual({ name: "bash", kind: "powershell" })
    await expect(selectShell([{ ...tool, exposure: "inactive" }])).rejects.toThrow("enabled shell")
    await expect(
      selectShell([{ name: "bash", traits: { shell: "bash" } } as ToolDefinition]),
    ).rejects.toThrow("explicit runtime")
    await expect(
      selectShell([{ ...tool, shellKind: async () => "cmd" } as unknown as ToolDefinition]),
    ).rejects.toThrow("explicit runtime")
  })

  test.skipIf(!Bun.which("pwsh"))(
    "PowerShell shell dialect safely quotes apostrophes and Unicode literal paths",
    async () => {
      const root = await repo({ "it's é.ts": "before\n" })
      await put(root, "it's é.ts", "after\n")
      const shell: Shell = { name: "bash", kind: "powershell" }
      const { owner, calls } = owned(root, { shell })
      const bundle = await collect(owner, shell, worktree(["it's é.ts"]), signal())
      expect(bundle.changes[0]!.path).toBe("it's é.ts")
      expect(bundle.patch).toContain("+after")
      expect(calls.every((call) => String(call.args.command).includes("$env:GIT_NO_LAZY_FETCH = '1'"))).toBe(
        true,
      )
    },
    120_000,
  )
})
