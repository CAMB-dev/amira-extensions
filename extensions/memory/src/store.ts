import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { ExtensionAPI, MutateFiles } from "@amira/api"
import {
  checkName,
  FILE_BYTES,
  indexText,
  type Memory,
  MemoryError,
  type MemoryInput,
  newest,
  parseMemory,
  type Scope,
  serialize,
} from "./format.ts"

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

export async function projectKey(
  cwd: string,
  run: ExtensionAPI["runCommand"],
  signal: AbortSignal,
): Promise<string> {
  let root = path.resolve(cwd)
  try {
    const result = await run(["git", "rev-parse", "--git-common-dir"], {
      cwd,
      signal,
      timeoutMs: 5000,
      stdoutOnly: true,
      maxOutputChars: 8192,
    })
    const output = result.output.trim()
    if (
      result.exitCode === 0 &&
      !result.truncated &&
      !result.timedOut &&
      !result.aborted &&
      output &&
      !/[\r\n]/.test(output)
    ) {
      const common = path.resolve(cwd, output)
      // Standard checkouts and linked worktrees share <main>/.git. Bare/separate git dirs
      // use the common directory itself as their identity, never a worktree's .git file.
      root = path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : common
    }
  } catch {
    // Git missing, non-git cwd, or failed probe: a stable cwd key still works.
  }
  root = await realpath(root).catch(() => root)
  if (process.platform === "win32") root = root.toLowerCase()
  const readable =
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "project"
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  return `${readable}-${hash}`
}

export function requireMain(depth: number | undefined): void {
  if (depth !== 0)
    throw new MemoryError("Subagents are read-only: only the main session may change memories.")
}

export interface Snapshot {
  memories: Memory[]
  index: string
  needsRepair: boolean
  invalid: number
}

/** All reads, including recovery of a missing/damaged index, are strictly disk-read-only. */
export class MemoryStore {
  readonly dir: string
  private readonly dataDir: string

