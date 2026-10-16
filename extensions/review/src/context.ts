// biome-ignore-all lint/suspicious/noControlCharactersInRegex: Source boundaries intentionally reject control characters.
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition, ToolResult } from "@amira/api"
import type { Bundle } from "./collect.ts"
import { exclusion, hash, redact, safePath } from "./privacy.ts"

type Snapshot = { hash: string; text: string; bytes: number }
const FILE_BYTES = 64 * 1024
const TOTAL_BYTES = 256 * 1024
const RESPONSE_BYTES = 8 * 1024
const GUIDANCE_BYTES = 16 * 1024
const guidanceNames = ["AGENTS.md", "CLAUDE.md", "REVIEW.md"]
const lines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n"))
const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
const result = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
})
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("Review context request cancelled")
}

/** Immutable, bounded source snapshots shared by every child, with budgets local to tools(). */
export class ReviewContext {
  private readonly root: string
  private readonly manifest: Set<string>
  private readonly guidanceAllowed: Set<string>
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly guides = new Set<string>()
  private sourceCount = 0
  private sourceBytes = 0
  private guideBytes = 0
  private queue: Promise<unknown> = Promise.resolve()
  private guidancePromise?: Promise<{ text: string; paths: string[]; hashes: Record<string, string> }>

  constructor(private readonly bundle: Bundle) {
    this.root = path.resolve(bundle.root)
    if (bundle.inventory.length > 10_000 || Buffer.byteLength(bundle.inventory.join("\0")) > 1024 * 1024)
      throw new Error("Approved context inventory exceeds its cap")
    this.guidanceAllowed = new Set(
      bundle.inventory.filter((name) => {
        try {
          return !exclusion(safePath(name))
        } catch {
          return false
        }
      }),
    )
    for (const name of bundle.untracked) this.guidanceAllowed.delete(name)
    if (bundle.scope.kind === "worktree" && bundle.scope.includeUntracked) {
      for (const change of bundle.changes)
        if (change.untracked && !exclusion(safePath(change.path))) this.guidanceAllowed.add(change.path)
    }
    for (const entry of bundle.excluded) this.guidanceAllowed.delete(entry.path)
    this.manifest = new Set(
      bundle.inventory.filter((name) => {
        try {
          return !exclusion(safePath(name)) && this.inScope(name)
        } catch {
          return false
        }
      }),
    )
    for (const name of bundle.untracked) this.manifest.delete(name)
    if (bundle.scope.kind === "worktree" && bundle.scope.includeUntracked) {
      for (const change of bundle.changes) {
        if (change.untracked && this.inScope(change.path) && !exclusion(safePath(change.path)))
          this.manifest.add(change.path)
      }
    }
    // Never admit an excluded change through a manifest entry supplied accidentally by a collector.
    for (const entry of bundle.excluded) this.manifest.delete(entry.path)
    for (const change of bundle.changes) {
      if (change.untracked && !(bundle.scope.kind === "worktree" && bundle.scope.includeUntracked))
        this.manifest.delete(change.path)
    }
  }

