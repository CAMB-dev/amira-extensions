import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OpenPipeOptions, PipeProcess } from "@amira/api"
import { openPipe, runCommand } from "@amira/proc"
import { LspClient } from "../src/client.ts"
import { ServerManager } from "../src/manager.ts"
import { readSettings } from "../src/settings.ts"

// Spawns can take seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const FAKE = path.join(import.meta.dir, "fake-lsp.ts")

/** ExtensionAPI.openPipe, as the host implements it. */
function pipe(argv: string[], opts: OpenPipeOptions): PipeProcess {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (typeof v === "string") env[k] = v
  return openPipe({ argv, cwd: opts.cwd, env }, opts.onEvent)
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "lsp-test-"))
  // Servers run in it until they have exited, which may take a moment after close.
  cleanup.push(async () => {
    for (let i = 0; ; i++) {
      try {
        return rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        if (i >= 50) throw err
        await Bun.sleep(100)
      }
    }
  })
  const log = path.join(dir, "server.log")
  const received = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : []
  return { dir, log, received }
}

function client(dir: string, env: Record<string, string> = {}, settings?: Record<string, unknown>) {
  const c = new LspClient({
    argv: [process.execPath, FAKE],
    root: dir,
    env: { ...process.env, ...env },
    openPipe: pipe,
    startupTimeoutMs: 30_000,
    ...(settings ? { settings } : {}),
  })
  cleanup.push(() => c.close())
  return c
}

