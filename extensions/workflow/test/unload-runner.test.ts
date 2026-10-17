import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@amira/api"
import { createWorkflowExtension } from "../src/index.ts"
import type { WorkflowRunner } from "../src/runner.ts"
import { fakeGroup } from "./fakes.ts"

test("unload immediately revokes retained runner handles without dashboard polling or exit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-unload-runner-"))
  const services = new Map<string, unknown>()
  const unloads: (() => void)[] = []
  const exits: (() => unknown)[] = []
  let groups = 0
  const api = {
    cwd: dir,
    home: dir,
    settings: { extensions: { workflow: { enabled: "always" } } },
    provideService(name: string, service: unknown) {
      services.set(name, service)
      return () => services.delete(name)
    },
    useService: (name: string) => services.get(name),
    onUnload: (handler: () => void) => unloads.push(handler),
    onExit: (handler: () => unknown) => exits.push(handler),
    on: () => () => {},
    intercept: () => () => {},
    registerCommand: () => () => {},
    registerView: () => () => {},
    registerTool: () => () => {},
    registerToolRenderer: () => () => {},
    registerStatusItem: () => () => {},
    requestRender: () => {},
    reportError: () => {},
    notify: () => {},
    ui: { confirm: async () => true },
  } as unknown as ExtensionAPI
  createWorkflowExtension()(api)
  const runner = services.get("workflow.runner") as WorkflowRunner
  const signal = new AbortController().signal
  const createGroup = () => {
    groups++
    return fakeGroup({ name: "unloaded" }, () => ({ text: "unexpected" }))
  }
  const request = {
    script: 'export const meta = { name: "test", description: "test", phases: [] }; return "done"',
    startedBy: { sessionId: "owner", label: "owner" },
  }
  try {
    // The real host runs unload hooks and removes registrations, but does not run exit hooks.
    for (const unload of unloads) unload()
    services.clear()
    const bound = await runner.startBound(
      { ...request, cwd: dir },
      { sessionId: "owner", label: "owner", signal, createGroup },
    )
    const legacy = await runner.start(request, {
      cwd: dir,
      toolCallId: "unload-test",
      signal,
      update: () => {},
      session: {
        sessionId: "owner",
        depth: 0,
        maxDepth: 3,
        model: { provider: "mock", model: "test" },
        deferredTools: () => [],
        loadTools: () => [],
        createGroup,
      },
    })
    expect(bound).toHaveProperty("error")
    expect(legacy).toHaveProperty("error")
    expect(groups).toBe(0)
  } finally {
    for (const exit of exits) await exit()
    rmSync(dir, { recursive: true, force: true })
  }
})
