import type { OwnedConversation } from "@amira/api"
import { acceptanceCheckout, acceptanceCodeHash, verifyAcceptanceCheckout } from "../src/accept-integrity.ts"
import type { IterationStore, Project } from "../src/store.ts"
import { git, localShell } from "./implement-fixture.ts"

/** State-machine frontend fixtures still publish synthetic item observations, but
 * use a real local repository/fingerprint so production freshness is not bypassed. */
export async function frontendFingerprint(project: Project, store: IterationStore): Promise<string> {
  const probe = await localShell("git rev-parse --verify HEAD", project.root)
  if (probe.isError) {
    await git(project.root, "init")
    await git(project.root, 'config user.name "Offline Frontend Fixture"')
    await git(project.root, 'config user.email "frontend@invalid.local"')
    await git(project.root, "config commit.gpgsign false")
    await git(project.root, "add -A")
    await git(project.root, 'commit --allow-empty -m "Offline frontend baseline"')
  }
  const state = await store.read()
  const checkout = await acceptanceCheckout(project, state)
  const handle = {
    runTool: (_name: string, args: Record<string, unknown>) => localShell(String(args.command), checkout.cwd),
  } as unknown as OwnedConversation
  await verifyAcceptanceCheckout(handle, "bash", checkout)
  return acceptanceCodeHash(project, state, handle, "bash", checkout)
}