async function until(done: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

test("published diagnostics for the text last sent, with the server's questions answered", async () => {
  const { dir, log, received } = workspace()
  const c = client(dir, { FAKE_LSP_LOG: log }, { fake: { strict: true } })
  await c.start()
  expect(c.state).toBe("ready")
  expect(c.serverInfo).toBe("fake-lsp 1.0")
  const file = path.join(dir, "a.fk")
  expect(c.sync(file, "ok\nERROR: bad thing\n", "fake")).toBe(true)
  const first = await c.diagnostics(file, { waitMs: 5000 })
  expect(first.fresh).toBe(true)
  expect(first.diagnostics).toMatchObject([
    { severity: 1, message: "bad thing", range: { start: { line: 1, character: 0 } } },
  ])
  // Unchanged text sends nothing; the answer stands.
  expect(c.sync(file, "ok\nERROR: bad thing\n", "fake")).toBe(false)
  expect((await c.diagnostics(file, { waitMs: 5000 })).diagnostics).toHaveLength(1)
  c.sync(file, "fixed\n", "fake")
  expect(await c.diagnostics(file, { waitMs: 5000 })).toEqual({ diagnostics: [], fresh: true })

  const methods = received().map((m) => m.method)
  expect(methods.slice(0, 2)).toEqual(["initialize", "initialized"])
  expect(methods).toContain("textDocument/didChange")
  expect(methods).toContain("textDocument/didSave")
  const init = received()[0]
  expect(init.params.rootUri).toMatch(/^file:\/\/\//)
  // The server asked for its settings section and got it.
  const answer = received().find((m) => m.id === 1000 && m.method === undefined)
  expect(answer?.result).toEqual([{ strict: true }])
  const open = received().find((m) => m.method === "textDocument/didOpen")
  if (process.platform === "win32") expect(open.params.textDocument.uri).toMatch(/^file:\/\/\/[A-Z]:\//)

  await c.close()
  await until(() => received().some((m) => m.method === "exit"))
  expect(received().map((m) => m.method)).toContain("shutdown")
})

test("a publish about older text is not taken for the answer, and URIs in another form still match", async () => {
  const { dir } = workspace()
  const c = client(dir, { FAKE_LSP_STALE: "1", FAKE_LSP_URIS: "vscode", FAKE_LSP_DELAY: "150" })
  await c.start()
  const file = path.join(dir, "a.fk")
  c.sync(file, "ERROR: old\n", "fake")
  expect((await c.diagnostics(file, { waitMs: 5000 })).diagnostics[0]?.message).toBe("old")
  c.sync(file, "WARN: new\n", "fake")
  // The stale publish (the old text's error, sent at once) must be skipped for the versioned one.
  const r = await c.diagnostics(file, { waitMs: 5000 })
  expect(r.fresh).toBe(true)
  expect(r.diagnostics.map((d) => d.message)).toEqual(["new"])
})

test("a server that answers textDocument/diagnostic is asked directly", async () => {
  const { dir, log, received } = workspace()
  const c = client(dir, { FAKE_LSP_PULL: "1", FAKE_LSP_LOG: log })
  await c.start()
  expect(c.pulls).toBe(true)
  const file = path.join(dir, "a.fk")
  c.sync(file, "INFO: note\nERROR: e\n", "fake")
  const r = await c.diagnostics(file, { waitMs: 5000 })
  expect(r.fresh).toBe(true)
  expect(r.diagnostics.map((d) => d.severity)).toEqual([3, 1])
  expect(received().some((m) => m.method === "textDocument/diagnostic")).toBe(true)

  // A request with a signal already aborted is not sent and does not wait out its timeout.
  const aborted = AbortSignal.abort()
  const started = Date.now()
  await expect(c.request("textDocument/diagnostic", {}, 30_000, aborted)).rejects.toThrow("aborted")
  expect(await c.diagnostics(file, { waitMs: 30_000, signal: aborted })).toMatchObject({ fresh: false })
  expect(Date.now() - started).toBeLessThan(2000)
})

test("a silent server times out with fresh: false; a missing program fails to start", async () => {
  const { dir } = workspace()
  const c = client(dir, { FAKE_LSP_SILENT: "1" })
  await c.start()
  const file = path.join(dir, "a.fk")
  c.sync(file, "ERROR: x\n", "fake")
  const started = Date.now()
  expect(await c.diagnostics(file, { waitMs: 300 })).toEqual({ diagnostics: [], fresh: false })
  expect(Date.now() - started).toBeLessThan(3000)

  const missing = new LspClient({
    argv: [path.join(dir, "no-such-server.exe")],
    root: dir,
    openPipe: pipe,
    startupTimeoutMs: 30_000,
  })
  await expect(missing.start()).rejects.toThrow(/could not start/)
  expect(missing.state).toBe("failed")
})

function manager(errors: string[]) {
  const settings = readSettings({
    waitMs: 3000,
    servers: {
      fake: { command: [process.execPath, FAKE], extensions: [".fk"], rootMarkers: ["root.marker"] },
    },
  })
  const m = new ServerManager(settings, {
    openPipe: pipe,
    runCommand,
    which: () => null,
    reportError: (e) => void errors.push(e),
    onChange: () => {},
  })
  cleanup.push(() => m.stopAll())
  return m
}

test("the manager starts one server per root lazily, checks files together and restarts a crashed server", async () => {
  const { dir } = workspace()
  const errors: string[] = []
  const m = manager(errors)
  const a = path.join(dir, "a.fk")
  const b = path.join(dir, "b.fk")
  writeFileSync(a, "ERROR: in a\n")
  writeFileSync(b, "fine\n")
  expect(m.running).toBe(0)
  const signal = new AbortController().signal
  const checks = await m.check([a, b, path.join(dir, "c.txt")], dir, signal)
  expect(checks.map((c) => [path.basename(c.file), c.fresh, c.diagnostics.length])).toEqual([
    ["a.fk", true, 1],
    ["b.fk", true, 0],
  ])
  expect(m.running).toBe(1)
  const d = m.describe().find((s) => s.id === "fake")!
  expect(d.running).toMatchObject([{ root: dir, state: "ready", files: 2, serverInfo: "fake-lsp 1.0" }])
  expect(m.describe().find((s) => s.id === "python")).toMatchObject({ command: undefined, running: [] })

  // A file under another root gets a server of its own.
  mkdirSync(path.join(dir, "sub"))
  writeFileSync(path.join(dir, "sub", "root.marker"), "")
  const inSub = path.join(dir, "sub", "c.fk")
  writeFileSync(inSub, "INFO: sub\n")
  expect((await m.check([inSub], dir, signal))[0]?.diagnostics).toHaveLength(1)
  expect(m.running).toBe(2)
  expect(
    m
      .describe()
      .find((s) => s.id === "fake")!
      .running.map((r) => r.root),
  ).toEqual([dir, path.join(dir, "sub")])

  // A file changed on disk by someone else is sent again before the next check.
  writeFileSync(b, "WARN: changed elsewhere\n")
  writeFileSync(a, "fixed\n")
  const again = await m.check([a], dir, signal)
  expect(again[0]?.diagnostics).toEqual([])

  // The server dies; the next check starts a new one.
  writeFileSync(a, "CRASH\n")
  await m.check([a], dir, signal, 500)
  await until(() => m.running === 1)
  writeFileSync(a, "ERROR: back\n")
  const after = await m.check([a], dir, signal)
  expect(after[0]?.diagnostics[0]?.message).toBe("back")
  expect(errors).toEqual([])

  // A deleted file is closed and left out.
  rmSync(b)
  expect(await m.check([b], dir, signal)).toEqual([])
})

test("a server exiting while it is stopped is no crash, and does not take its replacement with it", async () => {
  const { dir } = workspace()
  process.env.FAKE_LSP_EXIT_ON_SHUTDOWN = "1"
  cleanup.push(() => delete process.env.FAKE_LSP_EXIT_ON_SHUTDOWN)
  const exits: string[] = []
  const c = new LspClient({
    argv: [process.execPath, FAKE],
    root: dir,
    openPipe: pipe,
    startupTimeoutMs: 30_000,
    onExit: (reason) => void exits.push(reason),
  })
  await c.start()
  await c.close()
  await Bun.sleep(200)
  expect(c.state).toBe("closed")
  expect(exits).toEqual([])

  const errors: string[] = []
  const m = manager(errors)
  const a = path.join(dir, "a.fk")
  writeFileSync(a, "ERROR: e\n")
  const signal = new AbortController().signal
  await m.check([a], dir, signal)
  expect(m.running).toBe(1)
  // Stopped, and a check starts a new server for the same folder before the old one is gone.
  const stopping = m.stopAll()
  const again = m.check([a], dir, signal)
  await stopping
  expect((await again)[0]).toMatchObject({ fresh: true, diagnostics: [{ message: "e" }] })
  await Bun.sleep(300)
  expect(m.running).toBe(1)
  expect(m.describe().find((s) => s.id === "fake")!.running).toMatchObject([{ state: "ready" }])
  expect(errors).toEqual([])
})

test("a server that cannot start is reported once and not tried again until restart", async () => {
  const { dir } = workspace()
  const errors: string[] = []
  const settings = readSettings({
    servers: { fake: { command: [path.join(dir, "missing.exe")], extensions: [".fk"] } },
  })
  // The command is absolute and missing, so it counts as not installed: nothing starts.
  const m = new ServerManager(settings, {
    openPipe: pipe,
    runCommand,
    which: () => null,
    reportError: (e) => void errors.push(e),
    onChange: () => {},
  })
  const a = path.join(dir, "a.fk")
  writeFileSync(a, "x\n")
  expect(await m.check([a], dir, new AbortController().signal)).toEqual([])
  expect(m.describe()[0]).toMatchObject({ id: "fake", command: undefined })

  // One that is found but exits at once fails to start.
  const bad = path.join(dir, "bad.ts")
  writeFileSync(bad, "process.exit(7)\n")
  const m2 = new ServerManager(
    readSettings({ servers: { fake: { command: [process.execPath, bad], extensions: [".fk"] } } }),
    {
      openPipe: pipe,
      runCommand,
      which: () => null,
      reportError: (e) => void errors.push(e),
      onChange: () => {},
    },
  )
  expect(await m2.check([a], dir, new AbortController().signal)).toEqual([])
  expect(await m2.check([a], dir, new AbortController().signal)).toEqual([])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/the fake server for .* failed: .*exited with code 7/)
  expect(m2.describe()[0]?.failed).toHaveLength(1)
  await m2.restart()
  expect(m2.describe()[0]?.failed).toHaveLength(0)
})

test("without a TypeScript server, tsc --noEmit checks the project", async () => {
  const { dir } = workspace()
  const errors: string[] = []
  // A stand-in for tsc: prints what real tsc prints for a type error in the file asked about.
  const fakeTsc = path.join(dir, "fake-tsc.ts")
  writeFileSync(
    fakeTsc,
    [
      "const args = process.argv.slice(2)",
      "if (!args.includes('--noEmit')) process.exit(9)",
      "console.log('src/a.ts(2,5): error TS2322: Type \\'string\\' is not assignable to type \\'number\\'.')",
      "process.exit(2)",
    ].join("\n"),
  )
  writeFileSync(path.join(dir, "tsconfig.json"), "{}")
  const a = path.join(dir, "src", "a.ts")
  mkdirSync(path.dirname(a))
  writeFileSync(a, "let x: number\nx = 'no'\n")
  const { runTsc } = await import("../src/tsc.ts")
  const run = await runTsc([process.execPath, fakeTsc], [a], dir, runCommand, {
    timeoutMs: 30_000,
    signal: new AbortController().signal,
  })
  expect(run.error).toBeUndefined()
  expect([...run.byFile.values()][0]).toMatchObject([
    { severity: 1, code: "TS2322", range: { start: { line: 1 } } },
  ])
  expect(errors).toEqual([])
})
