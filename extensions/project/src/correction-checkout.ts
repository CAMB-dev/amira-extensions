import { randomUUID } from "node:crypto"
import type { CommandContext, ExtensionAPI } from "@amira/api"
import type { CorrectionInputs } from "./correction.ts"
import { inDirectory, type Shell, shellCall, verifyWorktree } from "./iteration-git.ts"
import { IterationStore, type Project } from "./store.ts"

/** Interrupted attempts may not have a batch-result yet. Capture the retained
 * checkout's complete changed-file set via policy tools, conservatively attributing
 * it to affected requirements rather than guessing which partial edit belongs where. */
export async function collectCorrectionChanges(
  api: ExtensionAPI,
  project: Project,
  ctx: CommandContext,
  context: CorrectionInputs,
  checkOrigin: () => void,
): Promise<void> {
  if (!context.worktree) return
  if (!api.conversations)
    throw new Error("Correction file mapping requires owned runTool on Amira API 0.1.53.")
  const store = new IterationStore(project)
  const state = await store.read()
  const ref = state.artifacts.findLast((entry) => entry.kind === "iteration-worktree")
  const worktree = ref && (await store.readArtifact(ref))
  if (worktree?.kind !== "iteration-worktree" || worktree.status !== "ready")
    throw new Error("Correction requires the retained ready worktree; no shared-checkout fallback.")
  const shell: Shell = ctx.session.info().shell === "powershell" ? "powershell" : "bash"
  const handle = await api.conversations.openOrCreate(
    {
      key: `${project.marker.id}/iteration/${state.iteration}/correction-files/${randomUUID()}`,
      name: "Correction changed-file evidence",
      cwd: worktree.cwd,
      callableTools: [shell],
      writeRoots: [],
      systemPrompt: "Inert correction file-list probe. No model turn, edits, reset, commit or branch change.",
    },
    { askUser: (questions, request) => ctx.ui.ask(questions, request) },
  )
  try {
    checkOrigin()
    await verifyWorktree(handle, shell, worktree, ctx.signal)
    const files: string[] = []
    for (const command of [
      "git diff --name-only -z HEAD --",
      "git ls-files -z --others --exclude-standard",
    ]) {
      checkOrigin()
      const result = await shellCall(handle, shell, inDirectory(worktree.root, command, shell), ctx.signal)
      if (!result.ok) throw new Error(`Correction file mapping blocked: ${result.output}`)
      if (result.output && !result.output.endsWith("\0"))
        throw new Error(
          "Correction file mapping received an incomplete Git file list; no partial mapping was recorded.",
        )
      files.push(...result.output.split("\0").filter(Boolean))
    }
    checkOrigin()
    context.implemented.push({
      itemIds: context.affectedSpecItemIds,
      changedFiles: [...new Set(files)],
      pointer: worktree.root,
    })
    context.changes = [...new Set([...context.changes, worktree.root])]
  } finally {
    await handle.release()
  }
}
