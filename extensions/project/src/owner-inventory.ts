import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import type { ExtensionAPI } from "@amira/api"
import type { CostAttribution, CostLedger } from "./cost.ts"
import { HistoricalIterationReader, type Project, ProjectStorageError } from "./store.ts"

export interface RecoveredOwner extends CostAttribution {
  key: string
  id?: string
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

/** H3 deliberately withholds snapshots during an interrupted archive. Do not treat
 * that documented fail-closed result as a missing identity or an arbitrary IO error. */
export const incompleteOwnedArchive = (error: unknown): boolean =>
  object(error) && error.message === "owned conversation archive is incomplete; retry archive"

/** Read extension-owned identity/evidence only, never host session files or provider storage. */
export async function recoverOwnerInventory(
  api: ExtensionAPI,
  project: Project,
  ledger?: CostLedger,
  options: { includePredecessors?: boolean } = {},
): Promise<RecoveredOwner[]> {
  const recovered = new Map<string, RecoveredOwner>()
  const add = (row: RecoveredOwner) => {
    const old = recovered.get(row.key)
    if (old?.id && row.id && old.id !== row.id) throw new Error("Conflicting saved project owner identities")
    recovered.set(row.key, { ...row, ...(old?.id ? { id: old.id } : {}) })
  }
  const candidates = {
    "design-conversations": new Set<string>(),
    "prototype-conversations": new Set<string>(),
  }
  // Establish selected-project filenames before touching extension-wide identity storage.
  // Historical readers validate the immutable journal without repair, locks or initialization.
  for (let iteration = 1; iteration <= project.marker.currentIteration; iteration++) {
    candidates["design-conversations"].add(`${project.marker.id}/design/${iteration}`)
    const reader = new HistoricalIterationReader(project, iteration)
    const state = await reader.read().catch((error: unknown) => {
      if (error instanceof ProjectStorageError && error.code === "missing") return undefined
      throw error
    })
    for (const ref of state?.artifacts ?? []) {
      if (ref.kind !== "prototype-manifest") continue
      const manifest = await reader.readArtifact(ref)
      if (manifest.kind !== "prototype-manifest") throw new Error("Expected prototype manifest")
      // Include every committed manifest, not just the latest disposable variant list.
      for (const variant of manifest.variants)
        candidates["prototype-conversations"].add(
          `${project.marker.id}/iteration/${iteration}/prototype/${variant.id}`,
        )
    }
    for (const attempt of state?.attempts ?? []) {
      if (!["implement", "accept"].includes(attempt.stage) || !attempt.context?.batchId) continue
      add({
        key: `${project.marker.id}/iteration/${iteration}/batch/${attempt.context.batchId}/${attempt.stage}/${attempt.id}`,
        iteration,
        stage: attempt.stage as "implement" | "accept",
        role: attempt.stage === "accept" ? "reviewer" : "coordinator",
        attempt: attempt.id,
        batch: attempt.context.batchId,
      })
    }
  }
  // A validated project ledger can retain variant identity after disposable evidence is gone.
  if (ledger) {
    if (ledger.projectId !== project.marker.id)
      throw new Error("Saved owner ledger belongs to another project")
    for (const owner of ledger.owners) {
      if (owner.stage !== "prototype" || owner.role !== "variant") continue
      const key = `${project.marker.id}/iteration/${owner.iteration}/prototype/${owner.variant}`
      if (
        !Number.isSafeInteger(owner.iteration) ||
        owner.iteration < 1 ||
        owner.iteration > project.marker.currentIteration ||
        typeof owner.variant !== "string" ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(owner.variant) ||
        owner.variant === "none" ||
        (owner.key !== key &&
          (!owner.key.startsWith(`${key}/policy/`) ||
            !/^[^/\\\\\0]+$/.test(owner.key.slice(`${key}/policy/`.length))))
      )
        throw new Error("Saved prototype ledger binding escapes its project/variant scope")
      candidates["prototype-conversations"].add(key)
    }
  }
  if (api.dataDir) {
    for (const directory of ["design-conversations", "prototype-conversations"] as const) {
      if (!candidates[directory].size) continue
      const root = path.join(api.dataDir, directory)
      try {
        if ((await lstat(root)).isSymbolicLink())
          throw new Error("Saved project identities must not be redirected")
      } catch (error) {
        if (missing(error)) continue
        throw error
      }
      for (const key of candidates[directory]) {
        const file = `${createHash("sha256").update(key).digest("hex")}.json`
        const target = path.join(root, file)
        try {
          if ((await lstat(target)).isSymbolicLink())
            throw new Error("Saved project identity must not be redirected")
        } catch (error) {
          if (missing(error)) continue
          throw error
        }
        const value: unknown = JSON.parse(await readFile(target, "utf8"))
        if (
          !object(value) ||
          value.root !== project.root ||
          value.key !== key ||
          typeof value.id !== "string" ||
          !value.id
        )
          throw new Error("Malformed saved project owner identity")
        const design = value.key.match(/^(.*)\/design\/([1-9][0-9]*)$/)
        const prototype = value.key.match(/^(.*)\/iteration\/([1-9][0-9]*)\/prototype\/([^/]+)$/)
        const match = directory === "design-conversations" ? design : prototype
        if (!match || match[1] !== project.marker.id) throw new Error("Invalid saved owner key")
        const iteration = Number(match[2])
        if (!Number.isSafeInteger(iteration) || iteration > project.marker.currentIteration)
          throw new Error("Invalid saved owner iteration")
        if (
          value.sessionKey !== undefined &&
          (directory !== "prototype-conversations" ||
            typeof value.sessionKey !== "string" ||
            (value.sessionKey !== value.key &&
              (!value.sessionKey.startsWith(`${value.key}/policy/`) ||
                !/^[^/\\\\\0]+$/.test(value.sessionKey.slice(`${value.key}/policy/`.length)))))
        )
          throw new Error("Saved prototype accounting key escapes its project/variant scope")
        const attribution: CostAttribution = {
          iteration,
          stage: design ? "design" : "prototype",
          role: design ? "conversation" : "variant",
          ...(prototype ? { variant: prototype[3] } : {}),
        }
        add({
          ...attribution,
          key: typeof value.sessionKey === "string" ? value.sessionKey : value.key,
          id: value.id,
        })
        if (value.previous !== undefined) {
          if (
            !object(value.previous) ||
            typeof value.previous.key !== "string" ||
            typeof value.previous.id !== "string" ||
            !value.previous.id ||
            value.previous.key !== value.key
          )
            throw new Error("Malformed prototype predecessor identity")
          if (options.includePredecessors !== false)
            add({ ...attribution, key: value.previous.key, id: value.previous.id })
        }
      }
    }
  }
  for (let iteration = 1; iteration <= project.marker.currentIteration; iteration++) {
    // Recovers a legacy design even if its extension-side ID publication crashed.
    if (typeof api.conversations?.read === "function") {
      const key = `${project.marker.id}/design/${iteration}`
      try {
        const saved = await api.conversations.read({ key })
        if (saved) add({ key, id: saved.id, iteration, stage: "design", role: "conversation" })
      } catch (error) {
        if (!incompleteOwnedArchive(error)) throw error
        // Keep the deterministic key so an explicitly approved H3 retry can settle
        // its archive before read() becomes available again.
        add({ key, iteration, stage: "design", role: "conversation" })
      }
    }
  }
  return [...recovered.values()]
}
