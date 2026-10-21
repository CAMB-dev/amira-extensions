import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import type { PrototypeManifestArtifact, WorktreeArtifact } from "./artifacts.ts"
import { checked, quote, type Shell, verifyWorktree } from "./iteration-git.ts"
import { probeShipCheckout, type ShipCheckout } from "./ship-git.ts"
import type { ArtifactRef } from "./stage.ts"
import {
  DecisionStore,
  HistoricalIterationReader,
  type Project,
  ProjectDocumentStore,
  projectLifecycle,
  withProjectClaim,
} from "./store.ts"
import { projectComponent, worktreeParent } from "./worktree-paths.ts"

export interface CleanupApproval {
  /** Human confirmation of this exact preview, not a host tool permission. */
  subject: string
  sessionId: string
  date: string
  /** Production command records a scoped human verification for users the host cannot enumerate. */
  externalUse?: { sessionId: string; date: string; subject: string }
}
export interface CleanupScope {
  iteration: number
  kind: "worktree" | "branch" | "prototype"
  path: string
}
export interface CleanupOptions {
  /** Must check the complete owner/provider inventory, including foreign writers.
   * Keep admissions fenced until this call settles. Throw for live OR unknown users.
   * The idle cleanup tool owner itself must not use the resource as its cwd. */
  assertUnused: (scope: CleanupScope) => Promise<void>
  signal?: AbortSignal
}
export interface GitCleanupRecord {
  iteration: number
  worktree: WorktreeArtifact
  /** Previously recorded ship pin; never discover/adopt a replacement during cleanup. */
  checkout: ShipCheckout
  preserved: { ref: string; head: string; evidence: string }
}
export interface GitCleanupPreview {
  kind: "git"
  projectId: string
  record: GitCleanupRecord
  repository: ShipCheckout
  files: string[]
  fingerprint: string
  subjects: { worktree: string; branch: string }
}
export interface PrototypeCleanupPreview {
  kind: "prototype"
  projectId: string
  iteration: number
  manifest: ArtifactRef
  variantId: string
  directory: string
  files: string[]
  fingerprint: string
  subject: string
}
type Preview = GitCleanupPreview | PrototypeCleanupPreview
interface Removal {
  subject: string
  scope: CleanupScope
  approval: CleanupApproval
  preview: Preview
  status: "requested" | "removed" | "uncertain"
  error?: string
}
interface CleanupDocument {
  schemaVersion: 1
  projectId: string
  removals: Removal[]
}
const documentName = "cleanup.json"
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const oid = (value: string) => /^[a-f0-9]{40,64}$/.test(value)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function document(value: unknown, projectId: string): CleanupDocument {
  if (value === undefined) return { schemaVersion: 1, projectId, removals: [] }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== projectId ||
    !Array.isArray(value.removals)
  )
    throw new Error("Malformed cleanup receipts; existing bytes were preserved")
  const subjects = new Set<string>()
  for (const row of value.removals) {
    if (
      !object(row) ||
      typeof row.subject !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.subject) ||
      subjects.has(row.subject) ||
      !object(row.scope) ||
      !["worktree", "branch", "prototype"].includes(String(row.scope.kind)) ||
      !Number.isSafeInteger(row.scope.iteration) ||
      Number(row.scope.iteration) < 1 ||
      typeof row.scope.path !== "string" ||
      !object(row.approval) ||
      row.approval.subject !== row.subject ||
      typeof row.approval.sessionId !== "string" ||
      !row.approval.sessionId.trim() ||
      typeof row.approval.date !== "string" ||
      !Number.isFinite(Date.parse(row.approval.date)) ||
      !object(row.preview) ||
      row.preview.projectId !== projectId ||
      !["requested", "removed", "uncertain"].includes(String(row.status))
    )
      throw new Error("Malformed cleanup receipt; no removal can be replayed")
    approval(row.approval as unknown as CleanupApproval, row.subject)
    subjects.add(row.subject)
  }
  return value as unknown as CleanupDocument
}
async function canonical(directory: string): Promise<string> {
  if (
    !path.isAbsolute(directory) ||
    directory !== path.resolve(directory) ||
    path.relative(directory, await realpath(directory)) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error(`Cleanup path is missing or redirected: ${directory}`)
  return directory
}
async function identity(directory: string): Promise<string> {
  await canonical(directory)
  const info = await lstat(directory)
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`
}
/** Enumerate all disposable bytes, not just Git-visible files. Reject links/special files
 * and empty untracked directories, which Git status/worktree remove can otherwise miss. */
async function contents(root: string, git = false): Promise<{ files: string[]; fingerprint: string }> {
  const entries: unknown[] = []
  const files: string[] = []
  const walk = async (directory: string) => {
    entries.push([path.relative(root, directory), await identity(directory)])
    const children = (await readdir(directory)).sort()
    if (git && directory !== root && !children.length)
      throw new Error("Untracked empty directory blocks cleanup")
    for (const name of children) {
      const file = path.join(directory, name)
      const relative = path.relative(root, file).split(path.sep).join("/")
      if (/[\0\r\n]/.test(name)) throw new Error("Unsupported cleanup filename")
      const info = await lstat(file)
      if (git && relative === ".git") {
        if (!info.isFile() || !/^gitdir: /m.test(await readFile(file, "utf8")))
          throw new Error("Iteration Git metadata was redirected")
        entries.push([relative, await readFile(file, "utf8")])
      } else if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || name === ".git")
        throw new Error("Submodule, redirected or special cleanup input")
      else if (info.isDirectory()) await walk(file)
      else {
        files.push(relative)
        entries.push([
          relative,
          info.mode,
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ])
      }
    }
  }
  await walk(root)
  return { files: files.sort(), fingerprint: hash(entries) }
}
function records(output: string): string[] {
  if (output && !output.endsWith("\0")) throw new Error("Incomplete Git cleanup listing")
  return output.split("\0").filter(Boolean)
}
function approval(value: CleanupApproval, subject: string): void {
  const external: unknown = value.externalUse
  if (
    external !== undefined &&
    (!object(external) ||
      external.subject !== subject ||
      external.sessionId !== value.sessionId ||
      typeof external.date !== "string" ||
      !Number.isFinite(Date.parse(external.date)))
  )
    throw new Error("External resource-use verification is not bound to this cleanup approval")
  if (value.subject !== subject || !value.sessionId?.trim() || !Number.isFinite(Date.parse(value.date)))
    throw new Error("Cleanup requires a fresh exact-operation human confirmation")
}
function iterationNumber(iteration: number): void {
  if (!Number.isSafeInteger(iteration) || iteration < 1) throw new Error("Invalid cleanup iteration")
}

/** Command usage:
 * 1. Fence/drain owners; construct with an idle owned shell handle and assertUnused.
 * 2. previewGit(recordedShipPin) / previewPrototype(iteration, immutableRef, variantId).
 * 3. Display the complete preview, including files; obtain SEPARATE human confirmations.
 * 4. removeWorktree(preview, receipt), then optionally removeBranch(preview, anotherReceipt).
 *    removePrototype requires its own preview/receipt, independently of Git cleanup.
 * No receipt => retain, with no probes/writes/effects. No automatic cleanup on closure.
 * All Git commands use runTool; none use force, bypass configuration, prune or fs fallback.
 * Requested/uncertain receipts prohibit replay: inspect/reconcile manually after a crash.
 * Historical prototype consumers MUST use prototypeCode(), not old manifest run commands.
 * Claims/pins prevent accidental races, not hostile external filesystem modification.
 */
export class ProjectCleanup {
  private readonly project: Project
  constructor(
    project: Project,
    private readonly handle: OwnedConversation,
    private readonly shell: Shell,
    private readonly options: CleanupOptions,
  ) {
    this.project = structuredClone(project)
  }
  private store() {
    return new ProjectDocumentStore(this.project)
  }
  private async receipts() {
    return document(await this.store().read(documentName), this.project.marker.id)
  }
  private run(root: string, command: string) {
    this.options.signal?.throwIfAborted()
    return checked(this.handle, this.shell, root, command, this.options.signal)
  }
  private async settled(current: Project, iteration: number) {
    iterationNumber(iteration)
    const lifecycle = projectLifecycle(current)
    if (
      !lifecycle.iterations[String(iteration)] ||
      (lifecycle.status !== "archived" && lifecycle.iterations[String(iteration)]?.status !== "closed")
    )
      throw new Error("Cleanup requires a closed iteration or an archived project; retain by default")
    this.options.signal?.throwIfAborted()
  }
  private async unused(scope: CleanupScope) {
    this.options.signal?.throwIfAborted()
    // The tool runtime cannot be rooted in a directory it is about to delete.
    const relative = path.relative(scope.path, this.handle.cwd)
    if (
      scope.kind !== "branch" &&
      (relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
    )
      throw new Error("Cleanup tool owner is a live user of the removal path")
    await this.options.assertUnused(scope)
    this.options.signal?.throwIfAborted()
  }
  private async preserved(record: GitCleanupRecord) {
    const { preserved, checkout, worktree } = record
    if (
      !oid(checkout.head) ||
      !oid(preserved.head) ||
      !preserved.evidence.trim() ||
      !/^refs\/(heads|tags)\/.+/.test(preserved.ref) ||
      preserved.ref === `refs/heads/${worktree.branch}`
    )
      throw new Error("Cleanup requires recorded merge/preservation evidence on a separate ref")
    const direct = await this.run(
      worktree.repository,
      `git for-each-ref --format=${quote("%(refname) %(symref)", this.shell)} -- ${quote(preserved.ref, this.shell)}`,
    )
    if (direct !== preserved.ref)
      throw new Error("Cleanup preservation must be an independent direct ref, not a symbolic alias")
    const head = await this.run(
      worktree.repository,
      `git rev-parse --verify ${quote(`${preserved.ref}^{commit}`, this.shell)}`,
    )
    if (head !== preserved.head) throw new Error("Cleanup preservation ref moved")
    await this.run(
      worktree.repository,
      `git merge-base --is-ancestor ${quote(checkout.head, this.shell)} ${quote(preserved.head, this.shell)}`,
    )
  }
  private async clean(record: GitCleanupRecord) {
    const root = record.worktree.root
    if (
      await this.run(
        root,
        "git --no-optional-locks status --porcelain=v1 --untracked-files=all --ignored --ignore-submodules=none",
      )
    )
      throw new Error("Dirty, staged, untracked, ignored or unmerged work blocks cleanup")
    const index = records(await this.run(root, "git ls-files --stage -z"))
    if (index.some((entry) => !/^(100644|100755) [a-f0-9]{40,64} 0\t/.test(entry)))
      throw new Error("Submodule, symlink or unmerged index blocks cleanup")
    const tree = records(await this.run(root, "git ls-tree -r -z HEAD"))
    if (tree.some((entry) => !/^(100644|100755) blob /.test(entry)))
      throw new Error("Submodule or unsupported committed input blocks cleanup")
    if (records(await this.run(root, "git ls-files -v -z")).some((entry) => !entry.startsWith("H ")))
      throw new Error("Hidden index flags block cleanup")
    const operations = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]
    const locations = (
      await this.run(
        root,
        `git rev-parse ${operations.map((name) => `--git-path ${quote(name, this.shell)}`).join(" ")}`,
      )
    ).split(/\r?\n/)
    if (locations.length !== operations.length) throw new Error("Incomplete Git operation probe")
    for (const location of locations) {
      try {
        await lstat(path.resolve(root, location))
        throw new Error("Unfinished Git operation blocks cleanup")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const snapshot = await contents(root, true)
    const tracked = index.map((entry) => entry.slice(entry.indexOf("\t") + 1)).sort()
    if (!same(snapshot.files, tracked)) throw new Error("Untracked disposable contents block cleanup")
    return snapshot
  }
  private async gitIdentity(record: GitCleanupRecord): Promise<ShipCheckout> {
    const { worktree, checkout } = record
    const component = projectComponent(this.project.marker.id)
    const expectedRoot = path.join(
      worktreeParent(worktree.repository),
      component,
      `iteration-${record.iteration}`,
    )
    if (
      worktree.status !== "ready" ||
      checkout.root !== worktree.root ||
      checkout.branch !== worktree.branch ||
      !worktree.branch.startsWith("amira/project/") ||
      !worktree.branch.endsWith(`-${component}/iteration-${record.iteration}`) ||
      worktree.root !== expectedRoot ||
      worktree.cwd !== path.join(worktree.root, path.relative(worktree.repository, this.project.root))
    )
      throw new Error("Cleanup must match the recorded project worktree/path/branch identity")
    await verifyWorktree(this.handle, this.shell, worktree, this.options.signal)
    if (!same(await probeShipCheckout(this.handle, this.shell, worktree.root, this.options.signal), checkout))
      throw new Error("Recorded cleanup checkout/common directory/HEAD identity changed")
    const repository = await probeShipCheckout(
      this.handle,
      this.shell,
      worktree.repository,
      this.options.signal,
    )
    if (repository.common !== checkout.common || repository.branch === checkout.branch)
      throw new Error("Recorded cleanup repository/common directory identity changed")
    return repository
  }
  async previewGit(record: GitCleanupRecord): Promise<GitCleanupPreview> {
    record = structuredClone(record)
    return withProjectClaim(
      this.project,
      async (current) => {
        await this.settled(current, record.iteration)
        await this.unused({ iteration: record.iteration, kind: "worktree", path: record.worktree.root })
        const repository = await this.gitIdentity(record)
        await this.preserved(record)
        const snapshot = await this.clean(record)
        const inputs = { kind: "git" as const, projectId: current.marker.id, record, repository, ...snapshot }
        return {
          ...inputs,
          subjects: { worktree: hash(["worktree", inputs]), branch: hash(["branch", inputs]) },
        }
      },
      { administrative: true },
    )
  }
  private async execute(
    preview: Preview,
    scope: CleanupScope,
    subject: string,
    receipt: CleanupApproval | undefined,
    verify: () => Promise<void>,
    effect: () => Promise<unknown>,
  ): Promise<"retained" | "removed"> {
    if (receipt === undefined) return "retained"
    preview = structuredClone(preview)
    receipt = structuredClone(receipt)
    approval(receipt, subject)
    return withProjectClaim(
      this.project,
      async (current) => {
        await this.settled(current, scope.iteration)
        if (preview.projectId !== current.marker.id)
          throw new Error("Cleanup preview belongs to another project")
        await this.unused(scope)
        await verify()
        const row: Removal = { subject, scope, preview, approval: receipt!, status: "requested" }
        await this.store().update(
          documentName,
          (value) => {
            const saved = document(value, current.marker.id)
            if (saved.removals.some((entry) => entry.subject === subject || same(entry.scope, scope)))
              throw new Error("Cleanup already requested; reconcile existing receipt, never replay removal")
            saved.removals.push(row)
            return saved
          },
          { administrative: true },
        )
        try {
          // Revalidate after durable intent publication and immediately before the effect.
          await this.unused(scope)
          await verify()
          await effect()
          await this.finish(subject, "removed")
          return "removed" as const
        } catch (error) {
          // A failed receipt write leaves requested evidence, which is also non-runnable.
          await this.finish(subject, "uncertain", error instanceof Error ? error.message : String(error))
          throw error
        }
      },
      { administrative: true },
    )
  }
  private async finish(subject: string, status: Removal["status"], error?: string) {
    await this.store().update(
      documentName,
      (value) => {
        const saved = document(value, this.project.marker.id)
        const row = saved.removals.find((entry) => entry.subject === subject)
        if (!row) throw new Error("Cleanup intent disappeared")
        row.status = status
        if (error !== undefined) row.error = error
        return saved
      },
      { administrative: true },
    )
  }
  async removeWorktree(preview: GitCleanupPreview, receipt?: CleanupApproval) {
    preview = structuredClone(preview)
    return this.execute(
      preview,
      { iteration: preview.record.iteration, kind: "worktree", path: preview.record.worktree.root },
      preview.subjects.worktree,
      receipt,
      async () => {
        if (!same(await this.previewGit(preview.record), preview)) throw new Error("Cleanup preview changed")
      },
      () =>
        this.run(
          preview.record.worktree.repository,
          `git worktree remove -- ${quote(preview.record.worktree.root, this.shell)}`,
        ),
    )
  }
  async removeBranch(preview: GitCleanupPreview, receipt?: CleanupApproval) {
    preview = structuredClone(preview)
    const { record, repository } = preview
    return this.execute(
      preview,
      {
        iteration: record.iteration,
        kind: "branch",
        path: `${record.checkout.common}#refs/heads/${record.worktree.branch}`,
      },
      preview.subjects.branch,
      receipt,
      async () => {
        const { subjects: _subjects, ...inputs } = preview
        if (hash(["branch", inputs]) !== preview.subjects.branch) throw new Error("Cleanup preview changed")
        const removed = (await this.receipts()).removals.find(
          (row) => row.subject === preview.subjects.worktree,
        )
        if (removed?.status !== "removed") throw new Error("Remove the exact recorded worktree first")
        if (
          !same(
            await probeShipCheckout(this.handle, this.shell, repository.root, this.options.signal),
            repository,
          )
        )
          throw new Error("Cleanup repository identity changed")
        try {
          await lstat(record.worktree.root)
          throw new Error("Cleanup worktree path was recreated")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        const branch = await this.run(
          repository.root,
          `git rev-parse --verify ${quote(`refs/heads/${record.worktree.branch}`, this.shell)}`,
        )
        if (branch !== record.checkout.head) throw new Error("Cleanup branch moved")
        const worktrees = await this.run(repository.root, "git worktree list --porcelain")
        if (worktrees.split(/\r?\n/).includes(`branch refs/heads/${record.worktree.branch}`))
          throw new Error("Cleanup branch has a live worktree user")
        await this.preserved(record)
      },
      () => this.run(repository.root, `git branch -d -- ${quote(record.worktree.branch, this.shell)}`),
    )
  }
  private async manifest(iteration: number, ref: ArtifactRef): Promise<PrototypeManifestArtifact> {
    iterationNumber(iteration)
    const reader = new HistoricalIterationReader(this.project, iteration)
    const state = await reader.read()
    if (!state.artifacts.some((entry) => same(entry, ref)))
      throw new Error("Prototype manifest is not permanent iteration evidence")
    const manifest = await reader.readArtifact(ref)
    if (manifest.kind !== "prototype-manifest") throw new Error("Expected immutable prototype manifest")
    if (manifest.chosen) {
      const decision = (await new DecisionStore(this.project).records()).find(
        (row) => row.id === manifest.chosen!.decisionId,
      )
      if (!decision) throw new Error("Prototype selection rationale/decision evidence is missing")
    }
    return manifest
  }
  async previewPrototype(
    iteration: number,
    ref: ArtifactRef,
    variantId: string,
  ): Promise<PrototypeCleanupPreview> {
    ref = structuredClone(ref)
    return withProjectClaim(
      this.project,
      async (current) => {
        await this.settled(current, iteration)
        const manifest = await this.manifest(iteration, ref)
        const variant = manifest.variants.find((entry) => entry.id === variantId)
        if (!variant || !/^[a-z][a-z0-9-]{0,39}$/.test(variantId) || variantId === "none")
          throw new Error("Invalid recorded prototype variant")
        const directory = path.join(
          current.root,
          ".amira",
          "project",
          "prototypes",
          String(iteration),
          variantId,
        )
        if (variant.directory !== directory) throw new Error("Prototype cleanup path changed")
        await canonical(directory)
        await this.unused({ iteration, kind: "prototype", path: directory })
        const snapshot = await contents(directory)
        const inputs = {
          kind: "prototype" as const,
          projectId: current.marker.id,
          iteration,
          manifest: ref,
          variantId,
          directory,
          ...snapshot,
        }
        return { ...inputs, subject: hash(inputs) }
      },
      { administrative: true },
    )
  }
  async removePrototype(preview: PrototypeCleanupPreview, receipt?: CleanupApproval) {
    preview = structuredClone(preview)
    return this.execute(
      preview,
      { iteration: preview.iteration, kind: "prototype", path: preview.directory },
      preview.subject,
      receipt,
      async () => {
        if (
          !same(await this.previewPrototype(preview.iteration, preview.manifest, preview.variantId), preview)
        )
          throw new Error("Prototype cleanup preview changed")
      },
      () =>
        this.run(
          this.project.root,
          this.shell === "bash"
            ? `rm -r -- ${quote(preview.directory, this.shell)}`
            : `Remove-Item -LiteralPath ${quote(preview.directory, this.shell)} -Recurse -ErrorAction Stop`,
        ),
    )
  }
  /** Inert historical overlay. Original manifest/rationale/decision evidence is untouched.
   * Requested/uncertain removal is unavailable even if some code still exists. */
  async prototypeCode(iteration: number, ref: ArtifactRef) {
    const evidence = await this.manifest(iteration, ref)
    const variants = await prototypeAvailability(this.project, iteration, evidence)
    return { evidence, variants }
  }
}

