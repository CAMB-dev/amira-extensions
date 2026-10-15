import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs"
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import type { AskAnswer, AskQuestion } from "@amira/api"
import { validateAskAnswers } from "./answers.ts"
import { localize } from "./language.ts"
import { validateAskQuestions } from "./questions.ts"

export interface Project {
  root: string
  marker: {
    schemaVersion: 1
    id: string
    name: string
    created: string
    currentIteration: number
    settings: { language?: string; commitDocuments?: boolean }
  }
}

export interface RegistryEntry {
  id: string
  root: string
  name: string
  lastUsed: string
}

export interface DecisionRecord {
  id: string
  /** Missing on legacy records; keeps their original projection/hash-chain wording intact. */
  formatVersion?: 2
  question: AskQuestion
  answer: AskAnswer
  date: string
  language: string
  sessionId: string
  askId: string
  provenance: "human"
  /** Only the human's free text, never an inferred model explanation. */
  rationale?: string
  /** Original writer copied Other into rationale; the semantic view never treats that as an explanation. */
  legacyRationaleUnverified?: true
  supersedes: string[]
  supersededBy: string[]
}

export interface DecisionMeta {
  sessionId: string
  askId: string
  language: string
  supersedes?: string[]
}

export interface DecisionRecordOptions {
  signal?: AbortSignal
  /** Design asks acknowledge committed evidence first; project Markdown later and report its status. */
  onProjection?: (result: { conflict: boolean; path: string }) => void
  onProjectionError?: (error: unknown) => void
}

