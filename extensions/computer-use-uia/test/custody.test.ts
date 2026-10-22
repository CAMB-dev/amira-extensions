import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ExtensionAPI, OpenPipeOptions } from "@amira/api"
import { type CustodyOffer, SessionCustody } from "../src/custody.ts"

// Fake private pipes only. No PowerShell, process lookup, UIA or desktop access.
function fixture(
  options: {
    ready?: Record<string, unknown>
    incomplete?: boolean
    holdReady?: boolean
    holdEnd?: boolean
  } = {},
) {
  let events!: OpenPipeOptions["onEvent"]
  const writes: Record<string, unknown>[] = []
  const closes: number[] = []
  const host = {
    cwd: "fake",
    reportError() {},
    openPipe(_argv: string[], pipeOptions: OpenPipeOptions) {
      events = pipeOptions.onEvent
      queueMicrotask(() => events({ type: "spawned", pid: 83 }))
      return {
        write(line: string) {
          const message = JSON.parse(line)
          writes.push(message)
          if (message.event === "end" && !options.holdEnd) finish()
          if (message.event === "custody-session" && !options.holdReady)
            queueMicrotask(() =>
              emit({
                event: "custody-ready",
                session: message.session,
                pid: 83,
                started: "5000",
                ...options.ready,
              }),
            )
        },
        close(ms: number) {
          closes.push(ms)
          finish()
        },
      }
    },
  } as Pick<ExtensionAPI, "openPipe" | "cwd" | "reportError">
  function emit(message: object) {
    events({ type: "stdout", data: `${JSON.stringify(message)}\n` })
  }
  function finish() {
    emit({ event: "custody-drained", session: owner.session, incomplete: options.incomplete ?? false })
    queueMicrotask(() => events({ type: "exit", code: 0 }))
  }
  const owner = new SessionCustody(host, 30)
  const offer = (): CustodyOffer => ({
    job: `amira-uia-job-${crypto.randomUUID()}`,
    transfer: crypto.randomUUID(),
    session: owner.session,
    pid: 80,
    started: "2000",
    handle: 700,
    writerPid: 70,
    writerStarted: "1000",
  })
  return { owner, writes, closes, emit, offer, finish, exit: () => events({ type: "exit", code: 1 }) }
}

test("custody waits for an exact authenticated transfer acknowledgement", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const offer = h.offer()
  let accepted = false
  const retained = h.owner.retain(offer).then(() => {
    accepted = true
  })
  expect(h.writes.at(-1)).toEqual({ ...offer, event: "retain" })
  for (const mismatch of [
    { session: "foreign" },
    { job: h.offer().job },
    { transfer: crypto.randomUUID() },
    { pid: 81 },
    { started: "2001" },
    { handle: 701 },
    { writerPid: 71 },
    { writerStarted: "1001" },
  ]) {
    h.emit({ ...offer, ...mismatch, event: "retained" })
    await Bun.sleep(0)
    expect(accepted).toBe(false)
  }
  h.emit({ ...offer, event: "retained" })
  await retained
  expect(accepted).toBe(true)
  await h.owner.stop()
})

test("late custody acks cannot authorize a second transfer or reopen a stopped owner", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const old = h.offer()
  const timedOut = h.owner.retain(old)
  await expect(timedOut).rejects.toThrow("custody acknowledgement timed out")
  const fresh = h.offer()
  let accepted = false
  const next = h.owner.retain(fresh).then(() => {
    accepted = true
  })
  h.emit({ ...old, event: "retained" })
  await Bun.sleep(0)
  expect(accepted).toBe(false)
  h.emit({ ...fresh, event: "retained" })
  await next
  await h.owner.stop()
  h.emit({ ...old, event: "retained" })
  await expect(h.owner.retain(h.offer())).rejects.toThrow("custody owner is unavailable")
})

