import type { BatchPlanArtifact, SpecArtifact, SpecCheck, SpecItem } from "./artifacts.ts"
import type { ArtifactRef } from "./stage.ts"

export interface SavedSpec {
  spec: SpecArtifact
  ref: ArtifactRef
}
export function requiredChecks(spec: SpecArtifact, itemIds = spec.items.map((item) => item.id)): SpecCheck[] {
  const all = new Set(spec.items.flatMap((item) => item.checkIds))
  if (spec.checks.some((check) => !all.has(check.id)))
    throw new Error("Every exact check must be referenced by a spec item; orphan checks are not permitted")
  const selected = new Set(
    spec.items.filter((item) => itemIds.includes(item.id)).flatMap((item) => item.checkIds),
  )
  return spec.checks.filter((check) => selected.has(check.id))
}
function fingerprint(item: SpecItem): string {
  const texts = (values: string[]) => values.map((value) => value.trim().replace(/\s+/g, " ")).sort()
  return JSON.stringify({
    description: item.description.trim().replace(/\s+/g, " "),
    constraints: texts(item.constraints),
    verification: texts(item.verification),
    acceptanceCriteria: texts(item.acceptanceCriteria),
    decisionIds: [...item.decisionIds].sort(),
    checkIds: [...item.checkIds].sort(),
    ui: item.ui,
  })
}
function allocator(history: SavedSpec[]): () => string {
  const used = new Set(history.flatMap(({ spec }) => spec.items.map((item) => item.id)))
  let next = Math.max(0, ...[...used].map((id) => (/^S[1-9]\d*$/.test(id) ? Number(id.slice(1)) : 0))) + 1
  return () => {
    if (!Number.isSafeInteger(next)) throw new Error("Spec item identity allocator exhausted")
    const id = `S${next++}`
    used.add(id)
    return id
  }
}
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id))

/** Storage independently checks identity continuity; old artifacts need not be rewritten.
 * A legacy revision without lineage may only edit the same existing ID set. */
export function validateSpecIdentity(spec: SpecArtifact, history: SavedSpec[]): void {
  const previous = history.at(-1)
  const old = previous?.spec.items ?? []
  for (const item of spec.items) {
    const matches = old.filter((prior) => fingerprint(prior) === fingerprint(item))
    if (matches.length && !matches.some((prior) => prior.id === item.id))
      throw new Error("Stable spec item identity was renamed or reassigned")
  }
  const lineage = spec.lineage
  if (!lineage) {
    if (
      previous &&
      !sameSet(
        old.map((item) => item.id),
        spec.items.map((item) => item.id),
      )
    )
      throw new Error("Spec identity changes require explicit predecessor/addition/retirement lineage")
    return
  }
  const expected = previous
    ? { artifactId: previous.ref.id, revision: previous.spec.revision, hash: previous.ref.hash }
    : null
  if (
    JSON.stringify(
      lineage.previousSpec && {
        artifactId: lineage.previousSpec.artifactId,
        revision: lineage.previousSpec.revision,
        hash: lineage.previousSpec.hash,
      },
    ) !== JSON.stringify(expected)
  )
    throw new Error("Spec lineage must bind the exact preceding revision and hash")
  if (
    !sameSet(
      lineage.items.map((item) => item.id),
      spec.items.map((item) => item.id),
    )
  )
    throw new Error("Spec lineage must cover each item identity exactly once")
  const allocate = allocator(history)
  const retired = old
    .filter((item) => !spec.items.some((current) => current.id === item.id))
    .map((item) => item.id)
  if (!sameSet(lineage.retiredItemIds, retired))
    throw new Error("Spec retirement lineage must identify every removed item")
  for (const item of spec.items) {
    const origin = lineage.items.find((entry) => entry.id === item.id)!
    if (origin.previousId === null) {
      if (
        history.some((entry) => entry.spec.items.some((prior) => prior.id === item.id)) ||
        item.id !== allocate()
      )
        throw new Error(
          "New spec item IDs must be freshly allocated by the extension; historical IDs cannot be recycled",
        )
    } else if (origin.previousId !== item.id || !old.some((prior) => prior.id === item.id))
      throw new Error("An edited spec item must retain its existing predecessor identity")
  }
}

/** The model chooses draft labels and explicit origins, never persisted item IDs. */
export function bindSpecIdentity(
  draft: SpecArtifact,
  origins: (string | null | undefined)[],
  batches: BatchPlanArtifact["batches"],
  retiredItemIds: string[],
  history: SavedSpec[],
): { spec: SpecArtifact; batches: BatchPlanArtifact["batches"] } {
  const previous = history.at(-1)
  const old = previous?.spec.items ?? []
  const allocate = allocator(history)
  const labels = new Map<string, string>()
  const lineageItems: NonNullable<SpecArtifact["lineage"]>["items"] = []
  const items = draft.items.map((item, index) => {
    const origin = origins[index]
    if (origin !== undefined && origin !== null && typeof origin !== "string")
      throw new Error("Invalid item predecessor identity")
    let id: string
    let previousId: string | null
    if (!previous) {
      if (origin != null) throw new Error("Initial spec items have no predecessor")
      id = allocate()
      previousId = null
    } else if (origin === null) {
      if (old.some((prior) => fingerprint(prior) === fingerprint(item)))
        throw new Error(
          "An unchanged existing requirement is not an addition; retain its predecessor identity",
        )
      id = allocate()
      previousId = null
    } else {
      previousId = origin ?? item.id
      if (!old.some((prior) => prior.id === previousId))
        throw new Error(
          "Revised requirements must reference an existing predecessor ID; use previousItemId:null only for additions",
        )
      id = previousId
      if (
        origin === undefined &&
        old.some((prior) => prior.id !== id && fingerprint(prior) === fingerprint(item)) &&
        !old.some((prior) => prior.id === id && fingerprint(prior) === fingerprint(item))
      )
        throw new Error("Stable spec item identity was reassigned")
    }
    labels.set(item.id, id)
    lineageItems.push({ id, previousId })
    return { ...item, id }
  })
  const spec: SpecArtifact = {
    ...draft,
    items,
    lineage: {
      previousSpec: previous
        ? { artifactId: previous.ref.id, revision: previous.spec.revision, hash: previous.ref.hash }
        : null,
      items: lineageItems,
      retiredItemIds,
    },
  }
  validateSpecIdentity(spec, history)
  return {
    spec,
    batches: batches.map((batch) => ({
      ...batch,
      itemIds: batch.itemIds.map((label) => {
        const id = labels.get(label)
        if (!id) throw new Error("Batch references an unknown draft item label")
        return id
      }),
    })),
  }
}