export class ProjectStorageError extends Error {
  constructor(
    readonly code: "missing" | "replaced" | "invalid" | "unsafe",
    message: string,
  ) {
    super(message)
    this.name = "ProjectStorageError"
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const singleLine = (value: string) =>
  [...value].every((char) => {
    const code = char.codePointAt(0)!
    return code >= 32 && !(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x2029
  })
const missing = (error: unknown) => isObject(error) && error.code === "ENOENT"
const key = (root: string) => {
  const resolved = path.resolve(root)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
// Bun's async Windows realpath can return "C:" for a volume root, unlike realpathSync.
const canonicalPath = (value: string) =>
  process.platform === "win32" && /^[a-z]:$/i.test(value) ? `${value}\\` : value
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
// Object key order is not part of question/answer identity; array order remains significant.
const stable = (value: unknown): string =>
  JSON.stringify(value, (_name, item: unknown) =>
    isObject(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((name) => [name, item[name]]),
        )
      : item,
  )

function invalid(message: string): never {
  throw new ProjectStorageError("invalid", message)
}

function settings(value: unknown): asserts value is Project["marker"]["settings"] {
  if (!isObject(value)) invalid("Invalid project settings")
  if (Object.keys(value).some((name) => name !== "language" && name !== "commitDocuments")) {
    invalid("Unsupported project setting; output paths are fixed")
  }
  if (value.language !== undefined && !nonempty(value.language)) invalid("Invalid project language")
  if (value.commitDocuments !== undefined && typeof value.commitDocuments !== "boolean") {
    invalid("Invalid commitDocuments setting")
  }
}

function marker(value: unknown): asserts value is Project["marker"] {
  if (!isObject(value) || value.schemaVersion !== 1 || !nonempty(value.id) || !nonempty(value.name)) {
    invalid("Malformed project marker")
  }
  if (!singleLine(value.id) || !singleLine(value.name))
    invalid("Project identity and name must be single-line text")
  if (!nonempty(value.created) || !Number.isFinite(Date.parse(value.created)))
    invalid("Invalid project creation date")
  if (!Number.isSafeInteger(value.currentIteration) || (value.currentIteration as number) < 1) {
    invalid("Invalid project iteration")
  }
  settings(value.settings)
}

/**
 * Pin directory identities, including ancestors ABOVE the selected root. Checking only the
 * canonicalized marker silently trusts a replacement junction containing a copied marker.
 * Pins last for this process; a fresh process establishes new pins on explicit selection.
 */
const directoryPins = new Map<string, Map<string, string>>()
async function pinDirectory(root: string, ...parts: string[]): Promise<void> {
  const directory = await safePath(root, ...parts)
  const stat = await lstat(directory)
  if (!stat.isDirectory()) invalid(`Project output is not a directory: ${directory}`)
  const pins = directoryPins.get(key(root))!
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${key(canonicalPath(await realpath(directory)))}`
  const prior = pins.get(key(directory))
  if (prior !== undefined && prior !== identity)
    throw new ProjectStorageError("replaced", `Project directory was replaced: ${directory}`)
  pins.set(key(directory), identity)
}

const capturedDirectories = new Set<string>()
async function captureDirectories(root: string, id: string): Promise<void> {
  const identity = `${key(root)}:${id}`
  if (capturedDirectories.has(identity)) return
  for (const parts of [
    [".amira"],
    [".amira", "project"],
    [".amira", "project", "research"],
    [".amira", "project", "iterations"],
    [".amira", "project", "iterations", "1"],
  ]) {
    try {
      await pinDirectory(root, ...parts)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  capturedDirectories.add(identity)
}

async function safePath(root: string, ...parts: string[]): Promise<string> {
  root = path.resolve(root)
  const destination = path.resolve(root, ...parts)
  const relative = path.relative(root, destination)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectStorageError("unsafe", "Project output escapes its root")
  }
  let pins = directoryPins.get(key(root))
  if (!pins) {
    pins = new Map()
    directoryPins.set(key(root), pins)
  }
  const volume = path.parse(destination).root
  const components = path.relative(volume, destination).split(path.sep).filter(Boolean)
  let current = volume
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = path.join(current, components[i]!)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (i < components.length - 1 && !stat.isDirectory())) {
        throw new ProjectStorageError("unsafe", `Unsafe project path: ${current}`)
      }
      if (stat.isDirectory() && (i < components.length - 1 || key(current) === key(root))) {
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${key(canonicalPath(await realpath(current)))}`
        const prior = pins.get(key(current))
        if (prior !== undefined && prior !== identity)
          throw new ProjectStorageError("replaced", `Project directory was replaced: ${current}`)
        pins.set(key(current), identity)
      }
    } catch (error) {
      if (!missing(error)) throw error
      if (pins.has(key(current)))
        throw new ProjectStorageError("replaced", `Project directory is missing or moved: ${current}`)
    }
  }
  return destination
}

/** Final evidence validation and publication must not yield to a queued Stop event. */
function safePathSync(root: string, ...parts: string[]): string {
  root = path.resolve(root)
  const destination = path.resolve(root, ...parts)
  const relative = path.relative(root, destination)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new ProjectStorageError("unsafe", "Project output escapes its root")
  const pins = directoryPins.get(key(root))
  if (!pins) throw new ProjectStorageError("unsafe", "Project directory was not captured")
  const volume = path.parse(destination).root
  const components = path.relative(volume, destination).split(path.sep).filter(Boolean)
  let current = volume
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = path.join(current, components[i]!)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || (i < components.length - 1 && !stat.isDirectory()))
        throw new ProjectStorageError("unsafe", `Unsafe project path: ${current}`)
      if (stat.isDirectory()) {
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${key(canonicalPath(realpathSync(current)))}`
        const prior = pins.get(key(current))
        if (prior !== undefined && prior !== identity)
          throw new ProjectStorageError("replaced", `Project directory was replaced: ${current}`)
      }
    } catch (error) {
      if (!missing(error)) throw error
      if (pins.has(key(current)))
        throw new ProjectStorageError("replaced", `Project directory is missing or moved: ${current}`)
    }
  }
  return destination
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    const absolute = path.resolve(root)
    // Initial explicit selection may use a system alias (e.g. macOS /tmp -> /private/tmp).
    // Retained projects always use the returned canonical spelling; validate any captured
    // spelling BEFORE realpath can erase a subsequently replaced root or ancestor.
    if (directoryPins.has(key(absolute))) await safePath(absolute)
    const resolved = canonicalPath(await realpath(absolute))
    if (!(await lstat(resolved)).isDirectory()) invalid(`Project root is not a directory: ${root}`)
    await safePath(resolved)
    return resolved
  } catch (error) {
    if (missing(error)) throw new ProjectStorageError("missing", `Project is missing or moved: ${root}`)
    throw error
  }
}

export async function readProject(root: string, expectedId?: string): Promise<Project> {
  const canonical = await canonicalRoot(root)
  const file = await safePath(canonical, ".amira", "project.json")
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (missing(error))
      throw new ProjectStorageError("missing", `Project marker is missing or moved: ${root}`)
    if (error instanceof SyntaxError) invalid(`Malformed project marker: ${file}`)
    throw error
  }
  marker(value)
  if (expectedId !== undefined && value.id !== expectedId) {
    throw new ProjectStorageError(
      "replaced",
      `Project was replaced at ${root}; expected ${expectedId}, found ${value.id}`,
    )
  }
  await captureDirectories(canonical, value.id)
  return { root: canonical, marker: value }
}

export async function discoverProject(cwd: string): Promise<Project | undefined> {
  let root = await canonicalRoot(cwd)
  while (true) {
    const file = await safePath(root, ".amira", "project.json")
    try {
      await lstat(file)
      // A present but invalid/inaccessible nearest marker blocks discovery of an outer project.
      return await readProject(root)
    } catch (error) {
      if (!missing(error)) throw error
    }
    const parent = path.dirname(root)
    if (parent === root) return undefined
    root = parent
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening directories for fsync. Files are still flushed before rename.
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function exclusiveWrite(file: string, content: string, check: () => Promise<unknown>): Promise<void> {
  await check()
  const handle = await open(file, "wx", 0o600)
  try {
    // Use the claimed inode, not a second path-based write which could follow a new junction.
    await check()
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await check()
  await syncDirectory(path.dirname(file))
}

function removeTemporarySync(root: string, parts: string[], file: string): void {
  try {
    safePathSync(root, ...parts)
    unlinkSync(file)
  } catch (error) {
    if (!missing(error) && !(error instanceof ProjectStorageError)) throw error
  }
}

/** Atomic replacement is reserved for extension-owned machine data, never human Markdown. */
async function atomicWrite(
  root: string,
  parts: string[],
  content: string,
  beforePublish?: () => void | Promise<void>,
  signal?: AbortSignal,
  commitProjectId?: string,
): Promise<void> {
  const file = await safePath(root, ...parts)
  const temporaryParts = [...parts.slice(0, -1), `.${parts.at(-1)}.${randomUUID()}.tmp`]
  const temporary = await safePath(root, ...temporaryParts)
  const check = () => safePath(root, ...parts)
  try {
    await exclusiveWrite(temporary, content, check)
    await check()
    await beforePublish?.()
    if (commitProjectId !== undefined) {
      safePathSync(root, ...parts)
      safePathSync(root, ...temporaryParts)
      const current: unknown = JSON.parse(readFileSync(safePathSync(root, ".amira", "project.json"), "utf8"))
      marker(current)
      if (current.id !== commitProjectId)
        throw new ProjectStorageError("replaced", "Project marker was replaced before evidence publication")
      // One short, non-yielding commit section. Otherwise a queued Stop can overtake a
      // completed rename during post-commit fsync/cleanup and the host reports declined.
      signal?.throwIfAborted()
      renameSync(temporary, file)
      if (process.platform !== "win32") {
        const directory = openSync(path.dirname(file), "r")
        try {
          fsyncSync(directory)
        } finally {
          closeSync(directory)
        }
      }
    } else {
      signal?.throwIfAborted()
      await rename(temporary, file)
      await syncDirectory(path.dirname(file))
    }
  } finally {
    // Never clean up through a directory that has been replaced, even with the same marker ID.
    if (commitProjectId !== undefined) {
      removeTemporarySync(root, temporaryParts, temporary)
    } else {
      await safePath(root, ...temporaryParts)
        .then(() => unlink(temporary))
        .catch((error) => {
          if (!missing(error) && !(error instanceof ProjectStorageError)) throw error
        })
    }
  }
}

/**
 * Filesystems do not provide compare-and-swap rename. Instead, first move the actual old
 * inode to a unique retained version, compare THAT version, and publish via a no-clobber
 * hard link. An editor saving a new inode at the original path wins; an editor holding an
 * old writable fd still writes into the retained version, never an unlinked/lost inode.
 * Versions intentionally survive success and crashes. Do not garbage-collect them while
 * external editors may hold descriptors. There is briefly no original pathname; after a
 * crash a retained version may need restoring. This is not a hostile-process sandbox:
 * Node has no portable dirfd-relative rename/link, so path checks cannot close the final
 * kernel-call TOCTOU window against malicious, continuous ancestor swapping.
 */
async function publishVersion(
  root: string,
  parts: string[],
  content: string,
  expected: string | undefined,
  validate?: () => Promise<unknown>,
): Promise<boolean> {
  const file = await safePath(root, ...parts)
  const temporaryParts = [...parts.slice(0, -1), `.${parts.at(-1)}.${randomUUID()}.tmp`]
  const temporary = await safePath(root, ...temporaryParts)
  const check = async () => {
    await validate?.()
    return safePath(root, ...parts)
  }
  try {
    await exclusiveWrite(temporary, content, check)
    // Check hardlink capability BEFORE displacing a human document (e.g. exFAT has none).
    const probeParts = [...parts.slice(0, -1), `.${parts.at(-1)}.${randomUUID()}.linkcheck`]
    const probe = await safePath(root, ...probeParts)
    try {
      await check()
      await link(temporary, probe)
    } catch (error) {
      if (
        isObject(error) &&
        ["EPERM", "EXDEV", "EOPNOTSUPP", "ENOTSUP", "ENOSYS"].includes(String(error.code))
      )
        throw new ProjectStorageError(
          "unsafe",
          "Safe Markdown publication requires hardlinks; use a filesystem that supports them. The original document was not replaced.",
        )
      throw error
    } finally {
      await safePath(root, ...probeParts)
        .then(() => unlink(probe))
        .catch((error) => {
          if (!missing(error) && !(error instanceof ProjectStorageError)) throw error
        })
    }
    await check()
    if (expected !== undefined) {
      const version = await safePath(
        root,
        ...parts.slice(0, -1),
        `.${parts.at(-1)}.${randomUUID()}.preserved`,
      )
      try {
        await check()
        await rename(file, version)
      } catch (error) {
        if (!missing(error)) throw error
        return false
      }
      await check()
      if ((await readFile(version, "utf8")) !== expected) {
        // Restore without replacing an editor's new save at the original pathname.
        await check()
        await link(version, file).catch((error) => {
          if (!isObject(error) || error.code !== "EEXIST") throw error
        })
        return false
      }
    }
    try {
      await check()
      await link(temporary, file)
      await syncDirectory(path.dirname(file))
      return true
    } catch (error) {
      if (!isObject(error) || error.code !== "EEXIST") throw error
      return false
    }
  } finally {
    await safePath(root, ...temporaryParts)
      .then(() => unlink(temporary))
      .catch((error) => {
        if (!missing(error) && !(error instanceof ProjectStorageError)) throw error
      })
  }
}

async function markdownWrite(
  root: string,
  parts: string[],
  content: string,
  expected: string | undefined,
  validate?: () => Promise<unknown>,
): Promise<{ conflict: boolean; path: string }> {
  if (await publishVersion(root, parts, content, expected, validate))
    return { conflict: false, path: await safePath(root, ...parts) }
  const base = parts.at(-1)!.replace(/\.md$/, "")
  const sibling = [...parts.slice(0, -1), `${base}.generated.md`]
  const siblingFile = await safePath(root, ...sibling)
  const prior = await optionalRead(siblingFile)
  if (prior === content || (await publishVersion(root, sibling, content, prior, validate)))
    return { conflict: true, path: siblingFile }
  // A concurrent editor also changed the generated sibling: never overwrite that save.
  const unique = [...parts.slice(0, -1), `${base}.generated.${randomUUID()}.md`]
  if (!(await publishVersion(root, unique, content, undefined, validate)))
    throw new ProjectStorageError("unsafe", "Generated document destination was claimed concurrently")
  return { conflict: true, path: await safePath(root, ...unique) }
}

async function optionalRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

const queues = new Map<string, Promise<unknown>>()
async function serialized<T>(identity: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(identity) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(action)
  queues.set(identity, result)
  try {
    return await result
  } finally {
    if (queues.get(identity) === result) queues.delete(identity)
  }
}

export async function createProject(
  root: string,
  name: string,
  projectSettings: Project["marker"]["settings"] = {},
): Promise<Project> {
  if (!nonempty(name) || !singleLine(name)) invalid("Project name must be nonempty single-line text")
  settings(projectSettings)
  projectSettings = structuredClone(projectSettings)
  const canonical = await canonicalRoot(root)
  return serialized(`create:${key(canonical)}`, async () => {
    const markerPath = await safePath(canonical, ".amira", "project.json")
    // Preflight all destinations before claiming the marker; never follow a pre-existing junction.
    for (const parts of [
      [".amira", "project"],
      [".amira", "project", "research"],
      [".amira", "project", "iterations", "1"],
      ...["design.md", "decisions.md", "suggestions.md"].map((name) => [".amira", "project", name]),
      [".gitignore"],
    ])
      await safePath(canonical, ...parts)
    await mkdir(await safePath(canonical, ".amira"), { recursive: true })
    await pinDirectory(canonical, ".amira")
    const project: Project = {
      root: canonical,
      marker: {
        schemaVersion: 1,
        id: randomUUID(),
        name: name.trim(),
        created: new Date().toISOString(),
        currentIteration: 1,
        settings: { ...projectSettings },
      },
    }
    // Exclusive creation prevents a second /project new from replacing identity.
    await exclusiveWrite(markerPath, json(project.marker), () =>
      safePath(canonical, ".amira", "project.json"),
    )
    for (const parts of [["research"], ["iterations", "1"]]) {
      await mkdir(await safePath(canonical, ".amira", "project", ...parts), { recursive: true })
      await pinDirectory(canonical, ".amira", "project", ...parts)
    }
    await captureDirectories(canonical, project.marker.id)
    for (const name of ["design.md", "decisions.md", "suggestions.md"]) {
      const file = await safePath(canonical, ".amira", "project", name)
      if ((await optionalRead(file)) === undefined)
        await exclusiveWrite(file, "", () => safePath(canonical, ".amira", "project", name))
    }
    if (!projectSettings.commitDocuments) {
      const ignore = await safePath(canonical, ".gitignore")
      // Append, never decode/rewrite existing bytes. Leading spaces are meaningful Git patterns;
      // an earlier positive rule does not override a later negation. No shell is used here.
      const handle = await open(ignore, "a+", 0o600)
      try {
        await safePath(canonical, ".gitignore")
        const opened = await handle.stat()
        const current = await lstat(ignore)
        if (opened.dev !== current.dev || opened.ino !== current.ino)
          throw new ProjectStorageError("replaced", "Gitignore was replaced while opening")
        const existing = await handle.readFile()
        const rules = existing
          .toString("utf8")
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith("#"))
        if (![".amira/project/", "/.amira/project/"].includes(rules.at(-1) ?? "")) {
          const newline = existing.includes(Buffer.from("\r\n")) ? "\r\n" : "\n"
          await safePath(canonical, ".gitignore")
          await handle.writeFile(
            `${existing.length && existing.at(-1) !== 10 ? newline : ""}.amira/project/${newline}`,
            "utf8",
          )
          await handle.sync()
        }
      } finally {
        await handle.close()
      }
    }
    return project
  })
}

async function output(project: Project, ...parts: string[]): Promise<string> {
  const current = await readProject(project.root, project.marker.id)
  return safePath(current.root, ".amira", "project", ...parts)
}

export async function readDocument(
  project: Project,
  name: "design.md" | "decisions.md" | "suggestions.md",
): Promise<string> {
  if (!["design.md", "decisions.md", "suggestions.md"].includes(name)) invalid("Unsupported project document")
  return readFile(await output(project, name), "utf8")
}

export async function writeDocument(
  project: Project,
  name: "design.md",
  content: string,
): Promise<{ conflict: boolean; path: string }> {
  if (name !== "design.md" || typeof content !== "string") invalid("Only design.md may be written directly")
  project = structuredClone(project)
  const file = await output(project, name)
  return markdownWrite(project.root, [".amira", "project", name], content, await optionalRead(file), () =>
    output(project, name),
  )
}

export async function appendSuggestion(
  project: Project,
  text: string,
  language: string,
): Promise<{ conflict: boolean; path: string }> {
  if (!nonempty(text) || !nonempty(language)) invalid("Suggestion text and language are required")
  project = structuredClone(project)
  return serialized(`suggestions:${key(project.root)}`, async () => {
    const file = await output(project, "suggestions.md")
    const existing = (await optionalRead(file)) ?? ""
    const heading = localize(language, "Pending suggestion", "待定建议", "未確定の提案")
    return markdownWrite(
      project.root,
      [".amira", "project", "suggestions.md"],
      `${existing}\n## ${heading} (${new Date().toISOString()}; ${language})\n\n${text}\n`,
      existing,
      () => output(project, "suggestions.md"),
    )
  })
}