  constructor(dataDir: string, scope: Scope, key: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(key)) throw new MemoryError("Invalid project key.")
    this.dataDir = path.resolve(dataDir)
    this.dir =
      scope === "global" ? path.join(this.dataDir, "global") : path.join(this.dataDir, "projects", key)
  }

  file(name: string): string {
    checkName(name)
    return path.join(this.dir, `${name}.md`)
  }

  private directoryPaths(): string[] {
    const dirs = [this.dataDir]
    let current = this.dataDir
    for (const part of path.relative(this.dataDir, this.dir).split(path.sep)) {
      current = path.join(current, part)
      dirs.push(current)
    }
    return dirs
  }

  private temp(file: string): string {
    return path.join(this.dir, `.${path.basename(file)}.tmp`)
  }

  /** Include directory creation, lock cleanup and every atomic-rename destination/source. */
  writtenPaths(name: string, operation: "write" | "delete"): string[] {
    const file = this.file(name)
    const index = path.join(this.dir, "MEMORY.md")
    return [
      ...this.directoryPaths(),
      file,
      index,
      path.join(this.dir, ".memory.lock"),
      ...(operation === "write" ? [this.temp(file)] : []),
      this.temp(index),
    ]
  }

  /** Refuse symlinks/junctions below (and at) dataDir, including metadata and destination files. */
  private async directories(create = false): Promise<boolean> {
    for (const current of this.directoryPaths()) {
      if (create) {
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      }
      try {
        const stat = await lstat(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new MemoryError("Memory storage must use real directories, not symlinks or junctions.")
        }
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
    }
    return true
  }

  private async regular(file: string): Promise<boolean> {
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
        throw new MemoryError("Memory files must be regular files, not links.")
      }
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  async read(name: string): Promise<Memory> {
    const file = this.file(name)
    if (!(await this.directories()) || !(await this.regular(file))) {
      throw new MemoryError("Memory not found. Use /memory list to check the name and scope.")
    }
    const stat = await lstat(file)
    if (stat.size > FILE_BYTES) throw new MemoryError("This memory exceeds the 4 KiB file limit.")
    return parseMemory(await readFile(file, "utf8"), name)
  }

  async snapshot(): Promise<Snapshot> {
    const memories: Memory[] = []
    let invalid = 0
    if (!(await this.directories()))
      return { memories, index: indexText(memories), needsRepair: true, invalid }
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (entry.name === "MEMORY.md" || !entry.name.endsWith(".md")) continue
      try {
        memories.push(await this.read(entry.name.slice(0, -3)))
      } catch (error) {
        if (error instanceof MemoryError || isMissing(error)) invalid++
        else throw error
      }
    }
    newest(memories)
    const index = indexText(memories)
    let saved: string | undefined
    const file = path.join(this.dir, "MEMORY.md")
    try {
      if (await this.regular(file)) {
        // A damaged index cannot cause an unbounded read.
        if ((await lstat(file)).size <= Math.max(Buffer.byteLength(index), 8192))
          saved = await readFile(file, "utf8")
      }
    } catch (error) {
      if (!(error instanceof MemoryError) && !isMissing(error)) throw error
    }
    return { memories, index: saved === index ? saved : index, needsRepair: saved !== index, invalid }
  }

  /** Lock directories are never stolen on age alone: a slow live writer must keep ownership. */
  private async locked<T>(
    depth: number | undefined,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> {
    requireMain(depth)
    signal.throwIfAborted()
    await this.directories(true)
    const lock = path.join(this.dir, ".memory.lock")
    const deadline = Date.now() + 15_000
    while (true) {
      signal.throwIfAborted()
      try {
        await mkdir(lock, { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (Date.now() >= deadline) {
          throw new MemoryError(
            "Memory storage is busy. Retry; if a writer crashed, remove .memory.lock only after all writers have stopped.",
          )
        }
        await sleep(25, undefined, { signal })
      }
    }
    try {
      await this.directories()
      signal.throwIfAborted()
      return await task()
    } finally {
      await rmdir(lock)
    }
  }

  private async atomic(file: string, text: string, mutate?: MutateFiles): Promise<void> {
    await this.regular(file)
    // The directory lock serializes these deterministic names; wx refuses stale files or links.
    const temp = this.temp(file)
    const write = async () => {
      const handle = await open(temp, "wx", 0o600)
      try {
        await handle.writeFile(text, "utf8")
        await handle.sync()
        await handle.close()
        await rename(temp, file)
      } finally {
        await handle.close()
        await unlink(temp).catch((error: unknown) => {
          if (!isMissing(error)) throw error
        })
      }
    }
    // Rewind captures file images, not the directories/lock in the permission path report.
    if (mutate) {
      await mutate(
        [
          { path: file, after: Buffer.from(text) },
          { path: temp, after: null },
        ],
        write,
      )
    } else await write()
  }

  private async syncIndex(mutate?: MutateFiles): Promise<void> {
    const snapshot = await this.snapshot()
    await this.atomic(path.join(this.dir, "MEMORY.md"), snapshot.index, mutate)
  }

  async write(
    input: MemoryInput,
    depth: number | undefined,
    signal: AbortSignal,
    mutate?: MutateFiles,
  ): Promise<Memory> {
    requireMain(depth)
    const memory = serialize(input)
    await this.locked(depth, signal, async () => {
      // Refuse a linked index before touching any memory file.
      await this.regular(path.join(this.dir, "MEMORY.md"))
      await this.atomic(this.file(memory.name), memory.text, mutate)
      await this.syncIndex(mutate)
    })
    return memory
  }

  async delete(
    name: string,
    depth: number | undefined,
    signal: AbortSignal,
    mutate?: MutateFiles,
  ): Promise<void> {
    requireMain(depth)
    const file = this.file(name)
    await this.locked(depth, signal, async () => {
      await this.regular(path.join(this.dir, "MEMORY.md"))
      if (!(await this.regular(file)))
        throw new MemoryError("Memory not found. Use /memory list to check the name and scope.")
      const remove = () => unlink(file)
      if (mutate) await mutate([{ path: file, after: null }], remove)
      else await remove()
      await this.syncIndex(mutate)
    })
  }
}

export function safeError(error: unknown): string {
  return error instanceof MemoryError
    ? error.message
    : "Memory storage could not be accessed. Check its permissions and try again."
}
