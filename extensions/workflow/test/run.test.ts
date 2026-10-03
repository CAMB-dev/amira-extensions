import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SpawnGroupOptions, SpawnOptions } from "@amira/api"
import { readJournal } from "../src/journal.ts"
import { BUILTIN_ROLES } from "../src/roles.ts"
import { WorkflowRun } from "../src/run.ts"
import type { RunGit } from "../src/worktree.ts"
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
  resumes?: number
  saved?: Record<string, string>
  budgetTokens?: number
  git?: RunGit
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
    ...(s.resumes !== undefined ? { resumes: s.resumes } : {}),
    ...(s.budgetTokens !== undefined ? { budgetTokens: s.budgetTokens } : {}),
    roles: () => new Map(BUILTIN_ROLES.map((r) => [r.name, r])),
    git: s.git ?? (async () => ({ output: "", ok: false })),
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

for (const [what, code, expected] of [
  ["Date.now()", "Date.now()"],
  ["new Date()", "new Date()"],
  ["Math.random()", "Math.random()"],
  ["the real Date through a date's constructor", "new (new Date(0).constructor)()"],
  ["the Function constructor", '(function () {}).constructor("return 1")()'],
  ["the AsyncFunction constructor", '(async () => {}).constructor("return 1")'],
  // Date's prototype is Function.prototype: it has no now() and is no constructor.
  ["the real Date through Date's prototype chain", "Object.getPrototypeOf(Date).now()", /is not a function/],
  [
    "a real Date built through Date's prototype chain",
    "new (Object.getPrototypeOf(Date))()",
    /not a constructor/,
  ],
  ["Intl formatting the current time", "new Intl.DateTimeFormat().format()"],
  ["Intl formatting the current time in parts", "Intl.DateTimeFormat().formatToParts()"],
] as [string, string, RegExp?][]) {
  test(`the sandbox refuses ${what}`, async () => {
    const { run } = start({ source: `${META}${code}\nreturn "reached"` })
    await run.done
    expect(run.status).toBe("error")
    expect(run.error).toMatch(expected ?? /not available/)
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

test("no alias of the global object is reachable, so neither is anything on it", async () => {
  const { run } = start({
    source: `${META}
      const probes = {
        global: () => typeof global, window: () => typeof window, globalThis: () => typeof globalThis,
        self: () => typeof self, Bun: () => typeof Bun, Temporal: () => typeof Temporal,
        ShadowRealm: () => typeof ShadowRealm, queueMicrotask: () => typeof queueMicrotask,
        EventTarget: () => typeof EventTarget, constructor: () => typeof constructor,
        __proto__: () => typeof __proto__, performance: () => typeof performance,
        sloppyThis: () => typeof (function () { return this })(),
        viaFunction: () => typeof Function,
      }
      const out = {}
      for (const [k, f] of Object.entries(probes)) {
        try { out[k] = f() } catch (e) { out[k] = "threw " + e.name }
      }
      return out`,
  })
  await run.done
  expect(run.error).toBeUndefined()
  const out = run.result as Record<string, string>
  for (const [k, v] of Object.entries(out)) expect(`${k}: ${v}`).toBe(`${k}: undefined`)
})

test("the plain builtins stay, Date.UTC and Date.parse included; console goes to the log", async () => {
  const { run } = start({
    source: `${META}
      console.log("hello", { a: 1 })
      console.warn("careful")
      return [JSON.stringify([1]), Math.max(1, 2), [3, 1].sort().join(), new Map([[1, 2]]).size,
        Date.parse("2020-01-01T00:00:00Z"), Date.UTC(2020, 0, 1), new Date(0) instanceof Date,
        Object.getPrototypeOf(Date) === Object.getPrototypeOf(Object), typeof Date.now,
        new Intl.DateTimeFormat("en", { timeZone: "UTC", year: "numeric" }).format(new Date(0)),
        new URL("https://x.test/a?b=1").searchParams.get("b"), new TextEncoder().encode("é").length]`,
  })
  await run.done
  expect(run.error).toBeUndefined()
  expect(run.result).toEqual([
    "[1]",
    2,
    "1,3",
    1,
    1577836800000,
    1577836800000,
    true,
    true,
    "function",
    "1970",
    "1",
    2,
  ])
  expect(run.logs).toContainEqual({ level: "info", text: 'hello {"a":1}' })
  expect(run.logs).toContainEqual({ level: "warning", text: "careful" })
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
  const { run, group, dir } = start({
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
  expect(run.settled).toBe(true)
  expect(readJournal(dir)).toMatchObject([{ status: "aborted", sessionId: "s_child1" }])
  const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"))
  expect(record.totals).toMatchObject({
    agents: 1,
    tokens: 0,
    cost: null,
    byStatus: { aborted: 1, working: 0, queued: 0 },
  })
  expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt)
  expect(record.totals.durationMs).toBe(record.endedAt - record.startedAt)
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

test("failures, validation errors, and spawn failures all have journal outcomes", async () => {
  const { run, dir } = start({
    source: `${META}
      return await parallel([
        () => agent("bad", { phase: "Explore", model: "provider/model" }),
        () => agent("invalid", { model: "invalid" }),
        () => agent("role", { role: "missing" }),
        () => agent("capped"),
      ])`,
    answer: () => ({ error: "provider failed", tokens: 15, cost: 0.02 }),
    group: { maxAgents: 1 },
  })
  await run.done
  const entries = readJournal(dir).sort((a, b) => a.call! - b.call!)
  expect(entries.map((entry) => entry.status)).toEqual(["error", "error", "error", "error"])
  expect(entries.every((entry) => typeof entry.startedAt === "number" && !!entry.error)).toBe(true)
  expect(entries[0]).toMatchObject({ phase: "Explore", sessionId: "s_child1", model: "x/y", tokens: 15 })
  expect(
    entries
      .slice(1)
      .every((entry) => entry.sessionId === undefined && entry.tokens === 0 && entry.cost === 0),
  ).toBe(true)
  expect(run.record.totals).toMatchObject({ tokens: 15, cost: 0.02, agents: 4, byStatus: { error: 4 } })
})

test("a caught failure ends the replay prefix even when later prompts are unchanged", async () => {
  const source = `${META}
    await agent("before")
    try { await agent("fails") } catch {}
    return await agent("after")`
  const first = start({
    source,
    answer: (o) => (o.prompt === "fails" ? { error: "no" } : { text: o.prompt }),
  })
  await first.run.done
  const again = start({ source, dir: first.dir, previous: readJournal(first.dir), resumes: 1 })
  await again.run.done
  expect(again.group.spawned.map((o) => o.prompt)).toEqual(["fails", "after"])
  const entries = readJournal(first.dir).filter((entry) => entry.attempt === 1)
  expect(entries.map((entry) => entry.status)).toEqual(["cached", "done", "done"])
  expect(entries[0]).toMatchObject({ tokens: 0, cost: 0, text: "before" })
  expect(entries[0]!.sessionId).toBe("s_child1")
  expect(again.run.record.totals).toMatchObject({ tokens: 200, cost: null, byStatus: { cached: 1, done: 2 } })
})

test("mixed reported costs stay unknown, and an all-cached attempt costs zero", async () => {
  const source = `${META}return await parallel([() => agent("known"), () => agent("unknown")])`
  const first = start({
    source,
    answer: (o) => ({ text: o.prompt, cost: o.prompt === "known" ? 0.1 : undefined }),
  })
  await first.run.done
  expect(first.run.record.totals).toMatchObject({ tokens: 200, cost: null })
  const again = start({ source, dir: first.dir, previous: readJournal(first.dir), resumes: 1 })
  await again.run.done
  expect(again.run.record.totals).toMatchObject({ tokens: 0, cost: 0, agents: 2, byStatus: { cached: 2 } })
  expect(
    readJournal(first.dir)
      .filter((entry) => entry.attempt === 1)
      .map((entry) => entry.sessionId)
      .sort(),
  ).toEqual(["s_child1", "s_child2"])
  const third = start({ source, dir: first.dir, previous: readJournal(first.dir), resumes: 2 })
  await third.run.done
  expect(third.group.spawned).toHaveLength(0)
  expect(
    readJournal(first.dir)
      .filter((entry) => entry.attempt === 2)
      .map((entry) => entry.sessionId)
      .sort(),
  ).toEqual(["s_child1", "s_child2"])
})

test("one child's unpriced or unobserved usage never becomes a known partial total", async () => {
  for (const messageUsages of [
    [
      { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    ],
    [{ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 }],
  ]) {
    const { run, dir } = start({
      source: `${META}return await agent("mixed usage")`,
      answer: () => ({ text: "done", tokens: 20, cost: 0.1, messageUsages }),
    })
    await run.done
    expect(run.record.totals).toMatchObject({ tokens: 20, cost: null })
    expect(readJournal(dir)[0]!.cost).toBeUndefined()
  }
})

test("stop settles queued and working calls before writing final totals", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { run, group, dir } = start({
    source: `${META}return await parallel([() => agent("slow"), () => agent("queued")])`,
    group: { maxConcurrent: 1 },
    answer: async () => {
      await gate
      return { text: "late" }
    },
  })
  while (group.spawned.length < 2) await Bun.sleep(2)
  run.stop()
  await run.done
  const before = readFileSync(path.join(dir, "run.json"), "utf8")
  expect(readJournal(dir).map((entry) => entry.status)).toEqual(["aborted", "aborted"])
  expect(run.record.totals?.byStatus).toEqual({
    queued: 0,
    working: 0,
    done: 0,
    error: 0,
    aborted: 2,
    cached: 0,
  })
  release()
  await Bun.sleep(10)
  expect(readFileSync(path.join(dir, "run.json"), "utf8")).toBe(before)
})

test("stop during worktree preparation journals the call without inventing a child", async () => {
  let preparing = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { run, group, dir } = start({
    source: `${META}return await agent("prepare", { isolation: "worktree" })`,
    git: async () => {
      preparing = true
      await gate
      return { ok: false, output: "" }
    },
  })
  while (!preparing) await Bun.sleep(2)
  run.stop()
  await Bun.sleep(2)
  expect(run.settled).toBe(false)
  release()
  await run.done
  expect(group.spawned).toHaveLength(0)
  expect(readJournal(dir)).toMatchObject([{ status: "aborted", tokens: 0, cost: 0 }])
  expect(readJournal(dir)[0]!.sessionId).toBeUndefined()
  expect(run.record.totals).toMatchObject({ tokens: 0, cost: 0, byStatus: { aborted: 1 } })
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
