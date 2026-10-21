import { randomUUID } from "node:crypto"
import type { OwnedConversation } from "@amira/api"
import { type Project, ProjectDocumentStore, projectLifecycle, readProject } from "./store.ts"

interface Opening {
  token: string
  key: string
  pid: number
}
interface Openings {
  schemaVersion: 1
  projectId: string
  pending: Opening[]
}
const document = "owner-openings.json"
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
function validate(value: unknown, project: Project): Openings {
  if (value === undefined) return { schemaVersion: 1, projectId: project.marker.id, pending: [] }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== project.marker.id ||
    !Array.isArray(value.pending)
  )
    throw new Error("Malformed project owner openings; lifecycle settlement is blocked")
  const tokens = new Set<string>()
  for (const row of value.pending) {
    if (
      !object(row) ||
      typeof row.token !== "string" ||
      !row.token ||
      tokens.has(row.token) ||
      typeof row.key !== "string" ||
      !row.key.trim() ||
      !Number.isSafeInteger(row.pid) ||
      Number(row.pid) < 1
    )
      throw new Error("Malformed pending project owner opening")
    tokens.add(row.token)
  }
  return value as unknown as Openings
}

/** A durable intent closes the foreign-process gap between the ledger key intent and
 * host identity publication. Do not hold a project claim over host opening or cost IO. */
export async function publishOwnerOpening(
  project: Project,
  key: string,
  open: () => Promise<OwnedConversation>,
  options: { administrative?: boolean } = {},
): Promise<OwnedConversation> {
  if (!key.trim()) throw new Error("Owner opening requires an intended key")
  const store = new ProjectDocumentStore(project)
  const row = { token: randomUUID(), key, pid: process.pid }
  await store.update(
    document,
    async (value) => {
      if (options.administrative) {
        const current = await readProject(project.root, project.marker.id)
        if (
          current.marker.currentIteration !== project.marker.currentIteration ||
          projectLifecycle(current).revision !== projectLifecycle(project).revision
        )
          throw new Error("Project changed before administrative owner opening")
      }
      const saved = validate(value, project)
      saved.pending.push(row)
      return saved
    },
    options,
  )
  let handle: OwnedConversation | undefined
  let failure: { error: unknown } | undefined
  try {
    handle = await open()
  } catch (error) {
    failure = { error }
  }
  // Removing a resolved opening is administrative bookkeeping, not a new launch.
  // A failed publication leaves a durable unknown user and blocks lifecycle completion.
  try {
    await store.update(
      document,
      (value) => {
        const saved = validate(value, project)
        saved.pending = saved.pending.filter((entry) => entry.token !== row.token)
        return saved
      },
      { administrative: true },
    )
  } catch (error) {
    await handle?.release()
    throw error
  }
  if (failure) throw failure.error
  return handle!
}

/** Explicit close/archive only. Unknown/live process owners fail closed; dead-process
 * intents retain their keys in the cost ledger for H3 recovery without stealing a writer. */
export async function assertNoPendingOwnerOpenings(
  project: Project,
  archived: (key: string) => Promise<boolean>,
): Promise<void> {
  const saved = validate(await new ProjectDocumentStore(project).read(document), project)
  for (const row of saved.pending) {
    if (!row.key.startsWith(`${project.marker.id}/`))
      throw new Error("Pending owner opening escapes its project")
    if (await archived(row.key)) continue
    try {
      process.kill(row.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue
      throw error
    }
    throw new Error(`Project owner opening is still in use or unverified: ${row.key} (process ${row.pid})`)
  }
}
