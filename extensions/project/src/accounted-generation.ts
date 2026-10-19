import { randomUUID } from "node:crypto"
import type { CommandContext, CompleteRequest, CompleteResult, ExtensionAPI } from "@amira/api"
import { type OwnerAttribution, openAccounted } from "./accounting.ts"
import type { Project } from "./store.ts"

/** One text-only request, attributed before acquisition, including failures and invalid output. */
export async function accountedGeneration(
  api: ExtensionAPI,
  project: Project,
  ctx: CommandContext,
  attribution: OwnerAttribution,
  request: Omit<CompleteRequest, "model">,
): Promise<CompleteResult> {
  const signal = request.signal ? AbortSignal.any([ctx.signal, request.signal]) : ctx.signal
  signal.throwIfAborted()
  const handle = await openAccounted(
    api,
    project,
    attribution,
    {
      key: `${project.marker.id}/iteration/${project.marker.currentIteration}/generation/${attribution.role}/${randomUUID()}`,
      name: request.label ?? `Project ${attribution.role}`,
      cwd: project.root,
      callableTools: [],
      writeRoots: [],
      systemPrompt: "Text-only project generation. No tools, inherited transcript or execution.",
    },
    {
      askUser: async () => {
        throw new Error("Text-only project generation cannot ask questions")
      },
    },
  )
  try {
    signal.throwIfAborted()
    if (typeof handle.complete !== "function")
      throw new Error("Project generation requires owner-bound complete; no unowned fallback was started")
    return await handle.complete({ ...request, signal })
  } finally {
    // Host release drains failed, cancelled and late-receipt work before returning.
    await handle.release()
  }
}
