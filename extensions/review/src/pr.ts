// biome-ignore-all lint/suspicious/noControlCharactersInRegex: Collection boundaries reject unsupported control characters.
import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { OwnedConversation, ToolResult } from "@amira/api"
import type { Bundle, Change, Hunk, ReviewScope, Shell } from "./collect.ts"
import { exclusion, hash, redact, safePath } from "./privacy.ts"

/** No local source inventory is approved for a remote PR. */
export type PrBundle = Bundle & {
  limitations: string[]
  pr: { number: number; url: string }
}
type PrScope = Omit<ReviewScope, "kind" | "ref"> & { kind: "pr"; ref: string }
type Metadata = { number: number; url: string; headRefOid: string; baseRefOid: string }
const OUTPUT_BYTES = 2 * 1024 * 1024
const FILE_BYTES = 32 * 1024
const END = "\n__AMIRA_REVIEW_END__"
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const prUrl =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}

function quote(value: string, shell: Shell): string {
  if (/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value))
    throw new Error("Unsupported encoding or control character in collection argument")
  return `'${value.replaceAll("'", shell.kind === "bash" ? "'\\''" : "''")}'`
}

/** Only read-only Git identity probes and the two explicitly approved gh subcommands. */
function command(shell: Shell, program: "git" | "gh", args: string[], root?: string): string {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "false",
    GIT_SSH_COMMAND: "false",
    GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: shell.kind === "powershell" && process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    LC_ALL: "C.UTF-8",
  }
  const unset = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_EXTERNAL_DIFF",
    "GH_REPO",
    "GH_DEBUG",
    "GH_FORCE_TTY",
  ]
  const prefix =
    shell.kind === "bash"
      ? `unset ${unset.join(" ")}; export ${Object.entries(env)
          .map(([key, value]) => `${key}=${quote(value, shell)}`)
          .join(" ")}; `
      : `$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $false; ${unset.map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`).join("; ")}; ${Object.entries(
          env,
        )
          .map(([key, value]) => `$env:${key} = ${quote(value, shell)}`)
          .join("; ")}; `
  const invoke = `${program} ${args.map((arg) => quote(arg, shell)).join(" ")}`
  const cd = !root
    ? ""
    : shell.kind === "bash"
      ? `cd -- ${quote(root, shell)} || exit 125; `
      : `Set-Location -LiteralPath ${quote(root, shell)}; `
  const script =
    shell.kind === "bash"
      ? `${prefix}${cd}${invoke}; review_exit=$?; printf '\\n__AMIRA_REVIEW_END__\\n'; exit "$review_exit"`
      : `${prefix}${cd}try { & ${invoke}; $reviewExit = $LASTEXITCODE } catch [System.Management.Automation.CommandNotFoundException] { [Console]::Out.Write('AMIRA_REVIEW_COMMAND_MISSING'); $reviewExit = 127 }` +
        '; [Console]::Out.Write("`n__AMIRA_REVIEW_END__`n"); exit $reviewExit'
  return shell.kind === "bash"
    ? `if [ -n "\${BASH_VERSION:-}" ]; then ${script}; else exit 125; fi`
    : `& { ${script} }`
}

function textOf(result: ToolResult): string {
  if (result.content.some((part) => part.type !== "text"))
    throw new Error("Unexpected non-text PR collection output")
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

async function output(owner: OwnedConversation, shell: Shell, result: ToolResult, signal: AbortSignal) {
  signal.throwIfAborted()
  const details = object(result.details)
  if (details.shellKind !== shell.kind) throw new Error("Shell runtime dialect changed or is unsupported")
  if (
    typeof details.exitCode !== "number" ||
    !Number.isInteger(details.exitCode) ||
    details.exitCode < 0 ||
    details.exitCode > 255 ||
    details.timedOut !== false ||
    details.aborted !== false ||
    details.settled !== true ||
    (result.isError && details.exitCode === 0)
  )
    throw new Error("PR collection denied, failed, timed out, cancelled, or left open output pipes")
  let text = textOf(result)
  if (text.startsWith("Shell: ")) {
    const end = text.indexOf("\n\n")
    if (end < 0) throw new Error("Invalid shell output label")
    text = text.slice(end + 2)
  }
  const suffix = `\n\nExit code: ${details.exitCode}`
  if (!text.endsWith(suffix)) throw new Error("Incomplete or uncontained PR shell output")
  let raw: string
  if (details.artifact !== undefined) {
    if (typeof details.artifact !== "string" || !/^a_[0-9a-f]+$/.test(details.artifact))
      throw new Error("Invalid shell artifact reference")
    const artifact = await owner.runTool("review_artifact", { id: details.artifact }, { signal })
    signal.throwIfAborted()
    if (artifact.isError || typeof object(artifact.details).raw !== "string")
      throw new Error("Cannot read complete owned collection artifact")
    raw = object(artifact.details).raw as string
  } else {
    raw = text.slice(0, -suffix.length)
    if (raw.startsWith("[Output saved as artifact ") || raw.startsWith("[Output too long:"))
      throw new Error("PR shell output was truncated or could not be saved")
  }
  if (Buffer.byteLength(raw) > OUTPUT_BYTES)
    throw new Error("PR collection output exceeds its size cap; narrow the PR")
  if (!raw.endsWith(END)) throw new Error("PR collection output is incomplete (missing end sentinel)")
  return { raw: raw.slice(0, -END.length), code: details.exitCode }
}

/** Shared command/input validation: never interpret a PR field as command options. */
export function prReference(ref: unknown): string {
  if (typeof ref !== "string" || (!/^[1-9][0-9]*$/.test(ref) && !prUrl.test(ref)) || ref.length > 512)
    throw new Error(
      "PR review requires a positive PR number or canonical https://github.com/owner/repo/pull/number URL",
    )
  const number = Number(prUrl.exec(ref)?.[3] ?? ref)
  if (!Number.isSafeInteger(number)) throw new Error("Unsupported PR number")
  return ref
}

function normalize(requested: ReviewScope): PrScope {
  const scope = requested
  if (scope.kind !== "pr") throw new Error("Expected a PR review scope")
  const ref = prReference(scope.ref)
  if (
    !Array.isArray(scope.paths) ||
    scope.includeUntracked !== false ||
    (scope.deep !== undefined && typeof scope.deep !== "boolean")
  )
    throw new Error("Invalid PR scope; --include-untracked is only supported for worktree reviews")
  return {
    kind: "pr",
    ref,
    paths: [...new Set(scope.paths.map(safePath))].sort(),
    includeUntracked: false,
    ...(scope.deep ? { deep: true } : {}),
  }
}

function metadata(raw: string, ref: string): Metadata {
  let value: Record<string, unknown>
  try {
    value = object(JSON.parse(raw))
  } catch {
    throw new Error("Invalid gh PR metadata JSON")
  }
  const url = typeof value.url === "string" && prUrl.exec(value.url)
  if (
    !url ||
    !Number.isSafeInteger(value.number) ||
    Number(value.number) < 1 ||
    Number(url[3]) !== value.number ||
    typeof value.headRefOid !== "string" ||
    !oid.test(value.headRefOid) ||
    typeof value.baseRefOid !== "string" ||
    !oid.test(value.baseRefOid) ||
    Number(prUrl.exec(ref)?.[3] ?? ref) !== value.number ||
    (prUrl.test(ref) && ref.toLowerCase() !== String(value.url).toLowerCase())
  )
    throw new Error("Invalid or mismatched PR URL, number, head or base commit metadata")
  return {
    number: value.number as number,
    url: value.url as string,
    headRefOid: value.headRefOid,
    baseRefOid: value.baseRefOid,
  }
}

function pathReason(path: string): string | undefined {
  try {
    return exclusion(safePath(path))
  } catch {
    return "unsupported repository path"
  }
}

/** Git's quoted path format is not shell quoting. Refuse escapes rather than guess. */
function filePaths(header: string): { oldPath: string; path: string } {
  const match = /^diff --git (?:"a\/([^"\\]+)"|a\/(.+)) (?:"b\/([^"\\]+)"|b\/(.+))$/.exec(header)
  if (!match) throw new Error("Unsupported or ambiguous PR diff paths")
  return { oldPath: match[1] ?? match[2]!, path: match[3] ?? match[4]! }
}
const gitPath = (name: string) => (name.includes(" ") ? `"${name}"` : name)

type Parsed = { change?: Change; excluded?: { path: string; reason: string }; added: number; removed: number }
function parseFile(patch: string, scope: PrScope): Parsed {
  const lines = patch.slice(0, -1).split("\n")
  const { oldPath, path } = filePaths(lines[0]!)
  const inScope =
    !scope.paths.length ||
    scope.paths.some((name) => [path, oldPath].some((file) => file === name || file.startsWith(`${name}/`)))
  if (!inScope) return { added: 0, removed: 0 }
  const reason = pathReason(oldPath) ?? pathReason(path)
  if (reason) return { excluded: { path: redact(path), reason }, added: 0, removed: 0 }
  // Symlinks, submodules and binary payloads never enter a model-facing patch.
  const modes = lines
    .filter((line) => /^(?:new file|deleted file|old|new) mode /.test(line))
    .map((line) => line.split(" ").at(-1)!)
  const indexMode = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/.exec(lines[1] ?? "")?.[1]
  if (indexMode) modes.push(indexMode)
  const unsupported = modes.find((mode) => !["100644", "100755"].includes(mode))
  const binary = lines.some((line) => line === "GIT binary patch" || /^Binary files .+ differ$/.test(line))
  if (binary || unsupported)
    return {
      excluded: {
        path,
        reason: binary
          ? "binary content"
          : unsupported === "120000"
            ? "symlink"
            : unsupported === "160000"
              ? "submodule"
              : "unsupported Git mode",
      },
      added: 0,
      removed: 0,
    }
  if (Buffer.byteLength(patch) > FILE_BYTES)
    throw new Error("Single file exceeds 32 KiB patch cap; narrow --path")
  const hunks: Hunk[] = []
  const body: { index: number; prefix: string; old?: number; next?: number }[] = []
  const sides: { old: string[]; next: string[] } = { old: [], next: [] }
  let added = 0
  let removed = 0
  let oldHeader: string | undefined
  let newHeader: string | undefined
  let status = oldPath === path ? "M" : "R"
  const headers = new Set<string>()
  for (let i = 1; i < lines.length; ) {
    const line = lines[i]!
    if (!line.startsWith("@@")) {
      if (hunks.length || headers.has(line)) throw new Error("Unsupported or incomplete PR file patch")
      headers.add(line)
      if (line.startsWith("--- ")) {
        if (
          oldHeader ||
          newHeader ||
          ![`--- a/${oldPath}`, `--- ${gitPath(`a/${oldPath}`)}`, "--- /dev/null"].some(
            (value) => line === value || line === `${value}\t`,
          )
        )
          throw new Error("Invalid old PR patch path")
        oldHeader = line
        if (line === "--- /dev/null") status = "A"
      } else if (line.startsWith("+++ ")) {
        if (
          !oldHeader ||
          newHeader ||
          ![`+++ b/${path}`, `+++ ${gitPath(`b/${path}`)}`, "+++ /dev/null"].some(
            (value) => line === value || line === `${value}\t`,
          )
        )
          throw new Error("Invalid new PR patch path")
        newHeader = line
        if (line === "+++ /dev/null") status = "D"
      } else {
        if (
          oldHeader ||
          newHeader ||
          !(
            /^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: (?:100644|100755))?$/.test(line) ||
            /^(?:new file|deleted file|old|new) mode (?:100644|100755)$/.test(line) ||
            /^(?:dis)?similarity index (?:100|[0-9]{1,2})%$/.test(line) ||
            line === `rename from ${oldPath}` ||
            line === `rename from ${gitPath(oldPath)}` ||
            line === `rename to ${path}` ||
            line === `rename to ${gitPath(path)}`
          )
        )
          throw new Error("Unsupported PR diff header")
        if (line.startsWith("new file mode ")) status = "A"
        if (line.startsWith("deleted file mode ")) status = "D"
      }
      i++
      continue
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line)
    if (!match || !oldHeader || !newHeader) throw new Error("Invalid PR hunk or missing file headers")
    const hunk: Hunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
    }
    const previous = hunks.at(-1)
    if (
      !Object.values(hunk).every(Number.isSafeInteger) ||
      !Number.isSafeInteger(hunk.oldStart + hunk.oldCount) ||
      !Number.isSafeInteger(hunk.newStart + hunk.newCount) ||
      (!hunk.oldStart && hunk.oldCount) ||
      (!hunk.newStart && hunk.newCount) ||
      (!hunk.oldCount && !hunk.newCount) ||
      (previous &&
        (hunk.oldStart < previous.oldStart + previous.oldCount ||
          hunk.newStart < previous.newStart + previous.newCount))
    )
      throw new Error("Invalid or overlapping PR hunk ranges")
    hunks.push(hunk)
    // Function-context hints may be secret source outside the hunk; never submit them.
    lines[i] = line.slice(0, line.indexOf("@@", 2) + 2)
    i++
    let old = 0
    let next = 0
    let markerAllowed = false
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      const value = lines[i]!
      if (value === "\\ No newline at end of file") {
        if (!markerAllowed) throw new Error("Invalid PR no-newline marker")
        markerAllowed = false
        i++
        continue
      }
      const prefix = value[0]!
      const item: (typeof body)[number] = { index: i, prefix }
      if (prefix === " " || prefix === "-") {
        old++
        item.old = sides.old.length
        sides.old.push(value.slice(1))
      }
      if (prefix === " " || prefix === "+") {
        next++
        item.next = sides.next.length
        sides.next.push(value.slice(1))
      }
      if (prefix === "+") added++
      else if (prefix === "-") removed++
      else if (prefix !== " ") throw new Error("Invalid PR hunk body")
      if (old > hunk.oldCount || next > hunk.newCount) throw new Error("PR hunk exceeds declared ranges")
      body.push(item)
      markerAllowed = true
      i++
    }
    if (old !== hunk.oldCount || next !== hunk.newCount) throw new Error("Incomplete PR hunk")
  }
  if (
    !!oldHeader !== !!newHeader ||
    (!hunks.length && (oldHeader || headers.size === 0)) ||
    (oldHeader === "--- /dev/null" && newHeader === "+++ /dev/null") ||
    (status === "A" && hunks.some((hunk) => hunk.oldCount !== 0)) ||
    (status === "D" && hunks.some((hunk) => hunk.newCount !== 0))
  )
    throw new Error("Incomplete PR file headers")
  // Redact complete old/new projections of the *remote diff*, not unrelated local source.
  // This preserves PEM spans across context, additions, deletions and separate hunks.
  const clean = {
    old: redact(sides.old.join("\n")).split("\n"),
    next: redact(sides.next.join("\n")).split("\n"),
  }
  if (
    (sides.old.length && clean.old.length !== sides.old.length) ||
    (sides.next.length && clean.next.length !== sides.next.length)
  )
    throw new Error("PR redaction changed source line counts")
  const bodyIndexes = new Set(body.map((item) => item.index))
  for (const item of body) {
    const original = lines[item.index]!.slice(1)
    const candidates = [
      item.old === undefined ? undefined : clean.old[item.old],
      item.next === undefined ? undefined : clean.next[item.next],
    ]
    const sanitized = candidates.find((value) => value !== undefined && value !== original) ?? original
    lines[item.index] = item.prefix + sanitized
  }
  // Redact header text separately: treating '+' as part of a base64 token would
  // otherwise erase a structural diff prefix after source redaction.
  const sanitized = `${lines.map((line, index) => (bodyIndexes.has(index) ? line : redact(line))).join("\n")}\n`
  if (Buffer.byteLength(sanitized) > FILE_BYTES)
    throw new Error("Redacted file exceeds 32 KiB patch cap; narrow --path")
  return {
    change: {
      path,
      oldPath,
      status,
      patch: sanitized,
      hunks,
      metadataOnly: hunks.length === 0,
      untracked: false,
    },
    added,
    removed,
  }
}

function parseDiff(raw: string, scope: PrScope) {
  const cap = scope.deep ? 256 * 1024 : 64 * 1024
  // Admission happens before parsing/redaction and even when --path would drop most files.
  if (Buffer.byteLength(raw) > cap)
    throw new Error(`PR diff exceeds ${cap / 1024} KiB patch cap before redaction; narrow the PR`)
  if (raw && (!raw.startsWith("diff --git ") || !raw.endsWith("\n")))
    throw new Error("Incomplete or unsupported PR diff")
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd\ud800-\udfff]/u.test(raw))
    throw new Error("Unsupported PR diff text encoding")
  const patches = raw ? raw.split(/(?<=\n)(?=diff --git )/) : []
  const changes: Change[] = []
  const excluded: Bundle["excluded"] = []
  const seen = new Set<string>()
  let added = 0
  let removed = 0
  for (const patch of patches) {
    const parsed = parseFile(patch, scope)
    if (parsed.excluded) excluded.push(parsed.excluded)
    if (!parsed.change) continue
    if (seen.has(parsed.change.path)) throw new Error("Duplicate PR diff path")
    seen.add(parsed.change.path)
    changes.push(parsed.change)
    added += parsed.added
    removed += parsed.removed
    if (changes.length > (scope.deep ? 128 : 32) || added + removed > (scope.deep ? 8000 : 2000))
      throw new Error(
        `PR review exceeds ${scope.deep ? "128 files / 8,000" : "32 files / 2,000"} changed lines; narrow --path`,
      )
  }
  const patch = changes.map((change) => change.patch).join("")
  if (Buffer.byteLength(patch) > cap)
    throw new Error(`Redacted PR patch exceeds ${cap / 1024} KiB cap; narrow --path`)
  return { changes, excluded, added, removed, patch }
}

/** Read-only remote collection: no checkout, fetch, raw process, API request or posting. */
export async function collectPr(
  owner: OwnedConversation,
  shell: Shell,
  requested: ReviewScope,
  signal: AbortSignal,
): Promise<PrBundle> {
  const scope = normalize(requested)
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason ?? new Error("PR collection cancelled"))
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error("PR collection two-minute deadline exceeded")),
    120_000,
  )
  const run = async (program: "git" | "gh", args: string[], root?: string) => {
    controller.signal.throwIfAborted()
    const result = await owner.runTool(
      shell.name,
      { command: command(shell, program, args, root), timeout: 30_000, background: false },
      { signal: controller.signal },
    )
    const value = await output(owner, shell, result, controller.signal)
    if (value.code !== 0) {
      if (
        program === "gh" &&
        (value.code === 127 || /(?:gh: command not found|AMIRA_REVIEW_COMMAND_MISSING)/.test(value.raw))
      )
        throw new Error("PR review requires GitHub CLI (gh); install gh and authenticate before retrying")
      if (
        program === "gh" &&
        (value.code === 4 ||
          /(?:gh auth login|authentication|not logged|HTTP 401|bad credentials|GH_TOKEN)/i.test(value.raw))
      )
        throw new Error(
          "GitHub CLI authentication is required or expired; run gh auth login outside review and retry",
        )
      throw new Error(
        program === "gh"
          ? "GitHub CLI PR collection failed or was denied; check repository access and PR number"
          : "PR review requires an accessible local Git repository",
      )
    }
    return value.raw
  }
  try {
    const rawRoot = (
      await run("git", ["--no-pager", "--no-optional-locks", "rev-parse", "--show-toplevel"])
    ).replace(/\r?\n$/, "")
    if (!isAbsolute(rawRoot) || /[\x00-\x1f\x7f\ufffd]/.test(rawRoot))
      throw new Error("PR source root must be a canonical local Git repository")
    const root = await realpath(rawRoot)
    const confirmed = (
      await run("git", ["--no-pager", "--no-optional-locks", "-C", root, "rev-parse", "--show-toplevel"])
    ).replace(/\r?\n$/, "")
    if ((await realpath(confirmed)) !== root)
      throw new Error("Local Git repository root changed during PR collection")
    const view = async (ref: string) =>
      metadata(await run("gh", ["pr", "view", ref, "--json", "number,url,headRefOid,baseRefOid"], root), ref)
    const before = await view(scope.ref)
    const raw = await run("gh", ["pr", "diff", before.url, "--color=never"], root)
    scope.ref = before.url
    const parsed = parseDiff(raw, scope)
    const after = await view(before.url)
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("PR head or base changed during collection; start a new review")
    return {
      root,
      repoKey: hash(process.platform === "win32" ? root.toLowerCase() : root),
      head: before.headRefOid,
      base: before.baseRefOid,
      scope,
      inventory: [],
      untracked: [],
      ...parsed,
      pr: { number: before.number, url: before.url },
      limitations: [
        "PR review uses the complete GitHub diff only. Immutable remote source snapshots and repository guidance are unavailable; local checkout files are not approved context. Secrets outside the diff cannot be inspected.",
      ],
      fingerprint: hash(JSON.stringify({ root, scope, metadata: before, diff: hash(raw) })),
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}
