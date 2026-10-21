import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import { checked, quote, type Shell } from "./iteration-git.ts"
import {
  assertShipCheckout,
  probeShipCheckout,
  probeShipCommit,
  runShipCheck,
  type ShipCandidate,
  type ShipCheckout,
  shipCheckoutInputs,
  verifyShipDeliveryCheckout,
  withShipIndex,
} from "./ship-git.ts"

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return (
    !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

/** Delivered receipts bind a clean, supported, immutable commit/tree both before
 * and after each check. A process exit code alone is not content evidence. */
export async function runDeliveredCheck(
  handle: OwnedConversation,
  shell: Shell,
  checkout: ShipCheckout,
  tree: string,
  relativeCwd: string,
  command: string,
  signal?: AbortSignal,
) {
  let result: Awaited<ReturnType<typeof runShipCheck>> | undefined
  try {
    await verifyShipDeliveryCheckout(handle, shell, checkout, signal)
    if ((await probeShipCommit(handle, shell, checkout.root, checkout.head, signal)).tree !== tree)
      throw new Error("Delivered check tree differs from the approved integration")
    const before = await shipCheckoutInputs(handle, shell, checkout, signal)
    result = await runShipCheck(handle, shell, checkout, relativeCwd, command, signal)
    await verifyShipDeliveryCheckout(handle, shell, checkout, signal)
    const after = await shipCheckoutInputs(handle, shell, checkout, signal)
    if (before.contentFingerprint !== after.contentFingerprint)
      throw new Error("Delivered check inputs changed")
    return { ...result, tree, checkoutRoot: checkout.root }
  } catch (error) {
    return {
      cwd: path.resolve(checkout.root, relativeCwd),
      command,
      tree,
      checkoutRoot: checkout.root,
      ok: false,
      output: [result?.output, String(error)].filter(Boolean).join("\n"),
      exitCode: result?.exitCode ?? null,
      aborted: result?.aborted || signal?.aborted === true,
      timedOut: result?.timedOut ?? false,
    }
  }
}

/** Checks see only the candidate, not the dirty iteration checkout. No temporary
 * commit/identity/signing configuration is invented. A detached worktree starts at
 * the pinned source HEAD; its OWN index/files are populated with the reviewed tree.
 * Normal read-tree two-way cleanup refuses changed inputs; worktree remove never
 * forces deletion. Interrupted/dirty checkouts are retained for explicit repair. */
export async function runCandidateCheck(
  handle: OwnedConversation,
  shell: Shell,
  candidate: ShipCandidate,
  root: string,
  relativeCwd: string,
  command: string,
  signal?: AbortSignal,
  head = candidate.pin.source.head,
) {
  if (!path.isAbsolute(root) || path.relative(path.dirname(root), await realpath(path.dirname(root))))
    throw new Error("Candidate check parent is missing or redirected")
  for (const checkout of [candidate.pin.source, candidate.pin.target]) {
    if (inside(checkout.root, root) || inside(root, checkout.root))
      throw new Error("Candidate checks must be outside the user checkouts")
  }
  try {
    await lstat(root)
    throw new Error(
      `Candidate check checkout already exists; inspect it explicitly, no adoption or replay: ${root}`,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await assertShipCheckout(handle, shell, { ...candidate.pin.source, head }, signal)
  const repository = candidate.pin.source.root
  // Intent (the immutable root/tree) is already in the saved plan before this call.
  await checked(
    handle,
    shell,
    repository,
    `git worktree add --detach --no-checkout ${quote(root, shell)} ${quote(head, shell)}`,
    signal,
  )
  let checkout: ShipCheckout | undefined
  let baseline: string | undefined
  let result: Awaited<ReturnType<typeof runShipCheck>> | undefined
  let failure: unknown
  let cleanupFailure: unknown
  const verify = async (scope: ShipCheckout, expectedFingerprint?: string) => {
    await assertShipCheckout(handle, shell, scope)
    const index = path.join(scope.gitDir, "index")
    const tree = await checked(handle, shell, root, withShipIndex(shell, index, ["git write-tree"]))
    if (tree !== candidate.tree) throw new Error("Candidate check index/tree changed")
    await checked(
      handle,
      shell,
      root,
      withShipIndex(shell, index, ["git diff --quiet --no-ext-diff --no-textconv"]),
    )
    const extra = await checked(
      handle,
      shell,
      root,
      withShipIndex(shell, index, ["git ls-files --others --exclude-standard"]),
    )
    if (extra) throw new Error("Candidate check created unreviewed nonignored files")
    const current = await shipCheckoutInputs(handle, shell, scope)
    if (expectedFingerprint && current.contentFingerprint !== expectedFingerprint)
      throw new Error("Candidate check inputs changed; no candidate commit or delivery is authorized")
    return current.contentFingerprint
  }
  try {
    checkout = await probeShipCheckout(handle, shell, root, signal, true)
    if (
      checkout.branch !== "HEAD" ||
      checkout.head !== head ||
      checkout.common !== candidate.pin.source.common
    )
      throw new Error("Candidate check checkout identity differs from its pinned repository/HEAD")
    await checked(
      handle,
      shell,
      root,
      withShipIndex(shell, path.join(checkout.gitDir, "index"), [
        `git read-tree ${quote(candidate.tree, shell)}`,
        "git checkout-index --all",
      ]),
      signal,
    )
    baseline = await verify(checkout)
    result = await runShipCheck(
      handle,
      shell,
      checkout,
      relativeCwd,
      command,
      signal,
      path.join(checkout.gitDir, "index"),
    )
    await verify(checkout, baseline)
  } catch (error) {
    failure = error
  } finally {
    // Cleanup is an already approved deterministic step. Use the still-owned tool
    // handle without the aborted check signal, never a new handle or bypass mode.
    if (!checkout || !baseline) cleanupFailure = new Error("Candidate checkout setup did not settle")
    else
      try {
        await verify(checkout, baseline)
        await checked(
          handle,
          shell,
          root,
          withShipIndex(shell, path.join(checkout.gitDir, "index"), [
            `git read-tree -m -u ${quote(candidate.tree, shell)} ${quote(checkout.head, shell)}`,
          ]),
        )
        await assertShipCheckout(handle, shell, checkout)
        await checked(
          handle,
          shell,
          repository,
          withShipIndex(shell, path.join(checkout.gitDir, "index"), [
            `git worktree remove ${quote(root, shell)}`,
          ]),
        )
      } catch (error) {
        cleanupFailure = error
      }
  }
  if (failure || cleanupFailure) {
    const output = [
      result?.output,
      failure && String(failure),
      cleanupFailure && `Candidate checkout retained at ${root}: ${String(cleanupFailure)}`,
    ]
      .filter(Boolean)
      .join("\n")
    return {
      cwd: path.resolve(root, relativeCwd),
      command,
      tree: candidate.tree,
      checkoutRoot: root,
      ok: false,
      output,
      exitCode: result?.exitCode ?? null,
      aborted: result?.aborted || signal?.aborted === true,
      timedOut: result?.timedOut ?? false,
    }
  }
  if (!result) throw new Error("Candidate check returned no tool evidence")
  return { ...result, tree: candidate.tree, checkoutRoot: root }
}
