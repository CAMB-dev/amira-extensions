import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  linkSync,
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
import { type IterationArtifact, type PrototypeManifestArtifact, validateArtifact } from "./artifacts.ts"
import { localize } from "./language.ts"
import { validateAskQuestions } from "./questions.ts"
import {
  type AcceptedBatchRef,
  type ApprovalContext,
  type BatchManifest,
  batchProgress,
  hasManualProblem,
  type IterationState,
  initialIteration,
  reduceStage,
  type StageEvent,
  validateIteration,
} from "./stage.ts"

export type {
  AcceptanceArtifact,
  BatchPlanArtifact,
  CorrectionArtifact,
  IterationArtifact,
  ManualTrialArtifact,
  PrototypeManifestArtifact,
  SpecArtifact,
  SpecCheck,
  SpecItem,
  StageSummaryArtifact,
} from "./artifacts.ts"

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
  formatVersion?: 2 | 3
  question: AskQuestion
  answer: AskAnswer
  date: string
  language: string
  sessionId: string
  askId: string
  provenance: "human"
  /** Only the human's free text, never an inferred model explanation. */
  rationale?: string
  /** Version 3 captures a separate human response, never AskAnswer.other. */
  reason?: string
  reasonSkipped?: true
  prototypeChoice?: PrototypeChoiceEvidence
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
  /** A separately captured human reason; not the choice question's Other field. */
  reason?: string
  reasonSkipped?: true
  /** Optional OCC guard for direct design recording; prototype choice verifies its own revision. */
  expectedRevision?: number
}

export interface PrototypeChoiceEvidence {
  projectId: string
  iteration: number
  revision: number
  manifest: IterationState["artifacts"][number]
  variantId: string | null
}

export interface DecisionRecordOptions {
  signal?: AbortSignal
  /** Store-supplied immutable pointers captured in the same atomic evidence write as the answer. */
  prototypeChoice?: PrototypeChoiceEvidence
  /** Design asks acknowledge committed evidence first; project Markdown later and report its status. */
  onProjection?: (result: { conflict: boolean; path: string }) => void
  onProjectionError?: (error: unknown) => void
}

export type ProjectStorageDetails =
  | { reason: "missing" | "replaced" | "invalid" | "unsafe" }
  | { reason: "stale-revision"; expectedRevision: number; currentRevision: number }
  | { reason: "unsupported-schema"; document: string; encountered: number; supported: number }
  | { reason: "transition-rejected" }
  | { reason: "malformed-storage" | "hash-mismatch"; document: string }

export class ProjectStorageError extends Error {
  constructor(
    readonly code: "missing" | "replaced" | "invalid" | "unsafe",
    message: string,
    readonly details: ProjectStorageDetails = { reason: code },
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

/** Unsupported formats are not damaged evidence. Never repair or reinterpret them. */
function checkSchema(value: unknown, document: string): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== 1)
    throw new ProjectStorageError(
      "invalid",
      `Unsupported ${document} schema version ${value}; supported version: 1. Use a compatible extension without deleting or rewriting evidence.`,
      { reason: "unsupported-schema", document, encountered: value, supported: 1 },
    )
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
  if (isObject(value)) checkSchema(value.schemaVersion, "project marker")
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
  commitIteration?: number,
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
      if (
        current.id !== commitProjectId ||
        (commitIteration !== undefined && current.currentIteration !== commitIteration)
      )
        throw new ProjectStorageError(
          "replaced",
          "Project marker or captured iteration was replaced before evidence publication",
        )
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

function reasonMetadata(meta: Record<string, unknown>): boolean {
  return (
    (meta.reason === undefined || nonempty(meta.reason)) &&
    (meta.reasonSkipped === undefined || meta.reasonSkipped === true) &&
    !(meta.reason !== undefined && meta.reasonSkipped !== undefined)
  )
}

function validatePrototypeChoice(value: unknown): asserts value is PrototypeChoiceEvidence {
  if (
    !isObject(value) ||
    !exactKeys(value, ["projectId", "iteration", "revision", "manifest", "variantId"]) ||
    !nonempty(value.projectId) ||
    !Number.isSafeInteger(value.iteration) ||
    (value.iteration as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.variantId !== null && !nonempty(value.variantId)) ||
    !isObject(value.manifest) ||
    !exactKeys(value.manifest, ["id", "kind", "path", "hash"]) ||
    !nonempty(value.manifest.id) ||
    value.manifest.kind !== "prototype-manifest" ||
    !nonempty(value.manifest.path) ||
    typeof value.manifest.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifest.hash)
  )
    invalid("Invalid prototype choice evidence")
}

interface Evidence {
  schemaVersion: 1
  /** New projections correct legacy rationale semantics without rewriting old evidence/hash links. */
  projectionVersion?: 2 | 3
  prototypeChoice?: PrototypeChoiceEvidence
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
        record.formatVersion !== undefined
          ? localize(record.language, en, zh, ja)
          : record.language.startsWith("zh")
            ? zh
            : en
      const choice =
        record.answer.selected.join(", ") ||
        (record.answer.other !== undefined || record.formatVersion === undefined
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
        `${text("Rationale", "理由", "理由")}: ${record.rationale ?? (record.reasonSkipped ? text("Explicitly skipped by the human.", "用户明确跳过。", "ユーザーが明示的に省略しました。") : text("Not supplied by the human.", "用户未提供。", "ユーザーからの説明はありません。"))}`,
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
        (value.projectionVersion !== undefined &&
          value.projectionVersion !== 2 &&
          value.projectionVersion !== 3) ||
        !isObject(value.meta) ||
        !nonempty(value.meta.sessionId) ||
        !nonempty(value.meta.askId) ||
        !nonempty(value.meta.language) ||
        typeof value.priorGeneratedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.priorGeneratedHash) ||
        !Array.isArray(value.records)
      )
        invalid("Malformed decision evidence")
      const modern = value.projectionVersion === 3
      if (
        modern &&
        (!reasonMetadata(value.meta) ||
          (value.meta.reason === undefined && value.meta.reasonSkipped !== true))
      )
        invalid("Version 3 evidence requires an explicit reason or skip")
      if (value.prototypeChoice !== undefined) {
        validatePrototypeChoice(value.prototypeChoice)
        if (!modern || value.records.length !== 1) invalid("Prototype choice requires version 3 evidence")
      }
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
          (modern
            ? record.formatVersion !== 3
            : record.formatVersion !== undefined && record.formatVersion !== 2) ||
          (modern
            ? record.reason !== value.meta.reason ||
              record.rationale !== value.meta.reason ||
              record.reasonSkipped !== value.meta.reasonSkipped ||
              stable(record.prototypeChoice) !== stable(value.prototypeChoice)
            : record.reason !== undefined ||
              record.reasonSkipped !== undefined ||
              record.prototypeChoice !== undefined ||
              (record.formatVersion === 2
                ? record.rationale !== undefined
                : record.rationale !== (value.answers as AskAnswer[])[i]?.other)) ||
          JSON.stringify(record.supersedes) !== JSON.stringify(supersedes) ||
          !Array.isArray(record.supersededBy) ||
          record.supersededBy.length !== 0
        )
          invalid("Invalid human decision record")
      }
      const priorProjection =
        value.projectionVersion !== undefined
          ? render(folded(result))
          : renderHistorical(folded(result, true))
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
      !exactKeys(meta, [
        "sessionId",
        "askId",
        "language",
        "supersedes",
        "reason",
        "reasonSkipped",
        "expectedRevision",
      ]) ||
      !reasonMetadata(meta) ||
      (meta.expectedRevision !== undefined &&
        (!Number.isSafeInteger(meta.expectedRevision) || (meta.expectedRevision as number) < 0)) ||
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
      ...(options.prototypeChoice ? { prototypeChoice: options.prototypeChoice } : {}),
    })
    const modern = meta.reason !== undefined || meta.reasonSkipped === true
    if (captured.prototypeChoice !== undefined) {
      validatePrototypeChoice(captured.prototypeChoice)
      if (!modern || questions.length !== 1) invalid("Prototype choice requires an explicit reason or skip")
    }
    if (meta.expectedRevision !== undefined) {
      if (captured.prototypeChoice) invalid("Use recordPrototypeChoice for prototype revision guards")
      const { expectedRevision, ...guardedMeta } = captured.meta
      return new IterationStore(this.project).guardDesignRevision(expectedRevision!, () =>
        this.record(captured.questions, captured.answers, guardedMeta, options),
      )
    }
    return serialized(`decisions:${key(this.project.root)}`, async () => {
      // A queued ask can have been cancelled while another transaction held this queue.
      signal?.throwIfAborted()
      const evidence = await this.evidence()
      const duplicate = evidence.find((entry) => entry.meta.askId === captured.meta.askId)
      if (duplicate) {
        if (
          stable({
            questions: duplicate.questions,
            answers: duplicate.answers,
            meta: duplicate.meta,
            ...(duplicate.prototypeChoice ? { prototypeChoice: duplicate.prototypeChoice } : {}),
          }) !== stable(captured)
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
        formatVersion: modern ? 3 : 2,
        ...(modern
          ? {
              ...(captured.meta.reason !== undefined
                ? { reason: captured.meta.reason, rationale: captured.meta.reason }
                : { reasonSkipped: true as const }),
              ...(captured.prototypeChoice ? { prototypeChoice: captured.prototypeChoice } : {}),
            }
          : {}),
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
        projectionVersion: modern ? 3 : 2,
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
        captured.prototypeChoice?.iteration,
      )
      await this.hooks.afterEvidenceSync?.()
      await this.projectEvidence([...evidence, entry], projection)
      return structuredClone(records)
    })
  }
}

