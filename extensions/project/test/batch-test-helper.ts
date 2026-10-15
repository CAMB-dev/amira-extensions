import type { CommandContext } from "@amira/api"
import type { AcceptanceArtifact } from "../src/artifacts.ts"
import type { IterationState } from "../src/stage.ts"
import { runStageCommand } from "../src/stage-commands.ts"
import type { IterationStore, Project } from "../src/store.ts"
import { human } from "./iteration-binding-helper.ts"

export async function summarize(store: IterationStore, state: IterationState) {
  const saved = await store.saveArtifact(state.revision, {
    kind: "stage-summary",
    stage: state.stage,
    language: "en",
    summary: `Evidence for ${state.approvedContext?.batchId}`,
    outputs: [],
    suggestion: "Review only; do not execute",
  })
  return store.dispatch(saved.state.revision, {
    type: "prepare-summary",
    expectedRevision: saved.state.revision,
    artifact: saved.artifact,
  })
}

export function commandHarness(project: Project) {
  const output: string[] = []
  const dialogs: string[] = []
  const control = {
    pick: async (_title: string, options: string[]): Promise<string | undefined> => options[0],
    confirm: async (_title: string, _body?: string): Promise<boolean> => true,
  }
  const ctx = {
    signal: new AbortController().signal,
    session: { info: () => ({ id: "main" }) },
    ui: {
      select: (title: string, options: string[]) => control.pick(title, options),
      confirm: (title: string, body?: string) => {
        dialogs.push(`${title}\n${body}`)
        return control.confirm(title, body)
      },
    },
    print: (text: string) => output.push(text),
  } as unknown as CommandContext
  return {
    control,
    output,
    dialogs,
    run: (verb: "next" | "skip" = "next", args: string[] = []) =>
      runStageCommand(
        verb,
        args,
        project,
        ctx,
        "en",
        () => {},
        async () => {},
      ),
  }
}

export async function startReview(store: IterationStore, state: IterationState, base: AcceptanceArtifact) {
  const attempt = state.attempts.filter((entry) => entry.stage === "accept").length + 1
  const attemptId = `review-${attempt}`
  const verdict: AcceptanceArtifact = {
    ...base,
    attempt,
    attemptId,
    batchId: state.approvedContext!.batchId!,
    batchPlan: state.approvedContext!.batchPlan!,
    specHash: state.approvedContext!.spec!.hash,
    specRevision: state.approvedContext!.spec!.revision,
    items: [
      {
        itemId: state.approvedContext?.batchId === "B2" ? "S2" : "S1",
        status: "pass",
        evidence: ["Observed"],
        reason: "Works",
      },
    ],
  }
  state = await store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId,
    review: { attempt, codeHash: verdict.codeHash },
  })
  return { state, verdict }
}

export async function consume(
  store: IterationStore,
  state: IterationState,
  verdict: AcceptanceArtifact,
  ui = false,
) {
  const saved = await store.saveArtifact(state.revision, verdict)
  return store.dispatch(saved.state.revision, {
    type: "finish-work",
    expectedRevision: saved.state.revision,
    attemptId: verdict.attemptId,
    changes: [],
    artifact: saved.artifact,
    acceptance: {
      verdict: verdict.outcome,
      artifactId: saved.artifact.id,
      failingItemIds:
        verdict.outcome === "fail"
          ? verdict.items.filter((entry) => entry.status === "fail").map((entry) => entry.itemId)
          : [],
      ...(ui ? { manualTrialRequired: true } : {}),
    },
  })
}

export async function implement(store: IterationStore, state: IterationState, changes = ["diff:B2-fresh"]) {
  state = await store.dispatch(state.revision, {
    type: "start-work",
    expectedRevision: state.revision,
    attemptId: `implement-${state.revision}`,
  })
  state = await store.dispatch(state.revision, {
    type: "finish-work",
    expectedRevision: state.revision,
    attemptId: state.activeAttemptId!,
    changes,
  })
  return summarize(store, state)
}

export async function trial(
  store: IterationStore,
  state: IterationState,
  verdict: AcceptanceArtifact,
  status: "pending" | "tried" | "problem" | "deferred",
) {
  const saved = await store.saveArtifact(state.revision, {
    kind: "manual-trial",
    specHash: verdict.specHash,
    specRevision: verdict.specRevision,
    batchId: verdict.batchId,
    batchPlan: verdict.batchPlan,
    attemptId: verdict.attemptId,
    attempt: verdict.attempt,
    codeHash: verdict.codeHash,
    instructions: "Try this batch",
    observe: ["Expected UI"],
    status,
    ...(status === "pending" ? {} : { result: status }),
  })
  const receipt = { ...human(saved.state, saved.artifact.id, status), context: undefined }
  return store.dispatch(saved.state.revision, {
    type: "record-manual-trial",
    expectedRevision: saved.state.revision,
    artifact: saved.artifact,
    status,
    ...(status === "pending" ? {} : { receipt }),
  })
}
