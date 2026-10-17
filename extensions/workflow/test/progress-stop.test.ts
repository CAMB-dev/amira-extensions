import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readJournal } from "../src/journal.ts"
import { type ScriptWorker, WorkflowRun } from "../src/run.ts"
import { fakeGroup } from "./fakes.ts"

test("a progress listener stopping at spawn waits for the call's journal before settlement", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-progress-stop-"))
  const group = fakeGroup({ name: "progress stop" }, () => new Promise(() => {}))
  const run = new WorkflowRun({
    id: "wf_progress_stop",
    dir,
    source: `export const meta = { name: "test", description: "test", phases: [] }
      return await agent("work")`,
    origin: "inline",
    args: null,
    group,
    cwd: dir,
    home: dir,
    roles: () => new Map(),
    git: async () => ({ ok: false, output: "" }),
    loadWorkflow: () => undefined,
    onChange: () => {
      if (group.spawned.length && run.status === "running") run.stop("stopped by progress listener")
    },
  })
  try {
    run.start()
    await run.done
    expect(readJournal(dir)).toMatchObject([{ status: "aborted" }])
    expect(run.record.totals?.byStatus.working).toBe(0)
    expect(run.record.totals?.byStatus.aborted).toBe(1)
  } finally {
    run.stop()
    // Also allow late continuations from a regressed implementation to leave the fixture.
    await Bun.sleep(10)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("terminal script status does not settle a run before its whole group drains", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-group-drain-"))
  const group = fakeGroup({ name: "group drain" }, () => ({ text: "done" }))
  const ended = group.ended.bind(group)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  group.ended = async () => {
    const info = await ended()
    await gate
    return info
  }
  const worker: ScriptWorker = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(message) {
      if (message.t === "run") this.onmessage?.({ data: { t: "done", value: "done" } })
    },
  }
  const run = new WorkflowRun({
    id: "wf_group_drain",
    dir,
    source: 'export const meta = { name: "test", description: "test", phases: [] }; return "done"',
    origin: "inline",
    args: null,
    group,
    cwd: dir,
    home: dir,
    roles: () => new Map(),
    git: async () => ({ ok: false, output: "" }),
    loadWorkflow: () => undefined,
    onChange: () => {},
    worker: () => worker,
  })
  try {
    run.start()
    await Bun.sleep(1)
    expect(run.status).toBe("done")
    expect(run.settled).toBe(false)
    release()
    await run.done
    expect(run.settled).toBe(true)
  } finally {
    release()
    await run.done
    rmSync(dir, { recursive: true, force: true })
  }
})