export type PrototypeCodeAvailability = Awaited<ReturnType<typeof prototypeAvailability>>

/** Any requested removal fences continuation too, even if code still exists after a failed tool. */
export async function prototypeRemoval(
  project: Project,
  iteration: number,
  directory: string,
): Promise<boolean> {
  return (await prototypeRemovalStatus(project, iteration, directory)) !== undefined
}

export async function prototypeRemovalStatus(project: Project, iteration: number, directory: string) {
  const receipts = document(await new ProjectDocumentStore(project).read(documentName), project.marker.id)
  return receipts.removals.find(
    (row) =>
      row.scope.kind === "prototype" && row.scope.iteration === iteration && row.scope.path === directory,
  )?.status
}

/** Read-only availability used by production panels, comparisons and run-command display. */
export async function prototypeAvailability(
  project: Project,
  iteration: number,
  manifest: PrototypeManifestArtifact,
) {
  const receipts = document(await new ProjectDocumentStore(project).read(documentName), project.marker.id)
  const variants = await Promise.all(
    manifest.variants.map(async (variant) => {
      const removed = receipts.removals.find(
        (row) =>
          row.scope.kind === "prototype" &&
          row.scope.iteration === iteration &&
          row.scope.path === variant.directory,
      )
      let available = false
      if (!removed) {
        try {
          await canonical(variant.directory)
          await canonical(variant.cwd)
          available = variant.status === "ready"
        } catch {
          /* Missing/redirected code is not runnable evidence. */
        }
      }
      return {
        id: variant.id,
        // Unfinished retained code is also non-runnable; keep cleanup fencing explicit.
        ...(removed ? { removalStatus: removed.status } : {}),
        status:
          removed?.status === "removed"
            ? ("removed" as const)
            : available
              ? ("retained" as const)
              : ("unavailable" as const),
        runnable: available,
        directory: available ? variant.directory : null,
        cwd: available ? variant.cwd : null,
        runCommand: available ? variant.runCommand : null,
      }
    }),
  )
  return variants
}
