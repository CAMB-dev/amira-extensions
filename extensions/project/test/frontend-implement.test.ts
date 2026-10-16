import { expect, setDefaultTimeout, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { ConversationSpec } from "@amira/api"
import { IMPLEMENT_SPAWN } from "../src/implement.ts"
import { writeDocument } from "../src/store.ts"
import { ESC, F6, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"
import { fixtureShell, git, specDraft } from "./implement-fixture.ts"

setDefaultTimeout(180_000)
frontendSuite("frontend-spec-implementation", () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    test(`${mode}: rendered spec, real implementation, and inert next-menu cancellation run offline`, async () => {
      const f = await frontend(mode, undefined, [fixtureShell])
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        f.agent.permissions.setMode("auto")
        await git(f.cwd, "init")
        await git(f.cwd, 'config user.name "Frontend Fixture"')
        await git(f.cwd, 'config user.email "frontend@invalid.local"')
        await git(f.cwd, "config commit.gpgsign false")
        await git(f.cwd, "add -A")
        await git(f.cwd, 'commit -m "Frontend baseline"')
        await writeDocument(f.project, "design.md", "SECRET DESIGN TRANSCRIPT")
        f.mock.push({ text: JSON.stringify(specDraft()) })
        f.send("spec")
        await f.dialog("Review implementation spec", 30_000)
        expect(f.all()).toContain("## Spec items")
        expect(f.all()).toContain("S1")
        expect(f.all()).toContain("Approve spec and batch plan")
        expect(f.mock.requests[0]!.tools).toEqual([])
        expect(JSON.stringify(f.mock.requests[0]!.messages)).not.toContain("SECRET DESIGN TRANSCRIPT")
        f.terminal.send("\r")
        await f.dismissed()
        expect((await f.store.read()).approvedContext?.spec?.revision).toBe(1)
        f.mock.push(
          { toolCalls: [{ id: "spawn-implementation", name: IMPLEMENT_SPAWN, args: {} }] },
          {
            text: "Implementation child is running in its iteration worktree.",
            hold: { chunks: 1, until: held },
            toolCalls: [
              { id: "write-result", name: "write", args: { path: "result.txt", content: "ready\n" } },
            ],
          },
          { text: "Implementation child completed the approved local result." },
          { text: "Coordinator finished the single implementation child." },
        )
        f.send("implement")
        await f.dialog("Use committed base", 30_000)
        expect(f.all()).toContain("Committed base preview")
        f.terminal.send("\x1b[B\r")
        try {
          await waitFor(
            () => f.mock.requests.length === 3,
            "coordinator spawned actual implementation child",
            60_000,
          )
        } catch (error) {
          throw new Error(
            `${error}\nRequests: ${f.mock.requests.length}\n${f.live()}\n${JSON.stringify(await f.store.read())}`,
          )
        }
        await f.idle()
        await f.visible("main idle")
        expect((await f.store.read()).status).toBe("working")
        expect(f.live()).toContain("Implement B1")
        const savedFiles = (await readdir(path.join(f.root, "owned-home"), { recursive: true })).filter(
          (file) => file.endsWith(".spec.json"),
        )
        const specs = await Promise.all(
          savedFiles.map(
            async (file) =>
              (
                JSON.parse(await readFile(path.join(f.root, "owned-home", file), "utf8")) as {
                  spec: ConversationSpec
                }
              ).spec,
          ),
        )
        const coordinator = specs.find((spec) => spec.descendants === "inherit")!
        expect(coordinator).toBeDefined()
        expect(coordinator.cwd).not.toBe(f.cwd)
        expect(coordinator.key).toContain("/iteration/1/batch/B1/implement/")
        const seed = JSON.stringify(f.mock.requests[2]!.messages)
        expect(seed).toContain("S1")
        expect(seed).toContain("git --version")
        expect(seed).not.toContain("SECRET DESIGN TRANSCRIPT")
        expect(f.mock.requests[2]!.tools.map((tool) => tool.name)).not.toContain(IMPLEMENT_SPAWN)
        f.terminal.send(F6)
        await waitFor(
          () => !f.live().includes("main idle"),
          "F6 returns from implementation coordinator",
          20_000,
        )
        release()
        await waitFor(
          () => f.mock.requests.length === 5,
          "child and coordinator model turns completed",
          30_000,
        )
        await waitFor(() => !f.agent.busy, "main stays idle", 20_000)
        for (let i = 0; i < 1200; i++) {
          const current = await f.store.read()
          if (current.pending?.to === "accept" || current.status === "interrupted") break
          await Bun.sleep(25)
        }
        const state = await f.store.read()
        expect(state.pending?.to, `${JSON.stringify(state)}\n${f.live()}`).toBe("accept")
        const ref = state.artifacts.findLast((entry) => entry.kind === "batch-result")!
        const result = await f.store.readArtifact(ref)
        expect(result).toMatchObject({
          kind: "batch-result",
          implementerModels: ["mock/frontend"],
          checks: [
            { checkId: "C1", command: "git --version", status: "passed", exitCode: 0, cwd: coordinator.cwd },
          ],
        })
        expect(await readFile(path.join(coordinator.cwd, "result.txt"), "utf8")).toBe("ready\n")
        expect(await Bun.file(path.join(f.cwd, "result.txt")).exists()).toBe(false)
        await f.command("status", ["Spec: approved", "Worktree:", "Acceptance: coming next"])
        const beforeDismissal = await f.store.read()
        const modelCalls = f.mock.requests.length
        f.send("next")
        await f.dialog("Choose the next step")
        expect(f.live()).not.toContain("Generate implementation spec")
        f.terminal.send(ESC)
        await f.dismissed()
        expect(await f.store.read()).toEqual(beforeDismissal)
        expect(f.mock.requests).toHaveLength(modelCalls)
        expect(f.host.ui.pending).toEqual([])
      } finally {
        release()
        await f.cleanup()
      }
    })
  }
})
