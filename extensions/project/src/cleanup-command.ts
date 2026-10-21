import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import type { CommandContext, ExtensionAPI, OwnedConversation } from "@amira/api"
import { projectAccounting } from "./accounting.ts"
import { FileCostPersistence } from "./cost-storage.ts"
import type { Shell } from "./iteration-git.ts"
import { localize } from "./language.ts"
import { recoverOwnerInventory } from "./owner-inventory.ts"
import { assertNoPendingOwnerOpenings, publishOwnerOpening } from "./owner-openings.ts"
import {
  type CleanupApproval,
  type GitCleanupPreview,
  ProjectCleanup,
  prototypeRemovalStatus,
} from "./project-cleanup.ts"
import { ProjectLifecycleController } from "./project-lifecycle.ts"
import { ShipStore } from "./ship-storage.ts"
import {
  HistoricalIterationReader,
  type Project,
  ProjectDocumentStore,
  projectLifecycle,
  readProject,
} from "./store.ts"

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Administrative tools are opened only on an explicit cleanup request, never archive/restore. */
export async function runCleanupCommand(
  api: ExtensionAPI,
  project: Project,
  args: string[],
  ctx: CommandContext,
  language: string,
  checkOrigin: () => void,
): Promise<void> {
  const kind = args[0]
  if (!kind) {
    ctx.print(
      "Resources retained. Choose /project iteration cleanup worktree|branch|prototypes [iteration]. Every removal needs a separate exact-preview confirmation.",
    )
    return
  }
  const iteration = args[1] === undefined ? project.marker.currentIteration : Number(args[1])
  if (
    args.length > 2 ||
    !["worktree", "branch", "prototypes"].includes(kind) ||
    !Number.isSafeInteger(iteration) ||
    iteration < 1 ||
    iteration > project.marker.currentIteration
  )
    throw new Error("Use /project iteration cleanup worktree|branch|prototypes [iteration].")
  const lifecycle = projectLifecycle(project)
  if (lifecycle.status !== "archived" && lifecycle.iterations[iteration]?.status !== "closed")
    throw new Error(
      "Close the selected iteration or finish archiving the project first. Resources were retained.",
    )
  const operations = await new ProjectLifecycleController(api, project).read()
  const latestSettlement = operations.findLast(
    (operation) => operation.action === "archive" || operation.iteration === iteration,
  )
  if (latestSettlement && latestSettlement.status !== "completed")
    throw new Error(
      "An unfinished lifecycle operation blocks cleanup. Inspect /project iteration and settle it first.",
    )
  checkOrigin()
  if (
    !(await ctx.ui.confirm(
      localize(language, "Inspect optional cleanup", "检查可选清理", "任意のクリーンアップを確認"),
      `${project.marker.name} · iteration ${iteration} · ${kind}\n\nInspect recorded resources through permission-checked tools? No removal is approved yet. Keep everything unless you confirm each exact preview.`,
      { signal: ctx.signal, sessionId: ctx.session.info().id },
    ))
  )
    return
  checkOrigin()
  const guard = async () => {
    checkOrigin()
    const current = await readProject(project.root, project.marker.id)
    if (
      current.marker.currentIteration !== project.marker.currentIteration ||
      projectLifecycle(current).revision !== lifecycle.revision
    )
      throw new Error("Project lifecycle changed during cleanup. Review the current resources again.")
  }
  await guard()
  if (
    typeof api.conversations?.openOrCreate !== "function" ||
    typeof api.conversations.archive !== "function"
  )
    throw new Error("Safe cleanup requires owned tools and archive support; no fallback shell was started.")
  const shell: Shell = ctx.session.info().shell === "powershell" ? "powershell" : "bash"
  const accounting = await projectAccounting(api, project)
  const key = `${project.marker.id}/iteration/${iteration}/cleanup/${randomUUID()}`
  let handle: OwnedConversation | undefined
  try {
    await accounting.costs.intent(key, { iteration, stage: "ship", role: "cleanup-tools" }, "owned", {
      administrative: true,
    })
    await guard()
    handle = await publishOwnerOpening(
      project,
      key,
      () =>
        api.conversations!.openOrCreate(
          {
            key,
            name: `Iteration ${iteration} optional cleanup`,
            cwd: project.root,
            systemPrompt:
              "Inert deterministic cleanup tool owner. Never send model turns, create children or run unapproved commands.",
            callableTools: [shell],
            writeRoots: [],
          },
          {
            askUser: async () => {
              throw new Error("Deterministic cleanup never asks model questions")
            },
          },
        ),
      { administrative: true },
    )
    await accounting.costs.bind(key, handle.id)
    await accounting.refresh(key, handle)
    const cleanup = new ProjectCleanup(project, handle, shell, {
      signal: ctx.signal,
      assertUnused: async (scope) => {
        await guard()
        if (
          ctx.session.info().busy ||
          typeof ctx.session.subagents !== "function" ||
          typeof ctx.session.groups !== "function"
        )
          throw new Error(
            "Main-session resource use is active or unavailable; retain resources until it can be verified.",
          )
        if (
          ctx.session
            .subagents()
            .some((child) => ["queued", "working", "paused", "idle"].includes(child.status)) ||
          ctx.session.groups().some((group) => group.state !== "ended")
        )
          throw new Error(
            "Main-session children/groups may still use this resource. Stop and drain them before cleanup.",
          )
        if (scope.kind !== "branch") {
          for (const cwd of [ctx.cwd, ctx.session.info().cwd]) {
            const relative = path.relative(scope.path, await realpath(cwd))
            if (
              relative === "" ||
              (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
            )
              throw new Error(
                "Main conversation is a live user of the cleanup path. Change its working directory before cleanup.",
              )
          }
        }
        await assertNoPendingOwnerOpenings(
          project,
          async (ownerKey) => (await api.conversations!.read({ key: ownerKey }))?.archived === true,
        )
        const ledger = await new FileCostPersistence(project).read()
        const owners = new Map(
          [...(ledger?.owners ?? []), ...(await recoverOwnerInventory(api, project, ledger))].map((owner) => [
            owner.key,
            owner,
          ]),
        )
        for (const owner of owners.values()) {
          if (owner.key === key) continue
          const saved = await api.conversations!.read({ key: owner.key })
          if (
            (owner.id && (!saved || saved.id !== owner.id)) ||
            (!saved && owner.iteration !== scope.iteration) ||
            (saved && !saved.archived)
          )
            throw new Error(`Live or unavailable project owner blocks cleanup: ${owner.key}`)
        }
        await guard()
      },
    })
    const approve = async (
      subject: string,
      title: string,
      body: string,
    ): Promise<CleanupApproval | undefined> => {
      await guard()
      const externalUseDate = new Date().toISOString()
      const unused = await ctx.ui.confirm(
        localize(
          language,
          "Verify no other resource users",
          "确认没有其他资源使用者",
          "他の利用者がいないことを確認",
        ),
        `${body}\n\nThe host cannot enumerate other applications, extensions or foreign sessions. Have you verified that none use this exact resource or retain a working directory here? If unknown, cancel and retain it. This attestation is recorded separately from deletion approval.`,
        { signal: ctx.signal, sessionId: ctx.session.info().id },
      )
      await guard()
      if (!unused) return undefined
      const answer = await ctx.ui.confirm(title, body, {
        signal: ctx.signal,
        sessionId: ctx.session.info().id,
      })
      await guard()
      return answer
        ? {
            subject,
            sessionId: ctx.session.info().id,
            date: new Date().toISOString(),
            externalUse: { sessionId: ctx.session.info().id, date: externalUseDate, subject },
          }
        : undefined
    }
    const reader = new HistoricalIterationReader(project, iteration)
    const state = await reader.read()
    if (kind === "prototypes") {
      const ref = state.artifacts.findLast((entry) => entry.kind === "prototype-manifest")
      if (!ref) throw new Error("No recorded prototype code to clean up.")
      const manifest = await reader.readArtifact(ref)
      if (manifest.kind !== "prototype-manifest") throw new Error("Expected prototype manifest")
      for (const variant of manifest.variants) {
        const removal = await prototypeRemovalStatus(project, iteration, variant.directory)
        if (removal) {
          ctx.print(
            `${variant.id}: ${removal}${removal === "removed" ? " — already removed; retained receipt" : " — inspect/reconcile the existing receipt; removal was not replayed"}`,
          )
          continue
        }
        const preview = await cleanup.previewPrototype(iteration, ref, variant.id)
        const receipt = await approve(
          preview.subject,
          localize(language, "Delete prototype code", "删除原型代码", "試作コードを削除"),
          `${preview.directory}\n${preview.files.join("\n")}\n\nDelete only this disposable code? Keep manifests, selection/rationale, design and decisions. This is separate from worktree/branch cleanup.`,
        )
        ctx.print(`${variant.id}: ${await cleanup.removePrototype(preview, receipt)}`)
      }
    } else {
      let preview: GitCleanupPreview
      if (kind === "branch") {
        const saved = await new ProjectDocumentStore(project).read("cleanup.json")
        const row =
          object(saved) && Array.isArray(saved.removals)
            ? saved.removals.find(
                (entry: unknown) =>
                  object(entry) &&
                  object(entry.scope) &&
                  entry.scope.iteration === iteration &&
                  entry.scope.kind === "worktree" &&
                  entry.status === "removed",
              )
            : undefined
        if (!object(row) || !object(row.preview) || row.preview.kind !== "git")
          throw new Error(
            "Remove the exact recorded worktree first. Its preserved preview is required for separate branch cleanup.",
          )
        preview = row.preview as unknown as GitCleanupPreview
      } else {
        const worktreeRef = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
        if (!worktreeRef) throw new Error("No recorded iteration worktree to clean up.")
        const worktree = await reader.readArtifact(worktreeRef)
        const plan = (await new ShipStore(project).read()).plans.findLast(
          (entry) => entry.iteration === iteration,
        )
        if (
          worktree.kind !== "iteration-worktree" ||
          !plan?.candidate ||
          plan.status !== "shipped" ||
          !plan.commit ||
          !plan.integrated
        )
          throw new Error(
            "Verified ship preservation and recorded checkout identity are required; resources were retained.",
          )
        preview = await cleanup.previewGit({
          iteration,
          worktree,
          checkout: { ...plan.candidate.pin.source, head: plan.commit },
          preserved: {
            ref: `refs/heads/${plan.target.branch}`,
            head: plan.integrated,
            evidence: `Ship plan ${plan.id} revision ${plan.revision}: ${plan.outcome}`,
          },
        })
      }
      const subject = kind === "worktree" ? preview.subjects.worktree : preview.subjects.branch
      const receipt = await approve(
        subject,
        localize(
          language,
          kind === "worktree" ? "Remove worktree" : "Delete merged branch",
          kind === "worktree" ? "移除工作树" : "删除已合并分支",
          kind === "worktree" ? "作業ツリーを削除" : "マージ済みブランチを削除",
        ),
        `${kind}: ${kind === "worktree" ? preview.record.worktree.root : preview.record.worktree.branch}\nRepository: ${preview.record.worktree.repository}\nHEAD: ${preview.record.checkout.head}\nPreserved: ${preview.record.preserved.ref} @ ${preview.record.preserved.head}\nFiles: ${preview.files.join("\n")}\n\nOnly this ${kind} is approved. Retain history, design and decisions. No forced removal or fallback deletion.`,
      )
      ctx.print(
        `${kind}: ${kind === "worktree" ? await cleanup.removeWorktree(preview, receipt) : await cleanup.removeBranch(preview, receipt)}`,
      )
    }
  } finally {
    try {
      if (handle) {
        try {
          await handle.release()
        } finally {
          await api.conversations.archive({ id: handle.id })
          await accounting.refresh(key)
        }
      }
    } finally {
      if (
        lifecycle.status === "archived" ||
        lifecycle.iterations[project.marker.currentIteration]?.status === "closed"
      )
        await accounting.stopAndDrain("Optional cleanup settled")
    }
  }
}
