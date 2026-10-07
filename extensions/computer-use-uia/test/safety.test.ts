import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source contracts only; never execute PowerShell or touch the desktop.
const helper = readFileSync(new URL("../helper/uia.ps1", import.meta.url), "utf8")
const launch = readFileSync(new URL("../helper/launch.ps1", import.meta.url), "utf8")

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
  const stop = launch.slice(
    launch.indexOf("public void StopHeadless()"),
    launch.indexOf("public int[] Members()"),
  )
  for (const fragment of [
    "member.Handle",
    "member.StartTime.ToUniversalTime().Ticks",
    "IsProcessInJob(handle, job",
    "EnumWindows",
    "IsWindowVisible",
    "if (!visible",
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
    "target.StartTime.ToUniversalTime().Ticks != started",
    "action sent; the target is busy or opened a modal dialog",
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
  expect(launch).toContain("helper.StartTime.ToUniversalTime().Ticks != helperStarted")
  expect(watchdog).toContain("::CreateFor(")
  expect(watchdog).not.toContain("::Open(")
  expect(helper).not.toContain("::Open(")
  expect(helper).toContain("@('overlay_ack', 'job_ack')")
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
  expect(watchdog).toContain("$helper = Get-ExactProcess $script:writerIdentity")
  expect(watchdog).not.toContain("$helper = Get-ExactProcess $state.Helper")
  expect(watchdog).toContain("Stop-CurrentWriter")
  expect(watchdog).toContain("Assert-CurrentWriter $state")
  expect(watchdog).toContain("elseif ($jobs.Count -gt 0)")
  expect(watchdog).toContain("cleanup refused (journal missing)")
})
