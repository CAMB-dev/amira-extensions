import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import path from "node:path"
import type { ReviewScope } from "./collect.ts"
import { DEEP_CANDIDATES, MAX_GROUPS } from "./deep.ts"
import type { Finding } from "./findings.ts"
import { redact, safePath } from "./privacy.ts"

export interface ReviewSettings {
  reviewerModel: string
  verifierModel: string
  verify: boolean
  maxParallel: number
  maxTokens: number
  maxCostUsd: number
}

export interface Report {
  schemaVersion: 1
  id: string
  repoKey: string
  root: string
  originSessionId: string
  ownerId: string
  startedAt: string
  endedAt?: string
  state: "running" | "completed" | "partial" | "cancelled" | "failed"
  stale: boolean
  scope: ReviewScope
  base: string
  head: string
  fingerprint: string
  snapshotHashes: Record<string, string>
  included: string[]
  untracked: string[]
  excluded: { path: string; reason: string }[]
  redacted: string[]
  guidance: string[]
  settings: ReviewSettings
  promptHashes: Record<string, string>
  findings: Finding[]
  limitations: string[]
  usage: unknown
  childStates: Record<string, string>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const MAX_BYTES = 1024 * 1024
const INTERRUPTED =
  "Review interrupted before completion; saved results are partial and will not be replayed."

/** The caller supplies a canonical root; Windows identities ignore case and separator spelling. */
export function repoKey(root: string): string {
  const windows = process.platform === "win32" || /^[a-z]:[\\/]|^\\\\/i.test(root)
  let canonical = windows ? path.win32.normalize(root).toLowerCase() : path.normalize(root)
  const rootLength = (windows ? path.win32.parse(canonical) : path.parse(canonical)).root.length
  if (canonical.length > rootLength) canonical = canonical.replace(/[\\/]+$/, "")
  return createHash("sha256").update(canonical).digest("hex")
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length <= max
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
function strings(value: unknown, max = 64, length = 4096): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => text(item, length))
}
function relative(value: unknown): value is string {
  if (!text(value, 1024)) return false
  try {
    safePath(value)
    return true
  } catch {
    return false
  }
}
function paths(value: unknown, max = 64): boolean {
  return Array.isArray(value) && value.length <= max && value.every(relative)
}
function record(value: unknown, max: number, check: (value: unknown, key: string) => boolean): boolean {
  return (
    object(value) &&
    Object.keys(value).length <= max &&
    Object.entries(value).every(
      ([key, item]) =>
        text(key, 1024) && !["__proto__", "constructor", "prototype"].includes(key) && check(item, key),
    )
  )
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (value === undefined || value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") return value.length <= 4096
  if (depth >= 8) return false
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => jsonValue(item, depth + 1))
  return record(value, 128, (item) => jsonValue(item, depth + 1))
}
function finding(value: unknown): boolean {
  if (
    !object(value) ||
    !exact(
      value,
      [
        "id",
        "path",
        "side",
        "startLine",
        "endLine",
        "severity",
        "category",
        "summary",
        "scenario",
        "evidence",
        "suggestedFix",
        "sources",
        "assessment",
        "ignored",
      ],
      ["rule", "rationale", "duplicateOf", "excerpt"],
    )
  )
    return false
  if (
    !text(value.id, 80) ||
    !value.id ||
    !relative(value.path) ||
    !["old", "new"].includes(String(value.side)) ||
    !integer(value.startLine, 1, 100000000) ||
    !integer(value.endLine, value.startLine, value.startLine + 9)
  )
    return false
  if (
    !["P1", "P2", "P3"].includes(String(value.severity)) ||
    !["correctness", "security", "contract", "tests", "standards"].includes(String(value.category))
  )
    return false
  if (
    !text(value.summary, 160) ||
    !text(value.scenario, 1200) ||
    !text(value.suggestedFix, 1200) ||
    !strings(value.sources, MAX_GROUPS + 2, 160) ||
    typeof value.ignored !== "boolean" ||
    !["supported", "uncertain", "refuted", "unchecked"].includes(String(value.assessment))
  )
    return false
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length > 3 ||
    !value.evidence.every(
      (e) =>
        object(e) &&
        exact(e, ["path", "side", "line", "reason"]) &&
        relative(e.path) &&
        ["old", "new"].includes(String(e.side)) &&
        integer(e.line, 1, 100000000) &&
        text(e.reason, 1200),
    )
  )
    return false
  return ["rule", "rationale", "duplicateOf", "excerpt"].every(
    (key) =>
      value[key] === undefined ||
      text(value[key], key === "excerpt" ? 8192 : key === "duplicateOf" ? 80 : 2400),
  )
}

