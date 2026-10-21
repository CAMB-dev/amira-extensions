import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import { checked, quote, type Shell } from "./iteration-git.ts"
import type { ShipGitPin } from "./ship-git.ts"

/** Shared by explicit path selection and the complete incoming-delta gate. */
export function shipPathAllowed(name: string): boolean {
  return (
    !!name &&
    !/[\\\0\r\n:]/.test(name) &&
    !path.isAbsolute(name) &&
    !name
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || /[ .]$/.test(part) || /^\.git(?:~\d+)?$/i.test(part),
      ) &&
    !/(^|\/)(\.env[^/]*|id_rsa|id_ed25519|credentials[^/]*|prototypes)(\/|$)/i.test(name) &&
    !/(^|\/)\.amira\/project(\/|$)/i.test(name)
  )
}
function oid(value: string): string {
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("Invalid Git object ID")
  return value
}

/** Lists the complete incoming tree delta against the pinned integration target's merge-base. */
export async function incomingShipDelta(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  tree: string,
  signal?: AbortSignal,
): Promise<{ base: string; paths: string[] }> {
  oid(tree)
  const base = oid(
    await checked(
      handle,
      shell,
      pin.source.root,
      `git merge-base ${quote(oid(pin.source.head), shell)} ${quote(oid(pin.target.head), shell)}`,
      signal,
    ),
  )
  const scratch = await mkdtemp(path.join(tmpdir(), "amira-ship-delta-"))
  try {
    const file = path.join(scratch, "paths")
    // Git writes bytes directly: neither tool-output trimming/truncation nor PowerShell's
    // native-output decoding/redirection can corrupt the NUL-delimited path listing.
    await checked(
      handle,
      shell,
      pin.source.root,
      `git --no-pager diff --no-ext-diff --no-textconv --no-renames --name-only -z --output=${quote(file, shell)} ${quote(base, shell)} ${quote(tree, shell)} --`,
      signal,
    )
    const decodePaths = (bytes: Uint8Array) => {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      if (text && !text.endsWith("\0")) throw new Error("Incomplete incoming ship delta listing")
      const paths = text ? text.slice(0, -1).split("\0") : []
      if (paths.some((name) => !name)) throw new Error("Invalid incoming ship delta listing")
      return paths
    }
    const paths = decodePaths(await readFile(file))
    // A normal push/merge also delivers source-only history. An add-and-delete or
    // reverted secret/prototype must not disappear from review merely because its
    // final net tree matches the target. Capture OIDs separately from path bytes.
    const commits = path.join(scratch, "commits")
    await writeFile(commits, "")
    await checked(
      handle,
      shell,
      pin.source.root,
      `git --no-pager log --format=%H --no-patch --output=${quote(commits, shell)} ${quote(pin.source.head, shell)} --not ${quote(pin.target.head, shell)} --`,
      signal,
    )
    for (const commit of (await readFile(commits, "utf8")).split(/\r?\n/).filter(Boolean)) {
      oid(commit)
      await checked(
        handle,
        shell,
        pin.source.root,
        `git --no-pager diff-tree -m --root --no-commit-id --no-renames --name-only -r -z --output=${quote(file, shell)} ${quote(commit, shell)} --`,
        signal,
      )
      paths.push(...decodePaths(await readFile(file)))
    }
    return { base, paths: [...new Set(paths)].sort() }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Requires explicit review of every allowed incoming path, including precommitted deletions. */
export async function reviewShipDelta(
  handle: OwnedConversation,
  shell: Shell,
  pin: ShipGitPin,
  tree: string,
  reviewedPaths: string[],
  signal?: AbortSignal,
): Promise<{ base: string; paths: string[] }> {
  const incoming = await incomingShipDelta(handle, shell, pin, tree, signal)
  const forbidden = incoming.paths.filter((name) => !shipPathAllowed(name))
  if (forbidden.length)
    throw new Error(
      `Forbidden incoming ship paths:\n${forbidden.map((name) => JSON.stringify(name)).join("\n")}`,
    )
  const reviewed = new Set(reviewedPaths)
  const unreviewed = incoming.paths.filter((name) => !reviewed.has(name))
  if (unreviewed.length)
    throw new Error(
      `Unreviewed incoming ship paths:\n${unreviewed.map((name) => JSON.stringify(name)).join("\n")}`,
    )
  return incoming
}