export interface IterationStoreOptions {
  /** Test-only crash/race boundaries. Publication of the immutable state record is the commit. */
  beforePublish?: () => void | Promise<void>
  afterPublish?: () => void | Promise<void>
  afterArtifactPublish?: () => void | Promise<void>
}
type IterationArtifactRef = IterationState["artifacts"][number]
interface IterationRecord {
  schemaVersion: 1
  previousHash: string | null
  state: IterationState
}
interface IterationHead {
  state: IterationState
  text: string
  hash: string
  history: string[]
}

/**
 * The immutable, hash-chained .state records are authoritative; state.json is their
 * recoverable projection. A crash after the record commit never replays stage work.
 * Existing publication helpers retain edited inodes, including editor-held fds.
 */
export class IterationStore {
  private readonly project: Project
  private readonly parts: string[]
  private captured = false

  constructor(
    project: Project,
    private readonly options: IterationStoreOptions = {},
  ) {
    this.project = structuredClone(project)
    marker(this.project.marker)
    this.parts = [".amira", "project", "iterations", String(project.marker.currentIteration)]
  }

  private async check(): Promise<void> {
    if (!this.captured) {
      await readProject(this.project.root, this.project.marker.id)
      this.captured = true
    }
    // Selection establishes canonical pins once. Rechecking those same pins and the
    // marker does not need repeated asynchronous canonicalization at every fs boundary.
    this.checkSync()
    safePathSync(this.project.root, ...this.parts)
  }

  private checkSync(): void {
    const current = this.parse(
      readFileSync(safePathSync(this.project.root, ".amira", "project.json"), "utf8"),
    )
    marker(current)
    if (
      current.id !== this.project.marker.id ||
      current.currentIteration !== this.project.marker.currentIteration
    )
      throw new ProjectStorageError(
        "replaced",
        "Project identity changed or captured iteration is stale; reopen before publication",
      )
  }

  private async directory(...suffix: string[]): Promise<void> {
    await this.check()
    const parts = [...this.parts, ...suffix]
    await mkdir(await safePath(this.project.root, ...parts), { recursive: true })
    await pinDirectory(this.project.root, ...parts)
    await syncDirectory(path.dirname(await safePath(this.project.root, ...parts)))
  }

  private prototypeParts(variantId: string): string[] {
    if (
      typeof variantId !== "string" ||
      variantId === "none" ||
      !/^[A-Za-z][A-Za-z0-9._-]*$/.test(variantId) ||
      variantId.endsWith(".") ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(variantId)
    )
      invalid("Invalid prototype variant ID")
    return [".amira", "project", "prototypes", String(this.project.marker.currentIteration), variantId]
  }

  /** Create/check a variant-scoped directory without trusting model-selected paths. */
  async preparePrototypeDirectory(variantId: string): Promise<string> {
    const parts = this.prototypeParts(variantId)
    return this.transaction(async () => {
      for (let length = 3; length <= parts.length; length++) {
        const prefix = parts.slice(0, length)
        await this.check()
        await mkdir(await safePath(this.project.root, ...prefix), { recursive: true })
        await pinDirectory(this.project.root, ...prefix)
        await syncDirectory(path.dirname(await safePath(this.project.root, ...prefix)))
      }
      await this.check()
      return safePath(this.project.root, ...parts)
    })
  }

  private async prototypePaths(manifest: PrototypeManifestArtifact, live = false): Promise<void> {
    // Historical evidence outlives disposable output. Only publication of a fresh report
    // checks live paths; recovery checks recorded identity/containment without pinning code.
    for (const variant of manifest.variants) {
      const parts = this.prototypeParts(variant.id)
      const directory = path.resolve(this.project.root, ...parts)
      if (variant.directory !== directory)
        throw new ProjectStorageError(
          "unsafe",
          "Prototype directory must match its project, iteration and variant ID",
        )
      if (path.resolve(variant.cwd) !== variant.cwd) invalid("Prototype cwd is not canonical")
      if (live && variant.status === "ready") {
        for (const location of [directory, variant.cwd]) {
          safePathSync(this.project.root, location)
          if (!lstatSync(location).isDirectory()) invalid(`Prototype output is not a directory: ${location}`)
        }
      }
    }
  }