test("invalid custody session, identities and handles never reach the native owner", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const count = h.writes.length
  for (const mismatch of [
    { session: "foreign" },
    { job: "foreign" },
    { transfer: "bad" },
    { pid: 0 },
    { started: "0" },
    { handle: 0 },
    { handle: 1.2 },
    { handle: Number.MAX_SAFE_INTEGER + 1 },
    { writerPid: 0 },
    { writerStarted: "0" },
  ])
    await expect(h.owner.retain({ ...h.offer(), ...mismatch })).rejects.toThrow("Invalid custody transfer")
  expect(h.writes).toHaveLength(count)
  await h.owner.stop()
})

test("custody loss rejects pending work and cannot silently replace lost authority", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const retained = h.owner.retain(h.offer())
  h.exit()
  await expect(retained).rejects.toThrow("custody owner exited")
  await expect(h.owner.start(42, "1234")).rejects.toThrow("custody owner is unavailable")
})

test("custody readiness rejects mismatched owner identity and never reports failed drain as clean teardown", async () => {
  for (const ready of [{ pid: 84 }, { started: 5000 }, { started: "0" }]) {
    const h = fixture({ ready })
    await expect(h.owner.start(42, "1234")).rejects.toThrow("Invalid UIA custody response")
    expect(h.closes).toEqual([15_000])
  }
  const h = fixture({ incomplete: true })
  await h.owner.start(42, "1234")
  await expect(h.owner.stop()).rejects.toThrow("custody owner exited")
})

test("intentional stop during custody startup preserves a confirmed clean drain", async () => {
  const h = fixture({ holdReady: true })
  const started = h.owner.start(42, "1234").catch((error: Error) => error)
  await Bun.sleep(0)
  await h.owner.stop()
  expect(await started).toMatchObject({ message: "UIA custody startup cancelled" })
  expect(h.closes).toEqual([])
})

test("unconfirmed custody cleanup retains the owner rather than force-closing its last duplicates", async () => {
  const h = fixture({ holdEnd: true })
  await h.owner.start(42, "1234")
  await expect(h.owner.stop()).rejects.toThrow("retained owner is retrying")
  expect(h.closes).toEqual([])
  expect(h.writes.at(-1)).toEqual({ event: "end", session: h.owner.session })
  await expect(h.owner.retain(h.offer())).rejects.toThrow("custody owner is unavailable")
  h.finish()
  await h.owner.stop()
  expect(h.closes).toEqual([])
})

test("duplicate custody transfer IDs cannot repull a released source handle slot", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const offer = h.offer()
  const retained = h.owner.retain(offer)
  h.emit({ ...offer, event: "retained" })
  await retained
  const count = h.writes.length
  await expect(h.owner.retain(offer)).rejects.toThrow("Invalid custody transfer")
  expect(h.writes).toHaveLength(count)
  await h.owner.stop()
})

test("custody root/grace metadata is bound to a retained job and exact acknowledgement", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const offer = h.offer()
  await expect(h.owner.rememberRoot(offer.job, 17, "6000")).rejects.toThrow("Invalid custody root")
  const retaining = h.owner.retain(offer)
  h.emit({ ...offer, event: "retained" })
  await retaining
  let recorded = false
  const recording = h.owner.rememberRoot(offer.job, 17, "6000").then(() => {
    recorded = true
  })
  const message = h.writes.at(-1)!
  expect(message).toMatchObject({
    event: "root",
    session: offer.session,
    job: offer.job,
    transfer: offer.transfer,
    pid: 17,
    started: "6000",
  })
  for (const wrong of [
    { session: "foreign" },
    { job: h.offer().job },
    { transfer: crypto.randomUUID() },
    { pid: 18 },
    { started: "6001" },
    { request: crypto.randomUUID() },
  ]) {
    h.emit({ ...message, ...wrong, event: "root-recorded" })
    await Bun.sleep(0)
    expect(recorded).toBe(false)
  }
  h.emit({ ...message, event: "root-recorded" })
  await recording
  expect(recorded).toBe(true)
  await h.owner.stop()
})

