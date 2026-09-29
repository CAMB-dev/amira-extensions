import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SpawnGroupOptions, SpawnOptions } from "@amira/api"
import { readJournal } from "../src/journal.ts"
import { BUILTIN_ROLES } from "../src/roles.ts"
import { WorkflowRun } from "../src/run.ts"
import { type Answer, fakeGroup } from "./fakes.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "wf-run-"))
  dirs.push(d)
  return d
}

interface Setup {
  source: string
  args?: unknown
  answer?: (o: SpawnOptions) => Answer | Promise<Answer>
  group?: Partial<SpawnGroupOptions>
  dir?: string
  previous?: ReturnType<typeof readJournal>
  saved?: Record<string, string>
  budgetTokens?: number
}

function start(s: Setup) {
  const group = fakeGroup({ name: "wf", ...s.group }, s.answer ?? ((o) => ({ text: `did: ${o.prompt}` })))
  const dir = s.dir ?? path.join(tmp(), "wf_test")
  const run = new WorkflowRun({
    id: "wf_test",
    dir,
    source: s.source,
    origin: "inline",
    args: s.args ?? null,
    group,
    cwd: "/work",
    home: "/home",
    ...(s.previous ? { previous: s.previous } : {}),
    ...(s.budgetTokens !== undefined ? { budgetTokens: s.budgetTokens } : {}),
    roles: () => new Map(BUILTIN_ROLES.map((r) => [r.name, r])),
    git: async () => ({ output: "", ok: false }),
    loadWorkflow: (name) => s.saved?.[name],
    onChange: () => {},
  })
  run.start()
  return { run, group, dir }
}

const META = `export const meta = { name: "t", description: "a test", phases: ["Explore", "Verify"] }\n`

test("a fan-out and verify script runs its agents and returns its value", async () => {
  const { run, group } = await start({
    source: `${META}
      phase("Explore")
      const found = await parallel(args.areas.map((a) => () => agent("look at " + a, { label: a })))
      phase("Verify")
      const verdict = await agent("check: " + found.join("; "), { schema: { type: "object" } })
      log("checked", found.length)
      return { found, verdict }`,
    args: { areas: ["api", "core", "tui"] },
    answer: (o) => (o.schema ? { value: { ok: true } } : { text: `did: ${o.prompt}` }),
  })
  await run.done
  expect(run.error).toBeUndefined()
  expect(run.status).toBe("done")
  expect(run.result).toEqual({
    found: ["did: look at api", "did: look at core", "did: look at tui"],
    verdict: { ok: true },
  })
  expect(group.spawned.map((o) => o.title)).toEqual(["api", "core", "tui", "check: did: look at api;…"])
  expect(group.spawned[3]!.schema).toEqual({ type: "object" })
  expect(run.logs.map((l) => l.text)).toContain("checked 3")
  // The progress tree has the phases with their agents.
  expect(run.flow.phases.map((p) => [p.title, p.items.length])).toEqual([
    ["Explore", 3],
    ["Verify", 1],
  ])
  expect(group.endReason).toBe("the workflow finished")
})

for (const [what, code] of [
  ["Date.now()", "Date.now()"],
  ["new Date()", "new Date()"],
  ["Math.random()", "Math.random()"],
  ["the real Date through a date's constructor", "new (new Date(0).constructor)()"],
  ["the Function constructor", '(function () {}).constructor("return 1")()'],
  ["the AsyncFunction constructor", '(async () => {}).constructor("return 1")'],
] as const) {
  test(`the sandbox refuses ${what}`, async () => {
    const { run } = start({ source: `${META}${code}\nreturn "reached"` })
    await run.done
    expect(run.status).toBe("error")
    expect(run.error).toMatch(/not available/)
  })
}

test("new Date(value) still works: only the current time is refused", async () => {
  const { run } = start({ source: `${META}return new Date(0).toISOString() + " " + Date.UTC(2020, 0, 1)` })
  await run.done
  expect(run.result).toBe("1970-01-01T00:00:00.000Z 1577836800000")
})

test("files, processes, the network and modules are out of reach", async () => {
  const { run } = start({
    source: `${META}
      // (The transpiler turns \`typeof require\` itself into "function"; the value is what counts.)
      const req = require
      return [typeof Bun, typeof process, typeof req, typeof fetch, typeof WebSocket, typeof Worker,
        typeof globalThis, typeof self, typeof setTimeout, typeof eval, typeof Function, typeof postMessage,
        typeof XMLHttpRequest, typeof crypto, typeof Buffer]`,
  })
  await run.done
  expect(run.error).toBeUndefined()
  expect(run.result).toEqual(Array(15).fill("undefined"))
})

test("imports are refused before anything runs", () => {
  expect(() => start({ source: `${META}import fs from "node:fs"\nreturn 1` })).toThrow(/cannot import/)
  expect(() => start({ source: `${META}const fs = await import("node:fs")\nreturn 1` })).toThrow(
    /cannot import/,
  )
  expect(() => start({ source: `${META}const fs = require("node:fs")\nreturn 1` })).toThrow(/cannot import/)
  // Types only matter to editors.
  const { run } = start({ source: `import type { Api } from "./workflow"\n${META}return 2` })
  return run.done.then(() => expect(run.result).toBe(2))
})

