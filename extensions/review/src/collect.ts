import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import type { OwnedConversation, ToolDefinition, ToolResult } from "@amira/api"
import { exclusion, hash, redact, safePath } from "./privacy.ts"

export type ReviewScope = {
  kind: "worktree" | "since"
  ref?: string
  paths: string[]
  includeUntracked: boolean
}
export type Shell = { name: string; kind: "bash" | "powershell" }
export type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number }
export type Change = {
  path: string
  oldPath: string
  status: string
  patch: string
  hunks: Hunk[]
  untracked: boolean
  metadataOnly: boolean
}
export type Bundle = {
  root: string
  repoKey: string
  head: string
  base: string
  scope: ReviewScope
  inventory: string[]
  changes: Change[]
  excluded: { path: string; reason: string }[]
  untracked: string[]
  patch: string
  fingerprint: string
  added: number
  removed: number
}

const FILES = 32
const LINES = 2_000
const PATCH_BYTES = 64 * 1024
const FILE_BYTES = 32 * 1024
const INVENTORY_BYTES = 1024 * 1024
const OUTPUT_BYTES = 2 * 1024 * 1024
const DEADLINE_MS = 120_000
const ARTIFACT_TOOL = "review_artifact"
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** Only install in the inert owner's runtime, never in child extraTools. */
export function artifactTool(): ToolDefinition {
  return {
    name: ARTIFACT_TOOL,
    description: "Read one complete output owned by this review's collection session.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", pattern: "^a_[0-9a-f]+$" } },
      required: ["id"],
      additionalProperties: false,
    },
    traits: { readOnly: true, writesFiles: false, artifactReader: true },
    async execute(params, ctx) {
      try {
        if (
          !params ||
          Object.keys(params).length !== 1 ||
          typeof params.id !== "string" ||
          !/^a_[0-9a-f]+$/.test(params.id)
        ) {
          throw new Error("Invalid collection artifact ID")
        }
        ctx.signal.throwIfAborted()
        if (ctx.session?.restricted)
          throw new Error("Collection artifacts are available only to the review owner")
        const info = ctx.session?.outputs?.find(params.id)
        if (!info || info.sessionId !== ctx.session?.sessionId)
          throw new Error("Collection artifact is not owned by this session")
        if (!info.complete || info.incomplete || info.pruned)
          throw new Error("Collection artifact is incomplete or pruned")
        if (!Number.isSafeInteger(info.bytes) || info.bytes < 0 || info.bytes > OUTPUT_BYTES)
          throw new Error("Collection output exceeds its size cap")
        const stat = await lstat(info.path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== info.bytes)
          throw new Error("Collection artifact is not a complete regular file")
        const handle = await open(info.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const current = await handle.stat()
          if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size)
            throw new Error("Collection artifact changed while opening")
          const buffer = Buffer.alloc(info.bytes + 1)
          let used = 0
          while (used < buffer.length) {
            ctx.signal.throwIfAborted()
            const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
            if (!bytesRead) break
            used += bytesRead
          }
          if (used !== info.bytes) throw new Error("Collection artifact size changed")
          const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            buffer.subarray(0, used),
          )
          if (raw.length !== info.chars) throw new Error("Collection artifact character count changed")
          ctx.signal.throwIfAborted()
          return { content: [{ type: "text", text: "Complete collection output read." }], details: { raw } }
        } finally {
          await handle.close()
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: redact(error instanceof Error ? error.message : "Cannot read collection artifact"),
            },
          ],
          isError: true,
        }
      }
    },
  }
}

/** A bash-named tool can actually run PowerShell; static traits are insufficient. */
export async function selectShell(tools: ToolDefinition[]): Promise<Shell> {
  const candidates = tools
    .filter(
      (tool) =>
        tool.exposure !== "inactive" && tool.name !== "monitor" && typeof tool.shellKind === "function",
    )
    .sort(
      (a, b) =>
        (a.name === "bash" ? 0 : a.name === "powershell" ? 1 : 2) -
        (b.name === "bash" ? 0 : b.name === "powershell" ? 1 : 2),
    )
  for (const tool of candidates) {
    try {
      const kind = await tool.shellKind!()
      if ((kind === "bash" || kind === "powershell") && /^[A-Za-z0-9_-]+$/.test(tool.name))
        return { name: tool.name, kind }
    } catch {
      /* Another explicitly classified enabled shell may be available. */
    }
  }
  throw new Error(
    "Review collection needs an enabled shell with an explicit runtime Bash or PowerShell dialect",
  )
}

function hasControl(value: string, space = false): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0)!
    return code <= (space ? 32 : 31) || code === 127 || code === 0xfffd
  })
}

function quote(value: string, shell: Shell): string {
  if (hasControl(value) || /[\ud800-\udfff]/u.test(value))
    throw new Error("Unsupported encoding or control character in Git argument")
  return `'${value.replaceAll("'", shell.kind === "bash" ? "'\\''" : "''")}'`
}

