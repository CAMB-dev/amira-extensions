import { afterAll, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import type {
  ExtensionAPI,
  OwnedConversation,
  SessionControl,
  SpawnGroup,
  SpawnOptions,
  ToolResult,
  UiApi,
} from "@amira/api"
import type { ReviewScope, Shell } from "../src/collect.ts"
import { ReviewContext } from "../src/context.ts"
import { validateReview } from "../src/findings.ts"
import { collectPr } from "../src/pr.ts"
import { ReviewRunner } from "../src/run.ts"
import { call, cleanup, file, temporary } from "./review-fixture.ts"

const root = realpathSync(temporary())
const bash: Shell = { name: "bash", kind: "bash" }
const powershell: Shell = { name: "powershell", kind: "powershell" }
const signal = () => new AbortController().signal
const meta = {
  number: 42,
  url: "https://github.com/example/project/pull/42",
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
}
const scope = (overrides: Partial<ReviewScope> = {}): ReviewScope => ({
  kind: "pr",
  ref: "42",
  paths: [],
  includeUntracked: false,
  ...overrides,
})
const patch = (name = "src/file.ts", before = "before", after = "after") =>
  `diff --git a/${name} b/${name}\nindex 1234567..abcdef0 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${before}\n+${after}\n`
const shellResult = (raw: string, shell = bash, code = 0): ToolResult => ({
  content: [
    {
      type: "text",
      text: `${shell.kind === "powershell" ? "Shell: PowerShell 7\n\n" : ""}${raw}\n__AMIRA_REVIEW_END__\n\nExit code: ${code}`,
    },
  ],
  isError: code !== 0,
  details: { exitCode: code, shellKind: shell.kind, timedOut: false, aborted: false, settled: true },
})

type Fake = {
  shell?: Shell
  diff?: string
  metadata?: Record<string, unknown>
  after?: Record<string, unknown>
  intercept?: (command: string, result: ToolResult) => ToolResult | undefined
  artifact?: "complete" | "denied" | "missing-end" | "oversized"
}
/** No processes or live GitHub calls: every operation is an owned fake runTool. */
function owned(options: Fake = {}) {
  const shell = options.shell ?? bash
  const calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = []
  const artifacts = new Map<string, string>()
  let views = 0
  const owner = {
    id: "pr-owner",
    cwd: root,
    async runTool(
      name: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<ToolResult> {
      calls.push({ name, args, signal: opts?.signal })
      opts?.signal?.throwIfAborted()
      if (name === "review_artifact") {
        expect(artifacts.has(String(args.id))).toBe(true)
        return options.artifact === "denied"
          ? { content: [{ type: "text", text: "Incomplete, pruned or foreign artifact" }], isError: true }
          : {
              content: [{ type: "text", text: "Complete collection output read." }],
              details: {
                raw:
                  options.artifact === "oversized"
                    ? "x".repeat(2 * 1024 * 1024 + 1)
                    : options.artifact === "missing-end"
                      ? "partial"
                      : artifacts.get(String(args.id)),
              },
            }
      }
      expect(name).toBe(shell.name)
      expect(args.timeout).toBe(30_000)
      expect(args.background).toBe(false)
      const command = String(args.command)
      let raw: string
      if (command.includes("git '--no-pager' '--no-optional-locks'")) {
        expect(command).toContain("'rev-parse' '--show-toplevel'")
        raw = `${root}\n`
      } else if (command.includes("gh 'pr' 'view'")) {
        views++
        expect(command).toContain("'--json' 'number,url,headRefOid,baseRefOid'")
        raw = JSON.stringify(views > 1 && options.after ? options.after : (options.metadata ?? meta))
      } else if (command.includes("gh 'pr' 'diff'")) {
        expect(command).toContain(`'${meta.url}' '--color=never'`)
        raw = options.diff ?? patch()
      } else throw new Error(`Unexpected command (no process fallback): ${command}`)
      const result = shellResult(raw, shell)
      const intercepted = options.intercept?.(command, result)
      if (intercepted) return intercepted
      if (options.artifact) {
        const id = `a_${calls.length.toString(16)}`
        artifacts.set(id, `${raw}\n__AMIRA_REVIEW_END__`)
        result.content = [{ type: "text", text: "Intentionally invalid preview\n\nExit code: 0" }]
        result.details = { ...(result.details as object), artifact: id }
      }
      return result
    },
  } as unknown as OwnedConversation
  return { owner, calls }
}
afterAll(cleanup)

describe("owned PR collection", () => {
  test("collects immutable PR identity, never approving unrelated local source or guidance", async () => {
    file(root, "src/file.ts", "LOCAL CHECKOUT IS UNRELATED\n")
    file(root, "AGENTS.md", "LOCAL INSTRUCTIONS MUST NOT BE EXPOSED\n")
    const fake = owned()
    const bundle = await collectPr(fake.owner, bash, scope(), signal())
    expect(bundle.head).toBe(meta.headRefOid)
    expect(bundle.base).toBe(meta.baseRefOid)
    expect(bundle.pr).toEqual({ number: 42, url: meta.url })
    expect(bundle.root).toBe(root)
    expect(bundle.inventory).toEqual([])
    expect(bundle.untracked).toEqual([])
    expect(bundle.limitations.join(" ")).toContain("local checkout files are not approved")
    expect(bundle.patch).toBe(patch())
    expect(bundle.added).toBe(1)
    expect(bundle.removed).toBe(1)
    expect(bundle.changes[0]?.hunks).toEqual([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }])
    const context = new ReviewContext(bundle)
    expect(await context.guidance()).toEqual({ text: "", paths: [], hashes: {} })
    const read = context.tools().find((tool) => tool.name === "review_read")!
    expect((await call(read, { path: "src/file.ts" })).isError).toBe(true)
    expect(fake.calls).toHaveLength(5)
    expect(fake.calls.every((entry) => entry.signal instanceof AbortSignal)).toBe(true)
    expect(fake.calls.map((entry) => String(entry.args.command)).join("\n")).not.toMatch(
      /(?:fetch|checkout|api|comment|review|auth) '\w+'/,
    )
  })

  test("supports canonical URL refs and runtime PowerShell with literal commands", async () => {
    const fake = owned({ shell: powershell })
    const bundle = await collectPr(fake.owner, powershell, scope({ ref: meta.url }), signal())
    expect(bundle.patch).toBe(patch())
    const command = String(fake.calls[2]?.args.command)
    expect(command).toContain(`gh 'pr' 'view' '${meta.url}'`)
    expect(command).toContain("Set-Location -LiteralPath")
    expect(command).toContain("GH_PROMPT_DISABLED")
    expect(command).toContain("Remove-Item Env:GH_REPO")
  })

  test.each([
    "",
    "0",
    "-1",
    "01",
    "42;echo nope",
    "https://evil.example/x/pull/42",
    `${meta.url}?token=secret`,
    "9007199254740992",
  ])("rejects unsupported refs before running tools: %s", async (ref) => {
    const fake = owned()
    await expect(collectPr(fake.owner, bash, scope({ ref }), signal())).rejects.toThrow()
    expect(fake.calls).toHaveLength(0)
  })

  test("rejects untracked and unsafe path options before collection", async () => {
    const fake = owned()
    await expect(collectPr(fake.owner, bash, scope({ includeUntracked: true }), signal())).rejects.toThrow(
      "only supported for worktree",
    )
    await expect(collectPr(fake.owner, bash, scope({ paths: ["../outside"] }), signal())).rejects.toThrow(
      "literal repository-relative",
    )
    expect(fake.calls).toHaveLength(0)
  })

  test.each([
    { url: "https://evil.example/example/project/pull/42" },
    { url: `${meta.url}/files` },
    { number: 43 },
    { headRefOid: "not-an-oid" },
    { baseRefOid: "f".repeat(41) },
  ])("validates canonical metadata before requesting a diff: %j", async (override) => {
    const fake = owned({ metadata: { ...meta, ...override } })
    await expect(collectPr(fake.owner, bash, scope(), signal())).rejects.toThrow("metadata")
    expect(fake.calls).toHaveLength(3)
  })

  test("rejects a URL resolving to another repository", async () => {
    const fake = owned({ metadata: { ...meta, url: "https://github.com/other/project/pull/42" } })
    await expect(collectPr(fake.owner, bash, scope({ ref: meta.url }), signal())).rejects.toThrow("metadata")
  })

  test("detects head/base movement while collecting the remote diff", async () => {
    const fake = owned({ after: { ...meta, headRefOid: "c".repeat(40) } })
    await expect(collectPr(fake.owner, bash, scope(), signal())).rejects.toThrow("changed during collection")
  })

  test.each([
    [127, "gh: command not found", "install gh"],
    [4, "authentication required", "gh auth login"],
    [1, "HTTP 401: Bad credentials", "gh auth login"],
    [1, "unknown PR", "check repository access"],
  ] as const)(
    "gives actionable gh failures without reflecting raw stderr (%i)",
    async (code, stderr, message) => {
      const fake = owned({
        intercept: (command) =>
          command.includes("gh 'pr' 'view'") ? shellResult(stderr, bash, code) : undefined,
      })
      await expect(collectPr(fake.owner, bash, scope(), signal())).rejects.toThrow(message)
    },
  )

  test("cancellation and tool permission denial fail closed", async () => {
    const fake = owned()
    const abort = new AbortController()
    abort.abort(new Error("cancel test"))
    await expect(collectPr(fake.owner, bash, scope(), abort.signal)).rejects.toThrow("cancel test")
    expect(fake.calls).toHaveLength(0)
    const denied = owned({
      intercept: () => ({ content: [{ type: "text", text: "Denied" }], isError: true }),
    })
    await expect(collectPr(denied.owner, bash, scope(), signal())).rejects.toThrow("dialect")
  })

  test("reads complete owned artifacts rather than their previews", async () => {
    const fake = owned({ artifact: "complete" })
    expect((await collectPr(fake.owner, bash, scope(), signal())).patch).toBe(patch())
    expect(fake.calls.filter((entry) => entry.name === "review_artifact")).toHaveLength(5)
  })

  test.each(["denied", "missing-end", "oversized"] as const)(
    "rejects unusable artifact output: %s",
    async (artifact) => {
      await expect(collectPr(owned({ artifact }).owner, bash, scope(), signal())).rejects.toThrow()
    },
  )

  test.each([
    (result: ToolResult) => ({ ...result, details: { ...(result.details as object), settled: false } }),
    (result: ToolResult) => ({
      ...result,
      details: { ...(result.details as object), shellKind: "powershell" },
    }),
    (result: ToolResult) => ({
      ...result,
      content: [{ type: "text" as const, text: "partial\n\nExit code: 0" }],
    }),
    (result: ToolResult) => ({
      ...result,
      content: [{ type: "text" as const, text: "[Output too long: discarded]\n\nExit code: 0" }],
    }),
    (result: ToolResult) => ({
      ...result,
      content: [
        {
          type: "text" as const,
          text: `${String((result.content[0] as { text: string }).text)}\ncontainment warning`,
        },
      ],
    }),
  ])("rejects incomplete, truncated or uncontained shell results", async (mutate) => {
    const fake = owned({ intercept: (_command, result) => mutate(result) })
    await expect(collectPr(fake.owner, bash, scope(), signal())).rejects.toThrow()
  })

  test("projects multiline PEM redaction across both sides and all hunks", async () => {
    const raw = `diff --git a/config.ts b/config.ts\nindex 1234567..abcdef0 100644\n--- a/config.ts\n+++ b/config.ts\n@@ -1,3 +1,3 @@ password=hintsecret\n -----BEGIN PRIVATE KEY-----\n-shortOLDwrappedbody\n+shortNEWwrappedbody\n unchangedWrappedBody\n@@ -20,2 +20,2 @@\n-anotherOldFragment\n+anotherNewFragment\n -----END PRIVATE KEY-----\n`
    const bundle = await collectPr(owned({ diff: raw }).owner, bash, scope(), signal())
    for (const secret of [
      "PRIVATE KEY",
      "shortOLD",
      "shortNEW",
      "unchangedWrappedBody",
      "anotherOld",
      "anotherNew",
      "hintsecret",
    ])
      expect(bundle.patch).not.toContain(secret)
    expect(bundle.patch).toContain("-[REDACTED]")
    expect(bundle.patch).toContain("+[REDACTED]")
    expect(bundle.changes[0]?.hunks).toHaveLength(2)
  })

  test("redacts credentials and preserves the final patch line whitespace", async () => {
    const raw = patch(
      "src/file.ts",
      "token=old-secret-value",
      "const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234'  ",
    )
    const bundle = await collectPr(owned({ diff: raw }).owner, bash, scope(), signal())
    expect(bundle.patch).not.toContain("old-secret-value")
    expect(bundle.patch).not.toContain("ghp_")
    expect(bundle.patch).toEndWith("  \n")
  })

  test("excludes dependency, secret, binary, symlink and submodule content", async () => {
    const raw =
      patch("node_modules/x.ts") +
      patch(".env") +
      "diff --git a/image.png b/image.png\nindex 1234567..abcdef0 100644\nBinary files a/image.png and b/image.png differ\n" +
      "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..abcdef0\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+outside\n" +
      "diff --git a/sub b/sub\nindex 1234567..abcdef0 160000\n--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-Subproject commit a\n+Subproject commit b\n" +
      patch()
    const bundle = await collectPr(owned({ diff: raw }).owner, bash, scope(), signal())
    expect(bundle.changes).toHaveLength(1)
    expect(bundle.excluded.map((entry) => entry.reason)).toEqual([
      "vendor/dependencies",
      "secret-bearing path",
      "binary content",
      "symlink",
      "submodule",
    ])
  })

  test("applies literal directory scope and supports added/deleted and rename-only files", async () => {
    const raw =
      patch("other/file.ts") +
      "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\nindex 0000000..abcdef0\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n" +
      "diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\nindex abcdef0..0000000\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" +
      "diff --git a/src/first.ts b/src/second.ts\nsimilarity index 100%\nrename from src/first.ts\nrename to src/second.ts\n"
    const bundle = await collectPr(owned({ diff: raw }).owner, bash, scope({ paths: ["src"] }), signal())
    expect(bundle.changes.map((entry) => entry.status)).toEqual(["A", "D", "R"])
    expect(bundle.changes[2]?.metadataOnly).toBe(true)
    expect(bundle.added).toBe(1)
    expect(bundle.removed).toBe(1)
  })

  test.each([
    patch().replace("+++ b/src/file.ts", "+++ b/another.ts"),
    patch().replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
    patch().replace("@@ -1 +1 @@", "@@ -0 +1 @@"),
    patch().replace("+after", "after"),
    patch().slice(0, -1),
    patch() + patch(),
    patch().replace("+after", "+bad\0body"),
  ])("rejects unsafe, incomplete or inconsistent diff input", async (diff) => {
    await expect(collectPr(owned({ diff }).owner, bash, scope(), signal())).rejects.toThrow()
  })

  test("excludes unsupported repository paths without exposing their patch bodies", async () => {
    const diff = patch("src/\\quoted.ts", "private fragment", "another private fragment")
    const bundle = await collectPr(owned({ diff }).owner, bash, scope(), signal())
    expect(bundle.changes).toEqual([])
    expect(bundle.patch).toBe("")
    expect(bundle.excluded[0]?.reason).toBe("unsupported repository path")
  })

  test("accepts Git path quoting for portable space-containing names", async () => {
    const raw = patch("src/my file.ts").replace(
      "a/src/my file.ts b/src/my file.ts",
      '"a/src/my file.ts" "b/src/my file.ts"',
    )
    const bundle = await collectPr(owned({ diff: raw }).owner, bash, scope(), signal())
    expect(bundle.changes[0]?.path).toBe("src/my file.ts")
  })

  test("normal and deep file caps are enforced before submission", async () => {
    const diff = Array.from({ length: 33 }, (_, index) => patch(`src/file${index}.ts`)).join("")
    await expect(collectPr(owned({ diff }).owner, bash, scope(), signal())).rejects.toThrow("32 files")
    expect(
      (await collectPr(owned({ diff }).owner, bash, scope({ deep: true }), signal())).changes,
    ).toHaveLength(33)
    const oversized = Array.from({ length: 129 }, (_, index) => patch(`src/file${index}.ts`)).join("")
    await expect(
      collectPr(owned({ diff: oversized }).owner, bash, scope({ deep: true }), signal()),
    ).rejects.toThrow("128 files")
  })

  test("enforces line caps with deep opt-in retaining the same per-file byte cap", async () => {
    const lines = (name: string, count: number) =>
      `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${count} @@\n${"+x\n".repeat(count)}`
    await expect(
      collectPr(owned({ diff: lines("src/one.ts", 2001) }).owner, bash, scope(), signal()),
    ).rejects.toThrow("2,000")
    expect(
      (
        await collectPr(
          owned({ diff: lines("src/one.ts", 2001) }).owner,
          bash,
          scope({ deep: true }),
          signal(),
        )
      ).added,
    ).toBe(2001)
    const diff = lines("src/one.ts", 4000) + lines("src/two.ts", 4001)
    await expect(collectPr(owned({ diff }).owner, bash, scope({ deep: true }), signal())).rejects.toThrow(
      "8,000",
    )
    const oneFile = patch("src/big.ts", "x", "y".repeat(33 * 1024))
    await expect(
      collectPr(owned({ diff: oneFile }).owner, bash, scope({ deep: true }), signal()),
    ).rejects.toThrow("32 KiB")
  })

  test("refuses an oversized whole diff before path filtering, redaction or source work", async () => {
    const diff = patch("outside/file.ts", "token=secret", "x".repeat(65 * 1024))
    const fake = owned({ diff })
    await expect(collectPr(fake.owner, bash, scope({ paths: ["src"] }), signal())).rejects.toThrow(
      "64 KiB patch cap before redaction",
    )
    expect(fake.calls).toHaveLength(4)
    const deep = owned({ diff: patch("outside/file.ts", "x", "x".repeat(257 * 1024)) })
    await expect(collectPr(deep.owner, bash, scope({ deep: true }), signal())).rejects.toThrow("256 KiB")
  })

  test("deep mode admits a combined patch larger than the normal cap without raising the per-file cap", async () => {
    const diff = Array.from({ length: 4 }, (_, index) =>
      patch(`src/file${index}.ts`, "x", "0".repeat(20 * 1024)),
    ).join("")
    await expect(collectPr(owned({ diff }).owner, bash, scope(), signal())).rejects.toThrow("64 KiB")
    const bundle = await collectPr(owned({ diff }).owner, bash, scope({ deep: true }), signal())
    expect(bundle.changes).toHaveLength(4)
    expect(Buffer.byteLength(bundle.patch)).toBeGreaterThan(64 * 1024)
  })

  test("fingerprints commit identities, raw diff and normalized scope deterministically", async () => {
    const first = await collectPr(owned().owner, bash, scope(), signal())
    const second = await collectPr(owned().owner, bash, scope(), signal())
    const different = await collectPr(
      owned({ diff: patch("src/file.ts", "before", "changed") }).owner,
      bash,
      scope(),
      signal(),
    )
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.fingerprint).not.toBe(different.fingerprint)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

test("PR anchors and evidence use only captured diff coordinates, never unrelated local content", async () => {
  const fake = owned()
  const bundle = await collectPr(fake.owner, bash, scope(), signal())
  const context = new ReviewContext(bundle)
  const candidate = {
    path: "src/file.ts",
    side: "new",
    startLine: 1,
    endLine: 1,
    severity: "P2",
    category: "correctness",
    summary: "Introduced failure",
    scenario: "Changed input violates the contract.",
    suggestedFix: "Restore the guard.",
    evidence: [{ path: "src/file.ts", side: "new", line: 1, reason: "Captured changed line." }],
  }
  expect((await validateReview({ findings: [candidate], limitations: [] }, bundle, context)).complete).toBe(
    true,
  )
  const invalid = { ...candidate, evidence: [{ ...candidate.evidence[0], line: 2 }] }
  expect(
    (await validateReview({ findings: [invalid], limitations: [] }, bundle, context)).findings,
  ).toHaveLength(0)
  expect(context.hashes()).toEqual({})
})

test("PR runner submits redacted diff-only prompts and persists canonical PR identity", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
  const fake = owned({ diff: patch("src/file.ts", "before", `after // ${secret}`) })
  const original = fake.owner.runTool.bind(fake.owner)
  fake.owner.runTool = async (name, args, opts) =>
    args.command === "git --version" ? shellResult("git version fake") : original(name, args, opts)
  const spawns: SpawnOptions[] = []
  const group = {
    id: "pr-group",
    name: "PR review",
    spawn(options: SpawnOptions) {
      spawns.push(options)
      return {
        id: `pr-child${spawns.length}`,
        state: "working",
        events: (async function* () {})(),
        result: async () => ({ status: "done", value: { findings: [], limitations: [] } }),
      }
    },
    info: () => ({ state: "active", tokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    end() {},
    ended: async () => group.info(),
  } as unknown as SpawnGroup
  fake.owner.createGroup = () => group
  fake.owner.release = async () => {}
  const session = {
    info: () => ({ id: "main", busy: false, model: { provider: "fake", model: "review" } }),
    tools: () => [{ name: "bash", enabled: true, traits: { shell: true } }],
  } as unknown as SessionControl
  const api = {
    dataDir: temporary(),
    session: () => session,
    requestRender() {},
    reportError() {},
    conversations: { openOrCreate: async () => fake.owner },
  } as unknown as ExtensionAPI
  const runner = new ReviewRunner(api)
  const { completion } = await runner.start(
    {
      scope: scope(),
      session,
      cwd: root,
      ui: {} as UiApi,
      settings: {
        reviewerModel: "fake/review",
        verifierModel: "fake/review",
        verify: true,
        maxParallel: 2,
        maxTokens: 120000,
        maxCostUsd: 2,
      },
      signal: signal(),
      printMode: false,
    },
    async () => true,
  )
  const report = await completion
  expect(report.state).toBe("completed")
  expect(report.scope.ref).toBe(meta.url)
  expect(report.snapshotHashes).toEqual({})
  expect(report.limitations.join("\n")).toContain("local checkout files are not approved")
  expect(spawns).toHaveLength(2)
  for (const spawn of spawns) {
    expect(spawn.prompt).toContain("[REDACTED]")
    expect(spawn.prompt).not.toContain(secret)
    expect(spawn.prompt).not.toContain("LOCAL CHECKOUT")
    expect(spawn.tools).toEqual([])
  }
  expect(await runner.store.last(report.repoKey)).toMatchObject({
    scope: { kind: "pr", ref: meta.url },
    state: "completed",
  })
})
