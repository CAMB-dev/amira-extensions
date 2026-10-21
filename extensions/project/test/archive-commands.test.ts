import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  OwnedConversationSnapshot,
  SessionControl,
  SessionData,
} from "@amira/api"
import type { PrototypeManifestArtifact } from "../src/artifacts.ts"
import { ATTACHMENT_KEY, createProjectExtension } from "../src/index.ts"
import { inDirectory, quote } from "../src/iteration-git.ts"
import {
  createProject,
  IterationStore,
  LifecycleStore,
  ProjectDocumentStore,
  projectLifecycle,
  Registry,
  readProject,
} from "../src/store.ts"
import { ownedFixture, zeroUsage } from "./owned-fixture.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const receipt = { id: "human", sessionId: "main", date: "2026-10-21T00:00:00Z" }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "project-archive-commands-"))
  roots.push(root)
  const project = await createProject(root, "Lifecycle commands", { language: "en" })
  await new IterationStore(project).read()
  const dataRoot = await mkdtemp(path.join(tmpdir(), "project-archive-data-"))
  roots.push(dataRoot)
  const records = new Map<string, unknown[]>()
  const data: SessionData = {
    append(key, value) {
      records.set(key, [...(records.get(key) ?? []), structuredClone(value)])
    },
    read(key) {
      return structuredClone(records.get(key) ?? [])
    },
  }
  data.append(ATTACHMENT_KEY, { projectId: project.marker.id, root: project.root, attachedAt: receipt.date })
  let sessionId = "main"
  const session = {
    info: () => ({ id: sessionId, cwd: root, busy: false }),
    data,
    messages: () => [],
  } as unknown as SessionControl
  let command!: CommandDefinition
  const calls: string[] = []
  const api = {
    apiVersion: "0.1.65",
    cwd: root,
    dataDir: dataRoot,
    session: () => session,
    settings: { declare: () => ({ get: () => ({ language: "en" }), onChange: () => () => {} }) },
    registerCommand(value: CommandDefinition) {
      command = value
    },
    registerPanel() {},
    on: () => () => {},
    requestRender() {},
    notify() {},
    reportError() {},
    conversations: {
      read: async () => {
        calls.push("read")
        return undefined
      },
      archive: async () => {
        calls.push("archive")
      },
      unarchive: async () => {
        calls.push("unarchive")
      },
      open: async () => {
        throw new Error("Unexpected executable open")
      },
      openOrCreate: async () => {
        throw new Error("Unexpected executable open")
      },
    },
  } as unknown as ExtensionAPI
  await createProjectExtension()(api)
  let confirm = true
  let onConfirm: (() => Promise<void> | void) | undefined
  let confirmWhen: ((title: string, body: string) => boolean) | undefined
  const output: { text: string; level?: string }[] = []
  const ctx = {
    cwd: root,
    frontend: "print",
    signal: new AbortController().signal,
    session,
    ui: {
      confirm: async (title: string, body: string) => {
        await onConfirm?.()
        return confirmWhen ? confirmWhen(title, body) : confirm
      },
      select: async () => undefined,
    },
    print: (text: string, level?: string) => output.push({ text, level }),
  } as unknown as CommandContext
  return {
    project,
    api,
    command,
    ctx,
    calls,
    output,
    confirm(value: boolean, hook?: () => Promise<void> | void) {
      confirm = value
      confirmWhen = undefined
      onConfirm = hook
    },
    confirmWhen(fn: (title: string, body: string) => boolean) {
      confirmWhen = fn
      onConfirm = undefined
    },
    switchSession() {
      sessionId = "other-main"
    },
  }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await snapshot(file)))
        result[`${entry.name}/${name}`] = content
    } else result[entry.name] = (await readFile(file)).toString("base64")
  }
  return result
}

test("archived stale attachment status/cost/history and explicit lookup are inert", async () => {
  const f = await fixture()
  await new Registry(f.api.dataDir).remember(f.project)
  await new LifecycleStore(f.project).transition(0, { type: "archive-pending", receipt })
  await new LifecycleStore(f.project).transition(1, { type: "archived", receipt })
  const before = await snapshot(f.project.root)
  const registryBefore = await snapshot(f.api.dataDir)
  for (const args of [
    "status",
    "cost",
    "iteration 1",
    "ship status",
    "list --archived",
    `switch ${f.project.marker.id}`,
  ])
    await f.command.run(args, f.ctx)
  expect(f.output.filter((row) => row.level === "error")).toEqual([])
  expect(f.output.map((row) => row.text).join("\n")).toContain("archived")
  expect(f.calls).toEqual([])
  expect(await snapshot(f.project.root)).toEqual(before)
  expect(await snapshot(f.api.dataDir)).toEqual(registryBefore)
  await f.command.run("design", f.ctx)
  expect(f.output.at(-1)?.level).toBe("error")
  expect(f.calls).toEqual([])
})