  private parse(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      throw new ProjectStorageError("invalid", "Malformed iteration storage; manual edits were preserved", {
        reason: "malformed-storage",
        document: "iteration storage",
      })
    }
  }

  private validateState(value: unknown): asserts value is IterationState {
    if (isObject(value)) checkSchema(value.schemaVersion, "iteration state")
    try {
      validateIteration(value)
    } catch (error) {
      invalid(`Invalid iteration state: ${error instanceof Error ? error.message : String(error)}`)
    }
    const state = value as IterationState
    if (
      state.projectId !== this.project.marker.id ||
      state.iteration !== this.project.marker.currentIteration
    )
      throw new ProjectStorageError("replaced", "Iteration state belongs to a different project or iteration")
    for (const ref of state.artifacts) this.referenceParts(ref)
  }

  private referenceParts(ref: IterationArtifactRef): string[] {
    const kinds = [
      "prototype-manifest",
      "stage-summary",
      "spec",
      "batch-plan",
      "acceptance",
      "manual-trial",
      "correction",
    ]
    if (
      !isObject(ref) ||
      Object.keys(ref).some((field) => !["id", "kind", "path", "hash"].includes(field)) ||
      typeof ref.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(ref.id) ||
      !kinds.includes(ref.kind) ||
      !/^[a-f0-9]{64}$/.test(ref.hash)
    )
      invalid("Invalid generated iteration artifact reference")
    const parts = [...this.parts, "artifacts", `${ref.kind}-${ref.id}.json`]
    if (ref.path !== parts.join("/"))
      throw new ProjectStorageError("unsafe", "Artifact paths are generated by the iteration store")
    return parts
  }

  /** Stage input never controls a filesystem destination. */
  private async artifact(ref: IterationArtifactRef): Promise<IterationArtifact> {
    const parts = this.referenceParts(ref)
    const content = await optionalRead(await safePath(this.project.root, ...parts))
    if (content === undefined) invalid(`Committed iteration artifact is missing: ${ref.id}`)
    if (hash(content) !== ref.hash)
      invalid(`Iteration artifact was edited: ${ref.id}; original bytes were preserved`)
    const value = this.parse(content)
    if (isObject(value)) checkSchema(value.schemaVersion, "iteration artifact")
    if (
      !isObject(value) ||
      Object.keys(value).some(
        (field) => !["schemaVersion", "projectId", "iteration", "id", "artifact"].includes(field),
      ) ||
      value.schemaVersion !== 1 ||
      value.projectId !== this.project.marker.id ||
      value.iteration !== this.project.marker.currentIteration ||
      value.id !== ref.id
    )
      invalid("Invalid iteration artifact envelope")
    try {
      validateArtifact(value.artifact)
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error))
    }
    if (value.artifact.kind !== ref.kind) invalid("Iteration artifact kind mismatch")
    if (value.artifact.kind === "prototype-manifest") await this.prototypePaths(value.artifact)
    return value.artifact
  }

  /** Atomic no-clobber publication of a complete, flushed immutable record. */
  private async immutable(
    parts: string[],
    content: string,
    beforePublish?: () => Promise<void>,
  ): Promise<void> {
    const temporaryParts = [...parts.slice(0, -1), `.${parts.at(-1)}.${randomUUID()}.tmp`]
    const file = await safePath(this.project.root, ...parts)
    const temporary = await safePath(this.project.root, ...temporaryParts)
    try {
      await exclusiveWrite(temporary, content, () => this.check())
      await beforePublish?.()
      this.checkSync()
      safePathSync(this.project.root, ...parts)
      safePathSync(this.project.root, ...temporaryParts)
      // No await between final identity checks and the publication syscall.
      linkSync(temporary, file)
      if (process.platform !== "win32") {
        const directory = openSync(path.dirname(file), "r")
        try {
          fsyncSync(directory)
        } finally {
          closeSync(directory)
        }
      }
    } catch (error) {
      if (isObject(error) && error.code === "EEXIST")
        throw new ProjectStorageError(
          "invalid",
          "Iteration publication was claimed by another writer; reload state",
        )
      throw error
    } finally {
      removeTemporarySync(this.project.root, temporaryParts, temporary)
    }
  }

  private async claim(parts: string[], depth = 0): Promise<() => void> {
    if (depth > 32) invalid("Too many abandoned writer recovery claims")
    const token = randomUUID()
    const claim = json({ pid: process.pid, token })
    const file = await safePath(this.project.root, ...parts)
    for (;;) {
      if (await publishVersion(this.project.root, parts, claim, undefined, () => this.check())) {
        return () => {
          this.checkSync()
          if (readFileSync(safePathSync(this.project.root, ...parts), "utf8") !== claim)
            throw new ProjectStorageError("replaced", "Iteration writer claim was replaced")
          unlinkSync(file)
        }
      }
      const priorText = await optionalRead(await safePath(this.project.root, ...parts))
      if (priorText === undefined) continue
      const prior = this.parse(priorText)
      if (
        !isObject(prior) ||
        !Number.isSafeInteger(prior.pid) ||
        (prior.pid as number) <= 0 ||
        typeof prior.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(prior.token)
      )
        invalid("Malformed iteration writer claim; refusing to steal it")
      try {
        process.kill(prior.pid as number, 0)
        throw new ProjectStorageError("invalid", "Iteration is in use by a live writer; reload and retry")
      } catch (error) {
        if (!isObject(error) || error.code !== "ESRCH") throw error
      }
      // A per-dead-token recovery claim serializes removers. Without this, two stale
      // removers can accidentally unlink a NEW live claim after the first removes it.
      const release = await this.claim([...this.parts, `.writer-recovery-${prior.token}.lock`], depth + 1)
      try {
        this.checkSync()
        const current = safePathSync(this.project.root, ...parts)
        if (readFileSync(current, "utf8") === priorText) unlinkSync(current)
      } catch (error) {
        if (!missing(error)) throw error
      } finally {
        release()
      }
    }
  }

  private async transaction<T>(action: () => Promise<T>): Promise<T> {
    return serialized(
      `iteration:${key(this.project.root)}:${this.project.marker.currentIteration}`,
      async () => {
        await this.directory()
        const release = await this.claim([...this.parts, ".writer.lock"])
        try {
          await this.directory(".state")
          await this.directory("artifacts")
          return await action()
        } finally {
          release()
        }
      },
    )
  }

  private async auditPreserved(history: string[]): Promise<void> {
    const directory = await safePath(this.project.root, ...this.parts)
    for (const name of await readdir(directory)) {
      if (!/^\.state\.json\.[a-f0-9-]+\.preserved$/.test(name)) continue
      const content = await readFile(await safePath(this.project.root, ...this.parts, name), "utf8")
      if (!history.includes(content))
        invalid("A retained iteration state was manually edited; edits were preserved")
    }
  }

  private async projection(head: IterationHead, repair: boolean): Promise<void> {
    const parts = [...this.parts, "state.json"]
    const file = await safePath(this.project.root, ...parts)
    const current = await optionalRead(file)
    const receiptParts = [
      ...this.parts,
      ".state",
      `${String(head.state.revision).padStart(16, "0")}.projected`,
    ]
    const receipt = await optionalRead(await safePath(this.project.root, ...receiptParts))
    if (receipt !== undefined && receipt !== `${head.hash}\n`)
      invalid("Iteration projection receipt was edited")
    const acknowledge = async () => {
      if (repair && receipt === undefined) await this.immutable(receiptParts, `${head.hash}\n`)
    }
    await this.auditPreserved(head.history)
    if (current === head.text) {
      await acknowledge()
      return
    }
    // Only an incomplete publication may repair an older byte-exact projection or
    // the short rename gap. After acknowledgment even a valid old snapshot is an
    // edit/rollback, not permission to regenerate state.json over the human's save.
    if (receipt !== undefined || (current !== undefined && !head.history.includes(current)))
      invalid("Iteration state.json was manually edited; edits were preserved")
    if (!repair) invalid("Iteration state projection changed during publication")
    if (!(await publishVersion(this.project.root, parts, head.text, current, () => this.check())))
      invalid("Iteration state.json changed during recovery; edits were preserved")
    await this.auditPreserved(head.history)
    if ((await optionalRead(file)) !== head.text) invalid("Iteration state.json changed during recovery")
    await acknowledge()
  }

  private async load(): Promise<IterationHead> {
    await this.check()
    const directory = await safePath(this.project.root, ...this.parts, ".state")
    const names = (await readdir(directory))
      .filter((name) => !name.endsWith(".tmp") && !/^\d{16}\.projected$/.test(name))
      .sort()
    let head: IterationHead | undefined
    for (const name of names) {
      const expectedRevision = head ? head.state.revision + 1 : 0
      if (name !== `${String(expectedRevision).padStart(16, "0")}.json`)
        invalid("Iteration journal is corrupt or has a missing revision")
      const content = await readFile(await safePath(this.project.root, ...this.parts, ".state", name), "utf8")
      const value = this.parse(content)
      if (isObject(value)) checkSchema(value.schemaVersion, "iteration journal")
      if (
        !isObject(value) ||
        value.schemaVersion !== 1 ||
        Object.keys(value).some((field) => !["schemaVersion", "previousHash", "state"].includes(field)) ||
        !(
          value.previousHash === null ||
          (typeof value.previousHash === "string" && /^[a-f0-9]{64}$/.test(value.previousHash))
        )
      )
        throw new ProjectStorageError(
          "invalid",
          "Malformed iteration journal envelope; evidence was preserved",
          { reason: "malformed-storage", document: "iteration journal" },
        )
      if (value.previousHash !== (head?.hash ?? null))
        throw new ProjectStorageError("invalid", "Iteration journal hash chain is corrupt", {
          reason: "hash-mismatch",
          document: "iteration journal",
        })
      this.validateState(value.state)
      if (value.state.revision !== expectedRevision) invalid("Iteration journal revision mismatch")
      const stateText = json(value.state)
      head = {
        state: value.state,
        text: stateText,
        hash: hash(content),
        history: [...(head?.history ?? []), stateText],
      }
    }
    if (!head) {
      const existing = await optionalRead(await safePath(this.project.root, ...this.parts, "state.json"))
      if (existing !== undefined) invalid("Unrecognized iteration state.json; existing bytes were preserved")
      const state = initialIteration(this.project.marker.id, this.project.marker.currentIteration)
      head = await this.commit(state)
    }
    // Recovery is a publication too: reject incompatible/missing evidence and false
    // plan metadata before touching state.json or creating a projection acknowledgement.
    for (const ref of head.state.artifacts) await this.artifact(ref)
    await this.batchMetadata(head.state, true)
    await this.projection(head, true)
    return head
  }

  private async commit(state: IterationState, previous?: IterationHead): Promise<IterationHead> {
    this.validateState(state)
    const record: IterationRecord = { schemaVersion: 1, previousHash: previous?.hash ?? null, state }
    const content = json(record)
    await this.immutable(
      [...this.parts, ".state", `${String(state.revision).padStart(16, "0")}.json`],
      content,
      async () => {
        await this.options.beforePublish?.()
        if (previous) await this.projection(previous, false)
        else if (
          (await optionalRead(await safePath(this.project.root, ...this.parts, "state.json"))) !== undefined
        )
          invalid("Iteration state was created concurrently; existing bytes were preserved")
        await this.check()
        for (const ref of state.artifacts) await this.artifact(ref)
        await this.batchMetadata(state)
      },
    )
    // The durable record is now authoritative, even if the caller never receives a receipt.
    await this.options.afterPublish?.()
    const text = json(state)
    const head = { state, text, hash: hash(content), history: [...(previous?.history ?? []), text] }
    await this.projection(head, true)
    return head
  }

  private expected(head: IterationHead, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== head.state.revision)
      throw new ProjectStorageError(
        "invalid",
        `Stale iteration writer: expected revision ${expectedRevision}, current revision ${head.state.revision}; reload state`,
        { reason: "stale-revision", expectedRevision, currentRevision: head.state.revision },
      )
  }

  async read(): Promise<IterationState> {
    return this.transaction(async () => structuredClone((await this.load()).state))
  }

  /**
   * Design writers share the iteration claim with stage commands, including across processes.
   * Invalidate captured summaries/approvals BEFORE publishing human evidence. There is no new
   * asynchronous state write after the decision's synchronous durable acknowledgment boundary.
   */
  async guardDesignRevision<T>(expectedRevision: number, action: () => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const head = await this.load()
      this.expected(head, expectedRevision)
      if (
        head.state.stage !== "design" ||
        head.state.pending ||
        !["ready", "confirmed", "running"].includes(head.state.phase)
      )
        invalid("The captured design is no longer writable; reopen the current design stage")
      await this.commit({ ...head.state, revision: head.state.revision + 1 }, head)
      return action()
    })
  }

  async dispatch(expectedRevision: number, event: StageEvent): Promise<IterationState> {
    const captured = structuredClone(event)
    return this.transaction(async () => {
      const head = await this.load()
      this.expected(head, expectedRevision)
      if (captured.expectedRevision !== expectedRevision)
        invalid("Stage event revision does not match the writer revision")
      await this.validateEventBinding(head.state, captured)
      const input = structuredClone(head.state)
      if ("artifact" in captured && captured.artifact) {
        const ref = captured.artifact
        if (!head.state.artifacts.some((prior) => stable(prior) === stable(ref)))
          invalid("Stage event references an artifact not committed by this iteration store")
        // Reducer artifact events register their input reference. The store has already
        // durably published it in saveArtifact's separate revision. Present that one
        // reference as unregistered to the reducer, then restore publication order.
        input.artifacts = input.artifacts.filter((prior) => prior.id !== ref.id)
      }
      let state: IterationState
      try {
        state = reduceStage(input, captured)
      } catch (error) {
        throw new ProjectStorageError("invalid", error instanceof Error ? error.message : String(error), {
          reason: "transition-rejected",
        })
      }
      if (state.revision !== expectedRevision + 1) invalid("Reducer must advance exactly one state revision")
      // Only saveArtifact can introduce evidence. No forged model-selected path/ref is trusted.
      for (const ref of state.artifacts) {
        if (!head.state.artifacts.some((prior) => stable(prior) === stable(ref)))
          invalid("Stage event references an artifact not committed by this iteration store")
      }
      if (state.artifacts.length !== head.state.artifacts.length)
        invalid("Stage events cannot remove immutable artifact history")
      state.artifacts = head.state.artifacts
      return structuredClone((await this.commit(state, head)).state)
    })
  }

  async saveArtifact(
    expectedRevision: number,
    artifact: IterationArtifact,
  ): Promise<{ state: IterationState; artifact: IterationArtifactRef }> {
    const captured = structuredClone(artifact)
    try {
      validateArtifact(captured)
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error))
    }
    return this.transaction(async () => {
      const head = await this.load()
      this.expected(head, expectedRevision)
      await this.validateBinding(head.state, captured)
      const ref = await this.publishArtifact(head.state, captured)
      const state: IterationState = {
        ...head.state,
        revision: head.state.revision + 1,
        artifacts: [...head.state.artifacts, ref],
      }
      if (captured.kind === "batch-plan") {
        state.batchManifests = [...(state.batchManifests ?? []), this.manifest(state, ref, captured)]
      }
      if (captured.kind === "batch-plan" && state.phase === "confirmed" && state.approvedContext) {
        // New immutable plans are history, never a mutation of human authorization.
        delete state.approvedContext
        delete state.summaryId
        state.phase = "ready"
        state.status = "idle"
      }
      return { state: structuredClone((await this.commit(state, head)).state), artifact: ref }
    })
  }

  private async publishArtifact(
    state: IterationState,
    artifact: IterationArtifact,
  ): Promise<IterationArtifactRef> {
    const id = randomUUID()
    const content = json({
      schemaVersion: 1,
      projectId: state.projectId,
      iteration: state.iteration,
      id,
      artifact,
    })
    const parts = [...this.parts, "artifacts", `${artifact.kind}-${id}.json`]
    const ref: IterationArtifactRef = { id, kind: artifact.kind, path: parts.join("/"), hash: hash(content) }
    await this.immutable(parts, content)
    await this.options.afterArtifactPublish?.()
    return ref
  }

  /**
   * Hold the iteration writer claim across the stale check and atomic decision evidence write.
   * Evidence contains the immutable manifest pointers, choice and separate reason together.
   * Journal/manifest projection follows that commit; retrying the same ask completes a partial
   * projection without duplicating the decision. No stage work or command is replayed.
   */
  async recordPrototypeChoice(
    expectedRevision: number,
    manifestRef: IterationArtifactRef,
    question: AskQuestion,
    answers: AskAnswer | AskAnswer[],
    meta: DecisionMeta,
    selectedVariantId?: string | null,
    options: DecisionRecordOptions = {},
  ): Promise<{ state: IterationState; artifact: IterationArtifactRef; records: DecisionRecord[] }> {
    const captured = structuredClone({
      manifestRef,
      question,
      answers: Array.isArray(answers) ? answers : [answers],
      meta,
      selectedVariantId,
    })
    validateAnswers([captured.question], captured.answers)
    if (
      captured.question.multiSelect ||
      captured.answers[0]!.selected.length !== 1 ||
      captured.answers[0]!.other !== undefined
    )
      invalid("Prototype selection requires one explicit variant or none option, not Other")
    if (captured.meta.reason === undefined && captured.meta.reasonSkipped !== true)
      invalid("Prototype selection requires a separately captured reason or explicit skip")
    if (captured.meta.expectedRevision !== undefined && captured.meta.expectedRevision !== expectedRevision)
      invalid("Prototype decision revision does not match the writer revision")
    return this.transaction(async () => {
      const head = await this.load()
      this.expected(head, expectedRevision)
      if (
        head.state.stage !== "prototype" ||
        !["running", "finished", "summarized"].includes(head.state.phase)
      )
        invalid("Prototype choice is not at a writable prototype boundary")
      const latest = head.state.artifacts.findLast((entry) => entry.kind === "prototype-manifest")
      if (!latest || stable(latest) !== stable(captured.manifestRef))
        invalid("Prototype choice must bind the latest committed manifest")
      const manifest = await this.artifact(latest)
      if (manifest.kind !== "prototype-manifest") invalid("Prototype choice requires a manifest")
      const selected = captured.answers[0]!.selected[0]!
      // Stable IDs identify variants. A localized none label needs the caller's explicit null.
      const variantId =
        captured.selectedVariantId === undefined
          ? selected === "none"
            ? null
            : selected
          : captured.selectedVariantId
      if (
        (variantId !== null && selected !== variantId) ||
        (variantId === null && manifest.variants.some((variant) => variant.id === selected))
      )
        invalid("Prototype answer does not match the selected variant")
      if (
        variantId !== null &&
        !manifest.variants.some((variant) => variant.id === variantId && variant.status === "ready")
      )
        invalid("Choose a ready variant from the captured prototype manifest")
      const labels = captured.question.options.map((option) => option.label)
      if (
        manifest.variants.some((variant) => !labels.includes(variant.id)) ||
        labels.filter((label) => !manifest.variants.some((variant) => variant.id === label)).length > 1
      )
        invalid("Prototype question must show the manifest variants using their stable IDs")
      options.signal?.throwIfAborted()
      const { expectedRevision: _revision, ...suppliedMeta } = captured.meta
      const decisions = new DecisionStore(this.project)
      const existing = await decisions.records()
      const replay = existing.find((record) => record.askId === suppliedMeta.askId)
      // A prototype conclusion is one replaceable decision per iteration, not an
      // accumulating set of contradictory active choices. Resolve the predecessor
      // under this iteration's writer claim, including legacy multiple-active choices.
      // A partially committed ask must retain its ORIGINAL supersession edges.
      const predecessors = replay
        ? replay.supersedes
        : existing
            .filter(
              (record) =>
                record.prototypeChoice?.projectId === head.state.projectId &&
                record.prototypeChoice.iteration === head.state.iteration &&
                !record.supersededBy.length,
            )
            .map((record) => record.id)
      const decisionMeta = {
        ...suppliedMeta,
        supersedes:
          replay && suppliedMeta.supersedes !== undefined
            ? suppliedMeta.supersedes
            : [...new Set([...(suppliedMeta.supersedes ?? []), ...predecessors])],
      }
      const records = await decisions.record([captured.question], captured.answers, decisionMeta, {
        ...options,
        prototypeChoice: {
          projectId: head.state.projectId,
          iteration: head.state.iteration,
          revision: expectedRevision,
          manifest: latest,
          variantId,
        },
      })
      const chosen: PrototypeManifestArtifact = {
        ...manifest,
        chosen: { variantId, decisionId: records[0]!.id },
      }
      await this.validateBinding(head.state, chosen)
      const ref = await this.publishArtifact(head.state, chosen)
      const state = reduceStage(head.state, {
        type: "select-prototype",
        expectedRevision,
        variantId,
        decisionId: records[0]!.id,
        receipt: {
          id: randomUUID(),
          provenance: "human",
          projectId: head.state.projectId,
          iteration: head.state.iteration,
          revision: expectedRevision,
          subjectId: variantId ?? "none",
          choice: variantId ?? "none",
          reason: decisionMeta.reason ?? "Reason skipped by the human.",
        },
      })
      state.artifacts = [...head.state.artifacts, ref]
      return { state: structuredClone((await this.commit(state, head)).state), artifact: ref, records }
    })
  }

  async readArtifact(ref: IterationArtifactRef): Promise<IterationArtifact> {
    const captured = structuredClone(ref)
    return this.transaction(async () => {
      const head = await this.load()
      if (!head.state.artifacts.some((prior) => stable(prior) === stable(captured)))
        invalid("Artifact reference is not committed by this iteration")
      return structuredClone(await this.artifact(captured))
    })
  }

  private manifest(
    state: IterationState,
    ref: IterationArtifactRef,
    plan: Extract<IterationArtifact, { kind: "batch-plan" }>,
  ): BatchManifest {
    const spec = state.artifacts.find((entry) => entry.kind === "spec" && entry.hash === plan.specHash)
    if (!spec) invalid("Batch manifest requires the immutable spec")
    return {
      batchPlan: { artifactId: ref.id, hash: ref.hash },
      spec: { artifactId: spec.id, hash: spec.hash, revision: plan.specRevision },
      mode: plan.mode,
      batchIds: plan.batches.map((batch) => batch.id),
    }
  }

  /** Cross-check reducer membership against immutable documents, never a model's list. */
  private async batchMetadata(state: IterationState, migrate = false): Promise<void> {
    const manifests: BatchManifest[] = []
    for (const ref of state.artifacts.filter((entry) => entry.kind === "batch-plan")) {
      const plan = await this.artifact(ref)
      if (plan.kind !== "batch-plan") invalid("Invalid batch manifest artifact")
      manifests.push(this.manifest(state, ref, plan))
    }
    const legacy = state.batchManifests === undefined
    if (legacy && migrate) {
      state.batchManifests = manifests
      state.batchResolutions = []
      // Legacy final transitions may have consumed only one batch of a split plan.
      // Preserve that evidence, but never infer unreviewed batches from publication.
      const transition = state.transitions.at(-1)
      const attempt = state.attempts.findLast((entry) => entry.stage === "accept")
      const approval = state.receipts.find((entry) => entry.subjectId === transition?.id)
      const context = attempt?.context
      if (state.manualTrial && attempt && attempt.id === state.activeAttemptId) {
        const trialRef = state.artifacts.find((entry) => entry.id === state.manualTrial?.artifactId)
        const trial = trialRef && (await this.artifact(trialRef))
        if (
          trial?.kind === "manual-trial" &&
          trial.attemptId === attempt.id &&
          trial.attempt === attempt.review?.attempt &&
          trial.codeHash === attempt.review?.codeHash &&
          trial.batchId === context?.batchId &&
          stable(trial.batchPlan) === stable(context?.batchPlan) &&
          trial.specHash === context?.spec?.hash &&
          trial.specRevision === context?.spec?.revision
        )
          attempt.manualTrial = state.manualTrial
      }
      if (
        state.completion &&
        transition?.kind === "complete" &&
        attempt?.status === "finished" &&
        attempt.acceptance?.verdict === "pass" &&
        context?.batchId &&
        approval &&
        stable(approval.context) === stable(context)
      ) {
        const trial = attempt.manualTrial ?? state.manualTrial
        if (
          (!attempt.acceptance.manualTrialRequired || trial) &&
          (!trial || ["tried", "deferred"].includes(trial.status))
        ) {
          if (trial) attempt.manualTrial = trial
          state.batchResolutions.push({
            context,
            batchId: context.batchId,
            status: "accepted",
            receiptId: approval.id,
            attemptId: attempt.id,
            ...(trial ? { manualTrial: trial } : {}),
          })
        }
      }
      if (state.completion) {
        state.approvedContext ??= context
        const progress = batchProgress(state)
        if (!progress.manifest || progress.remaining.length || state.completion === "skipped") {
          delete state.completion
          state.phase = "summarized"
          state.status = "idle"
          state.summaryId = transition?.summaryId
          if (attempt?.status === "finished") state.activeAttemptId = attempt.id
        }
      }
    }
    if (stable(state.batchManifests) !== stable(manifests))
      invalid("Reducer batch manifest does not match immutable plan batch IDs")
    for (const resolution of state.batchResolutions ?? []) {
      if (resolution.status !== "accepted") continue
      const attempt = state.attempts.find((entry) => entry.id === resolution.attemptId)
      const ref = state.artifacts.find((entry) => entry.id === attempt?.acceptance?.artifactId)
      const evidence = ref && (await this.artifact(ref))
      if (
        evidence?.kind !== "acceptance" ||
        evidence.outcome !== "pass" ||
        evidence.attemptId !== attempt?.id ||
        evidence.attempt !== attempt.review?.attempt ||
        evidence.codeHash !== attempt.review.codeHash ||
        evidence.batchId !== resolution.batchId ||
        stable(evidence.batchPlan) !== stable(resolution.context.batchPlan) ||
        evidence.specHash !== resolution.context.spec?.hash ||
        evidence.specRevision !== resolution.context.spec.revision
      )
        invalid("Batch resolution must consume exact passing acceptance evidence")
      const plan = await this.approvedPlan(state, resolution.context)
      const batch = plan.batches.find((entry) => entry.id === resolution.batchId)!
      if (stable([...batch.itemIds].sort()) !== stable(evidence.items.map((entry) => entry.itemId).sort()))
        invalid("Batch resolution must cover every pinned batch item")
      const specRef = state.artifacts.find((entry) => entry.id === resolution.context.spec?.artifactId)!
      const spec = await this.artifact(specRef)
      const trialRequired =
        spec.kind === "spec" && spec.items.some((entry) => batch.itemIds.includes(entry.id) && entry.ui)
      if ((attempt.acceptance?.manualTrialRequired ?? false) !== trialRequired)
        invalid("Batch resolution must retain the reviewed UI manual trial requirement")
      const trial = resolution.manualTrial ?? attempt.manualTrial
      if (trial) {
        const trialRef = state.artifacts.find((entry) => entry.id === trial.artifactId)
        const payload = trialRef && (await this.artifact(trialRef))
        if (
          payload?.kind !== "manual-trial" ||
          payload.status !== trial.status ||
          payload.attemptId !== evidence.attemptId ||
          payload.attempt !== evidence.attempt ||
          payload.codeHash !== evidence.codeHash ||
          payload.batchId !== evidence.batchId ||
          stable(payload.batchPlan) !== stable(evidence.batchPlan) ||
          payload.specHash !== evidence.specHash ||
          payload.specRevision !== evidence.specRevision
        )
          invalid("Batch resolution manual trial belongs to another review")
      }
    }
    this.validateState(state)
  }

  private async approvedPlan(state: IterationState, context?: ApprovalContext) {
    if (!context?.spec || !context.batchPlan || !context.batchId || !context.mode)
      invalid("Approval must bind an exact saved spec, batch plan, batch and mode")
    const specRef = state.artifacts.find((ref) => ref.id === context.spec!.artifactId)
    if (!specRef || specRef.hash !== context.spec.hash)
      invalid("Approval must bind the exact saved spec revision and hash")
    const spec = await this.artifact(specRef)
    if (spec.kind !== "spec" || spec.revision !== context.spec.revision)
      invalid("Approval must bind the exact saved spec revision and hash")
    const planRef = state.artifacts.find((ref) => ref.id === context.batchPlan!.artifactId)
    if (!planRef || planRef.hash !== context.batchPlan.hash)
      invalid("Approval must bind the exact saved batch plan")
    const plan = await this.artifact(planRef)
    if (
      plan.kind !== "batch-plan" ||
      plan.specHash !== specRef.hash ||
      plan.specRevision !== spec.revision ||
      plan.mode !== context.mode ||
      !plan.batches.some((batch) => batch.id === context.batchId)
    )
      invalid("Approval batch plan does not match the exact spec, batch and mode")
    return plan
  }

  /** A model recommendation or a historical trial cannot authorize a manual repair. */
  private async manualProblemProof(state: IterationState): Promise<void> {
    if (!hasManualProblem(state)) invalid("Repair requires a bound human manual problem receipt")
    const ref = state.artifacts.find((entry) => entry.id === state.manualTrial!.artifactId)!
    const payload = await this.artifact(ref)
    if (payload.kind !== "manual-trial" || payload.status !== "problem")
      invalid("Repair requires the actual immutable manual problem artifact")
    await this.validateBinding(state, payload, true)
  }

  private async validateEventBinding(state: IterationState, event: StageEvent): Promise<void> {
    if (event.type === "select-prototype")
      invalid("Use recordPrototypeChoice to bind the manifest, human answer and separate reason atomically")
    const proposal =
      event.type === "propose-transition"
        ? event.proposal
        : event.type === "confirm-transition"
          ? state.pending
          : undefined
    if (proposal?.kind === "repair") {
      const active = state.attempts.find((entry) => entry.id === state.activeAttemptId)
      if (active?.acceptance?.verdict !== "fail") await this.manualProblemProof(state)
    }
    const context =
      event.type === "propose-transition"
        ? event.proposal.context
        : event.type === "confirm-transition" || event.type === "confirm-continuation"
          ? event.receipt.context
          : state.approvedContext
    const target =
      event.type === "propose-transition"
        ? event.proposal.to
        : event.type === "confirm-transition"
          ? state.pending?.to
          : state.stage
    if (
      ["propose-transition", "confirm-transition", "start-work", "confirm-continuation"].includes(
        event.type,
      ) &&
      (target === "implement" || target === "accept") &&
      !(
        proposal?.preparationOnly &&
        state.stage === "prototype" &&
        target === "implement" &&
        !context &&
        ["propose-transition", "confirm-transition"].includes(event.type)
      )
    )
      await this.approvedPlan(state, context)
    if (event.type === "record-artifact" && event.manifest) {
      const ref = state.artifacts.find((entry) => entry.id === event.manifest!.batchPlan.artifactId)
      const payload = ref && (await this.artifact(ref))
      if (
        !ref ||
        payload?.kind !== "batch-plan" ||
        stable(event.manifest) !== stable(this.manifest(state, ref, payload))
      )
        invalid("Batch manifest must match immutable plan membership")
    }
    if (!("artifact" in event) || !event.artifact) return
    if (!state.artifacts.some((ref) => stable(ref) === stable(event.artifact)))
      invalid("Stage event references an artifact not committed by this iteration store")
    const payload = await this.artifact(event.artifact)
    if (
      event.type === "finish-work" ||
      event.type === "record-manual-trial" ||
      event.type === "record-correction"
    )
      await this.validateBinding(state, payload, true)
    const sameSet = (left: string[], right: string[]) =>
      stable([...new Set(left)].sort()) === stable([...new Set(right)].sort())
    if (
      event.type === "prepare-summary" &&
      (payload.kind !== "stage-summary" || payload.stage !== state.stage)
    )
      invalid("Summary artifact belongs to a different stage")
    if (event.type === "finish-work") {
      if (payload.kind !== "acceptance" || payload.outcome !== event.acceptance?.verdict)
        invalid("Acceptance result does not match its immutable artifact")
      const failing =
        payload.outcome === "fail"
          ? payload.items
              .filter((item) => item.status === "fail" || item.status === "blocked")
              .map((item) => item.itemId)
          : []
      if (!sameSet(failing, event.acceptance?.failingItemIds ?? []))
        invalid("Acceptance failing item IDs do not match the saved evidence")
      if (
        context?.spec &&
        (payload.specHash !== context.spec.hash || payload.specRevision !== context.spec.revision)
      )
        invalid("Acceptance evidence belongs to a different approved spec")
      if (context?.batchId && payload.batchId !== context.batchId)
        invalid("Acceptance evidence belongs to a different approved batch")
      const specRef = state.artifacts.find((ref) => ref.kind === "spec" && ref.hash === payload.specHash)
      const spec = specRef && (await this.artifact(specRef))
      const reviewedIds = new Set(payload.items.map((item) => item.itemId))
      const trialRequired =
        spec?.kind === "spec" && spec.items.some((item) => reviewedIds.has(item.id) && item.ui)
      if ((event.acceptance?.manualTrialRequired ?? false) !== trialRequired)
        invalid("UI acceptance must retain the manual trial requirement from the reviewed spec items")
      const trialRef = state.artifacts.find((ref) => ref.id === state.manualTrial?.artifactId)
      const trial = trialRef && (await this.artifact(trialRef))
      if (
        trial?.kind === "manual-trial" &&
        (trial.attemptId !== payload.attemptId ||
          trial.attempt !== payload.attempt ||
          trial.codeHash !== payload.codeHash ||
          stable(trial.batchPlan) !== stable(payload.batchPlan) ||
          trial.specHash !== payload.specHash ||
          trial.specRevision !== payload.specRevision ||
          trial.batchId !== payload.batchId)
      )
        invalid("Manual trial belongs to a different acceptance attempt or spec")
    }
    if (event.type === "record-manual-trial") {
      if (payload.kind !== "manual-trial" || payload.status !== event.status)
        invalid("Manual trial status does not match its immutable artifact")
      if (
        context?.spec &&
        (payload.specHash !== context.spec.hash || payload.specRevision !== context.spec.revision)
      )
        invalid("Manual trial belongs to a different approved spec")
      if (context?.batchId && payload.batchId !== context.batchId)
        invalid("Manual trial belongs to a different approved batch")
      const active = state.attempts.find((attempt) => attempt.id === state.activeAttemptId)
      const verdictRef = state.artifacts.find((ref) => ref.id === active?.acceptance?.artifactId)
      const verdict = verdictRef && (await this.artifact(verdictRef))
      if (verdict?.kind === "acceptance" && payload.attempt !== verdict.attempt)
        invalid("Manual trial belongs to a different acceptance attempt")
    }
    if (event.type === "record-correction") {
      if (payload.kind !== "correction") invalid("Correction event requires a correction artifact")
      const correction = event.correction
      if (
        !sameSet(
          payload.mappings.map((edge) => stable([edge.oldDecisionId, edge.newDecisionId])),
          correction.decisionLinks.map((edge) => stable([edge.oldDecisionId, edge.newDecisionId])),
        ) ||
        !sameSet(
          payload.mappings.flatMap((edge) => edge.itemIds),
          correction.affectedSpecItemIds,
        ) ||
        !sameSet(
          payload.mappings.flatMap((edge) => edge.changedFiles),
          correction.affectedFiles,
        ) ||
        stable(
          [
            ...new Set(payload.mappings.flatMap((edge) => edge.acceptedBatches.map((ref) => stable(ref)))),
          ].sort(),
        ) !== stable(correction.acceptedBatches.map((ref) => stable(ref)).sort())
      )
        invalid("Correction impact mapping does not match its immutable artifact")
    }
  }

  /** A correction points at the original acceptance owner, not its new target spec/plan. */
  private async confirmedAcceptedEvidence(state: IterationState, ref: AcceptedBatchRef): Promise<void> {
    const resolution = state.batchResolutions?.find(
      (entry) =>
        entry.status === "accepted" &&
        entry.batchId === ref.batchId &&
        stable(entry.context.spec) === stable(ref.spec) &&
        stable(entry.context.batchPlan) === stable(ref.batchPlan) &&
        entry.receiptId === ref.resolutionReceiptId &&
        entry.attemptId === ref.attemptId,
    )
    if (!resolution) invalid("Correction requires qualified confirmed accepted batch evidence")
    const receipt = state.receipts.find((entry) => entry.id === ref.resolutionReceiptId)
    const transition = state.transitions.find((entry) => entry.id === receipt?.subjectId)
    if (
      receipt?.provenance !== "human" ||
      receipt.projectId !== state.projectId ||
      receipt.iteration !== state.iteration ||
      stable(receipt.context?.spec) !== stable(ref.spec) ||
      stable(receipt.context?.batchPlan) !== stable(ref.batchPlan) ||
      transition?.from !== "accept" ||
      !["complete", "next-batch"].includes(transition.kind)
    )
      invalid("Correction accepted evidence requires its confirmed human resolution receipt")
    const attempt = state.attempts.find((entry) => entry.id === ref.attemptId)
    const evidenceRef = state.artifacts.find((entry) => entry.id === attempt?.acceptance?.artifactId)
    const evidence = evidenceRef && (await this.artifact(evidenceRef))
    if (
      attempt?.stage !== "accept" ||
      attempt.status !== "finished" ||
      attempt.acceptance?.verdict !== "pass" ||
      stable(attempt.context) !== stable(resolution.context) ||
      evidence?.kind !== "acceptance" ||
      evidence.outcome !== "pass" ||
      evidence.attemptId !== attempt.id ||
      evidence.attempt !== attempt.review?.attempt ||
      evidence.codeHash !== attempt.review.codeHash ||
      evidence.batchId !== ref.batchId ||
      stable(evidence.batchPlan) !== stable(ref.batchPlan) ||
      evidence.specHash !== ref.spec.hash ||
      evidence.specRevision !== ref.spec.revision
    )
      invalid("Correction accepted evidence must consume the exact passing review")
    const plan = await this.approvedPlan(state, resolution.context)
    const batch = plan.batches.find((entry) => entry.id === ref.batchId)!
    const specRef = state.artifacts.find((entry) => entry.id === ref.spec.artifactId)!
    const spec = await this.artifact(specRef)
    if (spec.kind !== "spec") invalid("Correction accepted evidence requires its saved spec")
    if (stable([...batch.itemIds].sort()) !== stable(evidence.items.map((entry) => entry.itemId).sort()))
      invalid("Correction accepted evidence must cover every original batch item")
    const items = spec.items.filter((entry) => batch.itemIds.includes(entry.id))
    const checks = new Set(items.flatMap((entry) => entry.checkIds))
    if (
      evidence.checks.length !== checks.size ||
      evidence.checks.some(
        (check) =>
          !checks.has(check.checkId) ||
          spec.checks.find((entry) => entry.id === check.checkId)?.command !== check.command,
      )
    )
      invalid("Correction accepted evidence must include every agreed original check")
    const trialRequired = items.some((entry) => entry.ui)
    if ((attempt.acceptance.manualTrialRequired ?? false) !== trialRequired)
      invalid("Correction accepted evidence must retain its UI trial requirement")
    const trial = resolution.manualTrial ?? attempt.manualTrial
    if (trialRequired && !trial) invalid("Correction accepted evidence requires a resolved manual trial")
    if (!trial) return
    const trialRef = state.artifacts.find((entry) => entry.id === trial.artifactId)
    const payload = trialRef && (await this.artifact(trialRef))
    const trialReceipt = state.receipts.find((entry) => entry.id === trial.receiptId)
    if (
      !["tried", "deferred"].includes(trial.status) ||
      !trialReceipt ||
      trialReceipt.provenance !== "human" ||
      trialReceipt.subjectId !== trial.artifactId ||
      trialReceipt.choice !== trial.status ||
      payload?.kind !== "manual-trial" ||
      payload.status !== trial.status ||
      payload.attemptId !== evidence.attemptId ||
      payload.attempt !== evidence.attempt ||
      payload.codeHash !== evidence.codeHash ||
      payload.batchId !== evidence.batchId ||
      stable(payload.batchPlan) !== stable(evidence.batchPlan) ||
      payload.specHash !== evidence.specHash ||
      payload.specRevision !== evidence.specRevision
    )
      invalid("Correction accepted evidence requires its exact resolved trial and human receipt")
  }

  private async validateBinding(
    state: IterationState,
    artifact: IterationArtifact,
    consuming = false,
  ): Promise<void> {
    const saved = await Promise.all(
      state.artifacts.map(async (ref) => ({ ref, artifact: await this.artifact(ref) })),
    )
    if (artifact.kind === "stage-summary") return
    if (artifact.kind === "prototype-manifest") {
      await this.prototypePaths(artifact, !artifact.chosen)
      if (artifact.chosen) {
        const decision = (await new DecisionStore(this.project).records()).find(
          (entry) => entry.id === artifact.chosen!.decisionId,
        )
        const choice = decision?.prototypeChoice
        const prior = choice && saved.find((entry) => stable(entry.ref) === stable(choice.manifest))
        if (
          !choice ||
          choice.projectId !== state.projectId ||
          choice.iteration !== state.iteration ||
          choice.variantId !== artifact.chosen.variantId ||
          prior?.artifact.kind !== "prototype-manifest" ||
          stable(prior.artifact.variants) !== stable(artifact.variants)
        )
          invalid("Chosen prototype must bind recorded human choice evidence and the exact manifest")
      }
      return
    }
    if (artifact.kind === "spec") {
      if (
        saved.some((entry) => entry.artifact.kind === "spec" && entry.artifact.revision >= artifact.revision)
      )
        invalid("Spec revisions must increase; old spec artifacts are immutable")
      return
    }
    const specEntry = saved.find((entry) => entry.ref.kind === "spec" && entry.ref.hash === artifact.specHash)
    if (specEntry?.artifact.kind !== "spec" || specEntry.artifact.revision !== artifact.specRevision)
      invalid("Artifact must bind an exact saved spec revision and hash")
    const spec = specEntry.artifact
    const itemIds = spec.items.map((item) => item.id)
    const knownItems = (ids: string[]) => {
      if (ids.some((id) => !itemIds.includes(id))) invalid("Artifact references unknown stable spec item IDs")
    }
    if (artifact.kind === "batch-plan") {
      if (
        (state.status === "working" || state.phase === "proposed") &&
        saved.some((entry) => entry.artifact.kind === "batch-plan")
      )
        invalid("Cannot replace a batch plan while work is running or approval is proposed")
      const covered = artifact.batches.flatMap((batch) => batch.itemIds)
      knownItems(covered)
      if (new Set(covered).size !== covered.length || itemIds.some((id) => !covered.includes(id)))
        invalid("Batch plan must cover every spec item exactly once")
      for (const batch of artifact.batches) {
        if (batch.decisionIds.some((id) => !spec.decisionIds.includes(id)))
          invalid("Batch references unknown spec decision IDs")
      }
      return
    }
    if (artifact.kind === "correction") {
      for (const mapping of artifact.mappings) knownItems(mapping.itemIds)
      for (const mapping of artifact.mappings)
        for (const ref of mapping.acceptedBatches) await this.confirmedAcceptedEvidence(state, ref)
      return
    }
    const active = state.attempts.find((attempt) => attempt.id === state.activeAttemptId)
    if (
      state.stage !== "accept" ||
      active?.stage !== "accept" ||
      active.id !== artifact.attemptId ||
      active.review?.attempt !== artifact.attempt ||
      active.review.codeHash !== artifact.codeHash ||
      (artifact.kind === "acceptance"
        ? state.status !== "working" || active.status !== "working"
        : !["working", "finished"].includes(active.status))
    )
      invalid("Acceptance/manual trial must bind the active review attempt ID, ordinal and code snapshot")
    const context = active.context
    const plan = await this.approvedPlan(state, context)
    if (
      artifact.specHash !== context!.spec!.hash ||
      artifact.specRevision !== context!.spec!.revision ||
      artifact.batchId !== context!.batchId ||
      stable(artifact.batchPlan) !== stable(context!.batchPlan)
    )
      invalid("Acceptance/manual trial must bind the exact approved spec, batch and batch plan")
    const batch = plan.batches.find((batch) => batch.id === artifact.batchId)
    if (!batch) invalid("Artifact references an unknown batch")
    if (artifact.kind === "manual-trial") return
    const reviewed = artifact.items.map((item) => item.itemId)
    if (reviewed.length !== batch.itemIds.length || batch.itemIds.some((id) => !reviewed.includes(id)))
      invalid("Acceptance must check every batch spec item exactly once")
    const checks = new Set(
      spec.items.filter((item) => batch.itemIds.includes(item.id)).flatMap((item) => item.checkIds),
    )
    if (artifact.checks.length !== checks.size || artifact.checks.some((check) => !checks.has(check.checkId)))
      invalid("Acceptance must include every agreed check result")
    for (const check of artifact.checks) {
      if (spec.checks.find((agreed) => agreed.id === check.checkId)?.command !== check.command)
        invalid("Acceptance command does not match the agreed spec check")
    }
    if (
      !consuming &&
      saved.some(
        (entry) => entry.artifact.kind === "acceptance" && entry.artifact.attemptId === artifact.attemptId,
      )
    )
      invalid("Acceptance attempt already exists; save a fresh review attempt")
  }
}