const gitEnv: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "false",
  GIT_SSH_COMMAND: "false",
  GIT_ALLOW_PROTOCOL: "",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  LC_ALL: "C.UTF-8",
}
const unsetEnv = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_EXTERNAL_DIFF",
]

function command(shell: Shell, args: string[]): string {
  const env = {
    ...gitEnv,
    GIT_CONFIG_GLOBAL: shell.kind === "powershell" && process.platform === "win32" ? "NUL" : "/dev/null",
  }
  const prefix =
    shell.kind === "bash"
      ? `unset ${unsetEnv.join(" ")}; export ${Object.entries(env)
          .map(([key, value]) => `${key}=${quote(value, shell)}`)
          .join(" ")}; `
      : `$ErrorActionPreference = 'Stop'; ${unsetEnv.map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`).join("; ")}; ${Object.entries(
          env,
        )
          .map(([key, value]) => `$env:${key} = ${quote(value, shell)}`)
          .join("; ")}; `
  const git = [
    "--no-pager",
    "--no-optional-locks",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.renames=false",
    "-c",
    "status.renames=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.file.allow=never",
    ...args,
  ]
  // The host trims trailing whitespace before saving output. A final sentinel preserves
  // NUL inventories and the *entire* final patch line, including its whitespace.
  const end =
    shell.kind === "bash"
      ? `; review_exit=$?; printf '\\n__AMIRA_REVIEW_END__\\n'; exit "$review_exit"`
      : '; $reviewExit = $LASTEXITCODE; [Console]::Out.Write("`n__AMIRA_REVIEW_END__`n"); exit $reviewExit'
  const script =
    prefix +
    (shell.kind === "powershell" ? "& " : "") +
    `git ${git.map((arg) => quote(arg, shell)).join(" ")}` +
    end
  // A runtime fallback after selection must fail syntactically before reaching Git,
  // rather than partially executing the other dialect without its safety environment.
  return shell.kind === "bash"
    ? `if [ -n "\${BASH_VERSION:-}" ]; then ${script}; else exit 125; fi`
    : `& { ${script} }`
}

function textOf(result: ToolResult): string {
  if (result.content.some((part) => part.type !== "text"))
    throw new Error("Unexpected non-text collection output")
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/** The public built-in shell wraps raw output with a label and final exit status. */
async function shellOutput(
  owner: OwnedConversation,
  shell: Shell,
  result: ToolResult,
  signal: AbortSignal,
  expected: number[],
): Promise<{ raw: string; code: number }> {
  signal.throwIfAborted()
  const details = object(result.details)
  const code = details.exitCode
  if (details.shellKind !== shell.kind) throw new Error("Shell runtime dialect changed or is unsupported")
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    !expected.includes(code) ||
    details.timedOut !== false ||
    details.aborted !== false ||
    details.settled !== true ||
    (result.isError && code === 0)
  ) {
    throw new Error("Git collection denied, failed, timed out, cancelled, or left open output pipes")
  }
  // Reject host containment warnings even when the raw Git output is an artifact.
  // This reads only the shell's status envelope, never the artifact preview payload.
  let text = textOf(result)
  if (text.startsWith("Shell: ")) {
    const end = text.indexOf("\n\n")
    if (end < 0) throw new Error("Invalid shell output label")
    text = text.slice(end + 2)
  }
  const suffix = `\n\nExit code: ${code}`
  if (!text.endsWith(suffix)) throw new Error("Incomplete or uncontained shell output")
  // A nonzero expected probe is the only allowed error result (e.g. ancestry).
  let raw: string
  if (details.artifact !== undefined) {
    if (typeof details.artifact !== "string") throw new Error("Invalid shell artifact reference")
    const artifact = await owner.runTool(ARTIFACT_TOOL, { id: details.artifact }, { signal })
    signal.throwIfAborted()
    if (artifact.isError || typeof object(artifact.details).raw !== "string")
      throw new Error("Cannot read complete owned collection artifact")
    raw = object(artifact.details).raw as string
  } else {
    raw = details.outputLines === 0 && text === `(no output)${suffix}` ? "" : text.slice(0, -suffix.length)
    if (raw.startsWith("[Output saved as artifact ") || raw.startsWith("[Output too long:"))
      throw new Error("Shell output was truncated or could not be saved")
  }
  if (Buffer.byteLength(raw, "utf8") > OUTPUT_BYTES)
    throw new Error("Collection output exceeds its size cap; narrow --path")
  if (!raw.endsWith("\n__AMIRA_REVIEW_END__"))
    throw new Error("Collection output is incomplete (missing end sentinel)")
  raw = raw.slice(0, -"\n__AMIRA_REVIEW_END__".length)
  return { raw, code }
}

function deadline(signal: AbortSignal): { signal: AbortSignal; close(): void } {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason ?? new Error("Review collection cancelled"))
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error("Review collection cancelled: two-minute collection deadline exceeded")),
    DEADLINE_MS,
  )
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    },
  }
}

function runner(owner: OwnedConversation, shell: Shell, signal: AbortSignal) {
  return async (args: string[], expected = [0]) => {
    signal.throwIfAborted()
    const result = await owner.runTool(
      shell.name,
      { command: command(shell, args), timeout: 30_000, background: false },
      { signal },
    )
    return shellOutput(owner, shell, result, signal, expected)
  }
}
type Git = ReturnType<typeof runner>

async function assertNoExecutableFilters(git: Git, root: string): Promise<void> {
  // --no-ext-diff/--no-textconv do not disable clean/process filters. Even a
  // read-only status/diff could otherwise execute a repository-configured script.
  const filters = await git(
    ["-C", root, "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
    [0, 1],
  )
  if (filters.code === 0 || filters.raw)
    throw new Error("Review does not support repository-configured clean/process filters")
}

const diffOptions = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--ignore-submodules=none",
  "--no-color",
]

function singleLine(raw: string): string {
  const line = raw.replace(/\r?\n$/, "")
  if (!line || hasControl(line)) throw new Error("Unsupported single-line Git output")
  return line
}

function normalizedScope(scope: ReviewScope): ReviewScope {
  if (scope.kind !== "worktree" && scope.kind !== "since") throw new Error("Unsupported review scope")
  if (!Array.isArray(scope.paths) || typeof scope.includeUntracked !== "boolean")
    throw new Error("Invalid review scope")
  if (scope.kind === "since" && scope.includeUntracked)
    throw new Error("--include-untracked is only supported for worktree reviews")
  if (
    scope.kind === "since" &&
    (!scope.ref ||
      scope.ref.length > 512 ||
      scope.ref.startsWith("-") ||
      scope.ref.includes("..") ||
      hasControl(scope.ref, true) ||
      /[\ud800-\udfff]/u.test(scope.ref))
  )
    throw new Error("Since requires one explicit local ancestor ref, not an option or revision range")
  return {
    kind: scope.kind,
    ...(scope.kind === "since" ? { ref: scope.ref } : {}),
    paths: [...new Set(scope.paths.map(safePath))].sort(),
    includeUntracked: scope.includeUntracked,
  }
}

function paths(raw: string): string[] {
  if (Buffer.byteLength(raw) > INVENTORY_BYTES) throw new Error("Path inventory exceeds 1 MiB; narrow --path")
  if (!raw) return []
  if (!raw.endsWith("\0")) throw new Error("Incomplete Git path inventory")
  const result = raw.slice(0, -1).split("\0")
  if (result.length > 10_000) throw new Error("Path inventory exceeds 10,000 paths; narrow --path")
  return result
}

function allowedPath(path: string): string | undefined {
  try {
    safePath(path)
    return exclusion(path)
  } catch {
    return "unsupported repository path"
  }
}

type Meta = {
  path: string
  oldPath: string
  status: string
  oldMode: string
  newMode: string
  added: number
  removed: number
  binary: boolean
}
function metadata(raw: string, counts: string): Meta[] {
  const tokens = raw ? raw.split("\0") : []
  if (tokens.length && tokens.pop() !== "") throw new Error("Incomplete Git diff metadata")
  const result: Meta[] = []
  for (let i = 0; i < tokens.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([AMDT])$/.exec(tokens[i]!)
    if (!match || !oid.test(match[3]!) || !oid.test(match[4]!) || !tokens[i + 1])
      throw new Error("Unsupported or unmerged Git diff metadata")
    result.push({
      path: tokens[i + 1]!,
      oldPath: tokens[i + 1]!,
      status: match[5]!,
      oldMode: match[1]!,
      newMode: match[2]!,
      added: 0,
      removed: 0,
      binary: false,
    })
  }
  const lines = paths(counts)
  const byPath = new Map(result.map((entry) => [entry.path, entry]))
  if (lines.length !== result.length || byPath.size !== result.length)
    throw new Error("Inconsistent Git diff metadata")
  for (const line of lines) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(line)
    const entry = match && byPath.get(match[3]!)
    if (!match || !entry || (match[1] === "-") !== (match[2] === "-"))
      throw new Error("Inconsistent Git line-count metadata")
    entry.binary = match[1] === "-"
    entry.added = entry.binary ? 0 : Number(match[1])
    entry.removed = entry.binary ? 0 : Number(match[2])
    if (!Number.isSafeInteger(entry.added + entry.removed)) throw new Error("Unsupported Git line counts")
    byPath.delete(entry.path)
  }
  if (byPath.size) throw new Error("Missing Git line-count metadata")
  return result
}

function metadataReason(entry: Meta): string | undefined {
  const pathReason = allowedPath(entry.oldPath) ?? allowedPath(entry.path)
  if (pathReason) return pathReason
  if ([entry.oldMode, entry.newMode].includes("120000")) return "symlink"
  if ([entry.oldMode, entry.newMode].includes("160000")) return "submodule"
  if (![entry.oldMode, entry.newMode].every((mode) => ["000000", "100644", "100755"].includes(mode)))
    return "unsupported Git mode"
  return entry.binary ? "binary content" : undefined
}

async function regularPath(root: string, path: string) {
  safePath(path)
  let current = root
  for (const component of path.split("/")) {
    current = join(current, component)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error("symlink/junction paths are excluded")
    if (current !== join(root, ...path.split("/")) && !stat.isDirectory())
      throw new Error("non-directory path component")
  }
  const canonical = await realpath(current)
  const inside = relative(root, canonical)
  if (
    inside === ".." ||
    inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(inside)
  )
    throw new Error("path escapes the repository")
  const stat = await lstat(current)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("non-regular or multi-link files are excluded")
  return { file: current, stat }
}

async function untrackedText(
  root: string,
  path: string,
  signal: AbortSignal,
  cap = FILE_BYTES,
): Promise<string> {
  const { file, stat } = await regularPath(root, path)
  if (stat.size > cap) throw new Error(`Source file exceeds ${cap / 1024} KiB cap; narrow --path`)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    if (
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.size !== stat.size ||
      current.nlink !== 1
    )
      throw new Error("untracked file changed while opening")
    const buffer = Buffer.alloc(cap + 1)
    let used = 0
    while (used < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > cap) throw new Error(`Source file exceeds ${cap / 1024} KiB cap; narrow --path`)
    if (used !== stat.size) throw new Error("untracked file changed while reading")
    if (buffer.subarray(0, used).includes(0)) throw new Error("binary content")
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used))
    } catch {
      throw new Error("non-UTF-8 content")
    }
  } finally {
    await handle.close()
  }
}

function gitPath(path: string): string {
  return /["\\]/.test(path) ? JSON.stringify(path) : path
}

type PatchSources = { old: string; new: string }
const PRIVACY_FILE_BYTES = 64 * 1024
const PRIVACY_TOTAL_BYTES = 256 * 1024

/** Only complete bounded source can establish multiline secret spans outside a displayed hunk. */
async function patchSources(
  git: Git,
  root: string,
  base: string,
  head: string,
  scope: ReviewScope,
  entry: Meta,
  signal: AbortSignal,
): Promise<PatchSources> {
  const blob = async (revision: string, name: string) => {
    const object = `${revision}:${name}`
    const size = Number(singleLine((await git(["-C", root, "cat-file", "-s", object])).raw))
    if (!Number.isSafeInteger(size) || size < 0 || size > PRIVACY_FILE_BYTES)
      throw new Error("Complete source for privacy exceeds 64 KiB cap; narrow --path or defer this file")
    const text = (await git(["-C", root, "cat-file", "blob", object])).raw
    if (Buffer.byteLength(text) !== size) throw new Error("Incomplete source for privacy; collection stopped")
    return text
  }
  const old = entry.oldMode === "000000" ? "" : await blob(base, entry.oldPath)
  const next =
    entry.newMode === "000000"
      ? ""
      : scope.kind === "since"
        ? await blob(head, entry.path)
        : await untrackedText(root, entry.path, signal, PRIVACY_FILE_BYTES)
  for (const source of [old, next]) {
    if (source.includes("\ufffd") || source.includes("\0"))
      throw new Error("Unsupported complete source encoding; collection stopped")
  }
  return { old, new: next }
}

function parsePatch(
  patch: string,
  entry: Meta,
  sources: PatchSources = { old: "", new: "" },
): { hunks: Hunk[]; added: number; removed: number; patch: string } {
  if (Buffer.byteLength(patch) > FILE_BYTES)
    throw new Error("Single file exceeds 32 KiB patch cap; narrow --path")
  if (patch.includes("\ufffd")) throw new Error("Unsupported patch text encoding")
  const lines = patch.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines.shift() !== `diff --git ${gitPath(`a/${entry.oldPath}`)} ${gitPath(`b/${entry.path}`)}`)
    throw new Error("Patch paths do not match selected Git metadata")
  const hunks: Hunk[] = []
  let added = 0
  let removed = 0
  const body: { index: number; prefix: string; oldLine?: number; newLine?: number }[] = []
  let oldHeader = false
  let newHeader = false
  const headers = new Set<string>()
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!
    if (!line.startsWith("@@")) {
      if (hunks.length || headers.has(line)) throw new Error("Unsupported or incomplete file patch")
      headers.add(line)
      if (line.startsWith("--- ")) {
        const expected = `--- ${entry.oldMode === "000000" ? "/dev/null" : gitPath(`a/${entry.oldPath}`)}`
        if (oldHeader || newHeader || (line !== expected && line !== `${expected}\t`))
          throw new Error("Invalid old patch path")
        oldHeader = true
      } else if (line.startsWith("+++ ")) {
        const expected = `+++ ${entry.newMode === "000000" ? "/dev/null" : gitPath(`b/${entry.path}`)}`
        if (!oldHeader || newHeader || (line !== expected && line !== `${expected}\t`))
          throw new Error("Invalid new patch path")
        newHeader = true
      } else if (
        oldHeader ||
        newHeader ||
        !(
          /^index (?:[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})(?: \d{6})?$/.test(line) ||
          line === `new file mode ${entry.newMode}` ||
          line === `deleted file mode ${entry.oldMode}` ||
          line === `old mode ${entry.oldMode}` ||
          line === `new mode ${entry.newMode}`
        )
      )
        throw new Error("Unsupported or incomplete file patch")
      i++
      continue
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line)
    if (!match || !oldHeader || !newHeader) throw new Error("Invalid patch hunk or missing file headers")
    const headerEnd = line.indexOf("@@", 2) + 2
    // Git function-context hints can originate outside this hunk; omit unlocatable source text.
    lines[i] = line.slice(0, headerEnd)
    const hunk: Hunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
    }
    const previous = hunks.at(-1)
    if (
      !Object.values(hunk).every(Number.isSafeInteger) ||
      (!hunk.oldStart && hunk.oldCount) ||
      (!hunk.newStart && hunk.newCount) ||
      (previous &&
        (hunk.oldStart < previous.oldStart + previous.oldCount ||
          hunk.newStart < previous.newStart + previous.newCount))
    )
      throw new Error("Invalid or overlapping hunk ranges")
    hunks.push(hunk)
    i++
    let old = 0
    let next = 0
    let markerAllowed = false
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      const value = lines[i]!
      if (value === "\\ No newline at end of file") {
        if (!markerAllowed) throw new Error("Invalid no-newline marker")
        markerAllowed = false
        i++
        continue
      }
      markerAllowed = true
      const prefix = value[0]
      const oldLine = prefix !== "+" ? hunk.oldStart + old : undefined
      const newLine = prefix !== "-" ? hunk.newStart + next : undefined
      if (prefix === " ") {
        old++
        next++
      } else if (prefix === "+") {
        next++
        added++
      } else if (prefix === "-") {
        old++
        removed++
      } else throw new Error("Invalid patch hunk body")
      body.push({ index: i, prefix, oldLine, newLine })
      i++
      if (old > hunk.oldCount || next > hunk.newCount) throw new Error("Patch hunk exceeds declared ranges")
    }
    if (old !== hunk.oldCount || next !== hunk.newCount) throw new Error("Incomplete patch hunk")
  }
  if (oldHeader !== newHeader || (!hunks.length && (oldHeader || !headers.size)))
    throw new Error("Incomplete file patch headers")
  if (added !== entry.added || removed !== entry.removed)
    throw new Error("Patch does not match line-count metadata")
  const sourceLines = (text: string) =>
    text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : []
  const raw = { old: sourceLines(sources.old), new: sourceLines(sources.new) }
  const cleanSources = { old: sourceLines(redact(sources.old)), new: sourceLines(redact(sources.new)) }
  if (raw.old.length !== cleanSources.old.length || raw.new.length !== cleanSources.new.length)
    throw new Error("Redaction changed complete source line counts")
  for (const { index, prefix, oldLine, newLine } of body) {
    const original = lines[index]!.slice(1).replace(/\r$/, "")
    const projected: string[] = []
    for (const [side, coordinate] of [
      ["old", oldLine],
      ["new", newLine],
    ] as const) {
      if (coordinate === undefined) continue
      if (
        coordinate < 1 ||
        raw[side][coordinate - 1] !== original ||
        cleanSources[side][coordinate - 1] === undefined
      )
        throw new Error("Patch does not match complete source context; collection stopped")
      projected.push(cleanSources[side][coordinate - 1]!)
    }
    // Context is sensitive if either side was sensitive (e.g. a removed PEM boundary).
    lines[index] = prefix + (projected.find((value) => value !== original) ?? original)
  }
  const clean = `${[`diff --git ${gitPath(`a/${entry.oldPath}`)} ${gitPath(`b/${entry.path}`)}`, ...lines].join("\n")}\n`
  if (Buffer.byteLength(clean) > FILE_BYTES)
    throw new Error("Redacted file exceeds 32 KiB patch cap; narrow --path")
  return { hunks, added, removed, patch: clean }
}

function ancestorGuidance(changed: string[]): string[] {
  const names = new Set<string>(["AGENTS.md", "CLAUDE.md", "REVIEW.md"])
  for (const name of changed) {
    if (allowedPath(name)) continue
    const parts = name.split("/")
    parts.pop()
    while (parts.length) {
      for (const guide of ["AGENTS.md", "CLAUDE.md", "REVIEW.md"]) names.add(`${parts.join("/")}/${guide}`)
      parts.pop()
    }
  }
  if (names.size > 10000) throw new Error("Guidance ancestor inventory is too large; narrow --path")
  return [...names].sort()
}

async function trackedGuidance(
  git: Git,
  at: string[],
  changed: string[],
): Promise<{ names: string[]; staged: string }> {
  const candidates = ancestorGuidance(changed)
  const names: string[] = []
  let staged = ""
  let batch: string[] = []
  const flush = async () => {
    if (!batch.length) return
    names.push(...paths((await git([...at, "ls-files", "--cached", "-z", "--", ...batch])).raw))
    staged += (await git([...at, "ls-files", "--stage", "-z", "--", ...batch])).raw
    batch = []
  }
  for (const name of candidates) {
    if (batch.length >= 24 || Buffer.byteLength([...batch, name].join(" ")) > 4000) await flush()
    batch.push(name)
  }
  await flush()
  return { names: [...new Set(names)], staged }
}

type Snapshot = {
  head: string
  status: string
  staged: string
  inventory: string[]
  others: string[]
  raw: string
  counts: string
  value: string
}
async function snapshot(
  git: Git,
  root: string,
  scope: ReviewScope,
  base: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const at = ["-C", root]
  const head = singleLine((await git([...at, "rev-parse", "--verify", "HEAD^{commit}"])).raw)
  if (!oid.test(head)) throw new Error("Unborn or unsupported HEAD")
  const status = (
    await git([
      ...at,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--",
      ...(scope.kind === "since" ? [] : scope.paths),
    ])
  ).raw
  const staged = (await git([...at, "ls-files", "--stage", "-z", "--", ...scope.paths])).raw
  let inventory = paths((await git([...at, "ls-files", "--cached", "-z", "--", ...scope.paths])).raw)
  const others =
    scope.kind === "worktree"
      ? paths(
          (await git([...at, "ls-files", "--others", "--exclude-standard", "-z", "--", ...scope.paths])).raw,
        )
      : []
  if (
    inventory.length + others.length > 10_000 ||
    Buffer.byteLength(
      inventory
        .concat(others)
        .map((path) => `${path}\0`)
        .join(""),
    ) > INVENTORY_BYTES
  )
    throw new Error("Combined inventory exceeds 10,000 paths / 1 MiB; narrow --path")
  if (Buffer.byteLength(staged) > OUTPUT_BYTES)
    throw new Error("Index inventory exceeds its size cap; narrow --path")
  const revisions = scope.kind === "since" ? [base, head] : [head]
  const raw = (
    await git([
      ...at,
      "diff",
      ...diffOptions,
      "--raw",
      "-z",
      "--no-abbrev",
      ...revisions,
      "--",
      ...scope.paths,
    ])
  ).raw
  const counts = (
    await git([...at, "diff", ...diffOptions, "--numstat", "-z", ...revisions, "--", ...scope.paths])
  ).raw
  const selected = metadata(raw, counts).filter((entry) => !metadataReason(entry))
  const pending = scope.includeUntracked ? others.filter((path) => !allowedPath(path)) : []
  // Candidate admission precedes source/guidance work and covers tracked + opted-in untracked files.
  if (selected.length + pending.length > FILES) throw new Error("Review exceeds 32 files; narrow --path")
  if (selected.reduce((sum, entry) => sum + entry.added + entry.removed, 0) > LINES)
    throw new Error("Review exceeds 2,000 changed lines; narrow --path")
  const guidance = await trackedGuidance(git, at, [...selected.map((entry) => entry.path), ...pending])
  inventory = [...new Set([...inventory, ...guidance.names])]
  if (
    inventory.length + others.length > 10000 ||
    Buffer.byteLength(inventory.concat(others).join("\0")) > INVENTORY_BYTES
  )
    throw new Error("Inventory including ancestor guidance exceeds its cap; narrow --path")
  const guidanceHashes: string[] = []
  for (const name of guidance.names) {
    let regular = true
    try {
      await regularPath(root, name)
    } catch {
      regular = false
    }
    signal.throwIfAborted()
    // Git failures/denials must propagate; never classify them as missing guidance.
    guidanceHashes.push(
      regular
        ? `${name}:${(await git([...at, "hash-object", "--no-filters", "--", name])).raw}`
        : `${name}:unavailable`,
    )
  }
  const working: string[] = []
  const tokens = status ? status.split("\0") : []
  if (tokens.length && tokens.pop() !== "") throw new Error("Incomplete Git status")
  for (const token of tokens) {
    if (!/^[ MADRCU?!T]{2} /.test(token)) throw new Error("Unsupported Git status")
    const path = token.slice(3)
    if (allowedPath(path)) continue
    try {
      await regularPath(root, path)
      working.push(path)
    } catch (error) {
      if (object(error).code !== "ENOENT") working.push(`!${path}`)
    }
  }
  const hashes: string[] = []
  for (let i = 0; i < working.length; i += 32) {
    const batch = working.slice(i, i + 32).filter((path) => !path.startsWith("!"))
    if (batch.length) {
      const output = (await git([...at, "hash-object", "--no-filters", "--", ...batch])).raw
        .replace(/\r?\n$/, "")
        .split(/\r?\n/)
      if (output.length !== batch.length || output.some((value) => !oid.test(value)))
        throw new Error("Cannot fingerprint working files")
      hashes.push(...output)
    }
  }
  const untrackedHashes: string[] = []
  if (scope.includeUntracked) {
    for (const path of others) {
      signal.throwIfAborted()
      const reason = allowedPath(path)
      if (reason) {
        untrackedHashes.push(`${path}:${reason}`)
        continue
      }
      try {
        untrackedHashes.push(`${path}:${hash(await untrackedText(root, path, signal))}`)
      } catch (error) {
        if (error instanceof Error && error.message.includes("cap")) throw error
        untrackedHashes.push(
          `${path}:excluded:${object(error).code ?? (error instanceof Error ? error.message : "unreadable")}`,
        )
      }
    }
  }
  const value = hash(
    JSON.stringify({
      scope,
      head,
      base,
      status,
      staged,
      inventory,
      others,
      raw,
      counts,
      working,
      hashes,
      guidanceIndex: guidance.staged,
      guidanceHashes,
      untrackedHashes,
    }),
  )
  return { head, status, staged, inventory, others, raw, counts, value }
}

export async function fingerprint(
  owner: OwnedConversation,
  shell: Shell,
  bundle: Bundle,
  signal: AbortSignal,
): Promise<string> {
  const clock = deadline(signal)
  try {
    const git = runner(owner, shell, clock.signal)
    const root = await realpath(singleLine((await git(["rev-parse", "--show-toplevel"])).raw))
    if (root !== bundle.root) return hash(`repository-changed:${root}`)
    await assertNoExecutableFilters(git, root)
    return (await snapshot(git, root, normalizedScope(bundle.scope), bundle.base, clock.signal)).value
  } finally {
    clock.close()
  }
}

export async function collect(
  owner: OwnedConversation,
  shell: Shell,
  requested: ReviewScope,
  signal: AbortSignal,
): Promise<Bundle> {
  const scope = normalizedScope(requested)
  const clock = deadline(signal)
  try {
    const git = runner(owner, shell, clock.signal)
    const root = await realpath(singleLine((await git(["rev-parse", "--show-toplevel"])).raw))
    const at = ["-C", root]
    await assertNoExecutableFilters(git, root)
    const headResult = await git([...at, "rev-parse", "--verify", "HEAD^{commit}"], [0, 128])
    if (headResult.code !== 0)
      throw new Error("Unborn HEAD is unsupported; review requires an existing commit")
    const head = singleLine(headResult.raw)
    if (!oid.test(head)) throw new Error("Unsupported HEAD commit ID")
    if ((await git([...at, "ls-files", "--unmerged", "-z"])).raw)
      throw new Error("Unmerged index is unsupported; resolve conflicts before review")
    let base = head
    if (scope.kind === "since") {
      const resolved = await git([
        ...at,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${scope.ref}^{commit}`,
      ])
      base = singleLine(resolved.raw)
      if (!oid.test(base)) throw new Error("Since ref did not resolve to a local commit")
      if ((await git([...at, "merge-base", "--is-ancestor", base, head], [0, 1])).code !== 0)
        throw new Error("Since ref must be an ancestor of captured HEAD")
      if ((await git([...at, "status", "--porcelain=v1", "-z", "--untracked-files=no"])).raw)
        throw new Error("Since review requires a clean tracked checkout and index")
    }
    const before = await snapshot(git, root, scope, base, clock.signal)
    if (before.head !== head) throw new Error("HEAD changed during collection; start a new review")
    if (scope.kind === "since" && before.status)
      throw new Error("Since review requires a clean tracked checkout and index")
    const entries = metadata(before.raw, before.counts)
    const excluded: Bundle["excluded"] = []
    const admitted: Meta[] = []
    const exclude = (path: string, reason: string) => {
      if (!excluded.some((entry) => entry.path === path && entry.reason === reason))
        excluded.push({ path, reason })
    }
    for (const entry of entries) {
      let reason = metadataReason(entry)
      if (!reason && entry.newMode !== "000000") {
        try {
          await regularPath(root, entry.path)
        } catch (error) {
          reason = error instanceof Error ? error.message : "unsupported working file"
        }
      }
      if (reason) exclude(entry.path, reason)
      else admitted.push(entry)
    }
    let added = admitted.reduce((sum, entry) => sum + entry.added, 0)
    const removed = admitted.reduce((sum, entry) => sum + entry.removed, 0)
    if (admitted.length > FILES || added + removed > LINES)
      throw new Error("Review exceeds 32 files / 2,000 changed lines; narrow --path")
    const changes: Change[] = []
    let privacyBytes = 0
    let rawPatchBytes = 0
    for (const entry of admitted) {
      const revisions = scope.kind === "since" ? [base, head] : [head]
      const output = await git([
        ...at,
        "diff",
        ...diffOptions,
        "--full-index",
        "--unified=3",
        "--diff-algorithm=myers",
        "--no-indent-heuristic",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ...revisions,
        "--",
        entry.path,
      ])
      if (!output.raw.endsWith("\n")) throw new Error("Incomplete file patch")
      rawPatchBytes += Buffer.byteLength(output.raw)
      if (rawPatchBytes > PATCH_BYTES)
        throw new Error("Combined patch exceeds 64 KiB before redaction; narrow --path")
      const sources =
        entry.added + entry.removed
          ? await patchSources(git, root, base, head, scope, entry, clock.signal)
          : { old: "", new: "" }
      privacyBytes += Buffer.byteLength(sources.old) + Buffer.byteLength(sources.new)
      if (privacyBytes > PRIVACY_TOTAL_BYTES)
        throw new Error("Complete privacy sources exceed 256 KiB cap; narrow --path")
      const parsed = parsePatch(output.raw, entry, sources)
      changes.push({
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        patch: parsed.patch,
        hunks: parsed.hunks,
        untracked: false,
        metadataOnly: parsed.hunks.length === 0,
      })
      if (Buffer.byteLength(changes.map((change) => change.patch).join("")) > PATCH_BYTES)
        throw new Error("Combined patch exceeds 64 KiB; narrow --path")
    }
    for (const path of before.others) {
      const reason = allowedPath(path)
      if (reason) {
        exclude(path, reason)
        continue
      }
      if (!scope.includeUntracked) {
        exclude(path, "untracked (not included)")
        continue
      }
      if (changes.length >= FILES) throw new Error("Review exceeds 32 files; narrow --path")
      let text: string
      try {
        text = await untrackedText(root, path, clock.signal)
      } catch (error) {
        clock.signal.throwIfAborted()
        if (error instanceof Error && error.message.includes("cap")) throw error
        exclude(path, error instanceof Error ? error.message : "unreadable untracked file")
        continue
      }
      const lines = text ? text.split("\n") : []
      if (text.endsWith("\n")) lines.pop()
      added += lines.length
      if (added + removed > LINES) throw new Error("Review exceeds 2,000 changed lines; narrow --path")
      const prefix = `diff --git ${gitPath(`a/${path}`)} ${gitPath(`b/${path}`)}\nnew file mode 100644\n`
      const patch =
        prefix +
        (lines.length
          ? `--- /dev/null\n+++ ${gitPath(`b/${path}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n${text.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`
          : "")
      rawPatchBytes += Buffer.byteLength(patch)
      if (rawPatchBytes > PATCH_BYTES)
        throw new Error("Combined patch exceeds 64 KiB before redaction; narrow --path")
      privacyBytes += Buffer.byteLength(text)
      if (privacyBytes > PRIVACY_TOTAL_BYTES)
        throw new Error("Complete privacy sources exceed 256 KiB cap; narrow --path")
      const parsed = parsePatch(
        patch,
        {
          path,
          oldPath: path,
          status: "A",
          oldMode: "000000",
          newMode: "100644",
          added: lines.length,
          removed: 0,
          binary: false,
        },
        { old: "", new: text },
      )
      changes.push({
        path,
        oldPath: path,
        status: "A",
        patch: parsed.patch,
        hunks: parsed.hunks,
        untracked: true,
        metadataOnly: parsed.hunks.length === 0,
      })
    }
    const patch = changes.map((change) => change.patch).join("")
    if (Buffer.byteLength(patch) > PATCH_BYTES)
      throw new Error("Combined patch exceeds 64 KiB; narrow --path")
    const after = await snapshot(git, root, scope, base, clock.signal)
    if (before.value !== after.value)
      throw new Error("Repository changed during collection; start a new review")
    return {
      root,
      repoKey: hash(process.platform === "win32" ? root.toLowerCase() : root),
      head,
      base,
      scope,
      inventory: before.inventory.filter((path) => !allowedPath(path)),
      changes,
      excluded,
      untracked: before.others,
      patch,
      fingerprint: before.value,
      added,
      removed,
    }
  } finally {
    clock.close()
  }
}
