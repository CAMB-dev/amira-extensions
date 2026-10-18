import { afterAll, describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@amira/api"
import { type Bundle, type Change, DEEP_CAPS, NORMAL_CAPS, reviewCaps } from "../src/collect.ts"
import { parse } from "../src/command.ts"
import { groupChanges, MAX_GROUPS, runFanout, workflowRunner } from "../src/deep.ts"
import { fakeWorkflow } from "./deep-fixture.ts"
import { bundle, cleanup, temporary } from "./review-fixture.ts"

afterAll(cleanup)
const api = (value: unknown) => ({ useService: () => value }) as Pick<ExtensionAPI, "useService">
function changes(count: number, lines = 2, bytes = 0): Bundle {
  const value = bundle(temporary())
  value.scope.deep = true
  value.changes = Array.from(
    { length: count },
    (_, index): Change => ({
      ...value.changes[0]!,
      path: `dir${index % 3}/file${index}.ts`,
      patch: `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n${Array.from({ length: lines }, (_, line) => `${line % 2 ? "+" : "-"}${"x".repeat(bytes)}`).join("\n")}\n`,
    }),
  )
  value.patch = value.changes.map((change) => change.patch).join("")
  value.added = (count * lines) / 2
  value.removed = (count * lines) / 2
  return value
}

describe("workflow compatibility is structural and fail-closed", () => {
  test("absent or primitive service", () => {
    for (const value of [undefined, null, false, "workflow"])
      expect(() => workflowRunner(api(value))).toThrow("workflow.runner")
  })
  for (const method of ["available", "startBound", "status", "stop", "onProgress", "onResult"] as const) {
    test(`old provider without ${method}`, () => {
      const runner = { ...fakeWorkflow().runner, [method]: undefined }
      expect(() => workflowRunner(api(runner))).toThrow(method)
    })
  }
  for (const flag of ["cwd", "freshRun", "models", "ownedLifetime", "progress"] as const) {
    test(`requires ${flag} exactly true`, () => {
      for (const value of [undefined, false, "true", 1]) {
        const runner = fakeWorkflow().runner
        Reflect.set(runner.capabilities, flag, value)
        expect(() => workflowRunner(api(runner))).toThrow(`capabilities.${flag}=true`)
      }
    })
  }
  test("disabled, throwing availability, and re-discovery", () => {
    const fake = fakeWorkflow()
    expect(workflowRunner(api(fake.runner))).toBe(fake.runner)
    fake.disable()
    expect(() => workflowRunner(api(fake.runner))).toThrow("extensions.workflow.enabled: never")
    fake.runner.available = () => {
      throw new Error("unloaded")
    }
    expect(() => workflowRunner(api(fake.runner))).toThrow("unloaded")
  })
})

describe("bounded deep grouping", () => {
  test("normal/deep caps, exact 128 files and no loss or duplication", () => {
    const value = changes(128)
    expect(reviewCaps({ ...value.scope, deep: false })).toBe(NORMAL_CAPS)
    expect(reviewCaps(value.scope)).toBe(DEEP_CAPS)
    const groups = groupChanges(value)
    expect(groups).toHaveLength(4)
    expect(
      groups
        .flatMap((group) => group.changes)
        .map((change) => change.path)
        .sort(),
    ).toEqual(value.changes.map((change) => change.path).sort())
    for (const group of groups) expect(group.changes.length).toBeLessThanOrEqual(32)
    expect(groupChanges(value)).toEqual(groups)
    expect(groups.length).toBeLessThanOrEqual(MAX_GROUPS)
  })
  test("directory order is stable, same directory remains adjacent", () => {
    const value = changes(6)
    expect(groupChanges(value)[0]!.changes.map((change) => change.path)).toEqual([
      "dir0/file0.ts",
      "dir0/file3.ts",
      "dir1/file1.ts",
      "dir1/file4.ts",
      "dir2/file2.ts",
      "dir2/file5.ts",
    ])
  })
  test("line and byte bin limits split before exceeding normal group caps", () => {
    expect(groupChanges(changes(8, 1000))).toHaveLength(4)
    const value = changes(8, 2, 8000)
    const groups = groupChanges(value)
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) expect(Buffer.byteLength(group.patch)).toBeLessThanOrEqual(64 * 1024)
  })
  test("counts source lines resembling headers", () => {
    const value = changes(2, 1200)
    for (const change of value.changes)
      change.patch = change.patch.replaceAll("-x", "--- text").replaceAll("+x", "+++ text")
    value.patch = value.changes.map((change) => change.patch).join("")
    expect(groupChanges(value)).toHaveLength(2)
  })
  test("rejects total file, line, byte and individual limits without truncation", () => {
    expect(() => groupChanges(changes(129))).toThrow("admission cap")
    expect(() => groupChanges(changes(9, 1000))).toThrow("admission cap")
    const bytes = changes(1)
    bytes.patch = "x".repeat(256 * 1024 + 1)
    expect(() => groupChanges(bytes)).toThrow("admission cap")
    expect(() => groupChanges(changes(1, 2001))).toThrow("per-group line")
    expect(() => groupChanges(changes(1, 2, 16 * 1024))).toThrow("per-file patch")
    expect(groupChanges(changes(0))).toEqual([])
  })
})

test("deep and PR command forms are bounded, explicit, and posting remains unsupported", () => {
  expect(parse("--deep")).toEqual({ action: "choose", deep: true })
  for (const command of [
    "worktree --deep",
    "--deep since HEAD~1",
    "pr 123 --deep --yes",
    "pr https://github.com/owner/repo/pull/12 --path src",
  ]) {
    expect(parse(command).action).toBe("start")
  }
  for (const command of [
    "pr",
    "pr -1",
    "pr 0",
    "pr https://evil.test/a/b/pull/1",
    "pr 1 --post",
    "pr 1 --include-untracked",
    "stop --deep",
  ])
    expect(() => parse(command)).toThrow()
})

test("terminal progress/status does not settle a workflow before onResult and subscriptions are removed", async () => {
  const fake = fakeWorkflow()
  let resultListener: ((value: { runId: string; status: string; result: unknown[] }) => void) | undefined
  let registered!: () => void
  const registration = new Promise<void>((resolve) => {
    registered = resolve
  })
  let removed = 0,
    finished = false,
    progressCount = 0
  fake.runner.startBound = async () => ({ runId: "deep-run" })
  fake.runner.status = () => ({ runId: "deep-run", status: "done", result: [] })
  fake.runner.onProgress = (_id, listener) => {
    queueMicrotask(() => listener({ runId: "deep-run", status: "done" }))
    return () => {
      removed++
    }
  }
  fake.runner.onResult = (_id, listener) => {
    resultListener = listener
    registered()
    return () => {
      removed++
    }
  }
  const promise = runFanout(api(fake.runner), {
    cwd: temporary(),
    origin: "main",
    ownerId: "owner",
    signal: new AbortController().signal,
    args: {},
    createGroup: () => {
      throw new Error("No child needed in settlement-only fixture")
    },
    attached() {},
    progress() {
      progressCount++
    },
  }).then((value) => {
    finished = true
    return value
  })
  await registration
  expect(progressCount).toBe(1)
  expect(finished).toBe(false)
  resultListener!({ runId: "deep-run", status: "done", result: [] })
  expect(await promise).toEqual([])
  expect(removed).toBe(2)
})
