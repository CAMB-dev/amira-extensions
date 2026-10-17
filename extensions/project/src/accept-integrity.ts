import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, readlink, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import type { AcceptanceArtifact, WorktreeArtifact } from "./artifacts.ts"
import { checked, quote, type Shell, verifyWorktree } from "./iteration-git.ts"
import { specInputs } from "./spec.ts"
import type { IterationState } from "./stage.ts"
import { IterationStore, type Project } from "./store.ts"

export interface AcceptanceCheckout {
  root: string
  cwd: string
  worktree?: WorktreeArtifact
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

export async function acceptanceCheckout(
  project: Project,
  state: IterationState,
): Promise<AcceptanceCheckout> {
  const ref = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
  if (!ref) return { root: project.root, cwd: project.root }
  const artifact = await new IterationStore(project).readArtifact(ref)
  if (artifact.kind !== "iteration-worktree" || artifact.status !== "ready")
    throw new Error("Acceptance requires the recorded ready iteration checkout; no fallback is allowed")
  return { root: artifact.root, cwd: artifact.cwd, worktree: artifact }
}

export async function verifyAcceptanceCheckout(
  handle: OwnedConversation,
  shell: Shell,
  checkout: AcceptanceCheckout,
  signal?: AbortSignal,
): Promise<void> {
  if (checkout.worktree) return verifyWorktree(handle, shell, checkout.worktree, signal)
  if (path.relative(checkout.cwd, await realpath(checkout.cwd)))
    throw new Error("Acceptance project directory was redirected")
  // Acceptance-only routes explicitly approve existing change pointers, not an invented worktree.
  checkout.root = path.resolve(
    await checked(handle, shell, checkout.cwd, "git rev-parse --show-toplevel", signal),
  )
}

export async function acceptanceCheckCwd(checkout: AcceptanceCheckout, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw new Error("Check cwd must be relative to the iteration project")
  const cwd = path.resolve(checkout.cwd, relative)
  const rel = path.relative(checkout.root, cwd)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error("Check cwd escapes the acceptance checkout")
  if (path.relative(cwd, await realpath(cwd)) || !(await lstat(cwd)).isDirectory())
    throw new Error(`Check cwd is redirected or not a directory: ${cwd}`)
  return cwd
}

/** Read-only fingerprint: no temporary index, staging, commits or model claims.
 * Hash full file bytes rather than a shell's potentially truncated textual patch.
 * HEAD + raw diff bind index/mode/deletion changes; listed tracked/untracked files
 * bind content changes even when Git's stat cache or a textual diff omits them. */
export async function acceptanceCodeHash(
  project: Project,
  state: IterationState,
  handle: OwnedConversation,
  shell: Shell,
  checkout: AcceptanceCheckout,
  signal?: AbortSignal,
): Promise<string> {
  const head = await checked(handle, shell, checkout.root, "git rev-parse --verify HEAD", signal)
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid acceptance HEAD")
  // Shell output can be truncated by the host. Capture Git's complete byte
  // streams in disposable scratch files instead; every probe still goes through
  // the owned, policy-checked runTool path. No index or checkout file is written.
  // Control-plane output is bound through verified spec/decision/prototype inputs,
  // not its ever-growing journal/artifacts. Otherwise a committed-documents
  // acceptance-only route would invalidate itself merely by recording its result.
  const control = path
    .relative(checkout.root, path.join(checkout.cwd, ".amira", "project"))
    .replaceAll("\\", "/")
  const paths = `-- . ${quote(`:(top,exclude,literal)${control}`, shell)}`
  const scratch = await mkdtemp(path.join(tmpdir(), "amira-acceptance-"))
  let raw: string
  let index: string
  let names: string
  try {
    const diffFile = path.join(scratch, "diff")
    const indexFile = path.join(scratch, "index")
    const namesFile = path.join(scratch, "names")
    await checked(
      handle,
      shell,
      checkout.root,
      `git diff --raw --no-abbrev --no-ext-diff --no-textconv --output=${quote(diffFile, shell)} HEAD ${paths}`,
      signal,
    )
    await checked(
      handle,
      shell,
      checkout.root,
      `git ls-files --stage -z ${paths} > ${quote(indexFile, shell)}`,
      signal,
    )
    await checked(
      handle,
      shell,
      checkout.root,
      `git ls-files -z --cached --others --exclude-standard ${paths} > ${quote(namesFile, shell)}`,
      signal,
    )
    raw = digest(await readFile(diffFile))
    index = digest(await readFile(indexFile))
    names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(namesFile))
    if (names && !names.endsWith("\0")) throw new Error("Incomplete Git acceptance file listing")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const files: { name: string; content: string; mode: number }[] = []
  for (const name of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    const file = path.resolve(checkout.root, name)
    const relative = path.relative(checkout.root, file)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Git listed a file outside the acceptance checkout")
    try {
      // Refuse redirected parent directories; do not fingerprint arbitrary external files.
      // A deleted tracked directory is valid deletion evidence, not an unavailable probe.
      if (path.relative(path.dirname(file), await realpath(path.dirname(file))))
        throw new Error("Acceptance input parent directory was redirected")
      const stat = await lstat(file)
      const content = stat.isSymbolicLink()
        ? digest(await readlink(file))
        : stat.isFile()
          ? digest(await readFile(file))
          : (() => {
              throw new Error("Acceptance cannot fingerprint a submodule or special file")
            })()
      files.push({ name, content, mode: stat.mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      files.push({ name, content: "deleted", mode: 0 })
    }
  }
  const inputs = await specInputs(project, state)
  return digest(
    JSON.stringify({
      head,
      diffHash: digest(JSON.stringify({ raw, index, files })),
      inputs,
      spec: state.artifacts.findLast((entry) => entry.kind === "spec"),
      plan: state.artifacts.findLast((entry) => entry.kind === "batch-plan"),
      context: state.approvedContext,
    }),
  )
}

export interface AcceptanceFreshness {
  stale: boolean
  reason: string | null
}
export async function acceptanceStaleness(
  project: Project,
  handle: OwnedConversation,
  shell: Shell,
  artifact: AcceptanceArtifact,
  signal?: AbortSignal,
): Promise<AcceptanceFreshness> {
  try {
    const state = await new IterationStore(project).read()
    const checkout = await acceptanceCheckout(project, state)
    await verifyAcceptanceCheckout(handle, shell, checkout, signal)
    const codeHash = await acceptanceCodeHash(project, state, handle, shell, checkout, signal)
    return codeHash === artifact.codeHash
      ? { stale: false, reason: null }
      : {
          stale: true,
          reason:
            "Code, HEAD, decisions, prototype pointers, spec or batch approval changed; run fresh acceptance.",
        }
  } catch (error) {
    return { stale: true, reason: `Acceptance freshness could not be verified: ${String(error)}` }
  }
}
