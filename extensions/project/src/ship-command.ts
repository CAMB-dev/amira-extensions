import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext, ExtensionAPI, OwnedConversation } from "@amira/api"
import { acceptanceCheckout, acceptanceCodeHash, verifyAcceptanceCheckout } from "./accept-integrity.ts"
import { openAccounted } from "./accounting.ts"
import { checked, quote, type Shell } from "./iteration-git.ts"
import { localize } from "./language.ts"
import { type ShipPlan, type ShipPorts, ShipSequence, shipSummary } from "./ship.ts"
import { runCandidateCheck, runDeliveredCheck } from "./ship-checkout.ts"
import { incomingShipDelta, shipPathAllowed } from "./ship-delta.ts"
import { resolveShipEvidence } from "./ship-evidence.ts"
import {
  assertShipCheckSafety,
  commitShipCandidate,
  mergeShipCandidate,
  pinShipGit,
  pinShipSource,
  prepareShipCandidate,
  probeShipCheckout,
  probeShipCommit,
  type ShipCandidate,
  verifyShipCandidate,
  verifyShipDeliveryCheckout,
  verifyShipIntegration,
  verifyUnchangedShipSource,
  verifyUnchangedShipTarget,
} from "./ship-git.ts"
import { hostingRepository, ShipHosting } from "./ship-pr.ts"
import { ShipStore, shipHash } from "./ship-storage.ts"
import {
  assertProjectWritable,
  IterationStore,
  LifecycleStore,
  type Project,
  projectLifecycle,
  readProject,
} from "./store.ts"

function candidate(plan: ShipPlan): ShipCandidate {
  if (
    !plan.candidate?.incoming ||
    !plan.checkRoot ||
    !sameIdentity(plan.candidate.pin.source, plan.source) ||
    plan.candidate.pin.source.head !== plan.source.head ||
    !sameIdentity(plan.candidate.pin.target, plan.target) ||
    plan.candidate.pin.target.head !== plan.target.head ||
    plan.candidate.tree !== plan.source.tree ||
    shipHash(plan.candidate.paths) !== shipHash(plan.files)
  )
    throw new Error("Missing or inconsistent reviewed ship candidate")
  return plan.candidate
}
const sameIdentity = (
  a: { root: string; branch: string; common: string },
  b: { root: string; branch: string; common: string },
) => a.root === b.root && a.branch === b.branch && a.common === b.common

