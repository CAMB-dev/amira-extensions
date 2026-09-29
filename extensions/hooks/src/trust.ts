import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isListed, norm } from "./config.ts"

/**
 * Which projects' hooks the user allowed, kept in `<home>/hooks-trust.json`. Trust goes to the
 * project's hooks as they were when the user said yes (a fingerprint), so changed hooks, e.g.
 * after a pull, are asked about again.
 */
export interface TrustFile {
  projects: Record<string, { hash: string; at: string }>
}

export function trustFile(home: string): string {
  return path.join(home, "hooks-trust.json")
}

function read(file: string): TrustFile {
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustFile> | null
    const projects = json?.projects
    return { projects: projects && typeof projects === "object" && !Array.isArray(projects) ? projects : {} }
  } catch {
    return { projects: {} }
  }
}

function write(file: string, data: TrustFile): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, file)
}

/**
 * "trusted" when the user said yes to exactly these hooks, or lists the project (or a parent)
 * under trustedProjects in the user settings; "changed" when they said yes to other hooks.
 */
export function trustState(
  home: string,
  cwd: string,
  hash: string,
  listed: readonly string[],
): "trusted" | "changed" | "unknown" {
  if (isListed(cwd, listed)) return "trusted"
  const entry = read(trustFile(home)).projects[norm(cwd)]
  if (!entry) return "unknown"
  return entry.hash === hash ? "trusted" : "changed"
}

/** Records that the user trusts these hooks of the project; throws when the file cannot be written. */
export function trust(home: string, cwd: string, hash: string): void {
  const file = trustFile(home)
  const data = read(file)
  data.projects[norm(cwd)] = { hash, at: new Date().toISOString() }
  write(file, data)
}

/** Forgets the project; false when it was not there. */
export function untrust(home: string, cwd: string): boolean {
  const file = trustFile(home)
  const data = read(file)
  const key = norm(cwd)
  if (!data.projects[key]) return false
  delete data.projects[key]
  write(file, data)
  return true
}