export async function saveResearchNote(project: Project, title: string, content: string): Promise<string> {
  if (!nonempty(title) || typeof content !== "string") invalid("Research title and content are required")
  // Titles are document content, not authority over the destination filename.
  const filename = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.md`
  const file = await output(project, "research", filename)
  await exclusiveWrite(file, `# ${title}\n\n${content}\n`, () => output(project, "research", filename))
  return file
}

export class Registry {
  constructor(private readonly dataDir: string) {}

  private async root(): Promise<string> {
    const root = path.resolve(this.dataDir)
    // Validate even ancestors of a not-yet-created extension bookkeeping directory.
    await safePath(root)
    await mkdir(root, { recursive: true })
    await safePath(root)
    return realpath(root)
  }

  private async entries(root: string): Promise<RegistryEntry[]> {
    const text = await optionalRead(await safePath(root, "registry.json"))
    if (text === undefined) return []
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      invalid("Malformed project registry")
    }
    if (!Array.isArray(value)) invalid("Malformed project registry")
    for (const entry of value) {
      if (
        !isObject(entry) ||
        !nonempty(entry.id) ||
        !nonempty(entry.root) ||
        !nonempty(entry.name) ||
        !nonempty(entry.lastUsed) ||
        !Number.isFinite(Date.parse(entry.lastUsed))
      )
        invalid("Malformed registry entry")
    }
    return value as RegistryEntry[]
  }

  async list(): Promise<RegistryEntry[]> {
    const root = await this.root()
    const entries = await this.entries(root)
    const directory = await safePath(root, "registry.entries")
    const files = await readdir(directory).catch((error) => {
      if (!missing(error)) throw error
      return [] as string[]
    })
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      // Each transaction is immutable and independently published. A crashed writer's .tmp
      // is ignored, and unrelated processes never read/replace a shared registry snapshot.
      const text = await readFile(await safePath(root, "registry.entries", name), "utf8")
      let entry: unknown
      try {
        entry = JSON.parse(text)
      } catch {
        invalid("Malformed registry entry")
      }
      if (
        !isObject(entry) ||
        !nonempty(entry.id) ||
        !nonempty(entry.root) ||
        !nonempty(entry.name) ||
        !nonempty(entry.lastUsed) ||
        !Number.isFinite(Date.parse(entry.lastUsed))
      )
        invalid("Malformed registry entry")
      entries.push(entry as unknown as RegistryEntry)
    }
    // Validate each identity/location once, then prefer a healthy location over stale ones.
    // Wall-clock order is only a tie-breaker; clock skew cannot hide an explicitly reopened root.
    const candidates = new Map<string, RegistryEntry>()
    for (const entry of entries) {
      const identity = JSON.stringify([entry.id, key(entry.root)])
      const prior = candidates.get(identity)
      if (!prior || entry.lastUsed > prior.lastUsed) candidates.set(identity, entry)
    }
    const checked = await Promise.all(
      [...candidates.values()].map(async (entry) => {
        try {
          const project = await readProject(entry.root, entry.id)
          return { healthy: true, entry: { ...entry, root: project.root, name: project.marker.name } }
        } catch {
          // Preserve stale/inaccessible identities as visible rows; never substitute another ID.
          return { healthy: false, entry }
        }
      }),
    )
    checked.sort(
      (a, b) => Number(b.healthy) - Number(a.healthy) || b.entry.lastUsed.localeCompare(a.entry.lastUsed),
    )
    const valid: RegistryEntry[] = []
    for (const { entry } of checked) {
      if (!valid.some((other) => other.id === entry.id || key(other.root) === key(entry.root)))
        valid.push(entry)
    }
    return valid.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
  }

  async remember(project: Project): Promise<void> {
    project = structuredClone(project)
    const root = await this.root()
    await serialized(`registry:${key(root)}`, async () => {
      const current = await readProject(project.root, project.marker.id)
      // Keep legacy entries (including stale roots), but never replace their shared snapshot.
      await this.entries(root)
      await mkdir(await safePath(root, "registry.entries"), { recursive: true })
      await pinDirectory(root, "registry.entries")
      const entry: RegistryEntry = {
        id: current.marker.id,
        root: current.root,
        name: current.marker.name,
        lastUsed: new Date().toISOString(),
      }
      const name = `${hash(`${entry.id}:${randomUUID()}`)}.json`
      await atomicWrite(root, ["registry.entries", name], json(entry))
    })
  }
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((name) => allowed.includes(name))
}