test("archive cancellation and stale dialog do not publish a fence", async () => {
  const f = await fixture()
  f.confirm(false)
  await f.command.run("archive", f.ctx)
  expect(projectLifecycle(await readProject(f.project.root)).status).toBe("active")
  f.confirm(true, () => f.switchSession())
  await f.command.run("archive", f.ctx)
  expect(f.output.at(-1)?.level).toBe("error")
  expect(projectLifecycle(await readProject(f.project.root)).status).toBe("active")
  expect(f.calls).toEqual([])
})

test("restore requires a fresh explicit continuation even without a saved design conversation", async () => {
  const f = await fixture()
  await f.command.run("archive", f.ctx)
  await f.command.run("restore", f.ctx)
  const restored = await readProject(f.project.root)
  expect(projectLifecycle(restored).iterations[1]?.continuationRequired).toBe(true)
  await f.command.run("cost cap 1", f.ctx)
  expect(f.output.at(-1)?.level).toBe("error")
  expect(f.output.at(-1)?.text).toMatch(/continu/i)
  await f.command.run("iteration continue", f.ctx)
  expect(f.output.at(-1)?.level).not.toBe("error")
  expect(
    projectLifecycle(await readProject(f.project.root)).iterations[1]?.continuationRequired,
  ).toBeUndefined()
  expect(f.calls.filter((call) => call !== "read")).toEqual([])
})

test("successful lifecycle retry does not let historical failure block cleanup inspection", async () => {
  const f = await fixture()
  await new LifecycleStore(f.project).transition(0, { type: "ship", status: "skipped", receipt })
  const closed = await new LifecycleStore(f.project).transition(1, { type: "close", receipt })
  await new ProjectDocumentStore(closed).update(
    "lifecycle-operations.json",
    () => ({
      schemaVersion: 1,
      projectId: f.project.marker.id,
      operations: ["failed", "completed"].map((status, index) => ({
        id: `close-${index}`,
        action: "close",
        iteration: 1,
        receipt,
        status,
        pid: process.pid,
        owners: [],
        errors: status === "failed" ? ["old failure"] : [],
      })),
    }),
    { administrative: true },
  )
  f.confirm(false)
  await f.command.run("iteration cleanup worktree", f.ctx)
  expect(f.output.at(-1)?.level).not.toBe("error")
  expect(f.calls).toEqual([])
})

async function cleanupFixture() {
  const f = await fixture()
  Object.assign(f.ctx.session, { subagents: () => [], groups: () => [] })
  const store = new IterationStore(f.project)
  const variants: PrototypeManifestArtifact["variants"] = []
  for (const id of ["alpha", "beta"]) {
    const directory = await store.preparePrototypeDirectory(id)
    await writeFile(path.join(directory, "demo.js"), `// ${id}\n`)
    variants.push({
      id,
      idea: id,
      question: "Try?",
      directory,
      cwd: directory,
      runCommand: "bun demo.js",
      prerequisites: [],
      notes: "",
      status: "ready" as const,
    })
  }
  const saved = await store.saveArtifact(0, { kind: "prototype-manifest", variants })
  await new LifecycleStore(f.project).transition(0, { type: "ship", status: "skipped", receipt })
  await new LifecycleStore(f.project).transition(1, { type: "close", receipt })
  const owners = new Map<string, OwnedConversationSnapshot>()
  const commands: string[] = []
  f.api.conversations!.read = async (ref) =>
    structuredClone(
      "key" in ref ? owners.get(ref.key) : [...owners.values()].find((owner) => owner.id === ref.id),
    )
  f.api.conversations!.archive = async (ref) => {
    const owner =
      "key" in ref ? owners.get(ref.key) : [...owners.values()].find((owner) => owner.id === ref.id)
    if (!owner) throw new Error("Missing test owner")
    owner.archived = true
  }
  f.api.conversations!.openOrCreate = async (spec) => {
    const id = `cleanup-${owners.size}`
    owners.set(spec.key, {
      id,
      key: spec.key,
      name: spec.name,
      cwd: spec.cwd,
      archived: false,
      history: [],
      usage: zeroUsage(id),
    })
    const handle = ownedFixture(spec, id)
    handle.runTool = async (name, input) => {
      const command = (input as { command: string }).command
      const variant = variants.find(
        (entry) =>
          command === inDirectory(f.project.root, `rm -r -- ${quote(entry.directory, "bash")}`, "bash"),
      )
      if (name !== "bash" || !variant) throw new Error("Unexpected cleanup command")
      commands.push(command)
      await rm(variant.directory, { recursive: true })
      return { content: [{ type: "text", text: "" }], details: { exitCode: 0 } }
    }
    return handle
  }
  return { ...f, variants, commands, saved }
}