test("a failing agent rejects its agent() call; parallel turns it into null", async () => {
  const { run } = start({
    source: `${META}
      const all = await parallel([() => agent("good"), () => agent("bad"), () => agent("good too")])
      let caught = ""
      try { await agent("bad again") } catch (e) { caught = e.message }
      return { all, caught }`,
    answer: (o) => (o.prompt.startsWith("bad") ? { error: "boom" } : { text: "ok" }),
  })
  await run.done
  expect(run.result).toEqual({ all: ["ok", null, "ok"], caught: 'agent "bad again" failed: boom' })
  expect(run.logs.some((l) => l.level === "warning" && l.text.includes("parallel task 2 failed"))).toBe(true)
})

test("pipeline runs every item through its stages; items do not wait for each other", async () => {
  const order: string[] = []
  const { run } = start({
    source: `${META}
      return await pipeline(["a", "b"],
        (x) => agent("draft " + x),
        (draft, x, i) => agent("review " + x + " " + i + ": " + draft))`,
    answer: async (o) => {
      order.push(o.prompt)
      if (o.prompt === "draft a") await Bun.sleep(40)
      return { text: o.prompt.toUpperCase() }
    },
  })
  await run.done
  expect(run.result).toEqual(["REVIEW A 0: DRAFT A", "REVIEW B 1: DRAFT B"])
  // b's review started before a's draft was done.
  expect(order.indexOf("review b 1: DRAFT B")).toBeLessThan(order.indexOf("review a 0: DRAFT A"))
})

test("the script's throw fails the run and ends its group", async () => {
  const { run, group } = start({ source: `${META}await agent("x")\nthrow new Error("nope")` })
  await run.done
  expect(run.status).toBe("error")
  expect(run.error).toBe("Error: nope")
  expect(group.endReason).toBe("the workflow failed")
})

test("stop ends the script and aborts its running agents", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { run, group } = start({
    source: `${META}return await agent("slow")`,
    answer: async () => {
      await gate
      return { text: "late" }
    },
  })
  while (!group.spawned.length) await Bun.sleep(2)
  expect(run.stop()).toBe(true)
  await run.done
  release()
  expect(run.status).toBe("stopped")
  expect(group.endReason).toBe("the workflow was stopped")
  expect(run.stop()).toBe(false)
})

test("agents queue behind the group's maxConcurrent, and maxAgents fails the call past it", async () => {
  const { run, group } = start({
    source: `${META}
      const r = await parallel([1, 2, 3, 4, 5].map((i) => () => agent("task " + i)))
      return r.filter((x) => x === null).length`,
    group: { maxConcurrent: 2, maxAgents: 4 },
  })
  await run.done
  expect(group.peak).toBe(2)
  expect(group.spawned).toHaveLength(4)
  expect(run.result).toBe(1)
  expect(
    run.flow.phases.flatMap((p) => p.items).filter((i) => i.kind === "agent" && i.status === "error"),
  ).toHaveLength(1)
})

test("budget: total from the settings, spent from the group's use", async () => {
  const { run } = start({
    source: `${META}
      const before = [budget.total, budget.spent(), budget.remaining()]
      await agent("x")
      return { before, after: [budget.spent(), budget.remaining()] }`,
    budgetTokens: 1000,
    answer: () => ({ text: "ok" }),
  })
  // The extension forwards group.update tokens; here we do it by hand.
  const wait = setInterval(() => run.budgetChanged(250), 1)
  await run.done
  clearInterval(wait)
  const r = run.result as { before: number[]; after: number[] }
  expect(r.before[0]).toBe(1000)
  expect(r.after).toEqual([250, 750])
})

test("unknown options are refused with a message the script sees", async () => {
  const { run } = start({
    source: `${META}
      const errors = []
      for (const o of [{ model: "nope" }, { isolation: "vm" }, { schema: [] }, { role: "wizard" }]) {
        try { await agent("x", o) } catch (e) { errors.push(e.message) }
      }
      return errors`,
  })
  await run.done
  const errors = run.result as string[]
  expect(errors[0]).toMatch(/provider\/model/)
  expect(errors[1]).toMatch(/isolation/)
  expect(errors[2]).toMatch(/JSON Schema/)
  expect(errors[3]).toMatch(/unknown role "wizard"; known roles: explorer, coder, reviewer/)
})

test("a role's tools and prompt reach the agent", async () => {
  const { run, group } = start({
    source: `${META}return await agent("scan", { role: "explorer", model: "p/m" })`,
  })
  await run.done
  const o = group.spawned[0]!
  expect(o.role).toBe("explorer")
  expect(o.model).toBe("p/m")
  expect(o.tools).toContain("read")
  expect(o.tools).not.toContain("write")
  expect(o.systemPrompt).toContain("You are an explorer")
  expect(o.systemPrompt).toContain("run by a workflow script")
})

// ---- journal and resume ----

const FANOUT = `${META}
  const found = await parallel(["a", "b", "c"].map((x) => () => agent("find " + x)))
  const verdict = await agent("verify " + found.join(","))
  return { found, verdict }`