/** Strict runtime validation; a type assertion or model-emitted object is not human evidence. */
function validateAnswers(
  questions: unknown,
  answers: unknown,
  legacy = false,
): asserts questions is AskQuestion[] {
  if (
    !Array.isArray(questions) ||
    !Array.isArray(answers) ||
    questions.length === 0 ||
    questions.length !== answers.length
  ) {
    invalid("Questions and human answers must have matching nonzero counts")
  }
  try {
    validateAskQuestions(questions)
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Invalid AskQuestion")
  }
  for (const answer of answers) {
    if (
      !isObject(answer) ||
      !exactKeys(answer, ["selected", "other"]) ||
      !Array.isArray(answer.selected) ||
      (answer.other !== undefined && !nonempty(answer.other))
    )
      invalid("Invalid human AskAnswer")
  }
  try {
    // Read-only compatibility for the original writer, which used Other as rationale even
    // on single-select answers. New record() calls ALWAYS use the host's strict cardinality.
    const checked = legacy
      ? answers.map((answer, index) => {
          if (!questions[index].multiSelect && answer.selected.length === 1 && answer.other !== undefined) {
            return { selected: answer.selected }
          }
          return answer
        })
      : answers
    validateAskAnswers(questions as AskQuestion[], checked)
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Invalid human AskAnswer")
  }
}

