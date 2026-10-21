import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OwnedConversation } from "@amira/api"
import { checked, inDirectory, quote, type Shell } from "./iteration-git.ts"
import { type ShipPlan, ShipPreflightError } from "./ship.ts"

function ref(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  )
    throw new Error("Unsafe ship branch/ref")
  return value
}
export function hostingRepository(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error("Choose an explicit owner/repository for gh")
  return value
}
export function pushCommand(plan: ShipPlan, shell: Shell): string {
  const remote = plan.remote
  const commit = plan.preference.strategy === "pr" ? plan.commit : plan.integrated
  if (!remote || !commit || !/^[a-f0-9]{40,64}$/.test(commit))
    throw new Error("Push requires an exact checked commit and remote")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote.name)) throw new Error("Unsafe remote name")
  return `git push -- ${quote(remote.url, shell)} ${quote(`${commit}:refs/heads/${ref(remote.branch)}`, shell)}`
}
export function createPrCommand(plan: ShipPlan, shell: Shell, bodyFile?: string): string {
  if (!plan.pr || !plan.remote || plan.remote.branch !== plan.source.branch)
    throw new Error("PR source branch must match the separately published branch")
  const pr = plan.pr
  if (pr.base !== plan.target.branch) throw new Error("PR base differs from the approved target")
  return `gh pr create --repo ${quote(hostingRepository(pr.repository), shell)} --base ${quote(ref(pr.base), shell)} --head ${quote(ref(plan.source.branch), shell)} --title ${quote(pr.title, shell)} ${bodyFile ? `--body-file ${quote(bodyFile, shell)}` : `--body ${quote(pr.body, shell)}`}`
}
interface PrObservation {
  url: string
  state: "OPEN" | "CLOSED" | "MERGED"
  headRefOid: string
  baseRefName: string
  mergeCommit: { oid: string } | null
}
export function parsePrObservations(text: string): PrObservation[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value)) throw new Error("Unavailable gh PR evidence")
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.url !== "string" ||
      !/^https:\/\//.test(row.url) ||
      !["OPEN", "CLOSED", "MERGED"].includes(row.state) ||
      !/^[a-f0-9]{40,64}$/.test(row.headRefOid) ||
      typeof row.baseRefName !== "string" ||
      (row.mergeCommit !== null && (!row.mergeCommit || !/^[a-f0-9]{40,64}$/.test(row.mergeCommit.oid)))
    )
      throw new Error("Malformed gh PR evidence; no success was inferred")
  }
  return value as PrObservation[]
}
/** Hosting adapter is structural/local. No gh SDK, provider import or model tool authority. */
export class ShipHosting {
  constructor(
    private readonly handle: OwnedConversation,
    private readonly shell: Shell,
    private readonly signal: AbortSignal,
  ) {}
  async verifyRemote(plan: ShipPlan): Promise<void> {
    if (!plan.remote) throw new Error("No outward operation selected")
    const actual = await checked(
      this.handle,
      this.shell,
      plan.source.root,
      `git remote get-url --push --all ${quote(plan.remote.name, this.shell)}`,
      this.signal,
    )
    if (actual !== plan.remote.url)
      throw new Error("Remote URL changed after approval; no external effect was started")
  }
  /** The fence is crossed immediately before the mutation is handed to runTool.
   * Even an error shaped like a preflight failure after that point is ambiguous. */
  private async outward(
    operation: "push" | "pr",
    run: (dispatch: () => void) => Promise<string>,
  ): Promise<string> {
    let dispatched = false
    try {
      return await run(() => {
        this.signal.throwIfAborted()
        dispatched = true
      })
    } catch (error) {
      if (!dispatched) throw new ShipPreflightError(operation, error)
      throw new Error(`${operation} was dispatched; outcome requires reconciliation: ${String(error)}`, {
        cause: error,
      })
    }
  }
  async push(plan: ShipPlan): Promise<string> {
    return this.outward("push", async (dispatch) => {
      await this.verifyRemote(plan)
      const cwd = plan.source.root
      const command = pushCommand(plan, this.shell)
      inDirectory(cwd, command, this.shell) // Validate shell construction before dispatch too.
      dispatch()
      await checked(this.handle, this.shell, cwd, command, this.signal)
      const observed = await this.pushed(plan)
      if (!observed)
        throw new Error(
          "Push returned but the exact remote ref is unavailable or moved; reconcile before any retry",
        )
      return observed
    })
  }
  async create(plan: ShipPlan): Promise<string> {
    return this.outward("pr", async (dispatch) => {
      await this.verifyRemote(plan)
      if ((await this.pushed(plan)) !== plan.commit)
        throw new Error("Published source branch moved or is unavailable; no PR was started")
      const scratch = await mkdtemp(path.join(tmpdir(), "amira-ship-pr-"))
      try {
        const bodyFile = path.join(scratch, "body.md")
        await writeFile(bodyFile, plan.pr?.body ?? "")
        const cwd = plan.source.root
        const command = createPrCommand(plan, this.shell, bodyFile)
        inDirectory(cwd, command, this.shell)
        dispatch()
        const url = await checked(this.handle, this.shell, cwd, command, this.signal)
        if (!/^https:\/\/\S+$/.test(url))
          throw new Error("PR create returned no unambiguous URL; reconcile before any retry")
        const observation = await this.observe({ ...plan, pr: plan.pr ? { ...plan.pr, url } : undefined })
        if (!observation)
          throw new Error(
            "PR was requested but exact repository/base/head evidence is unavailable; reconcile before any retry",
          )
        return url
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })
  }
  async pushed(plan: ShipPlan): Promise<string | undefined> {
    await this.verifyRemote(plan)
    const remote = plan.remote!
    const expected = plan.preference.strategy === "pr" ? plan.commit : plan.integrated
    const text = await checked(
      this.handle,
      this.shell,
      plan.source.root,
      `git ls-remote --heads -- ${quote(remote.url, this.shell)} ${quote(`refs/heads/${ref(remote.branch)}`, this.shell)}`,
      this.signal,
    )
    return text.trim() === `${expected}\trefs/heads/${remote.branch}` ? expected : undefined
  }
  async observe(plan: ShipPlan): Promise<PrObservation | undefined> {
    if (!plan.pr || !plan.commit) return undefined
    const text = await checked(
      this.handle,
      this.shell,
      plan.source.root,
      `gh pr list --repo ${quote(hostingRepository(plan.pr.repository), this.shell)} --base ${quote(ref(plan.pr.base), this.shell)} --head ${quote(ref(plan.source.branch), this.shell)} --state all --json url,state,headRefOid,baseRefName,mergeCommit`,
      this.signal,
    )
    const rows = parsePrObservations(text).filter(
      (row) =>
        row.headRefOid === plan.commit &&
        row.baseRefName === plan.pr!.base &&
        (!plan.pr!.url || row.url === plan.pr!.url),
    )
    if (rows.length > 1) throw new Error("Ambiguous PR identity; reconcile manually")
    return rows[0]
  }
}

// D135 extension point: a future explicitly selected release adapter must receive
// immutable checked commit inputs and its own per-operation approval/receipt.
// No tag, release, package publishing, repository creation or deployment in v1.