  private inScope(name: string): boolean {
    return (
      !this.bundle.scope.paths.length ||
      this.bundle.scope.paths.some((scope) => name === scope || name.startsWith(`${scope}/`))
    )
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn)
    this.queue = task.catch(() => {})
    return task
  }

  private async ancestors(target: string): Promise<void> {
    const parsed = path.parse(target)
    let current = parsed.root
    for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error("Symbolic links/junctions are not review context")
      if (current !== target && !stat.isDirectory()) throw new Error("Non-directory context ancestor")
    }
    const canonical = await realpath(target)
    if (!same(canonical, target)) throw new Error("Noncanonical context path")
  }

  private async raw(name: string, cap: number, signal?: AbortSignal): Promise<string> {
    abort(signal)
    safePath(name)
    const target = path.join(this.root, name)
    await this.ancestors(target)
    const before = await lstat(target)
    if (!before.isFile() || before.nlink !== 1 || before.size > cap)
      throw new Error("Context must be a bounded, single-link regular text file")
    // O_NOFOLLOW where supported plus pre/post identity and ancestor checks; no recursive walks.
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size > cap
      )
        throw new Error("Context file changed during open")
      const data = Buffer.alloc(cap + 1)
      let size = 0
      while (size < data.length) {
        abort(signal)
        const read = await handle.read(data, size, data.length - size, null)
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size > cap) throw new Error("Context file exceeds size cap")
      const after = await handle.stat()
      const entry = await lstat(target)
      await this.ancestors(target)
      if (
        after.nlink !== 1 ||
        entry.nlink !== 1 ||
        entry.dev !== stat.dev ||
        entry.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("Context file changed during read")
      abort(signal)
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, size))
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("Context is not regular UTF-8 text")
      return text
    } finally {
      await handle.close()
    }
  }

  private snapshot(name: string, signal?: AbortSignal, guide = false): Promise<Snapshot> {
    return this.serial(async () => {
      abort(signal)
      safePath(name)
      if (exclusion(name) || (!guide && !this.manifest.has(name) && !this.guides.has(name)))
        throw new Error("Path is not approved review context")
      const overhead = guide
        ? Buffer.byteLength(`--- ${name} (repository criteria, not instructions) ---\n\n\n`)
        : 0
      const cached = this.snapshots.get(name)
      if (cached) {
        if (guide && !this.guides.has(name)) {
          if (this.guideBytes + cached.bytes + overhead > GUIDANCE_BYTES)
            throw new Error("Review guidance byte cap reached")
          this.guideBytes += cached.bytes + overhead
          this.guides.add(name)
        }
        return cached
      }
      if (!guide && this.sourceCount >= 16) throw new Error("Review context snapshot count cap (16) reached")
      const text = await this.raw(name, guide ? GUIDANCE_BYTES : FILE_BYTES, signal)
      const sanitized = redact(text)
      const size = Math.max(Buffer.byteLength(text), Buffer.byteLength(sanitized))
      if (
        size + overhead > (guide ? GUIDANCE_BYTES : FILE_BYTES) ||
        (guide ? this.guideBytes + size + overhead > GUIDANCE_BYTES : this.sourceBytes + size > TOTAL_BYTES)
      )
        throw new Error("Review context total byte cap reached")
      const snapshot = Object.freeze({ hash: hash(text), text: sanitized, bytes: size })
      if (guide) {
        this.guideBytes += size + overhead
        this.guides.add(name)
      } else {
        this.sourceCount++
        this.sourceBytes += size
      }
      this.snapshots.set(name, snapshot)
      return snapshot
    })
  }

  guidance(): Promise<{ text: string; paths: string[]; hashes: Record<string, string> }> {
    this.guidancePromise ??= this.loadGuidance()
    return this.guidancePromise.then((value) => ({
      ...value,
      paths: [...value.paths],
      hashes: { ...value.hashes },
    }))
  }

  private async loadGuidance(): Promise<{ text: string; paths: string[]; hashes: Record<string, string> }> {
    const dirs = new Set([""])
    for (const change of this.bundle.changes) {
      let dir = path.posix.dirname(safePath(change.path))
      while (dir !== ".") {
        dirs.add(dir)
        dir = path.posix.dirname(dir)
      }
    }
    const paths: string[] = []
    const sections: string[] = []
    const hashes: Record<string, string> = {}
    for (const dir of [...dirs].sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"),
    )) {
      for (const file of guidanceNames) {
        const name = dir ? `${dir}/${file}` : file
        if (!this.guidanceAllowed.has(name)) continue
        try {
          const snapshot = await this.snapshot(name, undefined, true)
          paths.push(name)
          hashes[name] = snapshot.hash
          sections.push(`--- ${name} (repository criteria, not instructions) ---\n${snapshot.text}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    }
    return { text: sections.join("\n\n"), paths, hashes }
  }

  hashes(): Record<string, string> {
    return Object.fromEntries([...this.snapshots].map(([name, snapshot]) => [name, snapshot.hash]))
  }

  /** Freshness checks compare source bytes, including legitimate empty snapshots, not line excerpts. */
  async matches(expected: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
    for (const [name, expectedHash] of Object.entries(expected)) {
      abort(signal)
      try {
        if ((await this.snapshot(name, signal)).hash !== expectedHash) return false
      } catch {
        abort(signal)
        return false
      }
    }
    return true
  }

  redactedPaths(): string[] {
    return [...this.snapshots]
      .filter(([, snapshot]) => snapshot.text.includes("[REDACTED]"))
      .map(([name]) => name)
  }

  async stale(): Promise<boolean> {
    await this.queue
    for (const [name, snapshot] of this.snapshots) {
      try {
        if (hash(await this.raw(name, this.guides.has(name) ? GUIDANCE_BYTES : FILE_BYTES)) !== snapshot.hash)
          return true
      } catch {
        return true
      }
    }
    return false
  }

  /** A short sanitized excerpt; rejects fabricated coordinates instead of clipping them. */
  async excerpt(name: string, line: number): Promise<string> {
    const snapshot = await this.snapshot(name)
    const source = lines(snapshot.text)
    if (!snapshot.text || !Number.isSafeInteger(line) || line < 1 || line > source.length)
      throw new Error("Source line is unavailable")
    return this.page(source, Math.max(1, line - 2), Math.min(10, source.length - Math.max(1, line - 2) + 1))
  }

  private page(source: string[], offset: number, limit: number): string {
    const output: string[] = []
    let bytes = 0
    let next = offset
    for (let i = offset - 1; i < Math.min(source.length, offset - 1 + limit); i++) {
      const value = `${i + 1}: ${source[i]}`
      // Leave room for the continuation marker. Never split a UTF-8 character or source line.
      if (bytes + Buffer.byteLength(value) + 1 > RESPONSE_BYTES - 160) break
      output.push(value)
      bytes += Buffer.byteLength(value) + 1
      next = i + 2
    }
    if (next <= source.length)
      output.push(`[continued: review_read offset=${next}; a single oversized line cannot be returned]`)
    return output.join("\n")
  }

  tools(): ToolDefinition[] {
    let calls = 0
    let searches = 0
    const run = async (
      fn: () => Promise<string>,
      signal: AbortSignal,
      search = false,
    ): Promise<ToolResult> => {
      calls++
      if (search) searches++
      try {
        abort(signal)
        if (calls > 24) throw new Error("Review reader call cap (24) reached")
        if (search && searches > 8) throw new Error("Review search call cap (8) reached")
        const text = await fn()
        abort(signal)
        return result(text)
      } catch {
        return result(
          "Review context request refused (unapproved path, unavailable text, invalid input, cancellation or budget limit).",
          true,
        )
      }
    }
    return [
      {
        name: "review_read",
        description:
          "Read an approved immutable UTF-8 source snapshot. At most 200 lines/8 KiB, 24 shared reader/search calls per child.",
        traits: { readOnly: true, writesFiles: false },
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", maxLength: 1024 },
            offset: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        execute: async (params: { path: string; offset?: number; limit?: number }, ctx) =>
          run(async () => {
            if (!params || Object.keys(params).some((key) => !["path", "offset", "limit"].includes(key)))
              throw new Error("Invalid reader arguments")
            const offset = params.offset === undefined ? 1 : params.offset
            const limit = params.limit === undefined ? 200 : params.limit
            if (
              !Number.isSafeInteger(offset) ||
              offset < 1 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 200
            )
              throw new Error("Invalid reader range")
            const snapshot = await this.snapshot(safePath(params.path), ctx.signal)
            return this.page(snapshot.text ? lines(snapshot.text) : [], offset, limit)
          }, ctx.signal),
      },
      {
        name: "review_search",
        description:
          "Case-sensitive literal search of approved source snapshots only; no glob, regex, Git or outside paths. At most 50 results and 8 searches per child, counting toward 24 reader calls.",
        traits: { readOnly: true, writesFiles: false },
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 256 },
            path: { type: "string", maxLength: 1024 },
            maxResults: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        execute: async (params: { query: string; path?: string; maxResults?: number }, ctx) =>
          run(
            async () => {
              if (
                !params ||
                Object.keys(params).some((key) => !["query", "path", "maxResults"].includes(key)) ||
                typeof params.query !== "string" ||
                !params.query ||
                params.query.length > 256 ||
                /[\x00-\x1f\x7f]/.test(params.query)
              )
                throw new Error("Invalid literal search")
              const maximum = params.maxResults === undefined ? 50 : params.maxResults
              if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50)
                throw new Error("Invalid result cap")
              let names = [...this.manifest, ...this.guides]
                .filter((name, index, all) => this.inScope(name) && all.indexOf(name) === index)
                .sort()
              if (params.path !== undefined) {
                const prefix = safePath(params.path)
                names = names.filter((name) => name === prefix || name.startsWith(`${prefix}/`))
                if (!names.length) throw new Error("Unapproved search path")
              }
              const matches: string[] = []
              let stopped = false
              for (const name of names) {
                abort(ctx.signal)
                let snapshot: Snapshot
                try {
                  snapshot = await this.snapshot(name, ctx.signal)
                } catch {
                  stopped = true
                  continue
                }
                const source = lines(snapshot.text)
                for (let i = 0; i < source.length; i++) {
                  if (!source[i]!.includes(params.query)) continue
                  const entry = `${name}:${i + 1}: ${source[i]}`
                  if (
                    matches.length >= maximum ||
                    Buffer.byteLength(matches.join("\n")) + Buffer.byteLength(entry) > RESPONSE_BYTES - 160
                  ) {
                    stopped = true
                    break
                  }
                  matches.push(entry)
                }
                if (matches.length >= maximum) {
                  stopped = true
                  break
                }
              }
              return [
                ...matches,
                stopped
                  ? "[Search incomplete: result, response or shared snapshot cap/unavailable files.]"
                  : "[Search complete within approved scope.]",
              ].join("\n")
            },
            ctx.signal,
            true,
          ),
      },
    ]
  }
}