test("each finished agent() call is journaled under the run's directory", async () => {
  const { run, dir } = start({ source: FANOUT })
  await run.done
  const entries = readJournal(dir)
  expect(entries.map((e) => e.text).sort()).toEqual(
    ["did: find a", "did: find b", "did: find c", "did: verify did: find a,did: find b,did: find c"].sort(),
  )
  expect(new Set(entries.map((e) => e.key)).size).toBe(4)
  const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"))
  expect(record).toMatchObject({ id: "wf_test", status: "done", meta: { name: "t" } })
  expect(readFileSync(path.join(dir, "script.ts"), "utf8")).toBe(FANOUT)
})

test("resuming an unchanged run replays every call from the journal and starts no agent", async () => {
  const first = start({ source: FANOUT })
  await first.run.done
  const again = start({ source: FANOUT, dir: first.dir, previous: readJournal(first.dir) })
  await again.run.done
  expect(again.group.spawned).toHaveLength(0)
  expect(again.run.result).toEqual(first.run.result)
  expect(
    again.run.flow.phases.flatMap((p) => p.items).every((i) => i.kind === "agent" && i.status === "cached"),
  ).toBe(true)
})

test("after a crash, a resume runs only what never finished", async () => {
  const first = start({
    source: FANOUT,
    answer: (o) => (o.prompt === "find b" ? { error: "provider down" } : { text: `did: ${o.prompt}` }),
  })
  await first.run.done
  // b failed: parallel gave null, and verify ran with it; drop verify to act like a crash before it.
  const journal = readJournal(first.dir).filter((e) => !e.text.startsWith("did: verify"))
  const again = start({ source: FANOUT, dir: first.dir, previous: journal })
  await again.run.done
  expect(again.group.spawned.map((o) => o.prompt)).toEqual([
    "find b",
    "verify did: find a,did: find b,did: find c",
  ])
})

test("an edited script replays its unchanged prefix and reruns from the first change on", async () => {
  const first = start({ source: FANOUT })
  await first.run.done
  const edited = FANOUT.replace('"verify "', '"double-check "')
  const again = start({ source: edited, dir: first.dir, previous: readJournal(first.dir) })
  await again.run.done
  expect(again.group.spawned.map((o) => o.prompt)).toEqual([
    "double-check did: find a,did: find b,did: find c",
  ])
  // Changing an early call reruns everything that came after it, even calls that look unchanged.
  const early = FANOUT.replace('["a", "b", "c"]', '["a", "B", "c"]')
  const third = start({ source: early, dir: first.dir, previous: readJournal(first.dir) })
  await third.run.done
  expect(third.group.spawned.map((o) => o.prompt)).toEqual([
    "find B",
    "verify did: find a,did: find B,did: find c",
  ])
})

test("two identical calls are journaled apart and replay in order", async () => {
  const src = `${META}
    const a = await agent("same")
    const b = await agent("same")
    return [a, b]`
  let n = 0
  const first = start({ source: src, answer: () => ({ text: `answer ${++n}` }) })
  await first.run.done
  const again = start({ source: src, dir: first.dir, previous: readJournal(first.dir) })
  await again.run.done
  expect(again.group.spawned).toHaveLength(0)
  expect(again.run.result).toEqual(["answer 1", "answer 2"])
})

// ---- nesting ----

const CHILD = `export const meta = { name: "child", description: "nested", phases: ["Inner"] }
  phase("Inner")
  const r = await agent("inner " + args.x)
  return r.toUpperCase()`

test("workflow(name, args) runs a saved workflow one level deep, in the parent's group and journal", async () => {
  const { run, group, dir } = start({
    source: `${META}
      phase("Explore")
      const a = await agent("outer")
      const b = await workflow("child", { x: 1 })
      return [a, b]`,
    saved: { child: CHILD },
  })
  await run.done
  expect(run.error).toBeUndefined()
  expect(run.result).toEqual(["did: outer", "DID: INNER 1"])
  expect(group.spawned.map((o) => o.prompt)).toEqual(["outer", "inner 1"])
  // The nested run is a node under the phase it was called in.
  const explore = run.flow.phases.find((p) => p.title === "Explore")!
  const nested = explore.items.find((i) => i.kind === "workflow")
  expect(nested).toMatchObject({ kind: "workflow", name: "child", state: "done" })
  expect(readJournal(dir)).toHaveLength(2)
})

test("a nested workflow cannot start another", async () => {
  const inner = `export const meta = { name: "deep", description: "nests again", phases: [] }
    return await workflow("child", { x: 2 })`
  const { run } = start({
    source: `${META}
      try { await workflow("deep", {}) } catch (e) { return e.message }`,
    saved: { deep: inner, child: CHILD },
  })
  await run.done
  expect(run.result).toMatch(/only be used one level deep/)
})

test("an unknown saved workflow rejects workflow()", async () => {
  const { run } = start({ source: `${META}try { await workflow("nope") } catch (e) { return e.message }` })
  await run.done
  expect(run.result).toMatch(/no saved workflow named "nope"/)
})