interface Evidence {
  schemaVersion: 1
  /** New projections correct legacy rationale semantics without rewriting old evidence/hash links. */
  projectionVersion?: 2
  meta: DecisionMeta
  questions: AskQuestion[]
  answers: AskAnswer[]
  records: DecisionRecord[]
  /** Written atomically WITH evidence, before Markdown; closes the evidence/manifest crash window. */
  priorGeneratedHash: string
}

function renderHistorical(records: DecisionRecord[]): string {
  return records
    .map((record) => {
      const text = (en: string, zh: string, ja: string) =>
        record.formatVersion === 2
          ? localize(record.language, en, zh, ja)
          : record.language.startsWith("zh")
            ? zh
            : en
      const choice =
        record.answer.selected.join(", ") ||
        (record.answer.other !== undefined || record.formatVersion !== 2
          ? text("Other", "其他", "その他")
          : text("None selected", "未选择", "選択なし"))
      const lines = [
        `## ${record.id}: ${record.question.question}`,
        "",
        `${text("Date", "日期", "日付")}: ${record.date}`,
        `${text("Language", "语言", "言語")}: ${record.language}`,
        "",
        `### ${text("Options and trade-offs", "备选方案与取舍", "選択肢とトレードオフ")}`,
      ]
      for (const option of record.question.options) {
        lines.push(
          `- [${record.answer.selected.includes(option.label) ? "x" : " "}] ${option.label}${option.description !== undefined ? ` — ${option.description}` : ""}`,
        )
      }
      lines.push("", `${text("Human choice", "用户选择", "ユーザーの選択")}: ${choice}`)
      if (record.answer.other !== undefined)
        lines.push(
          `${text("Other (exact human text)", "其他（用户原文）", "その他（ユーザーの原文）")}: ${record.answer.other}`,
        )
      lines.push(
        `${text("Rationale", "理由", "理由")}: ${record.rationale ?? text("Not supplied by the human.", "用户未提供。", "ユーザーからの説明はありません。")}`,
      )
      lines.push(
        "",
        `${text("Evidence (human response)", "证据（人类回答）", "証拠（ユーザーの回答）")}: session=${record.sessionId}; ask=${record.askId}`,
      )
      if (record.supersedes.length)
        lines.push(`${text("Supersedes", "取代", "置き換える決定")}: ${record.supersedes.join(", ")}`)
      if (record.supersededBy.length)
        lines.push(`${text("Superseded by", "被取代", "置き換えた決定")}: ${record.supersededBy.join(", ")}`)
      return `${lines.join("\n")}\n`
    })
    .join("\n")
}