export function shipPorts(
  project: Project,
  handle: OwnedConversation,
  shell: Shell,
  ctx: CommandContext,
  checkOrigin: () => void,
  store = new ShipStore(project),
): ShipPorts {
  const hosting = new ShipHosting(handle, shell, ctx.signal)
  const currentEvidence = async (plan: ShipPlan) => {
    checkOrigin()
    await assertProjectWritable(project)
    const boundary = await resolveShipEvidence(project)
    if (
      boundary.status !== "verified" ||
      boundary.state.revision !== plan.stageRevision ||
      shipHash(boundary.references) !== plan.evidence
    )
      throw new Error(
        "Ship completion evidence changed or is unavailable. Review the current plan before any further operation.",
      )
  }
  const guard: ShipPorts["guard"] = async (plan, phase) => {
    await currentEvidence(plan)
    const saved = await store.latest()
    if (saved && (saved.id !== plan.id || saved.revision !== plan.revision))
      throw new Error("Ship plan changed during confirmation; no effect was started")
    const selected = candidate(plan)
    if (!plan.commit) {
      await verifyShipCandidate(handle, shell, selected, ctx.signal)
      return
    }
    const source = await probeShipCheckout(handle, shell, plan.source.root, ctx.signal)
    const committed = await probeShipCommit(handle, shell, plan.source.root, plan.commit, ctx.signal)
    if (
      !sameIdentity(source, plan.source) ||
      source.gitDir !== selected.pin.source.gitDir ||
      source.identity !== selected.pin.source.identity ||
      source.head !== plan.commit ||
      committed.tree !== plan.source.tree ||
      (plan.existingCommit
        ? plan.commit !== plan.source.head
        : committed.parents.length !== 1 || committed.parents[0] !== plan.source.head)
    )
      throw new Error("Committed source differs from the exact reviewed candidate")
    // Reconstruct the same temporary tree using the original source HEAD. It
    // checks raw files + the untouched real index, not a HEAD-sensitive acceptance hash.
    if (phase === "source") {
      const refreshed = await prepareShipCandidate(
        handle,
        shell,
        { ...selected.pin, source: { ...selected.pin.source, head: plan.commit } },
        selected.paths,
        ctx.signal,
      )
      if (
        refreshed.tree !== selected.tree ||
        refreshed.fingerprint !== selected.fingerprint ||
        JSON.stringify(refreshed.incoming) !== JSON.stringify(selected.incoming)
      )
        throw new Error("Source inputs changed after checks/commit")
    } else if (plan.preference.strategy === "local-merge") {
      const integrated = await verifyShipIntegration(handle, shell, selected.pin, plan.commit, ctx.signal)
      if (integrated.head !== plan.integrated || integrated.tree !== plan.integratedTree)
        throw new Error("Integrated target commit/tree moved after approval")
    } else {
      const target = await probeShipCheckout(handle, shell, plan.target.root, ctx.signal)
      if (
        !sameIdentity(target, plan.target) ||
        target.gitDir !== selected.pin.target.gitDir ||
        target.identity !== selected.pin.target.identity ||
        target.head !== plan.integrated
      )
        throw new Error(
          "Fetch and update the explicitly selected target checkout to the exact verified PR merge commit yourself; project never checks out or resets it",
        )
      await verifyShipDeliveryCheckout(handle, shell, target, ctx.signal)
      const delivered = await probeShipCommit(handle, shell, target.root, target.head, ctx.signal)
      if (delivered.tree !== plan.integratedTree)
        throw new Error("PR delivered tree differs from the pinned merge result")
      await checked(
        handle,
        shell,
        target.root,
        `git merge-base --is-ancestor ${quote(plan.target.head, shell)} ${quote(target.head, shell)}`,
        ctx.signal,
      )
    }
  }
  return {
    save: (plan) => store.save(plan),
    confirm: async (title, body) => {
      checkOrigin()
      const result = await ctx.ui.confirm(title, body, {
        signal: ctx.signal,
        sessionId: ctx.session.info().id,
      })
      checkOrigin()
      return result === true
    },
    guard,
    check: async (check, phase) => {
      const plan = await store.latest()
      if (!plan) throw new Error("Ship plan disappeared")
      const pin = candidate(plan).pin
      if (phase === "source") {
        if (!plan.checkRoot)
          throw new Error("Ship source checks require an explicitly approved isolated checkout")
        return runCandidateCheck(
          handle,
          shell,
          candidate(plan),
          plan.checkRoot,
          check.cwd,
          check.command,
          ctx.signal,
          plan.commit ?? pin.source.head,
        )
      }
      const checkout = { ...pin.target, head: plan.integrated! }
      if (!plan.integratedTree) throw new Error("Integrated checks require the exact delivered tree")
      return runDeliveredCheck(
        handle,
        shell,
        checkout,
        plan.integratedTree,
        check.cwd,
        check.command,
        ctx.signal,
      )
    },
    commit: async (plan) =>
      (await commitShipCandidate(handle, shell, candidate(plan), plan.message, ctx.signal)).head,
    merge: async (plan) => {
      const commit = await probeShipCommit(handle, shell, plan.source.root, plan.commit!, ctx.signal)
      if (plan.existingCommit) {
        await guard(plan, "source")
        await checked(
          handle,
          shell,
          plan.target.root,
          `git merge ${plan.preference.merge === "ff-only" ? "--ff-only" : "--no-ff --no-edit"} ${quote(plan.commit!, shell)}`,
          ctx.signal,
        )
        const integrated = await verifyShipIntegration(
          handle,
          shell,
          candidate(plan).pin,
          plan.commit!,
          ctx.signal,
        )
        plan.integratedTree = integrated.tree
        return integrated.head
      }
      const integrated = await mergeShipCandidate(
        handle,
        shell,
        candidate(plan),
        commit,
        plan.preference.merge,
        ctx.signal,
      )
      plan.integratedTree = integrated.tree
      return integrated.head
    },
    push: (plan) => hosting.push(plan),
    createPr: (plan) => hosting.create(plan),
    reconcile: async (plan, operation) => {
      await currentEvidence(plan)
      const pin = candidate(plan).pin
      if (operation.kind === "commit") {
        const actual = await probeShipCheckout(handle, shell, plan.source.root, ctx.signal)
        if (
          !sameIdentity(actual, plan.source) ||
          actual.gitDir !== pin.source.gitDir ||
          actual.identity !== pin.source.identity
        )
          return undefined
        if (actual.head === plan.source.head) {
          await verifyUnchangedShipSource(handle, shell, pin, ctx.signal)
          return {
            notApplied: true,
            evidence: `Source HEAD remains ${actual.head}, with its original identity and no unfinished Git operation. Any changed working files/index are retained for explicit repair and reapproval`,
          }
        }
        const committed = await probeShipCommit(handle, shell, actual.root, actual.head, ctx.signal)
        if (committed.parents.length !== 1 || committed.parents[0] !== plan.source.head) return undefined
        if (committed.tree !== plan.source.tree)
          return {
            notApplied: false,
            evidence: `Observed commit ${actual.head} with parent ${plan.source.head} but unapproved tree ${committed.tree} (expected ${plan.source.tree}). No integration is authorized; revise and recheck the actual deliverables.`,
          }
        // The exact approved commit exists. Raw-file/index drift still blocks the
        // next source guard, but does not make the already observed commit unknown.
        return actual.head
      }
      if (operation.kind === "merge" && plan.commit) {
        const target = await probeShipCheckout(handle, shell, plan.target.root, ctx.signal)
        if (target.head === pin.target.head) {
          await verifyUnchangedShipTarget(handle, shell, pin, ctx.signal)
          await guard(plan, "source")
          return {
            notApplied: true,
            evidence: `Target remains clean at ${target.head}, with no unfinished merge; no integration occurred`,
          }
        }
        const integrated = await verifyShipIntegration(handle, shell, pin, plan.commit, ctx.signal)
        if (plan.integratedTree && plan.integratedTree !== integrated.tree)
          throw new Error("Integrated tree changed during reconciliation")
        plan.integratedTree = integrated.tree
        return integrated.head
      }
      if (operation.kind === "push") return hosting.pushed(plan)
      if (operation.kind === "pr") return (await hosting.observe(plan))?.url
      return undefined
    },
    mergedPr: async (plan) => {
      checkOrigin()
      const observation = await hosting.observe(plan)
      if (observation?.state !== "MERGED" || !observation.mergeCommit?.oid) return undefined
      const merged = await probeShipCommit(
        handle,
        shell,
        plan.target.root,
        observation.mergeCommit.oid,
        ctx.signal,
      )
      if (plan.integratedTree && plan.integratedTree !== merged.tree)
        throw new Error("PR merge tree changed during reconciliation")
      plan.integratedTree = merged.tree
      return merged.head
    },
  }
}