function valid(value: unknown): value is Report {
  if (
    !object(value) ||
    !exact(
      value,
      [
        "schemaVersion",
        "id",
        "repoKey",
        "root",
        "originSessionId",
        "ownerId",
        "startedAt",
        "state",
        "stale",
        "scope",
        "base",
        "head",
        "fingerprint",
        "snapshotHashes",
        "included",
        "untracked",
        "excluded",
        "redacted",
        "guidance",
        "settings",
        "promptHashes",
        "findings",
        "limitations",
        "usage",
        "childStates",
      ],
      ["endedAt"],
    )
  )
    return false
  if (
    value.schemaVersion !== 1 ||
    !text(value.id) ||
    !UUID.test(value.id) ||
    !text(value.repoKey) ||
    !HASH.test(value.repoKey) ||
    !text(value.root, 4096) ||
    !value.root ||
    !text(value.originSessionId, 256) ||
    !text(value.ownerId, 256)
  )
    return false
  if (
    !text(value.startedAt, 64) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    (value.endedAt !== undefined && (!text(value.endedAt, 64) || !Number.isFinite(Date.parse(value.endedAt))))
  )
    return false
  if (
    !["running", "completed", "partial", "cancelled", "failed"].includes(String(value.state)) ||
    typeof value.stale !== "boolean"
  )
    return false
  if (
    !object(value.scope) ||
    !exact(value.scope, ["kind", "paths", "includeUntracked"], ["ref", "deep"]) ||
    !paths(value.scope.paths) ||
    !["worktree", "since", "pr"].includes(String(value.scope.kind)) ||
    typeof value.scope.includeUntracked !== "boolean" ||
    (value.scope.deep !== undefined && typeof value.scope.deep !== "boolean") ||
    (value.scope.ref !== undefined &&
      (!text(value.scope.ref, 1024) ||
        !value.scope.ref ||
        value.scope.ref.startsWith("-") ||
        value.scope.ref.split("").some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)))
  )
    return false
  if (
    (value.scope.kind === "since" || value.scope.kind === "pr") &&
    (!value.scope.ref || value.scope.includeUntracked)
  )
    return false
  if (
    ![value.base, value.head].every((v) => text(v, 64) && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v)) ||
    !text(value.fingerprint) ||
    !HASH.test(value.fingerprint)
  )
    return false
  if (
    !record(
      value.snapshotHashes,
      value.scope.deep ? 528 : 64,
      (v, key) => relative(key) && text(v) && HASH.test(v),
    ) ||
    !record(value.promptHashes, 16, (v) => text(v) && HASH.test(v)) ||
    !record(value.childStates, value.scope.deep ? MAX_GROUPS + 3 : 3, (v) => text(v, 80))
  )
    return false
  if (
    !paths(value.included, value.scope.deep ? 128 : 32) ||
    !paths(value.untracked, 10000) ||
    !paths(value.redacted, value.scope.deep ? 656 : 64) ||
    !paths(value.guidance, value.scope.deep ? 512 : 64) ||
    !Array.isArray(value.excluded) ||
    value.excluded.length > 10000 ||
    !value.excluded.every(
      (e) => object(e) && exact(e, ["path", "reason"]) && text(e.path, 4096) && text(e.reason, 1200),
    )
  )
    return false
  const s = value.settings
  if (
    !object(s) ||
    !exact(s, ["reviewerModel", "verifierModel", "verify", "maxParallel", "maxTokens", "maxCostUsd"]) ||
    !text(s.reviewerModel, 256) ||
    !text(s.verifierModel, 256) ||
    typeof s.verify !== "boolean" ||
    !integer(s.maxParallel, 1, 2) ||
    !integer(s.maxTokens, 1, 240000) ||
    typeof s.maxCostUsd !== "number" ||
    !Number.isFinite(s.maxCostUsd) ||
    s.maxCostUsd <= 0 ||
    s.maxCostUsd > 10
  )
    return false
  if (
    !Array.isArray(value.findings) ||
    value.findings.length > (value.scope.deep ? DEEP_CANDIDATES : 12) ||
    !value.findings.every(finding) ||
    !strings(value.limitations, 128, 4096) ||
    !(value.usage === null || object(value.usage)) ||
    !jsonValue(value.usage)
  )
    return false
  const ids = new Set(value.findings.map((f) => f.id))
  return (
    ids.size === value.findings.length &&
    value.findings.every((f) => !f.duplicateOf || (f.duplicateOf !== f.id && ids.has(f.duplicateOf)))
  )
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(sanitize)
  if (object(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]))
  return value
}
function recovered(report: Report): Report {
  return report.state === "running"
    ? {
        ...report,
        state: "partial",
        limitations: [...report.limitations.filter((v) => v !== INTERRUPTED), INTERRUPTED],
      }
    : report
}

