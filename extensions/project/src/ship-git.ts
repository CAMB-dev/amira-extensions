import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import type { WorktreeArtifact } from "./artifacts.ts"
import { checked, inDirectory, quote, type Shell, shellCall, verifyWorktree } from "./iteration-git.ts"
import { incomingShipDelta, reviewShipDelta, shipPathAllowed } from "./ship-delta.ts"

export interface ShipCheckout {
  root: string
  branch: string
  head: string
  common: string
  gitDir: string
  /** Filesystem identity as well as canonical paths; detects replaced directories. */
  identity: string
}
export interface ShipGitPin {
  worktree: WorktreeArtifact
  source: ShipCheckout
  target: ShipCheckout
}
export interface ShipCandidate {
  pin: ShipGitPin
  paths: string[]
  tree: string
  /** Includes unrelated tracked/untracked inputs and the original index bytes. */
  fingerprint: string
  /** Complete incoming delta, including source-only commits before ship preparation. */
  incoming: { base: string; paths: string[] }
}
export interface ShipCommit {
  head: string
  tree: string
  parents: string[]
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
function oid(value: string): string {
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("Invalid Git object ID")
  return value
}
function safePath(value: string): string {
  if (
    !value ||
    /[\\\0\r\n:]/.test(value) ||
    path.isAbsolute(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || /[ .]$/.test(part) || /^\.git(?:~\d+)?$/i.test(part),
      )
  )
    throw new Error(`Unsafe ship path: ${JSON.stringify(value)}`)
  return value
}
async function canonical(directory: string): Promise<string> {
  if (
    !path.isAbsolute(directory) ||
    path.relative(directory, await realpath(directory)) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error(`Ship checkout is missing or redirected: ${directory}`)
  return path.resolve(directory)
}

/** Read-only reconciliation probe: does not require the old HEAD to remain current. */
export async function probeShipCheckout(
  handle: OwnedConversation,
  shell: Shell,
  root: string,
  signal?: AbortSignal,
  allowDetached = false,
): Promise<ShipCheckout> {
  await canonical(root)
  const run = (command: string) => checked(handle, shell, root, command, signal)
  const lines = (
    await run(
      "git rev-parse --show-toplevel --path-format=absolute --git-common-dir --absolute-git-dir --verify HEAD",
    )
  ).split(/\r?\n/)
  if (lines.length !== 4) throw new Error("Incomplete ship checkout probe")
  const [top, commonPath, gitPath, head] = lines
  if (path.relative(root, path.resolve(top!))) throw new Error("Ship checkout root changed")
  const ref = await run("git rev-parse --symbolic-full-name HEAD")
  if (!ref.startsWith("refs/heads/") && !(allowDetached && ref === "HEAD"))
    throw new Error("Ship requires a checked-out local branch")
  const common = await canonical(path.resolve(commonPath!))
  const gitDir = await canonical(path.resolve(gitPath!))
  const identities = await Promise.all(
    [root, common, gitDir].map(async (directory) => {
      const info = await lstat(directory)
      return [info.dev, info.ino, info.birthtimeMs]
    }),
  )
  return {
    root,
    branch: ref === "HEAD" ? "HEAD" : ref.slice("refs/heads/".length),
    head: oid(head!),
    common,
    gitDir,
    identity: hash(JSON.stringify(identities)),
  }
}
async function assertCheckout(
  handle: OwnedConversation,
  shell: Shell,
  expected: ShipCheckout,
  signal?: AbortSignal,
): Promise<void> {
  if (
    JSON.stringify(
      await probeShipCheckout(handle, shell, expected.root, signal, expected.branch === "HEAD"),
    ) !== JSON.stringify(expected)
  )
    throw new Error("Ship source/target checkout, branch, HEAD or repository identity moved")
}
async function cleanTarget(
  handle: OwnedConversation,
  shell: Shell,
  target: ShipCheckout,
  signal?: AbortSignal,
) {
  // diff-index alone misses untracked files. No automatic reset, stash or merge abort.
  const status = await checked(
    handle,
    shell,
    target.root,
    "git --no-optional-locks status --porcelain=v1 --untracked-files=all --ignore-submodules=none",
    signal,
  )
  if (status) throw new Error(`Dirty ship target; resolve explicitly:\n${status}`)
  await noOperation(handle, shell, target.root, signal)
}
async function noOperation(handle: OwnedConversation, shell: Shell, root: string, signal?: AbortSignal) {
  const names = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]
  const locations = (
    await checked(
      handle,
      shell,
      root,
      `git rev-parse ${names.map((name) => `--git-path ${quote(name, shell)}`).join(" ")}`,
      signal,
    )
  ).split(/\r?\n/)
  if (locations.length !== names.length) throw new Error("Incomplete Git operation probe")
  for (const [index, location] of locations.entries()) {
    try {
      await lstat(path.resolve(root, location))
      throw new Error(`Unfinished Git operation blocks ship: ${names[index]}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}
export async function pinShipSource(
  handle: OwnedConversation,
  shell: Shell,
  worktree: WorktreeArtifact,
  signal?: AbortSignal,
): Promise<ShipCheckout> {
  if (worktree.status !== "ready") throw new Error("Ship requires a ready iteration worktree")
  await verifyWorktree(handle, shell, worktree, signal)
  const source = await probeShipCheckout(handle, shell, worktree.root, signal)
  await noOperation(handle, shell, source.root, signal)
  return source
}

export async function pinShipGit(
  handle: OwnedConversation,
  shell: Shell,
  worktree: WorktreeArtifact,
  targetRoot: string,
  signal?: AbortSignal,
  expectedSource?: ShipCheckout,
): Promise<ShipGitPin> {
  const source = await pinShipSource(handle, shell, worktree, signal)
  if (expectedSource && JSON.stringify(source) !== JSON.stringify(expectedSource))
    throw new Error("Ship source identity/branch/HEAD changed during preparation")
  const target = await probeShipCheckout(handle, shell, targetRoot, signal)
  if (source.common !== target.common || source.root === target.root || source.branch === target.branch)
    throw new Error("Ship target must be a different checkout/branch of the same repository")
  await noOperation(handle, shell, source.root, signal)
  await cleanTarget(handle, shell, target, signal)
  await inputs(handle, shell, target, signal)
  return { worktree: { ...worktree }, source, target }
}

async function capture(
  handle: OwnedConversation,
  shell: Shell,
  root: string,
  command: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const scratch = await mkdtemp(path.join(tmpdir(), "amira-ship-probe-"))
  try {
    const file = path.join(scratch, "output")
    await checked(handle, shell, root, `${command} > ${quote(file, shell)}`, signal)
    return await readFile(file)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
function decode(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value)
}
function records(value: Uint8Array): string[] {
  const text = decode(value)
  if (text && !text.endsWith("\0")) throw new Error("Incomplete Git ship listing")
  return text.split("\0").filter(Boolean)
}
async function indexHash(checkout: ShipCheckout): Promise<string> {
  try {
    return hash(await readFile(path.join(checkout.gitDir, "index")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return "absent"
  }
}
async function inputs(handle: OwnedConversation, shell: Shell, checkout: ShipCheckout, signal?: AbortSignal) {
  const staged = records(await capture(handle, shell, checkout.root, "git ls-files --stage -z", signal))
  for (const entry of staged) {
    if (!/^(100644|100755) [a-f0-9]{40,64} 0\t/.test(entry))
      throw new Error("Ship does not support submodules, symlinks, special files or unmerged entries")
  }
  // Also reject unsupported committed inputs even if absent from the real index.
  const tree = records(await capture(handle, shell, checkout.root, "git ls-tree -r -z HEAD", signal))
  if (tree.some((entry) => !/^(100644|100755) blob /.test(entry)))
    throw new Error("Ship does not support submodules, symlinks or special files")
  const names = [
    ...new Set([
      ...staged.map((entry) => entry.slice(entry.indexOf("\t") + 1)),
      ...tree.map((entry) => entry.slice(entry.indexOf("\t") + 1)),
      ...records(
        await capture(handle, shell, checkout.root, "git ls-files --others --exclude-standard -z", signal),
      ),
    ]),
  ].sort()
  const files: unknown[] = []
  for (const name of names) {
    safePath(name)
    const file = path.join(checkout.root, name)
    try {
      if (path.relative(path.dirname(file), await realpath(path.dirname(file))))
        throw new Error("Ship input parent was redirected")
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Ship input is a submodule, symlink or special file")
      files.push([name, info.mode, hash(await readFile(file))])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      files.push([name, "deleted"])
    }
  }
  return {
    names,
    contentFingerprint: hash(JSON.stringify(files)),
    fingerprint: hash(JSON.stringify({ files, staged, index: await indexHash(checkout) })),
  }
}
function withIndex(shell: Shell, index: string, commands: string[]): string {
  const q = (value: string) => quote(value, shell)
  if (shell === "bash") return `export GIT_INDEX_FILE=${q(index)}; ${commands.join(" && ")}`
  return `$previous = $env:GIT_INDEX_FILE; $env:GIT_INDEX_FILE = ${q(index)}; try { ${commands.map((command) => `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join("; ")} } finally { $env:GIT_INDEX_FILE = $previous }`
}
async function temporaryTree(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  paths: string[],
  signal?: AbortSignal,
): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), "amira-ship-index-"))
  try {
    const file = path.join(scratch, "tree")
    await checked(
      handle,
      shell,
      pin.source.root,
      withIndex(shell, path.join(scratch, "index"), [
        `git read-tree ${quote(pin.source.head, shell)}`,
        ...(paths.length
          ? [`git --literal-pathspecs add -A -- ${paths.map((name) => quote(name, shell)).join(" ")}`]
          : []),
        `git write-tree > ${quote(file, shell)}`,
      ]),
      signal,
    )
    return oid(decode(await readFile(file)).trim())
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
export async function prepareShipCandidate(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  reviewedPaths: string[],
  signal?: AbortSignal,
): Promise<ShipCandidate> {
  if (!reviewedPaths.length) throw new Error("Ship requires explicit reviewed paths")
  await verifyWorktree(handle, shell, pin.worktree, signal)
  await assertCheckout(handle, shell, pin.source, signal)
  await assertCheckout(handle, shell, pin.target, signal)
  await noOperation(handle, shell, pin.source.root, signal)
  await cleanTarget(handle, shell, pin.target, signal)
  const paths = [...new Set(reviewedPaths.map(safePath))].sort()
  if (paths.some((name) => !shipPathAllowed(name))) throw new Error("Forbidden reviewed ship path")
  const before = await inputs(handle, shell, pin.source, signal)
  const committed = await incomingShipDelta(handle, shell, pin, pin.source.head, signal)
  if (paths.some((name) => !before.names.includes(name) && !committed.paths.includes(name)))
    throw new Error(
      "Reviewed paths must be exact tracked, committed-deleted or nonignored untracked files, not directories",
    )
  // A precommitted deletion is reviewable, but must not be passed to git add:
  // it is already absent from HEAD/index and would be a nonmatching pathspec.
  const tree = await temporaryTree(
    handle,
    shell,
    pin,
    paths.filter((name) => before.names.includes(name)),
    signal,
  )
  const incoming = await reviewShipDelta(handle, shell, pin, tree, paths, signal)
  const after = await inputs(handle, shell, pin.source, signal)
  if (before.fingerprint !== after.fingerprint)
    throw new Error("Source inputs moved while preparing ship candidate")
  await assertCheckout(handle, shell, pin.source, signal)
  return { pin, paths, tree, fingerprint: before.fingerprint, incoming }
}
export async function verifyShipCandidate(
  handle: OwnedConversation,
  shell: Shell,
  candidate: ShipCandidate,
  signal?: AbortSignal,
): Promise<void> {
  const current = await prepareShipCandidate(handle, shell, candidate.pin, candidate.paths, signal)
  if (
    current.tree !== candidate.tree ||
    current.fingerprint !== candidate.fingerprint ||
    JSON.stringify(current.incoming) !== JSON.stringify(candidate.incoming)
  )
    throw new Error("Ship candidate changed; run checks and obtain approval again")
}
/** Read-only commit probe for recovery after a missing durable receipt. */
export async function probeShipCommit(
  handle: OwnedConversation,
  shell: Shell,
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<ShipCommit> {
  oid(commit)
  const output = await checked(
    handle,
    shell,
    root,
    `git show -s --format=%H%n%T%n%P ${quote(commit, shell)} --`,
    signal,
  )
  const [head, tree, parents = ""] = output.split(/\r?\n/)
  return { head: oid(head ?? ""), tree: oid(tree ?? ""), parents: parents ? parents.split(" ").map(oid) : [] }
}
export async function commitShipCandidate(
  handle: OwnedConversation,
  shell: Shell,
  candidate: ShipCandidate,
  message: string,
  signal?: AbortSignal,
): Promise<ShipCommit> {
  if (!message.trim() || message.includes("\0")) throw new Error("Ship commit message is empty or invalid")
  await verifyShipCandidate(handle, shell, candidate, signal)
  const { pin } = candidate
  const originalIndex = await indexHash(pin.source)
  const scratch = await mkdtemp(path.join(tmpdir(), "amira-ship-commit-"))
  let failure: { error: unknown } | undefined
  try {
    const messageFile = path.join(scratch, "message")
    await writeFile(messageFile, message)
    // Normal commit: signing and all hooks apply to the isolated reviewed index.
    await checked(
      handle,
      shell,
      pin.source.root,
      withIndex(shell, path.join(scratch, "index"), [
        `git read-tree ${quote(oid(candidate.tree), shell)}`,
        `git commit --file=${quote(messageFile, shell)}`,
      ]),
      signal,
    )
  } catch (error) {
    failure = { error }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if ((await indexHash(pin.source)) !== originalIndex)
    throw new Error("Ship commit changed the original index; inspect explicitly before continuing", {
      cause: failure?.error,
    })
  if (failure) throw failure.error
  const current = await probeShipCheckout(handle, shell, pin.source.root, signal)
  if (
    current.branch !== pin.source.branch ||
    current.common !== pin.source.common ||
    current.gitDir !== pin.source.gitDir ||
    current.identity !== pin.source.identity
  )
    throw new Error("Ship source identity changed during commit")
  const committed = await probeShipCommit(handle, shell, pin.source.root, current.head, signal)
  if (
    committed.tree !== candidate.tree ||
    committed.parents.length !== 1 ||
    committed.parents[0] !== pin.source.head
  )
    throw new Error(
      "Actual commit tree/parent differs from reviewed candidate; stop and recheck (hooks may have changed it)",
    )
  // Bind raw working files too: hooks may modify files without adding them.
  if ((await inputs(handle, shell, current, signal)).fingerprint !== candidate.fingerprint)
    throw new Error("Source inputs changed during commit; stop and recheck")
  return committed
}
export async function mergeShipCandidate(
  handle: OwnedConversation,
  shell: Shell,
  candidate: ShipCandidate,
  commit: ShipCommit,
  strategy: "ff-only" | "merge",
  signal?: AbortSignal,
): Promise<ShipCommit> {
  if (strategy !== "ff-only" && strategy !== "merge") throw new Error("Unsupported local merge strategy")
  const { pin } = candidate
  await verifyWorktree(handle, shell, pin.worktree, signal)
  await assertCheckout(handle, shell, { ...pin.source, head: oid(commit.head) }, signal)
  const actual = await probeShipCommit(handle, shell, pin.source.root, commit.head, signal)
  if (actual.tree !== candidate.tree || actual.parents.length !== 1 || actual.parents[0] !== pin.source.head)
    throw new Error("Merge commit is not the exact reviewed source commit")
  if ((await inputs(handle, shell, pin.source, signal)).fingerprint !== candidate.fingerprint)
    throw new Error("Source inputs changed before merge")
  await assertCheckout(handle, shell, pin.target, signal)
  await cleanTarget(handle, shell, pin.target, signal)
  await checked(
    handle,
    shell,
    pin.target.root,
    `git merge ${strategy === "ff-only" ? "--ff-only" : "--no-ff --no-edit"} ${quote(commit.head, shell)}`,
    signal,
  )
  return verifyShipIntegration(handle, shell, pin, commit.head, signal)
}
/** Validate supported inputs on a delivered checkout, including a hosting-generated squash. */
export async function verifyShipDeliveryCheckout(
  handle: OwnedConversation,
  shell: Shell,
  checkout: ShipCheckout,
  signal?: AbortSignal,
): Promise<void> {
  await assertCheckout(handle, shell, checkout, signal)
  await cleanTarget(handle, shell, checkout, signal)
  await inputs(handle, shell, checkout, signal)
}

/** Exact unchanged source ref/identity with no unfinished operation; dirty files are retained. */
export async function verifyUnchangedShipSource(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  signal?: AbortSignal,
): Promise<void> {
  await verifyWorktree(handle, shell, pin.worktree, signal)
  await assertCheckout(handle, shell, pin.source, signal)
  await noOperation(handle, shell, pin.source.root, signal)
}

/** Negative reconciliation evidence: exact original target, clean and no unfinished operation. */
export async function verifyUnchangedShipTarget(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  signal?: AbortSignal,
): Promise<void> {
  await assertCheckout(handle, shell, pin.target, signal)
  await cleanTarget(handle, shell, pin.target, signal)
}

/** Read-only post-merge/recovery verification. A different result tree needs its own checks. */
export async function verifyShipIntegration(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  sourceCommit: string,
  signal?: AbortSignal,
): Promise<ShipCommit> {
  const current = await probeShipCheckout(handle, shell, pin.target.root, signal)
  if (
    current.branch !== pin.target.branch ||
    current.common !== pin.target.common ||
    current.gitDir !== pin.target.gitDir ||
    current.identity !== pin.target.identity
  )
    throw new Error("Ship target identity changed")
  await verifyShipDeliveryCheckout(handle, shell, current, signal)
  for (const ancestor of [pin.target.head, oid(sourceCommit)])
    await checked(
      handle,
      shell,
      current.root,
      `git merge-base --is-ancestor ${quote(ancestor, shell)} ${quote(current.head, shell)}`,
      signal,
    )
  const result = await probeShipCommit(handle, shell, current.root, current.head, signal)
  if (
    result.head !== sourceCommit &&
    (result.parents.length !== 2 ||
      result.parents[0] !== pin.target.head ||
      result.parents[1] !== sourceCommit)
  )
    throw new Error("Ship target moved beyond the exact planned integration; inspect explicitly")
  return result
}
export function assertShipCheckSafety(command: string): void {
  if (
    /--force(?:-with-lease)?\b|--no-verify\b|--no-gpg-sign\b|(?:commit|tag)\.gpgsign\s*=\s*(?:false|0)|core\.hooksPath|HUSKY\s*=\s*0|reset\s+--hard|branch\s+-D/.test(
      command,
    )
  )
    throw new Error("Ship checks cannot generate force, hook/signing bypass or destructive Git flags")
  if (
    /\bgit\s+(?:push|tag)\b|\bgh\s+(?:release|pr\s+(?:create|merge|close))\b|\b(?:npm|bun|pnpm|yarn)\s+publish\b/.test(
      command,
    )
  )
    throw new Error("Outward mutations are not ship checks; use a separately approved supported operation")
}

export async function runShipCheck(
  handle: OwnedConversation,
  shell: Shell,
  checkout: ShipCheckout,
  relativeCwd: string,
  command: string,
  signal?: AbortSignal,
  index?: string,
) {
  if (!command.trim() || /[\0]/.test(command)) throw new Error("Invalid ship check command")
  assertShipCheckSafety(command)
  const cwd = path.resolve(checkout.root, relativeCwd)
  const relative = path.relative(checkout.root, cwd)
  if (path.isAbsolute(relativeCwd) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Ship check cwd escapes checkout")
  await canonical(cwd)
  await assertCheckout(handle, shell, checkout, signal)
  const execution = index ? withIndex(shell, index, [command]) : command
  return { cwd, command, ...(await shellCall(handle, shell, inDirectory(cwd, execution, shell), signal)) }
}

// Local infrastructure seams; they never grant model or provider tool authority.
export { assertCheckout as assertShipCheckout, inputs as shipCheckoutInputs, withIndex as withShipIndex }
