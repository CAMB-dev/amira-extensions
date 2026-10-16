import { expect, setDefaultTimeout, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { ConversationSpec } from "@amira/api"
import { IMPLEMENT_SPAWN } from "../src/implement.ts"
import { ESC, frontend, frontendSuite, waitFor } from "./frontend-harness.ts"
import { fixtureShell, git, specDraft } from "./implement-fixture.ts"

setDefaultTimeout(180_000)
frontendSuite("native implementation cancellation", () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    test(`${mode}: native Stop after the child finishes never starts checks or proposes acceptance`, async () => {
      const commands: string[] = []
      const f = await frontend(mode, undefined, [
        {
          ...fixtureShell,
          execute(args, ctx) {
            commands.push(String(args.command))
            return fixtureShell.execute(args, ctx)
          },
        },
      ])
      try {
        f.agent.permissions.setMode("auto")
        await git(f.cwd, "init")
        await git(f.cwd, 'config user.name "Cancellation Fixture"')
        await git(f.cwd, 'config user.email "cancel@invalid.local"')
        await git(f.cwd, "config commit.gpgsign false")
        await git(f.cwd, 'add -A && git commit -m "Cancellation fixture base"')
        f.mock.push({ text: JSON.stringify(specDraft()) })
        f.send("spec")
        await f.dialog("Review implementation spec")
        f.terminal.send("\r")
        await f.dismissed()
        f.mock.push(
          { toolCalls: [{ name: IMPLEMENT_SPAWN, args: {}, id: "spawn-for-cancel" }] },
          {
            toolCalls: [
              {
                name: "write",
                args: { path: "result.txt", content: "retain this change\n" },
                id: "write-before-stop",
              },
            ],
          },
          { text: "Implementation child finished successfully." },
          { text: "Coordinator summary waiting for native Stop. ".repeat(200), delayMs: 25 },
        )
        f.send("implement")
        await f.dialog("Use committed base", 30_000)
        f.terminal.send("\x1b[B\r")
        await waitFor(
          () => f.mock.requests.length === 5,
          "coordinator summarizing after completed child",
          60_000,
        )
        await f.idle()
        await f.visible("main idle")
        await f.visible("Coordinator summary")
        const files = await readdir(path.join(f.root, "owned-home"), { recursive: true })
        const saved = await Promise.all(
          files
            .filter((file) => file.endsWith(".spec.json"))
            .map(async (file) => ({
              file: path.join(f.root, "owned-home", file),
              spec: (
                JSON.parse(await readFile(path.join(f.root, "owned-home", file), "utf8")) as {
                  spec: ConversationSpec
                }
              ).spec,
            })),
        )
        const coordinator = saved.find((entry) => entry.spec.descendants === "inherit")!
        expect(await readFile(path.join(coordinator.spec.cwd, "result.txt"), "utf8")).toBe(
          "retain this change\n",
        )
        f.terminal.send(ESC)
        const transcript = coordinator.file.replace(/\.spec\.json$/, ".jsonl")
        for (let i = 0; i < 600; i++) {
          const state = await f.store.read()
          if (state.status === "interrupted" || state.pending?.to === "accept") break
          await Bun.sleep(25)
        }
        expect(await readFile(transcript, "utf8")).toMatch(/"stopReason"\s*:\s*"aborted"/)
        const state = await f.store.read()
        expect(commands.filter((command) => command.endsWith("git --version"))).toEqual([])
        expect(state.status).toBe("interrupted")
        expect(state.pending).toBeUndefined()
        expect(state.attempts.at(-1)?.status).toBe("interrupted")
        expect(await readFile(path.join(coordinator.spec.cwd, "result.txt"), "utf8")).toBe(
          "retain this change\n",
        )
      } finally {
        await f.cleanup()
      }
    })

    test(`${mode}: native Stop during a check is terminal for checks and finalization`, async () => {
      let checking = false
      const commands: string[] = []
      const f = await frontend(mode, undefined, [
        {
          ...fixtureShell,
          async execute(args, ctx) {
            const command = String(args.command)
            commands.push(command)
            if (!command.endsWith("git --version")) return fixtureShell.execute(args, ctx)
            checking = true
            await new Promise<void>((resolve) => {
              if (ctx.signal.aborted) resolve()
              else ctx.signal.addEventListener("abort", () => resolve(), { once: true })
            })
            return {
              content: [{ type: "text", text: "Check cancelled" }],
              isError: true,
              details: { exitCode: null, aborted: true },
            }
          },
        },
      ])
      try {
        f.agent.permissions.setMode("auto")
        await git(f.cwd, "init")
        await git(f.cwd, 'config user.name "Cancellation Fixture"')
        await git(f.cwd, 'config user.email "cancel@invalid.local"')
        await git(f.cwd, "config commit.gpgsign false")
        await git(f.cwd, 'add -A && git commit -m "Check cancellation fixture"')
        const draft = specDraft()
        draft.spec.checks.push({ id: "C2", command: "git --version --build-options", cwd: "." })
        draft.spec.items[0]!.checkIds.push("C2")
        f.mock.push({ text: JSON.stringify(draft) })
        f.send("spec")
        await f.dialog("Review implementation spec")
        f.terminal.send("\r")
        await f.dismissed()
        f.mock.push(
          { toolCalls: [{ name: IMPLEMENT_SPAWN, args: {}, id: "spawn-check-cancel" }] },
          { text: "Implementation child finished." },
          { text: "Coordinator finished." },
        )
        f.send("implement")
        await f.dialog("Use committed base", 30_000)
        f.terminal.send("\x1b[B\r")
        await waitFor(() => checking, "first exact check running", 60_000)
        await f.idle()
        await f.visible("main idle")
        f.terminal.send(ESC)
        for (let i = 0; i < 600; i++) {
          const state = await f.store.read()
          if (state.status === "interrupted" || state.pending?.to === "accept") break
          await Bun.sleep(25)
        }
        const state = await f.store.read()
        expect(state.status).toBe("interrupted")
        expect(state.pending).toBeUndefined()
        expect(commands.some((command) => command.endsWith("git --version --build-options"))).toBe(false)
        const ref = state.artifacts.findLast((entry) => entry.kind === "batch-result")!
        const result = await f.store.readArtifact(ref)
        expect(
          result.kind === "batch-result" && result.checks.some((check) => check.status === "passed"),
        ).toBe(false)
      } finally {
        await f.cleanup()
      }
    })
  }
})
