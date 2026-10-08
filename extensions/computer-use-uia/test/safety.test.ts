import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"

// Source contracts only; never execute PowerShell or touch the desktop.
const helper = readFileSync(new URL("../helper/uia.ps1", import.meta.url), "utf8")
const launch = readFileSync(new URL("../helper/launch.ps1", import.meta.url), "utf8")

test("every PowerShell helper is pure ASCII, including model-visible strings", () => {
  const directory = new URL("../helper/", import.meta.url)
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".ps1")))
    expect(readFileSync(new URL(name, directory)).some((byte) => byte > 127), name).toBe(false)
})

test("no startup sweep can consume another client's journal", () => {
  expect(helper).not.toContain("Clear-StaleJournals")
  expect(helper).not.toContain("[IO.Directory]::GetFiles")
})

test("committed launches cannot silently break away from their job", () => {
  expect(launch).not.toContain("0x1000u")
  expect(launch).not.toContain("Limits(false)")
})

const journal = readFileSync(new URL("../helper/journal.ps1", import.meta.url), "utf8")
const watchdog = readFileSync(new URL("../helper/lifetime.ps1", import.meta.url), "utf8")

test("every journal reader verifies exact content before parsing identities and all MAC bytes", () => {
  expect(journal).toContain("Get-JournalMac $envelope.Content")
  expect(journal).toContain("$i -lt 32; $i++")
  expect(journal).toContain("$difference = $difference -bor ($actual[$i] -bxor $expected[$i])")
  expect(journal.indexOf("if ($difference -ne 0)")).toBeLessThan(
    journal.indexOf("$state = $envelope.Content | ConvertFrom-Json"),
  )
  expect(helper).toContain("Read-JournalKey $reader")
  expect(watchdog).toContain("Read-JournalKey $reader")
  expect(helper).not.toMatch(/ReadAllText\(\$StatePath\)/)
  expect(watchdog).not.toMatch(/ReadAllText\(\$StatePath\)/)
  expect(journal).toContain("untrusted launch journal; cleanup refused")
})

test("headless stop checks exact handle identity and job membership, not image names", () => {
  const stop = launch.slice(launch.indexOf("bool Visible(int pid)"), launch.indexOf("public int[] Members()"))
  for (const fragment of [
    "member.Handle",
    "CreationTime(handle)",
    "IsProcessInJob(handle, job",
    "EnumWindows",
    "IsWindowVisible",
    "HeadlessAncestors(pid, started",
    "parentStarted > started",
    "parentStarted != rootStarted",
    "rootStarted < 30000000L",
    "still starting",
    "member.Kill()",
  ])
    expect(stop).toContain(fragment)
  expect(helper + watchdog + launch).not.toMatch(/taskkill|Stop-Process\s+-Name/)
})

test("modal patterns run on a bounded background thread and retain target checks", () => {
  for (const fragment of [
    "worker.IsBackground = true",
    "worker.Join(5000)",
    "RawViewWalker.GetParent",
    "Native.GetAncestor",
    "Native.CreationTime(handle) != started",
    "action timed out; it may still be running or the target may be busy",
  ])
    expect(helper).toContain(fragment)
  for (const action of ["invoke", "toggle", "select", "expand", "collapse", "value"])
    expect(helper).toContain(`$pattern '${action}'`)
  const finallyBlock = helper.slice(helper.lastIndexOf("} finally {"))
  expect(finallyBlock).not.toContain("Stop-ExactProcess")
  expect(finallyBlock).not.toContain(".Terminate()")
  expect(watchdog).not.toContain("$helperDead")
})

test("refusing edited journals cannot implicitly kill apps; job objects cannot be rebound by name", () => {
  expect(launch).toContain("limits.Basic.Flags = 0u")
  expect(launch).not.toContain("0x2000u")
  expect(launch).not.toContain("OpenJobObject")
  expect(launch).toContain("CreateJobObject(IntPtr.Zero, null)")
  expect(launch).toContain("DuplicateHandle(GetCurrentProcess(), guard.job, target")
  expect(launch).toContain("CreationTime(target) != helperStarted")
  expect(watchdog).toContain("::CreateFor(")
  expect(watchdog).not.toContain("::Open(")
  expect(helper).not.toContain("::Open(")
  expect(helper).toContain("@('overlay_ack', 'job_ack', 'root_ack', 'writer_ack')")
})

test("session nonce and exact path are authenticated and untrusted job names are never adopted", () => {
  expect(journal).toContain("$state.Nonce = $script:journalNonce")
  expect(journal).toContain("$state.StatePath = $path")
  expect(journal).toContain("$state.Nonce -cne $script:journalNonce -or $state.StatePath -cne $path")
  expect(helper).toContain("if ($null -ne $previous)")
  const create = watchdog.slice(
    watchdog.indexOf("elseif ($message.event -ceq 'create-job')"),
    watchdog.indexOf("elseif ($message.event -ceq 'stop')"),
  )
  expect(create).not.toContain("Read-OwnedJournal")
  expect(create).toContain("if (-not $writerAccepted)")
  expect(create).toContain("::CreateFor($message.job, [int]$script:writerIdentity.Pid")
})

test("all process identities use raw native UTC FILETIME, never ambiguous local StartTime", () => {
  const overlay = readFileSync(new URL("../helper/overlay.ps1", import.meta.url), "utf8")
  expect(helper + watchdog + launch + overlay).not.toContain(".StartTime.ToUniversalTime()")
  expect(launch).toContain("guard.Started = CreationTime(guard.process)")
  for (const source of [helper, launch, overlay]) {
    expect(source).toContain("GetProcessTimes(")
    expect(source).toContain("return created;")
  }
})

test("PowerShell and TypeScript accept the same opaque job IDs", () => {
  const pattern = /\$name -cnotmatch '([^']+)'/.exec(journal)?.[1]
  expect(pattern).toBeDefined()
  const validator = new RegExp(pattern!)
  expect(validator.test(`amira-uia-job-${crypto.randomUUID()}`)).toBe(true)
  expect(validator.test(`Local\\amira-uia-job-${crypto.randomUUID()}`)).toBe(false)
})

test("cleanup pins the actual writer independently of replayable signed journal content", () => {
  expect(watchdog).toContain("$message.event -ceq 'writer'")
  expect(watchdog).toContain("$script:writerIdentity = $identity")
  expect(watchdog).toContain("Stop-HelperIdentity $script:writerIdentity")
  expect(watchdog).toContain("$helper = Get-ExactProcess $identity")
  expect(watchdog).not.toContain("$helper = Get-ExactProcess $state.Helper")
  expect(watchdog).toContain("Stop-CurrentWriter")
  expect(watchdog).toContain("Assert-CurrentWriter $snapshot")
  expect(watchdog).toContain("try { Stop-RetainedJobs $force $state }")
  expect(watchdog).not.toContain("elseif ($jobs.Count -gt 0)")
  expect(watchdog).toContain("$writerAccepted -or [int]$message.pid -ne $expectedHelperPid")
  expect(watchdog).toContain("[int]$message.generation -ne $helperGeneration")
  expect(watchdog).toContain("$verified = Get-ExactProcess $identity")
})