test("custody stop completion checks request/session and preserves incomplete classification", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  let completed = false
  const stopping = h.owner.stopHeadless().then((incomplete) => {
    completed = true
    return incomplete
  })
  const message = h.writes.at(-1)!
  expect(message).toMatchObject({ event: "stop", session: h.owner.session })
  for (const wrong of [{ session: "foreign" }, { request: crypto.randomUUID() }, { incomplete: "false" }]) {
    h.emit({ ...message, event: "stopped", incomplete: false, ...wrong })
    await Bun.sleep(0)
    expect(completed).toBe(false)
  }
  h.emit({ ...message, event: "stopped", incomplete: true })
  expect(await stopping).toBe(true)
  await h.owner.stop()
})

test("custody emergency stop uses native per-member checks with retained root/grace metadata, never whole-job termination", () => {
  const owner = readFileSync(new URL("../helper/custody.ps1", import.meta.url), "utf8")
  const guard = readFileSync(new URL("../helper/launch.ps1", import.meta.url), "utf8")
  const commands = owner.slice(
    owner.indexOf("$message.event -cin @('root', 'stop')"),
    owner.indexOf("$message.event -cne 'retain'"),
  )
  expect(commands).toContain("$jobs[$token].Name -cne [string]$message.job")
  expect(commands).toContain(".RememberRoot([int]$message.pid, [long]$message.started)")
  expect(commands).toContain("foreach ($job in @($jobs.Values))")
  expect(commands).toContain("$job.StopHeadless()")
  expect(commands).not.toContain(".Terminate()")
  expect(commands).not.toContain(".RetireProducers()")
  const metadata = guard.slice(
    guard.indexOf("public void RememberRoot"),
    guard.indexOf("public void SetRoot"),
  )
  expect(metadata).toContain("CreationTime(handle) != started")
  expect(metadata).toContain("!IsProcessInJob(handle, job, out belongs) || !belongs")
  expect(metadata).toContain("rootPid = pid; rootStarted = started")
  expect(metadata).toContain("rootPid == pid && rootStarted == started")
  expect(metadata).not.toContain("ResumeThread")
  expect(guard).toContain("rootStarted < 30000000L")
})

test("journal registration acknowledges the exact path, writer and request before permitting writes", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const path = `C:\\Temp\\amira-uia-${crypto.randomUUID()}.json`
  let accepted = false
  const registration = h.owner.rememberJournal(path, 70, "1000").then(() => {
    accepted = true
  })
  const message = h.writes.at(-1)!
  expect(message).toMatchObject({
    event: "journal",
    path,
    pid: 70,
    started: "1000",
    session: h.owner.session,
  })
  for (const wrong of [
    { path: `${path}.foreign` },
    { pid: 71 },
    { started: "1001" },
    { request: crypto.randomUUID() },
    { session: "foreign" },
  ]) {
    h.emit({ ...message, ...wrong, event: "journal-recorded" })
    await Bun.sleep(0)
    expect(accepted).toBe(false)
  }
  h.emit({ ...message, event: "journal-recorded" })
  await registration
  expect(accepted).toBe(true)
  await h.owner.stop()
})

test("missing journal acknowledgement fails closed; a late acknowledgement cannot reopen the gate", async () => {
  const h = fixture()
  await h.owner.start(42, "1234")
  const registration = h.owner.rememberJournal("C:\\Temp\\journal.json", 70, "1000")
  const message = h.writes.at(-1)!
  await expect(registration).rejects.toThrow("journal acknowledgement timed out")
  h.emit({ ...message, event: "journal-recorded" })
  await h.owner.stop()
})

