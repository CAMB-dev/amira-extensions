import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { CommandContext, OwnedConversation, ToolResult } from "@amira/api"
import type { WorktreeArtifact } from "./artifacts.ts"
import { IterationStore, type Project } from "./store.ts"
import { pinWorktreeDestination, projectComponent, worktreeParent } from "./worktree-paths.ts"

export type Shell = "bash" | "powershell"
export function quote(value: string, shell: Shell): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Shell argument contains a line break or NUL")
  return shell === "powershell" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}
export function inDirectory(cwd: string, command: string, shell: Shell): string {
  return shell === "powershell"
    ? `Set-Location -LiteralPath ${quote(cwd, shell)} -ErrorAction Stop; ${command}`
    : `cd ${quote(cwd, shell)} && ${command}`
}
export function toolEvidence(result: ToolResult) {
  const output = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const details = result.details as { exitCode?: unknown; timedOut?: boolean; aborted?: boolean } | undefined
  const exitCode = typeof details?.exitCode === "number" ? details.exitCode : null
  const value = output
    .replace(/^Shell: [^\n]+\n\n/, "")
    .replace(/\n\nExit code: -?\d+[\s\S]*$/, "")
    .replace(/^\(no output\)$/, "")
    .trimEnd()
  return {
    output: value,
    exitCode,
    timedOut: details?.timedOut === true,
    aborted: details?.aborted === true,
    ok: !result.isError && exitCode === 0 && !details?.timedOut && !details?.aborted,
  }
}
export async function shellCall(
  handle: OwnedConversation,
  shell: Shell,
  command: string,
  signal?: AbortSignal,
) {
  const result = toolEvidence(await handle.runTool(shell, { command, timeout: 600_000 }, { signal }))
  return result
}
export async function checked(
  handle: OwnedConversation,
  shell: Shell,
  cwd: string,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await shellCall(handle, shell, inDirectory(cwd, command, shell), signal)
  if (!result.ok)
    throw new Error(
      `Command stopped (${cwd}): ${command}\n${result.output}\nResolve permissions, signing, hooks or Git errors and retry explicitly. No shared-cwd fallback.`,
    )
  return result.output
    .replace(/^Shell: [^\n]+\n\n/, "")
    .replace(/\n\nExit code: -?\d+[\s\S]*$/, "")
    .replace(/^\(no output\)$/, "")
    .trim()
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
export function checkCwd(worktree: WorktreeArtifact, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error("Check cwd must be relative to the iteration project")
  const cwd = path.resolve(worktree.cwd, relative)
  if (!inside(worktree.root, cwd)) throw new Error("Check cwd escapes the iteration worktree")
  return cwd
}

export async function verifiedCheckCwd(worktree: WorktreeArtifact, relative: string): Promise<string> {
  const cwd = checkCwd(worktree, relative)
  if (path.relative(cwd, await realpath(cwd)) || !(await stat(cwd)).isDirectory())
    throw new Error(`Check cwd is missing, redirected or not a directory: ${cwd}`)
  return cwd
}

export async function verifyWorktree(
  handle: OwnedConversation,
  shell: Shell,
  worktree: WorktreeArtifact,
  signal?: AbortSignal,
): Promise<void> {
  const verifyDestination = await pinWorktreeDestination(worktree.repository, worktree.root)
  for (const directory of [worktree.root, worktree.cwd]) {
    if (path.relative(directory, await realpath(directory)) || !(await stat(directory)).isDirectory())
      throw new Error("Iteration worktree path was redirected or removed")
  }
  if (!inside(worktree.root, worktree.cwd) || inside(worktree.repository, worktree.root))
    throw new Error("Invalid worktree mapping")
  const root = await checked(handle, shell, worktree.cwd, "git rev-parse --show-toplevel", signal)
  const branch = await checked(handle, shell, worktree.cwd, "git symbolic-ref --short HEAD", signal)
  if (path.relative(worktree.root, path.resolve(root)) || branch !== worktree.branch)
    throw new Error("Iteration worktree identity changed; no fallback is allowed")
  const common = await checked(
    handle,
    shell,
    worktree.root,
    "git rev-parse --path-format=absolute --git-common-dir",
    signal,
  )
  const original = await checked(
    handle,
    shell,
    worktree.repository,
    "git rev-parse --path-format=absolute --git-common-dir",
    signal,
  )
  if (path.relative(path.resolve(common), path.resolve(original)))
    throw new Error("Worktree no longer belongs to the original repository")
  await checked(
    handle,
    shell,
    worktree.root,
    `git merge-base --is-ancestor ${quote(worktree.base, shell)} HEAD`,
    signal,
  )
  await verifyDestination()
}

/** Every Git command, including probes, is an attributed policy-checked owned tool call. */
export async function prepareWorktree(
  project: Project,
  handle: OwnedConversation,
  shell: Shell,
  ctx: CommandContext,
  checkOrigin: () => void,
): Promise<WorktreeArtifact> {
  const store = new IterationStore(project)
  let state = await store.read()
  const approval = JSON.stringify(state.approvedContext)
  const authorizeSetup = async () => {
    checkOrigin()
    const current = await store.read()
    if (
      current.stage !== "implement" ||
      current.phase !== "confirmed" ||
      current.status !== "idle" ||
      current.pending ||
      current.revisit ||
      JSON.stringify(current.approvedContext) !== approval
    )
      throw new Error("Implementation approval changed during Git setup; no further Git mutation was started")
  }
  const ready = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
  if (ready) {
    const saved = await store.readArtifact(ready)
    if (saved.kind !== "iteration-worktree" || saved.status !== "ready")
      throw new Error(
        "Worktree setup was interrupted. Inspect its planned paths and Git state; no creation is replayed or existing branch adopted.",
      )
    await verifyWorktree(handle, shell, saved, ctx.signal)
    return saved
  }
  let repository: string
  const probe = await shellCall(
    handle,
    shell,
    inDirectory(project.root, "git rev-parse --show-toplevel", shell),
    ctx.signal,
  )
  if (probe.ok) repository = await realpath(path.resolve(probe.output.trim()))
  else {
    // An error/denial is not evidence of an absent repository. Only Git's explicit
    // not-a-repository diagnostic permits the human-confirmed bootstrap path.
    if (probe.exitCode !== 128 || !/not a git repository/i.test(probe.output))
      throw new Error(`Repository discovery stopped: ${probe.output}`)
    repository = project.root
  }
  if (!inside(repository, project.root)) throw new Error("Project is outside the discovered repository")
  const slug =
    project.marker.name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "project"
  const component = projectComponent(project.marker.id)
  const branch = `amira/project/${slug}-${component}/iteration-${state.iteration}`
  const root = path.join(worktreeParent(repository), component, `iteration-${state.iteration}`)
  const verifyDestination = await pinWorktreeDestination(repository, root)
  const cwd = path.join(root, path.relative(repository, project.root))
  const head = probe.ok
    ? await shellCall(
        handle,
        shell,
        inDirectory(repository, "git rev-parse --verify HEAD", shell),
        ctx.signal,
      )
    : null
  if (
    head &&
    !head.ok &&
    (head.exitCode !== 128 ||
      !/single revision|unknown revision|ambiguous argument|bad revision/i.test(head.output))
  )
    throw new Error(`Committed-base discovery stopped: ${head.output}`)
  if (!head?.ok) {
    checkOrigin()
    if (
      (await ctx.ui.confirm(
        "Initialize iteration Git base",
        `Create Git metadata if needed and an empty initial commit in ${repository}? Existing files will NOT be staged. Your signing and hooks apply; any failure stops setup. Scaffold only in the new worktree.`,
        { signal: ctx.signal, sessionId: ctx.session.info().id },
      )) !== true
    )
      throw new Error("Git bootstrap cancelled; no batch started")
    checkOrigin()
    await authorizeSetup()
    if (!probe.ok) await checked(handle, shell, repository, "git init", ctx.signal)
    // Never include a previously staged index in the promised empty commit.
    const staged = await checked(handle, shell, repository, "git diff --cached --name-only", ctx.signal)
    if (staged)
      throw new Error(`Staged files prevent an empty initial commit. Unstage them yourself first:\n${staged}`)
    await authorizeSetup()
    await checked(handle, shell, repository, 'git commit --allow-empty -m "Initial project base"', ctx.signal)
  }
  const base = await checked(handle, shell, repository, "git rev-parse --verify HEAD", ctx.signal)
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Git returned an invalid committed base")
  const preview = await checked(handle, shell, repository, "git log -1 --format='%H %s'", ctx.signal)
  const dirty = await checked(
    handle,
    shell,
    repository,
    "git status --porcelain=v1 --untracked-files=all --ignore-submodules=none",
    ctx.signal,
  )
  ctx.print(
    `Committed base preview\n${repository}\n${preview}\nBranch: ${branch}\nWorktree: ${cwd}\n${dirty ? `Excluded unless explicitly confirmed:\n${dirty}` : "Working tree clean"}`,
    "info",
    { persist: true },
  )
  checkOrigin()
  const choice = dirty
    ? await ctx.ui.select(
        "Dirty tree blocks implementation",
        ["Stop and resolve local changes", "Use displayed commit and explicitly exclude ALL local changes"],
        { signal: ctx.signal, sessionId: ctx.session.info().id },
      )
    : await ctx.ui.confirm(
        "Use committed base",
        `${preview}\nBranch: ${branch}\nWorktree: ${cwd}\nCreate an isolated iteration branch/worktree from this exact commit?`,
        { signal: ctx.signal, sessionId: ctx.session.info().id },
      )
  checkOrigin()
  if (dirty ? choice !== "Use displayed commit and explicitly exclude ALL local changes" : choice !== true)
    throw new Error(
      `Git setup stopped. Resolve local changes or explicitly exclude them from the displayed committed base.\n${preview}\n${dirty}`,
    )
  const currentDirty = await checked(
    handle,
    shell,
    repository,
    "git status --porcelain=v1 --untracked-files=all --ignore-submodules=none",
    ctx.signal,
  )
  const currentHead = await checked(handle, shell, repository, "git rev-parse --verify HEAD", ctx.signal)
  if (currentDirty !== dirty || currentHead !== base)
    throw new Error("Git base or local changes changed during confirmation; review again")
  const worktree: WorktreeArtifact = {
    kind: "iteration-worktree",
    status: "planned",
    repository,
    root,
    cwd,
    branch,
    base,
    excluded: dirty,
    confirmation: `Human approved exact base ${base}; ${dirty ? "explicitly excluded all displayed local changes" : "clean tree"}`,
    setupKey: handle.key,
  }
  state = (await store.saveArtifact(state.revision, worktree)).state
  await checked(
    handle,
    shell,
    repository,
    `git check-ref-format --branch ${quote(branch, shell)}`,
    ctx.signal,
  )
  // -b refuses collisions; never adopt, reset or delete a pre-existing branch.
  await authorizeSetup()
  await verifyDestination()
  await checked(
    handle,
    shell,
    repository,
    `git worktree add -b ${quote(branch, shell)} ${quote(root, shell)} ${quote(base, shell)}`,
    ctx.signal,
  )
  await verifyDestination()
  if (cwd !== root)
    await checked(
      handle,
      shell,
      root,
      shell === "bash"
        ? `mkdir -p ${quote(cwd, shell)}`
        : `New-Item -ItemType Directory -Path ${quote(cwd, shell)} -Force -ErrorAction Stop | Out-Null`,
      ctx.signal,
    )
  await verifyWorktree(handle, shell, worktree, ctx.signal)
  const completed = { ...worktree, status: "ready" as const }
  await store.saveArtifact(state.revision, completed)
  return completed
}

/** A temporary index records all batch inputs (including untracked files) without
 * touching the user's real index, committing, or changing a branch. */
export async function snapshot(
  handle: OwnedConversation,
  shell: Shell,
  worktree: WorktreeArtifact,
  signal?: AbortSignal,
): Promise<string> {
  const index = path.join(path.dirname(worktree.root), `snapshot-${randomUUID()}.index`)
  const q = (value: string) => quote(value, shell)
  const command =
    shell === "bash"
      ? `export GIT_INDEX_FILE=${q(index)}; trap 'rm -f "$GIT_INDEX_FILE" "$GIT_INDEX_FILE.lock"' EXIT; git read-tree HEAD && git add -A && git write-tree`
      : `$previous = $env:GIT_INDEX_FILE; $env:GIT_INDEX_FILE = ${q(index)}; try { git read-tree HEAD; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git add -A; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git write-tree } finally { Remove-Item -LiteralPath ${q(index)},${q(`${index}.lock`)} -Force -ErrorAction SilentlyContinue; $env:GIT_INDEX_FILE = $previous }`
  const output = await checked(handle, shell, worktree.root, command, signal)
  // Successful Git clean/CRLF conversions may emit warnings on the combined stream.
  // Require one unambiguous write-tree result, without overriding the user's config.
  const trees = output.split(/\r?\n/).filter((line) => /^[a-f0-9]{40,64}$/.test(line))
  if (trees.length !== 1) throw new Error(`Unable to record batch snapshot: ${output}`)
  return trees[0]!
}