async function releaseNotes(
  project: Project,
  sourceRoot: string,
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
  handle: OwnedConversation,
  shell: Shell,
  authorize: () => Promise<void>,
) {
  await authorize()
  const text = await ctx.ui.input(
    localize(language, "Ship summary and release notes", "发布总结和说明", "リリースの要約と説明"),
    { signal: ctx.signal },
  )
  checkOrigin()
  await authorize()
  if (!text?.trim()) throw new Error("Ship notes cancelled; no candidate was committed")
  // Follow an existing convention only. Never invent a top-level changelog/version.
  for (const relative of ["CHANGELOG.md", "CHANGES.md", "HISTORY.md", "docs/changelog.md"]) {
    const file = path.join(sourceRoot, relative)
    let before: string
    try {
      if (
        !(await lstat(file)).isFile() ||
        path.relative(path.dirname(file), await realpath(path.dirname(file)))
      )
        throw new Error("Changelog is redirected or not a regular file")
      before = await readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (
      !(await ctx.ui.confirm(
        "Append notes to existing changelog",
        `${relative}\n\n${text}\n\nThis edit must be included in the reviewed candidate and full checks. No version or tag is invented.`,
        { signal: ctx.signal, sessionId: ctx.session.info().id },
      ))
    ) {
      checkOrigin()
      throw new Error(
        "Existing changelog convention was not updated. Edit it yourself, then prepare ship again.",
      )
    }
    checkOrigin()
    await authorize()
    if (
      (await readFile(file, "utf8")) !== before ||
      !(await lstat(file)).isFile() ||
      path.relative(path.dirname(file), await realpath(path.dirname(file)))
    )
      throw new Error("Changelog changed during confirmation")
    const scratch = await mkdtemp(path.join(tmpdir(), "amira-ship-notes-"))
    try {
      const prepared = path.join(scratch, "notes.md")
      await writeFile(prepared, `${before.trimEnd()}\n\n${text.trim()}\n`)
      // Versioned notes use the same normal permission-checked owner as Git.
      // Direct filesystem publication is reserved for project evidence/scratch.
      await authorize()
      await checked(
        handle,
        shell,
        sourceRoot,
        shell === "bash"
          ? `cat ${quote(prepared, shell)} > ${quote(file, shell)}`
          : `Copy-Item -LiteralPath ${quote(prepared, shell)} -Destination ${quote(file, shell)} -ErrorAction Stop`,
        ctx.signal,
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    return { language, text, location: relative }
  }
  await authorize()
  const store = new IterationStore(project)
  const state = await store.read()
  await authorize()
  const saved = await store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: "accept",
    language,
    summary: text,
    outputs: [],
    suggestion:
      "Review the exact ship candidate and complete checks. This is release-note evidence, not ship approval.",
  })
  return { language, text, location: saved.artifact.path }
}

async function preparePlan(
  project: Project,
  ctx: CommandContext,
  language: string,
  handle: OwnedConversation,
  shell: Shell,
  checkOrigin: () => void,
  changePreference = false,
): Promise<ShipPlan> {
  let evidence = await resolveShipEvidence(project)
  if (evidence.status !== "verified")
    throw new Error(
      `Ship evidence ${evidence.status}: ${evidence.reason ?? "unresolved completion boundary"}`,
    )
  const worktreeRef = evidence.state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
  if (!worktreeRef)
    throw new Error(
      "No recorded iteration worktree. Use explicit /project ship skip for a document-only/no-code iteration; no Git operation is invented.",
    )
  const worktree = await new IterationStore(project).readArtifact(worktreeRef)
  if (worktree.kind !== "iteration-worktree" || worktree.status !== "ready")
    throw new Error("Ship requires the recorded ready worktree")
  // Pin source identity before any notes dialog or versioned-file mutation.
  const source = await pinShipSource(handle, shell, worktree, ctx.signal)
  const store = new ShipStore(project)
  const preference = changePreference ? undefined : await store.preference(source.common)
  const options = ["Use local merge (default)", "Create PR with gh (await merge)"]
  const strategyChoice =
    preference?.strategy ??
    (await ctx.ui.select("Repository integration preference", options, {
      signal: ctx.signal,
      sessionId: ctx.session.info().id,
    }))
  checkOrigin()
  if (!strategyChoice) throw new Error("Ship preference cancelled")
  const strategy = strategyChoice === "pr" || strategyChoice === options[1] ? "pr" : "local-merge"
  const targetRoot = await ctx.ui.input("Target checkout directory (never checked out or reset by project)", {
    signal: ctx.signal,
    placeholder: worktree.repository,
  })
  checkOrigin()
  if (!targetRoot) throw new Error("Choose the exact target checkout directory")
  const pin = await pinShipGit(handle, shell, worktree, path.resolve(targetRoot), ctx.signal, source)
  if (preference && pin.target.branch !== preference.target)
    throw new Error(
      `Remembered target is ${preference.target}; choose its checkout. No target was silently changed.`,
    )
  const priorIncoming = await incomingShipDelta(handle, shell, pin, source.head, ctx.signal)
  const forbiddenCommitted = priorIncoming.paths.filter((name) => !shipPathAllowed(name))
  if (forbiddenCommitted.length)
    throw new Error(
      `Forbidden precommitted incoming paths; repair the branch explicitly:\n${forbiddenCommitted.join("\n")}`,
    )
  const priorHistory = await checked(
    handle,
    shell,
    source.root,
    `git --no-pager log --patch --no-ext-diff --no-textconv --no-renames ${quote(source.head, shell)} --not ${quote(pin.target.head, shell)} --`,
    ctx.signal,
  )
  ctx.print(priorHistory || "No source-only commits are incoming.", "info", { persist: true })
  ctx.print(
    `Already committed incoming paths (must also be explicitly reviewed):\n${priorIncoming.paths.join("\n") || "none"}`,
    "info",
    { persist: true },
  )

  // Completion consumes the active pointer. Reconstruct the last consumed review's
  // exact context/ref window rather than treating 'no active verdict' as fresh.
  // A full historical fingerprint also binds HEAD/index: a mismatch is unavailable
  // current-content authority, not proof that a legitimate commit changed code.
  const resolution = evidence.state.batchResolutions?.findLast(
    (entry) =>
      entry.batchId === evidence.state.approvedContext?.batchId &&
      entry.context.batchPlan?.artifactId === evidence.state.approvedContext?.batchPlan?.artifactId,
  )
  let contentVerified = false
  if (resolution?.status === "accepted") {
    const attempt = evidence.state.attempts.find((entry) => entry.id === resolution.attemptId)
    const index = evidence.state.artifacts.findIndex((entry) => entry.id === attempt?.acceptance?.artifactId)
    if (attempt?.review && index >= 0) {
      const historical = {
        ...evidence.state,
        approvedContext: resolution.context,
        artifacts: evidence.state.artifacts.slice(0, index),
      }
      const checkout = await acceptanceCheckout(project, historical)
      await verifyAcceptanceCheckout(handle, shell, checkout, ctx.signal)
      contentVerified =
        (await acceptanceCodeHash(project, historical, handle, shell, checkout, ctx.signal)) ===
        attempt.review.codeHash
    }
  }
  if (!contentVerified) {
    if (
      !(await ctx.ui.confirm(
        "Waive unavailable current-content acceptance — not a pass",
        "Consumed batch receipts remain valid history, but their HEAD/context-bound fingerprints cannot certify this current checkout (including legitimately committed or explicitly skipped work). Explicitly waive current-content acceptance and proceed with fresh full candidate/integrated checks? Cancel to repair or obtain fresh acceptance.",
        { signal: ctx.signal, sessionId: ctx.session.info().id },
      ))
    )
      throw new Error("Current-content acceptance is unavailable. No ship plan was authorized.")
    checkOrigin()
  }
  const notesRevision = evidence.state.revision
  const notesReferences = shipHash(evidence.references)
  const authorizeNotes = async () => {
    checkOrigin()
    await verifyUnchangedShipSource(handle, shell, pin, ctx.signal)
    await verifyUnchangedShipTarget(handle, shell, pin, ctx.signal)
    const current = await resolveShipEvidence(project)
    if (
      current.status !== "verified" ||
      current.state.revision !== notesRevision ||
      shipHash(current.references) !== notesReferences
    )
      throw new Error("Completion evidence changed during notes confirmation; no notes were written")
    checkOrigin()
  }
  const notes = await releaseNotes(
    project,
    worktree.root,
    ctx,
    language,
    checkOrigin,
    handle,
    shell,
    authorizeNotes,
  )
  evidence = await resolveShipEvidence(project)
  const mergeOptions = ["Fast-forward only", "Repository merge commit"]
  const mergeChoice =
    preference?.merge ??
    (strategy === "pr"
      ? "ff-only"
      : await ctx.ui.select("Local integration strategy", mergeOptions, {
          signal: ctx.signal,
          sessionId: ctx.session.info().id,
        }))
  checkOrigin()
  if (!mergeChoice) throw new Error("Merge strategy cancelled")
  const status = await checked(
    handle,
    shell,
    source.root,
    "git --no-optional-locks status --short --untracked-files=all --ignore-submodules=none",
    ctx.signal,
  )
  ctx.print(
    `Review source changes (unrelated changes are not staged):\n${status}\nSource ${source.branch} @ ${source.head}\nTarget ${pin.target.branch} @ ${pin.target.head}`,
    "info",
    { persist: true },
  )
  const paths = await ctx.ui.input("Exact reviewed repository-relative file paths as a JSON array", {
    signal: ctx.signal,
    placeholder: '["src/file.ts", "test/file.test.ts"]',
  })
  checkOrigin()
  const selected: unknown = JSON.parse(paths ?? "null")
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.some((name) => typeof name !== "string" || !shipPathAllowed(name))
  )
    throw new Error(
      "Choose explicit deliverable paths, not secrets, prototype code or project control-plane files",
    )
  if (!notes.location.startsWith(".amira/") && !selected.includes(notes.location))
    throw new Error("Include the changelog edit in the reviewed candidate")
  const reviewed = await prepareShipCandidate(handle, shell, pin, selected, ctx.signal)
  const diff = await checked(
    handle,
    shell,
    source.root,
    `git diff --no-ext-diff --no-textconv ${quote(reviewed.incoming.base, shell)} ${quote(reviewed.tree, shell)} --`,
    ctx.signal,
  )
  ctx.print(
    `Exact candidate tree: ${reviewed.tree}\nComplete incoming delta from ${reviewed.incoming.base}: ${reviewed.incoming.paths.join(", ")}\nReviewed files: ${reviewed.paths.join(", ")}\n${diff}`,
    "info",
    {
      persist: true,
    },
  )
  const message = await ctx.ui.input("Candidate commit message (repository signing and hooks apply)", {
    signal: ctx.signal,
  })
  checkOrigin()
  if (!message?.trim()) throw new Error("Candidate commit cancelled")
  const relativeProject = path.relative(worktree.root, worktree.cwd)
  const checks = evidence.checks.map((check) => ({
    id: check.id,
    command: check.command,
    cwd: path.join(relativeProject, check.cwd ?? "."),
  }))
  // Explicitly approved ship-only full suite can supplement item-bound checks.
  const extra = await ctx.ui.input(
    "Additional complete ship checks as JSON (or [] if item checks cover the full product)",
    { signal: ctx.signal, placeholder: '[{"id":"full-suite","command":"bun test","cwd":"."}]' },
  )
  checkOrigin()
  const manifest: unknown = JSON.parse(extra ?? "null")
  if (
    !Array.isArray(manifest) ||
    manifest.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        typeof row.command !== "string" ||
        typeof row.cwd !== "string",
    )
  )
    throw new Error(
      "Approve an explicit full-check manifest, including [] when no supplemental checks are needed",
    )
  for (const row of manifest) checks.push(row)
  for (const check of checks) assertShipCheckSafety(check.command)
  if (!checks.length || new Set(checks.map((row) => row.id)).size !== checks.length)
    throw new Error("Full-check IDs must be nonempty and unique")
  const planId = randomUUID()
  const plan: ShipPlan = {
    schemaVersion: 1,
    id: planId,
    checkRoot: path.join(await realpath(tmpdir()), `amira-ship-check-${planId}`),
    projectId: project.marker.id,
    iteration: project.marker.currentIteration,
    stageRevision: evidence.state.revision,
    revision: 0,
    status: "pending",
    preference: {
      repository: source.common,
      strategy,
      target: pin.target.branch,
      merge: mergeChoice === "merge" || mergeChoice === mergeOptions[1] ? "merge" : "ff-only",
    },
    source: { ...pin.source, tree: reviewed.tree },
    target: pin.target,
    candidate: reviewed,
    files: reviewed.paths,
    checks,
    notes,
    evidence: shipHash(evidence.references),
    contentAcceptance: contentVerified ? "verified-before-notes" : "waived-unavailable",
    skipped: [
      ...evidence.skipped,
      ...(!contentVerified ? ["current-content acceptance explicitly waived (unavailable; not passed)"] : []),
    ],
    message,
    results: [],
    operations: [],
  }
  const existing = await probeShipCommit(handle, shell, source.root, source.head, ctx.signal)
  if (existing.tree === reviewed.tree) {
    plan.commit = source.head
    plan.existingCommit = true
  }
  if (
    strategy === "pr" ||
    (await ctx.ui.confirm(
      "Include a remote push",
      "A push needs a separate exact-input confirmation later. Declining selects local-only delivery, not pushed/published.",
      { signal: ctx.signal, sessionId: ctx.session.info().id },
    ))
  ) {
    checkOrigin()
    const name = await ctx.ui.input("Remote name", { signal: ctx.signal, placeholder: "origin" })
    checkOrigin()
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw new Error("Choose an explicit safe remote name")
    const url = await checked(
      handle,
      shell,
      source.root,
      `git remote get-url --push --all ${quote(name, shell)}`,
      ctx.signal,
    )
    if (!url.trim() || /[\r\n]/.test(url))
      throw new Error("Choose a remote with exactly one push URL; multi-destination pushes are not supported")
    plan.remote = { name, url, branch: strategy === "pr" ? source.branch : pin.target.branch }
    if (strategy === "pr") {
      const repository = await ctx.ui.input("GitHub repository (owner/repository)", { signal: ctx.signal })
      checkOrigin()
      plan.pr = {
        repository: hostingRepository(repository ?? ""),
        base: pin.target.branch,
        title: message.split(/\r?\n/)[0]!,
        body: notes.text,
      }
    }
  }
  checkOrigin()
  if (
    !(await ctx.ui.confirm(
      "Approve exact ship plan and full checks",
      `${JSON.stringify(plan, null, 2)}\nSource checks create and normally remove a detached temporary Git worktree at checkRoot, populated with the exact candidate tree and its own index. No check runs in your dirty source checkout. Dirty, interrupted or redirected checkouts are retained rather than force-cleaned. Checks and hooks execute under normal permissions, not a sandbox. Review scripts with external effects. Skipped requirements are not passed. Every commit, merge, push and PR still needs its own confirmation.`,
      { signal: ctx.signal, sessionId: ctx.session.info().id },
    ))
  )
    throw new Error("Ship plan not approved")
  checkOrigin()
  await verifyShipCandidate(handle, shell, reviewed, ctx.signal)
  const current = await resolveShipEvidence(project)
  if (
    current.status !== "verified" ||
    current.state.revision !== plan.stageRevision ||
    shipHash(current.references) !== plan.evidence
  )
    throw new Error("Completion boundary changed during plan review")
  plan.approval = { sessionId: ctx.session.info().id, date: new Date().toISOString() }
  await store.create(plan)
  return plan
}