test("custody alone deletes registered journal pairs after all writers exit and jobs drain", () => {
  const owner = readFileSync(new URL("../helper/custody.ps1", import.meta.url), "utf8")
  const lifetime = readFileSync(new URL("../helper/lifetime.ps1", import.meta.url), "utf8")
  const client = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8")
  const registration = owner.slice(
    owner.indexOf("$message.event -ceq 'journal'"),
    owner.indexOf("$message.event -cin @('root', 'stop')"),
  )
  for (const text of [
    "$writers.ContainsKey($key)",
    "::CreationTime($writer.Handle)",
    "$writers[$key] = $writer",
    "$journals[$message.path] = $true",
    "$message.event = 'journal-recorded'",
  ])
    expect(registration).toContain(text)
  expect(registration.indexOf("$writers[$key] = $writer")).toBeLessThan(
    registration.indexOf("'journal-recorded'"),
  )
  const cleanup = owner.slice(owner.indexOf("} finally {\n    # All authenticated"))
  let previous = -1
  for (const text of [
    "foreach ($writer in @($writers.Values))",
    "$writer.Kill()",
    "$writer.WaitForExit(1000)",
    "$job.RetireProducers()",
    "$job.Terminate()",
    "$job.Members().Length",
    "if (-not $failed -and -not $remaining -and -not $incomplete)",
    "foreach ($path in @($journals.Keys))",
    "[IO.File]::Delete($path)",
    "[IO.File]::Delete($path + '.tmp')",
    "if (-not $failed -and -not $remaining) { break }",
    "$job.Dispose()",
    "event = 'custody-drained'",
  ]) {
    const index = cleanup.indexOf(text)
    expect(index, text).toBeGreaterThan(previous)
    previous = index
  }
  expect(cleanup).toContain("} catch { $failed = $true }") // Deletion failure retries with authority retained.
  expect(owner).toContain("$null -eq $line") // EOF, explicit end and sentinel death share cleanup.
  expect(owner).toContain("$message.event -ceq 'end'")
  expect(lifetime).not.toContain("Remove-Item")
  expect(client).not.toContain("rmSync")
  expect(client.match(/this\.statePath = join\(/g)).toHaveLength(2)
  for (const source of [owner, client]) {
    expect(source).not.toContain("Get-ChildItem")
    expect(source).not.toContain("[IO.Directory]::GetFiles")
    expect(source).not.toContain("readdir")
  }
})

test("custody source contracts pin local pull-duplication and explicit session-end cleanup", () => {
  const owner = readFileSync(new URL("../helper/custody.ps1", import.meta.url), "utf8")
  const guard = readFileSync(new URL("../helper/launch.ps1", import.meta.url), "utf8")
  const lifetime = readFileSync(new URL("../helper/lifetime.ps1", import.meta.url), "utf8")
  expect(owner).toContain("$sentinel.WaitForExit(0)")
  expect(owner).toContain("$session -cne [string]$message.session")
  expect(owner).toContain("::RetainForCleanup(")
  expect(owner).toContain("$job.Terminate()")
  expect(owner).toContain("$job.Members().Length")
  expect(owner).not.toContain("Read-OwnedJournal")
  expect(owner).not.toContain("CloseTransferredHandle")
  expect(guard).toContain("CreationTime(source.Handle) != sourceStarted")
  expect(guard).toContain("DuplicateHandle(source.Handle, new IntPtr(handle), GetCurrentProcess()")
  expect(guard).toContain("0x000Cu, false, 0)")
  expect(guard).not.toContain("OpenJobObject")
  expect(guard).toContain("if (!custodied)")
  expect(guard).toContain("CreationTime(writer.Handle) != writerStarted")
  expect(guard).toContain("Process.GetProcessById(custodyPid)")
  expect(guard).toContain("CreationTime(owner.Handle) != custodyStarted")
  expect(guard).toContain("out guard.custodyPin")
  const disposal = guard.slice(guard.indexOf("public void Dispose()"))
  expect(disposal).not.toContain("CloseHandle(custodyPin)")
  expect(owner.indexOf("$offers.ContainsKey($token)")).toBeLessThan(owner.indexOf("::RetainForCleanup("))
  expect(owner.indexOf("$job.RetireProducers()")).toBeLessThan(owner.indexOf("$job.Terminate()"))
  expect(owner).toContain("if (-not $failed -and -not $remaining) { break }")
  expect(owner).toContain("retained authority is retrying")
  expect(owner).not.toContain("$attempt -lt 2")
  expect(owner.indexOf("if (-not $failed -and -not $remaining) { break }")).toBeLessThan(
    owner.indexOf("$job.Dispose()"),
  )
  expect(lifetime.indexOf("$job.ConfirmCustody()")).toBeLessThan(lifetime.indexOf("event = 'job-created'"))
})