function render(records: DecisionRecord[]): string {
  return renderHistorical(records)
}

function folded(evidence: Evidence[], historical = false): DecisionRecord[] {
  const records = evidence.flatMap((entry) => structuredClone(entry.records))
  for (const record of records) {
    if (
      !historical &&
      record.formatVersion === undefined &&
      record.answer.other !== undefined &&
      record.rationale === record.answer.other
    ) {
      delete record.rationale
      record.legacyRationaleUnverified = true
    }
    record.supersededBy = records
      .filter((other) => other.supersedes.includes(record.id))
      .map((other) => other.id)
  }
  return records
}

export class DecisionStore {
  private readonly project: Project

  constructor(
    project: Project,
    /** Failure-injection seam, called only after the authoritative evidence has been flushed. */
    private readonly hooks: { afterEvidenceSync?: () => void | Promise<void> } = {},
  ) {
    this.project = structuredClone(project)
  }

  private async evidence(): Promise<Evidence[]> {
    const text = await optionalRead(await output(this.project, "decisions.evidence.jsonl"))
    if (text === undefined || text === "") return []
    const result: Evidence[] = []
    const ids = new Set<string>()
    for (const line of text.trimEnd().split("\n")) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        invalid("Malformed decision evidence; refusing to guess answers")
      }
      if (
        !isObject(value) ||
        value.schemaVersion !== 1 ||
        (value.projectionVersion !== undefined && value.projectionVersion !== 2) ||
        !isObject(value.meta) ||
        !nonempty(value.meta.sessionId) ||
        !nonempty(value.meta.askId) ||
        !nonempty(value.meta.language) ||
        typeof value.priorGeneratedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.priorGeneratedHash) ||
        !Array.isArray(value.records)
      )
        invalid("Malformed decision evidence")
      const legacy = value.records.every((record) => isObject(record) && record.formatVersion === undefined)
      validateAnswers(value.questions, value.answers, legacy)
      const records = value.records as DecisionRecord[]
      if (records.length !== value.questions.length || ids.has(value.meta.askId))
        invalid("Duplicate or incomplete decision evidence")
      const supersedes = value.meta.supersedes ?? []
      if (
        !Array.isArray(supersedes) ||
        supersedes.some(
          (id) =>
            typeof id !== "string" ||
            !result.flatMap((entry) => entry.records).some((record) => record.id === id),
        )
      )
        invalid("Invalid supersession evidence")
      for (let i = 0; i < records.length; i++) {
        const record = records[i]
        if (
          !isObject(record) ||
          record.id !== `D${result.reduce((count, entry) => count + entry.records.length, 0) + i + 1}` ||
          record.provenance !== "human" ||
          record.sessionId !== value.meta.sessionId ||
          record.askId !== value.meta.askId ||
          record.language !== value.meta.language ||
          !nonempty(record.date) ||
          !Number.isFinite(Date.parse(record.date)) ||
          JSON.stringify(record.question) !== JSON.stringify(value.questions[i]) ||
          JSON.stringify(record.answer) !== JSON.stringify((value.answers as AskAnswer[])[i]) ||
          (record.formatVersion !== undefined && record.formatVersion !== 2) ||
          (record.formatVersion === 2
            ? record.rationale !== undefined
            : record.rationale !== (value.answers as AskAnswer[])[i]?.other) ||
          JSON.stringify(record.supersedes) !== JSON.stringify(supersedes) ||
          !Array.isArray(record.supersededBy) ||
          record.supersededBy.length !== 0
        )
          invalid("Invalid human decision record")
      }
      const priorProjection =
        value.projectionVersion === 2 ? render(folded(result)) : renderHistorical(folded(result, true))
      if (value.priorGeneratedHash !== hash(priorProjection)) invalid("Broken decision evidence hash chain")
      ids.add(value.meta.askId)
      result.push(value as unknown as Evidence)
    }
    return result
  }

  async records(): Promise<DecisionRecord[]> {
    return folded(await this.evidence())
  }

  private async regenerate(evidence: Evidence[]): Promise<{ conflict: boolean; path: string }> {
    const generated = render(folded(evidence))
    const generatedHash = hash(generated)
    const file = await output(this.project, "decisions.md")
    const current = await optionalRead(file)
    const manifestFile = await output(this.project, "decisions.manifest.json")
    const manifestText = await optionalRead(manifestFile)
    let manifestHash: string | undefined
    if (manifestText !== undefined) {
      let manifest: unknown
      try {
        manifest = JSON.parse(manifestText)
      } catch {
        invalid("Malformed decision hash manifest")
      }
      if (
        !isObject(manifest) ||
        manifest.schemaVersion !== 1 ||
        typeof manifest.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(manifest.hash)
      )
        invalid("Malformed decision hash manifest")
      // A manifest can only bless actual generated content, not an arbitrary edited document.
      const knownHashes = new Set([
        hash(""),
        ...evidence.map((entry) => entry.priorGeneratedHash),
        // Original generated bytes remain verifiable, but are not the semantic projection.
        ...evidence.map((_entry, index) =>
          hash(renderHistorical(folded(evidence.slice(0, index + 1), true))),
        ),
        ...evidence.map((_entry, index) => hash(render(folded(evidence.slice(0, index + 1))))),
        generatedHash,
      ])
      if (!knownHashes.has(manifest.hash)) invalid("Decision manifest does not match the evidence")
      manifestHash = manifest.hash
    }
    const currentHash = current === undefined ? undefined : hash(current)
    const priorHash = evidence.at(-1)?.priorGeneratedHash ?? hash("")
    // The prior projection is recoverable only while the latest generation is unacknowledged.
    // Once its manifest is flushed, reverting Markdown to that older projection is a hand edit.
    const interruptedGeneration = manifestHash !== generatedHash && currentHash === priorHash
    const historicalHash = hash(renderHistorical(folded(evidence, true)))
    const legacyProjection = manifestHash !== generatedHash && currentHash === historicalHash
    let conflict =
      currentHash !== undefined &&
      currentHash !== generatedHash &&
      currentHash !== manifestHash &&
      !interruptedGeneration &&
      !legacyProjection
    const name = conflict ? "decisions.generated.md" : "decisions.md"
    let destination = await output(this.project, name)
    const destinationText = conflict ? await optionalRead(destination) : current
    if (destinationText !== generated) {
      const published = await markdownWrite(
        this.project.root,
        [".amira", "project", name],
        generated,
        destinationText,
        () => output(this.project, name),
      )
      conflict ||= published.conflict
      destination = published.path
    }
    if (!conflict) {
      await atomicWrite(
        this.project.root,
        [".amira", "project", "decisions.manifest.json"],
        json({ schemaVersion: 1, hash: generatedHash }),
        async () => {
          await output(this.project, "decisions.manifest.json")
        },
      )
    }
    return { conflict, path: destination }
  }

  async recover(): Promise<{ conflict: boolean; path: string }> {
    return serialized(`decisions:${key(this.project.root)}`, async () =>
      this.regenerate(await this.evidence()),
    )
  }

  private async projectEvidence(evidence: Evidence[], options: DecisionRecordOptions): Promise<void> {
    if (options.onProjection || options.onProjectionError) {
      // Do not await filesystem work after the human evidence commit on an owner-ask receipt
      // path. recover() rejoins the project queue and re-reads evidence, including newer asks.
      setImmediate(() => {
        void this.recover()
          .then(options.onProjection, options.onProjectionError)
          .catch(() => {})
      })
      return
    }
    await this.regenerate(evidence)
  }

  async record(
    questions: AskQuestion[],
    answers: AskAnswer[],
    meta: DecisionMeta,
    options: DecisionRecordOptions = {},
  ): Promise<DecisionRecord[]> {
    const signal = options.signal
    const projection = { onProjection: options.onProjection, onProjectionError: options.onProjectionError }
    validateAnswers(questions, answers)
    if (
      !isObject(meta) ||
      !exactKeys(meta, ["sessionId", "askId", "language", "supersedes"]) ||
      !nonempty(meta.sessionId) ||
      !nonempty(meta.askId) ||
      !nonempty(meta.language) ||
      (meta.supersedes !== undefined &&
        (!Array.isArray(meta.supersedes) ||
          meta.supersedes.some((id) => !nonempty(id)) ||
          new Set(meta.supersedes).size !== meta.supersedes.length))
    )
      invalid("Invalid human evidence reference")
    // Capture before the first await: UI callers cannot mutate evidence while it is being flushed.
    const date = new Date().toISOString()
    const captured = structuredClone({
      questions,
      answers,
      meta: { ...meta, supersedes: meta.supersedes ?? [] },
    })
    return serialized(`decisions:${key(this.project.root)}`, async () => {
      // A queued ask can have been cancelled while another transaction held this queue.
      signal?.throwIfAborted()
      const evidence = await this.evidence()
      const duplicate = evidence.find((entry) => entry.meta.askId === captured.meta.askId)
      if (duplicate) {
        if (
          stable({ questions: duplicate.questions, answers: duplicate.answers, meta: duplicate.meta }) !==
          stable(captured)
        )
          invalid("askId was already recorded with different evidence")
        await this.projectEvidence(evidence, projection)
        return folded(evidence).filter((record) => record.askId === captured.meta.askId)
      }
      const existing = folded(evidence)
      if (captured.meta.supersedes.some((id) => !existing.some((record) => record.id === id)))
        invalid("Cannot supersede an unknown decision")
      const records: DecisionRecord[] = captured.questions.map((question, index) => ({
        id: `D${existing.length + index + 1}`,
        formatVersion: 2,
        question,
        answer: captured.answers[index]!,
        date,
        language: captured.meta.language,
        sessionId: captured.meta.sessionId,
        askId: captured.meta.askId,
        provenance: "human",
        supersedes: [...captured.meta.supersedes],
        supersededBy: [],
      }))
      const entry: Evidence = {
        schemaVersion: 1,
        projectionVersion: 2,
        ...captured,
        records,
        priorGeneratedHash: hash(render(existing)),
      }
      // Recover any previous interrupted write first. Manual edits remain untouched even when new evidence arrives.
      const recovered = await this.regenerate(evidence)
      if (recovered.conflict) projection.onProjection?.(recovered)
      const file = await output(this.project, "decisions.evidence.jsonl")
      const prior = (await optionalRead(file)) ?? ""
      await atomicWrite(
        this.project.root,
        [".amira", "project", "decisions.evidence.jsonl"],
        `${prior}${prior && !prior.endsWith("\n") ? "\n" : ""}${JSON.stringify(entry)}\n`,
        async () => {
          await output(this.project, "decisions.evidence.jsonl")
        },
        signal,
        this.project.marker.id,
      )
      await this.hooks.afterEvidenceSync?.()
      await this.projectEvidence([...evidence, entry], projection)
      return structuredClone(records)
    })
  }
}