/** Repair only the local publication gap after a durable settled ship receipt; no tools/replay. */
export async function settleShipLifecycle(
  project: Project,
  plan: ShipPlan,
  sessionId: string,
): Promise<void> {
  if (
    !["shipped", "skipped"].includes(plan.status) ||
    plan.projectId !== project.marker.id ||
    plan.iteration !== project.marker.currentIteration
  )
    throw new Error("Lifecycle settlement requires this iteration's settled ship receipt")
  const latest = await new ShipStore(project).latest()
  if (!latest || latest.id !== plan.id || latest.revision !== plan.revision || latest.status !== plan.status)
    throw new Error("Settled ship receipt changed before lifecycle publication")
  const current = await readProject(project.root, project.marker.id)
  if (current.marker.currentIteration !== plan.iteration)
    throw new Error("Iteration changed before ship settlement")
  const lifecycle = projectLifecycle(current)
  const iteration = lifecycle.iterations[plan.iteration]!
  const status = plan.status === "shipped" ? "shipped" : "skipped"
  if (["shipped", "skipped"].includes(iteration.ship)) {
    if (iteration.ship !== status || iteration.receipt?.id !== plan.id)
      throw new Error("Conflicting settled lifecycle receipt; inspect local evidence")
    return
  }
  await new LifecycleStore(current).transition(lifecycle.revision, {
    type: "ship",
    status,
    receipt: { id: plan.id, sessionId, date: new Date().toISOString() },
  })
}