export class ReportStore {
  private readonly base: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.base = path.join(dataDir, "repos")
  }

  async save(report: Report): Promise<void> {
    // Serialize checkpoints, terminal publications and report updates within this store.
    const checkpoint = structuredClone(report)
    const operation = this.queue.then(() => this.commit(checkpoint))
    this.queue = operation.catch(() => {})
    return operation
  }

  /** Persist ignore/unignore changes without publishing a new terminal run. */
  async update(report: Report): Promise<void> {
    const checkpoint = structuredClone(report)
    const operation = this.queue.then(() => this.commit(checkpoint, false))
    this.queue = operation.catch(() => {})
    return operation
  }

  private async commit(report: Report, publish = true): Promise<void> {
    if (!valid(report)) throw new Error("Invalid or unsupported review report")
    const clean = sanitize(report)
    if (!valid(clean)) throw new Error("Review report became invalid after sanitization")
    const data = JSON.stringify(clean)
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Review report exceeds storage limit")
    if (!publish) {
      const existing = await this.readReport(report.repoKey, report.id)
      if (report.state === "running" || !existing || existing.state === "running")
        throw new Error("Cannot update a missing, invalid or running review report")
    }
    const dir = await this.directory(report.repoKey, publish)
    await this.atomic(path.join(dir, `${report.id}.json`), data)
    if (!publish || report.state === "running") return
    await this.atomic(path.join(dir, "..", "last.json"), JSON.stringify({ schemaVersion: 1, id: report.id }))
    await this.prune(report.repoKey, report.id)
  }

  async last(key: string): Promise<Report | undefined> {
    if (!HASH.test(key)) return undefined
    try {
      const dir = await this.directory(key)
      const pointer = await this.readJson(path.join(dir, "..", "last.json"))
      if (
        !object(pointer) ||
        !exact(pointer, ["schemaVersion", "id"]) ||
        pointer.schemaVersion !== 1 ||
        !text(pointer.id) ||
        !UUID.test(pointer.id)
      )
        return undefined
      const report = await this.readReport(key, pointer.id)
      return report && report.state !== "running" ? report : undefined
    } catch {
      return undefined
    }
  }

  async load(key: string, id: string): Promise<Report | undefined> {
    const report = await this.readReport(key, id)
    return report ? recovered(report) : undefined
  }

  async interrupted(key: string): Promise<Report[]> {
    if (!HASH.test(key)) return []
    try {
      const dir = await this.directory(key)
      const reports: Report[] = []
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue
        const report = await this.readReport(key, name.slice(0, -5))
        if (report?.state === "running") reports.push(recovered(report))
      }
      return reports.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    } catch {
      return []
    }
  }

  private async directory(key: string, create = false): Promise<string> {
    if (!HASH.test(key)) throw new Error("Invalid review repository key")
    const dir = path.join(this.base, key, "runs")
    for (const item of [this.base, path.join(this.base, key), dir]) {
      if (create) {
        try {
          await mkdir(item, { recursive: item === this.base })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      }
      const stat = await lstat(item)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe review storage directory")
    }
    return dir
  }

  private async readJson(file: string): Promise<unknown> {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
      throw new Error("Unsafe or oversized review file")
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const current = await handle.stat()
      if (
        current.ino !== stat.ino ||
        current.dev !== stat.dev ||
        current.size !== stat.size ||
        current.nlink !== 1
      )
        throw new Error("Review file changed while opening")
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let total = 0
      while (total < buffer.length) {
        const result = await handle.read(buffer, total, buffer.length - total, total)
        if (!result.bytesRead) break
        total += result.bytesRead
      }
      if (total > MAX_BYTES) throw new Error("Review file exceeds storage limit")
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)))
    } finally {
      await handle.close()
    }
  }

  private async readReport(key: string, id: string): Promise<Report | undefined> {
    if (!HASH.test(key) || !UUID.test(id)) return undefined
    try {
      const dir = await this.directory(key)
      const value = await this.readJson(path.join(dir, `${id}.json`))
      return valid(value) && value.repoKey === key && value.id === id ? value : undefined
    } catch {
      return undefined
    }
  }

  private async atomic(file: string, data: string): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temp, "wx", 0o600)
      await handle.writeFile(data, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temp, file)
    } finally {
      await handle?.close()
      await unlink(temp).catch(() => {})
    }
  }

  private async prune(key: string, current: string): Promise<void> {
    const dir = await this.directory(key)
    const reports: Report[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue
      const report = await this.readReport(key, name.slice(0, -5))
      if (report && report.state !== "running" && report.id !== current) reports.push(report)
    }
    reports.sort(
      (a, b) =>
        (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt) || b.id.localeCompare(a.id),
    )
    for (const report of reports.slice(19)) await unlink(path.join(dir, `${report.id}.json`))
  }
}