test("prototype cleanup retry skips removed alpha and can reach retained beta", async () => {
  const f = await cleanupFixture()
  const before = await readFile(
    path.join(
      f.project.root,
      ".amira",
      "project",
      "iterations",
      "1",
      "artifacts",
      path.basename(f.saved.artifact.path),
    ),
    "utf8",
  )
  f.confirmWhen(
    (title, body) => title !== "Delete prototype code" || body.startsWith(f.variants[0]!.directory),
  )
  await f.command.run("iteration cleanup prototypes", f.ctx)
  expect(f.output.filter((row) => row.level === "error")).toEqual([])
  expect(f.commands).toHaveLength(1)
  f.confirm(true)
  await f.command.run("iteration cleanup prototypes", f.ctx)
  expect(f.output.filter((row) => row.level === "error")).toEqual([])
  expect(f.commands).toHaveLength(2)
  expect(f.output.some((row) => row.text.includes("alpha: removed — already removed"))).toBe(true)
  expect(
    await readFile(
      path.join(
        f.project.root,
        ".amira",
        "project",
        "iterations",
        "1",
        "artifacts",
        path.basename(f.saved.artifact.path),
      ),
      "utf8",
    ),
  ).toBe(before)
}, 60000)

for (const reason of ["main-cwd", "live-group", "unknown-inventory", "unverified-foreign-users"] as const) {
  test(`cleanup retains code for ${reason}`, async () => {
    const f = await cleanupFixture()
    if (reason === "main-cwd") Object.assign(f.ctx, { cwd: f.variants[0]!.directory })
    if (reason === "live-group") Object.assign(f.ctx.session, { groups: () => [{ state: "active" }] })
    if (reason === "unknown-inventory") Object.assign(f.ctx.session, { subagents: undefined })
    if (reason === "unverified-foreign-users")
      f.confirmWhen((title) => title !== "Verify no other resource users")
    await f.command.run("iteration cleanup prototypes", f.ctx)
    expect(f.commands).toEqual([])
    expect(await readFile(path.join(f.variants[0]!.directory, "demo.js"), "utf8")).toContain("alpha")
    if (reason !== "unverified-foreign-users") {
      expect(f.output.at(-1)?.level).toBe("error")
      expect(f.output.at(-1)?.text).toMatch(
        {
          "main-cwd": /live user/,
          "live-group": /children\/groups/,
          "unknown-inventory": /resource use is active or unavailable/,
        }[reason],
      )
    } else expect(f.output.filter((row) => row.level === "error")).toEqual([])
  }, 60000)
}

test("a changed stage journal invalidates an open closure confirmation before the admission fence", async () => {
  const f = await fixture()
  await new LifecycleStore(f.project).transition(0, { type: "ship", status: "skipped", receipt })
  f.confirm(true, async () => {
    const store = new IterationStore(await readProject(f.project.root))
    await store.saveArtifact(0, {
      kind: "stage-summary",
      stage: "design",
      language: "en",
      summary: "Changed during dialog",
      outputs: [],
      suggestion: "Review again",
    })
  })
  await f.command.run("iteration close", f.ctx)
  expect(f.output.at(-1)?.level).toBe("error")
  expect(f.output.at(-1)?.text).toContain("Stage changed")
  expect(projectLifecycle(await readProject(f.project.root)).iterations[1]?.status).toBe("open")
  expect(f.calls).toEqual([])
}, 60000)

test("cleanup retains by default and cancelled inspection opens no tool owner", async () => {
  const f = await fixture()
  await new LifecycleStore(f.project).transition(0, { type: "ship", status: "skipped", receipt })
  await new LifecycleStore(f.project).transition(1, { type: "close", receipt })
  const before = await snapshot(f.project.root)
  await f.command.run("iteration cleanup", f.ctx)
  expect(f.output.at(-1)?.text).toContain("Resources retained")
  f.confirm(false)
  await f.command.run("iteration cleanup worktree", f.ctx)
  expect(f.calls).toEqual([])
  expect(await snapshot(f.project.root)).toEqual(before)
})

test("close then explicitly initialize iteration two without execution", async () => {
  const f = await fixture()
  await new LifecycleStore(f.project).transition(0, { type: "ship", status: "skipped", receipt })
  await f.command.run("iteration close", f.ctx)
  expect(f.output.at(-1)?.level).not.toBe("error")
  let current = await readProject(f.project.root)
  expect(projectLifecycle(current).iterations[1]?.status).toBe("closed")
  expect(current.marker.currentIteration).toBe(1)
  f.confirm(false)
  await f.command.run("iteration new", f.ctx)
  expect((await readProject(f.project.root)).marker.currentIteration).toBe(1)
  f.confirm(true)
  await f.command.run("iteration new", f.ctx)
  current = await readProject(f.project.root)
  expect(current.marker.currentIteration).toBe(2)
  expect((await new IterationStore(current).read()).attempts).toEqual([])
  expect(f.calls.filter((call) => call !== "read")).toEqual([])
})
