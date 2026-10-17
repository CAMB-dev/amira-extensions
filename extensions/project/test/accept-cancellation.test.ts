import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { acceptanceFixture } from "./accept-fixture.ts"

setDefaultTimeout(180_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

test("native reviewer stop is terminal even when send resolves normally after recording observations", async () => {
  const f = await acceptanceFixture()
  homes.push(f.home)
  f.beforeReport(async () => {
    f.reviewHandles[0]!.status = () => ({ state: "stopped", busy: false })
  })
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  const state = await f.store.read()
  expect(state.status).toBe("interrupted")
  expect(state.attempts.at(-1)?.acceptance).toBeUndefined()
  expect(f.reviewCalls.some((call) => call.command.includes("git --version"))).toBe(false)
  expect(state.completion).toBeUndefined()
  await expect(f.acceptances.quiesce(f.project)).resolves.toBeUndefined()
})

test("aborting independent C1 records blocked evidence and cannot start C2 or publish a pass", async () => {
  const f = await acceptanceFixture({ extraCheck: true })
  homes.push(f.home)
  f.commandResult((command) =>
    command.includes("git --version")
      ? {
          content: [{ type: "text", text: "Fixture check stopped" }],
          isError: true,
          details: { aborted: true, exitCode: null },
        }
      : undefined,
  )
  await f.acceptances.run(f.project, f.ctx, "en", () => {}, "mock/reviewer")
  await f.acceptances.wait(f.project)
  expect(await f.verdict()).toMatchObject({
    outcome: "blocked",
    checks: [
      { checkId: "C1", status: "blocked" },
      { checkId: "C2", status: "blocked" },
    ],
  })
  expect(f.reviewCalls.some((call) => call.command.includes("git diff --quiet"))).toBe(false)
  expect((await f.store.read()).completion).toBeUndefined()
  await expect(f.acceptances.quiesce(f.project)).resolves.toBeUndefined()
})