export async function runShip(
  api: ExtensionAPI,
  project: Project,
  args: string[],
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
  quiesce: () => Promise<void>,
): Promise<void> {
  const action = args[0] ?? "run"
  if (args.length > 1 || !["run", "status", "reconcile", "local-only", "skip", "revise"].includes(action))
    throw new Error("Use /project ship [status|reconcile|local-only|skip|revise]")
  const store = new ShipStore(project)
  let plan = await store.latest()
  const lifecycleShip = projectLifecycle(project).iterations[project.marker.currentIteration]?.ship
  if (action === "status" || (!plan && lifecycleShip === "skipped")) {
    ctx.print(
      plan
        ? shipSummary(plan)
        : lifecycleShip === "skipped"
          ? "Ship explicitly skipped — not passed or delivered. Iteration remains open."
          : "Ship has not started. Acceptance complete does not mean shipped.",
    )
    return
  }
  checkOrigin()
  await assertProjectWritable(project)
  if (plan && ["shipped", "skipped"].includes(plan.status)) {
    checkOrigin()
    await settleShipLifecycle(project, plan, ctx.session.info().id)
    ctx.print(shipSummary(plan))
    return
  }
  await quiesce()
  checkOrigin()
  // Individual publications share the project claim/CAS. Do not hold that claim
  // over tools: their accounting drain can publish on an independent event task.
  const execute = async () => {
    if (plan?.status === "superseded") plan = undefined
    if (action === "revise" && plan) {
      if (
        !(await ctx.ui.confirm(
          "Revise ship plan",
          `${shipSummary(plan)}\nPreserve these receipts and review a new exact candidate/check plan? Uncertain effects must be reconciled first.`,
          { signal: ctx.signal, sessionId: ctx.session.info().id },
        ))
      )
        return
      checkOrigin()
      await store.supersede(plan)
      plan = undefined
    }
    // Explicit no-code/ship skip needs no fake Git owner or candidate.
    if (action === "skip" && !plan) {
      const state = await new IterationStore(project).read()
      if (state.phase !== "complete" || state.pending || state.revisit || state.status === "working")
        throw new Error("Finish or explicitly skip unresolved stages before ship skip")
      if (
        !(await ctx.ui.confirm(
          "Skip ship — not a pass",
          "No merge, push, PR or publication will be claimed. Preserve this open iteration and its artifacts?",
          { signal: ctx.signal, sessionId: ctx.session.info().id },
        ))
      )
        return
      checkOrigin()
      await new LifecycleStore(project).transition(projectLifecycle(project).revision, {
        type: "ship",
        status: "skipped",
        receipt: { id: randomUUID(), sessionId: ctx.session.info().id, date: new Date().toISOString() },
      })
      ctx.print("Ship explicitly skipped — not passed or delivered. Iteration remains open.")
      return
    }
    if (!plan) {
      const boundary = await resolveShipEvidence(project)
      if (boundary.status !== "verified")
        throw new Error(
          `Ship requires a complete human-consumed boundary: ${boundary.status} — ${boundary.reason}`,
        )
    }
    if (typeof api.conversations?.openOrCreate !== "function")
      throw new Error(
        "Ship requires owned conversations and policy-checked runTool; no fallback shell was started",
      )
    const shell: Shell = ctx.session.info().shell === "powershell" ? "powershell" : "bash"
    const handle = await openAccounted(
      api,
      project,
      { stage: "ship", role: "deterministic-tools" },
      {
        key: `${project.marker.id}/iteration/${project.marker.currentIteration}/ship/${randomUUID()}`,
        name: `Iteration ${project.marker.currentIteration} ship`,
        cwd: project.root,
        systemPrompt:
          "Inert ship tool owner. The extension runs deterministic policy-checked tools only. Never send model turns or run release commands.",
        callableTools: [shell],
        writeRoots: [],
      },
      {
        askUser: async () => {
          throw new Error("Deterministic ship tools do not ask model questions")
        },
      },
    )
    try {
      if (!plan) {
        if (action !== "run" && action !== "revise") throw new Error("No saved ship plan to reconcile")
        plan = await preparePlan(project, ctx, language, handle, shell, checkOrigin, action === "revise")
      }
      const sequence = new ShipSequence(
        shipPorts(project, handle, shell, ctx, checkOrigin, store),
        ctx.session.info().id,
      )
      plan =
        action === "reconcile"
          ? await sequence.reconcile(plan)
          : action === "local-only"
            ? await sequence.localOnly(plan)
            : action === "skip"
              ? await sequence.skip(plan)
              : await sequence.run(plan)
      ctx.print(shipSummary(plan), plan.status === "blocked" ? "warning" : "info", { persist: true })
    } finally {
      await handle.release()
    }
    if (plan && ["shipped", "skipped"].includes(plan.status)) {
      checkOrigin()
      await settleShipLifecycle(project, plan, ctx.session.info().id)
    }
  }
  await execute()
}
