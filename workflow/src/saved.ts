import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseMeta, type WorkflowMeta } from "./meta.ts"

/** A workflow saved as a file, run by its name. */
export interface SavedWorkflow {
  /** The file name without `.ts`. */
  name: string
  file: string
  /** "project" (`.amira/workflows`) or "user" (`~/.amira/workflows`). */
  scope: "project" | "user"
  meta?: WorkflowMeta
  /** Why its meta could not be read. */
  problem?: string
}

export function workflowDirs(cwd: string, home: string): { dir: string; scope: SavedWorkflow["scope"] }[] {
  return [
    { dir: path.join(cwd, ".amira", "workflows"), scope: "project" },
    { dir: path.join(home, "workflows"), scope: "user" },
  ]
}

/** Saved workflows, a project's first: a project file hides a user file of the same name. */
export function listSaved(cwd: string, home: string): SavedWorkflow[] {
  const byName = new Map<string, SavedWorkflow>()
  for (const { dir, scope } of workflowDirs(cwd, home)) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
        .filter((n) => n.endsWith(".ts") && !n.endsWith(".d.ts"))
        .sort()
    } catch {
      continue
    }
    for (const n of names) {
      const name = n.slice(0, -3)
      if (byName.has(name)) continue
      const file = path.join(dir, n)
      const saved: SavedWorkflow = { name, file, scope }
      try {
        saved.meta = parseMeta(readFileSync(file, "utf8"))
      } catch (err) {
        saved.problem = err instanceof Error ? err.message : String(err)
      }
      byName.set(name, saved)
    }
  }
  return [...byName.values()]
}

/** A saved workflow by file name, or by the name in its meta. */
export function findSaved(cwd: string, home: string, name: string): SavedWorkflow | undefined {
  const all = listSaved(cwd, home)
  return all.find((w) => w.name === name) ?? all.find((w) => w.meta?.name === name)
}
