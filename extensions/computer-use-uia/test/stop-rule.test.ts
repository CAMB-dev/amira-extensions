import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Offline only: no PowerShell, native APIs, windows, or real process identities.
const launch = readFileSync(new URL("../helper/launch.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n")
const lifetime = readFileSync(new URL("../helper/lifetime.ps1", import.meta.url), "utf8")

type Classifier = (
  pid: number,
  belongs: boolean,
  exited: boolean,
  visible: (pid: number) => boolean,
) => boolean

function productionClassifier(): Classifier {
  const method =
    /public static bool ShouldStopMember\(int pid, bool belongs, bool exited, Func<int, bool> visible\) \{([^{}]+)\}/.exec(
      launch,
    )
  expect(method, "injectable production member classifier").not.toBeNull()
  // Execute the EXACT C# body, not a TypeScript reimplementation. This deliberately
  // tiny expression uses syntax shared by both languages. Native callers are pinned below.
  return new Function("pid", "belongs", "exited", "visible", method![1]!) as Classifier
}

interface FakeProcess {
  pid: number
  parent?: number
  belongs: boolean
  exited?: boolean
  visible: boolean
  minimized?: boolean
  queryFailure?: boolean
}

function classifyTree(tree: FakeProcess[]) {
  const classify = productionClassifier()
  const killed: number[] = []
  const failed: number[] = []
  const queried: number[] = []
  for (const member of tree) {
    try {
      if (
        classify(member.pid, member.belongs, member.exited ?? false, (pid) => {
          queried.push(pid)
          const candidate = tree.find((process) => process.pid === pid)!
          if (candidate.queryFailure) throw new Error("fake window enumeration failure")
          // Visibility is an injected native observation, including restored/minimized windows.
          return candidate.visible
        })
      )
        killed.push(member.pid)
    } catch {
      failed.push(member.pid)
    }
  }
  return { killed, failed, queried }
}

describe("D113 emergency stop member classification (offline production expression)", () => {
  test("a windowed root protects itself, not its windowless child or grandchild", () => {
    const result = classifyTree([
      { pid: 10, belongs: true, visible: true },
      { pid: 11, parent: 10, belongs: true, visible: false },
      { pid: 12, parent: 11, belongs: true, visible: false },
    ])
    expect(result.killed).toEqual([11, 12])
    expect(result.failed).toEqual([])
    expect(result.queried).toEqual([10, 11, 12])
  })

  test("a minimized owned app stays open but its windowless workers do not", () => {
    expect(
      classifyTree([
        { pid: 20, belongs: true, visible: true, minimized: true },
        { pid: 21, parent: 20, belongs: true, visible: false },
        { pid: 22, parent: 21, belongs: true, visible: true, minimized: true },
      ]).killed,
    ).toEqual([21])
  })

  test("a headless root cannot cause a windowed descendant to be killed", () => {
    expect(
      classifyTree([
        { pid: 30, belongs: true, visible: false },
        { pid: 31, parent: 30, belongs: true, visible: true },
        { pid: 32, parent: 31, belongs: true, visible: false },
      ]).killed,
    ).toEqual([30, 32])
  })

  test("foreign processes are never eligible, even descendants of an owned root", () => {
    const result = classifyTree([
      { pid: 40, belongs: true, visible: false },
      { pid: 41, parent: 40, belongs: false, visible: false, queryFailure: true },
      { pid: 42, belongs: false, visible: true },
    ])
    expect(result.killed).toEqual([40])
    expect(result.failed).toEqual([])
    expect(result.queried).toEqual([40])
  })

  test("an exited parent and an unrelated or missing parent grant no protection", () => {
    const result = classifyTree([
      { pid: 50, belongs: true, visible: true, exited: true, queryFailure: true },
      { pid: 51, parent: 50, belongs: true, visible: false },
      { pid: 52, belongs: false, visible: true, queryFailure: true },
      { pid: 53, parent: 52, belongs: true, visible: false },
      { pid: 54, parent: 999, belongs: true, visible: false },
    ])
    expect(result.killed).toEqual([51, 53, 54])
    expect(result.failed).toEqual([])
    expect(result.queried).toEqual([51, 53, 54])
  })

  test("candidate API failure preserves that candidate but not its children or siblings", () => {
    const result = classifyTree([
      { pid: 60, belongs: true, visible: false, queryFailure: true },
      { pid: 61, parent: 60, belongs: true, visible: false },
      { pid: 62, belongs: true, visible: false },
    ])
    expect(result.killed).toEqual([61, 62])
    expect(result.failed).toEqual([60])
  })

  test("a late visible window revokes eligibility on the final classification", () => {
    const classify = productionClassifier()
    expect(classify(70, true, false, () => false)).toBe(true)
    expect(classify(70, true, false, () => true)).toBe(false)
    expect(classify(70, false, false, () => false)).toBe(false)
    expect(classify(70, true, true, () => false)).toBe(false)
  })
})

describe("D113 native caller contracts (static, not Windows verification)", () => {
  const stop = launch.slice(
    launch.indexOf("public void StopHeadless()"),
    launch.indexOf("public int[] Members()"),
  )

  test("both native passes use the injected classifier and no ancestor rule remains", () => {
    expect(stop.match(/ShouldStopMember\(pid, belongs, member.HasExited, Visible\)/g)).toHaveLength(2)
    expect(launch).not.toContain("HeadlessAncestors")
    expect(launch).not.toContain("Dictionary<int, int> Parents()")
    expect(stop).not.toContain("Parents()")
  })

  test("kill authority remains cached-handle identity plus retained job membership", () => {
    expect(stop.match(/IntPtr handle = member.Handle;/g)).toHaveLength(2)
    expect(stop.match(/IsProcessInJob\(handle, job, out belongs\)/g)).toHaveLength(2)
    expect(stop).toContain("started != candidate.Started")
    expect(stop).toContain("!member.HasExited && CreationTime(handle) == started")
    expect(stop).toContain("member.Kill()")
    expect(stop).toContain("member.WaitForExit(1000)")
    expect(stop.match(/catch \(Win32Exception\) \{ failed = true; \}/g)).toHaveLength(2)
    expect(stop.match(/catch \(InvalidOperationException\) \{ \}/g)).toHaveLength(2)
    expect(stop).toContain("if (failed) throw")
    expect(launch).toContain("CreateJobObject(IntPtr.Zero, null)")
    expect(launch).not.toContain("OpenJobObject")
  })

  test("own-PID visibility retains minimized placement, cloaking and alpha rules", () => {
    const visible = launch.slice(
      launch.indexOf("bool Visible(int pid)"),
      launch.indexOf("public static bool ShouldStopMember"),
    )
    expect(visible).toContain("owner == pid && ProtectorWindow(window)")
    expect(visible).toContain("throw new Win32Exception()")
    const window = launch.slice(launch.indexOf("bool ProtectorWindow"), launch.indexOf("bool Visible"))
    expect(window).toContain("IsWindowVisible(window)")
    expect(window).toContain("bool iconic = IsIconic(window)")
    expect(window).toContain("GetWindowPlacement(window, ref placement)")
    expect(window).toContain("rect = placement.NormalPosition")
    expect(window).not.toContain("(styles & 0x80) != 0")
    expect(window).toContain("(cloaked & ~2u) != 0")
    expect(window).toContain("alpha == 0")
    expect(window.match(/if \(!iconic\)/g)).toHaveLength(2)
  })

  test("native window-query failures cannot be mistaken for windowless candidates", () => {
    const window = launch.slice(launch.indexOf("bool ProtectorWindow"), launch.indexOf("bool Visible"))
    expect(window).toContain(
      "if (DwmGetWindowAttribute(window, 14, out cloaked, 4) != 0) throw new Win32Exception();",
    )
    expect(window).toContain("if (!GetWindowRect(window, out rect)) throw new Win32Exception();")
    expect(window).toContain("if (!GetWindowPlacement(window, ref placement)) throw new Win32Exception();")
  })

  test("rootless custody is abandoned only after both cached original producers have exited", () => {
    const match = /bool OriginalProducersExited\(\) \{([^{}]+)\}/.exec(launch)
    expect(match).not.toBeNull()
    const exited = {
      WaitForExit: (ms: number) => {
        expect(ms).toBe(0)
        return true
      },
    }
    const running = {
      WaitForExit: (ms: number) => {
        expect(ms).toBe(0)
        return false
      },
    }
    const check = new Function("custodyWriter", "custodySource", match![1]!) as (
      writer: unknown,
      source: unknown,
    ) => boolean
    expect(check(exited, exited)).toBe(true)
    expect(check(running, exited)).toBe(false)
    expect(check(exited, running)).toBe(false)
    expect(check(null, exited)).toBe(false)
    expect(check(exited, null)).toBe(false)
    expect(() =>
      check(
        {
          WaitForExit() {
            throw new Error("unverifiable")
          },
        },
        exited,
      ),
    ).toThrow("unverifiable")
    expect(match![1]).not.toContain("GetProcessById")
    expect(match![1]).not.toContain("GetExitCodeProcess")
    expect(stop).toContain("if (!OriginalProducersExited())")
    expect(stop).not.toContain("TerminateJobObject")
  })

  test("bounded rescans require an empty completion scan and preserve identity/window rechecks", () => {
    expect(launch).toContain("const int HeadlessScanLimit = 4;")
    expect(launch).toContain("const int HeadlessBudgetMs = 3000;")
    expect(stop).toContain("scan < HeadlessScanLimit")
    expect(stop.indexOf("scan < HeadlessScanLimit")).toBeLessThan(
      stop.indexOf("foreach (int pid in Members())"),
    )
    expect(stop).toContain("if (eligible.Count == 0) break;")
    expect(stop).toContain("scan == HeadlessScanLimit - 1")
    expect(stop.indexOf("scan == HeadlessScanLimit - 1")).toBeLessThan(
      stop.indexOf("foreach (var candidate in eligible)"),
    )
    expect(stop.match(/clock.ElapsedMilliseconds >= HeadlessBudgetMs/g)).toHaveLength(3)
    expect(stop).toContain(
      'if (failed) throw new InvalidOperationException("Headless member cleanup incomplete.")',
    )
  })

  test("launch grace and pending-root preservation remain in place", () => {
    expect(stop).toContain("if (rootPid == 0)")
    expect(stop).toContain("rootStarted < 30000000L")
    expect(stop.indexOf("rootStarted < 30000000L")).toBeLessThan(
      stop.indexOf("foreach (int pid in Members())"),
    )
  })

  test("session end still terminates all retained jobs, without the window classifier", () => {
    const start = lifetime.indexOf("function Stop-RetainedJobs")
    const cleanup = lifetime.slice(start, lifetime.indexOf("\ntry {", start))
    const force = cleanup.slice(cleanup.indexOf("# TerminateJobObject"))
    expect(cleanup).toContain("if (-not $force)")
    expect(cleanup).toContain("$job.StopHeadless()")
    expect(force).toContain("foreach ($job in @($jobs.Values))")
    expect(force).toContain("$job.Terminate()")
    expect(force).toContain("$job.Members().Length")
    expect(force).not.toContain("StopHeadless")
    expect(launch).toContain("TerminateJobObject(job, 1)")
  })
})
