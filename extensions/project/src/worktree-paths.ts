import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

/** Marker IDs are opaque metadata, never path/ref fragments. Preserve normal generated
 * UUIDs; map legacy/unsafe IDs to one deterministic, case-safe, Windows-safe component. */
export function projectComponent(id: string): string {
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id)) return id
  return `id-${createHash("sha256").update(id).digest("hex")}`
}
export function worktreeParent(repository: string): string {
  return path.join(path.dirname(repository), ".amira-project-worktrees")
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  )
}
function location(repository: string, root: string): void {
  const parent = worktreeParent(repository)
  const relative = path.relative(parent, root)
  const parts = relative.split(path.sep)
  if (
    !path.isAbsolute(root) ||
    root !== path.resolve(root) ||
    !inside(parent, root) ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[0]!) ||
    !/^iteration-[1-9]\d*$/.test(parts[1]!) ||
    root === repository ||
    inside(repository, root)
  )
    throw new Error(
      "Worktree destination must be canonically contained beneath the designated external worktree parent",
    )
}

/** No directory creation here: creation stays on the owner's permission-checked shell.
 * Check every existing ancestor, including ones above the designated parent. Missing
 * descendants are safe only while those captured ancestors keep their identities. */
export async function pinWorktreeDestination(repository: string, root: string): Promise<() => Promise<void>> {
  location(repository, root)
  const walk = async () => {
    const found = new Map<string, string>()
    for (let directory = root; ; directory = path.dirname(directory)) {
      try {
        const entry = await lstat(directory)
        const resolved = await realpath(directory)
        const canonical = /^[A-Za-z]:$/.test(resolved) ? `${resolved}${path.sep}` : resolved
        if (!entry.isDirectory() || entry.isSymbolicLink() || path.relative(directory, canonical))
          throw new Error(`Redirected or non-canonical worktree destination ancestor: ${directory}`)
        found.set(directory, `${entry.dev}:${entry.ino}:${entry.birthtimeMs}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (path.dirname(directory) === directory) break
    }
    return found
  }
  const pins = await walk()
  return async () => {
    location(repository, root)
    const current = await walk()
    for (const [directory, identity] of pins) {
      if (current.get(directory) !== identity)
        throw new Error(`Worktree destination ancestor identity was replaced: ${directory}`)
    }
    for (const [directory, identity] of current) pins.set(directory, identity)
  }
}
