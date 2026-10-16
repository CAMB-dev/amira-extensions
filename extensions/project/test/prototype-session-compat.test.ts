import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext, ExtensionAPI, OwnedConversation } from "@amira/api"
import { PrototypeSessions, validatePrototypeReport } from "../src/prototype-sessions.ts"
import { createProject, IterationStore } from "../src/store.ts"
import { hostDescribe, loadHostModule, requireHostModule } from "./amira-source.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(60_000)
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), "prototype-session-compat-"))
  cleanups.push(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, "project")
  await mkdir(root)
  const project = await createProject(root, "Session compatibility")
  const store = new IterationStore(project)
  const summary = await store.saveArtifact(0, {
    kind: "stage-summary",
    stage: "design",
    language: "en",
    summary: "Skip design",
    outputs: [],
    suggestion: "Try prototypes",
  })
  let state = await store.dispatch(summary.state.revision, {
    type: "prepare-summary",
    expectedRevision: summary.state.revision,
    artifact: summary.artifact,
  })
  state = await store.dispatch(state.revision, {
    type: "propose-transition",
    expectedRevision: state.revision,
    proposal: {
      id: "skip-design",
      from: "design",
      to: "prototype",
      kind: "skip",
      summaryId: state.summaryId!,
      skippedStages: ["design"],
      suggestion: "Try prototypes",
    },
  })
  await store.dispatch(state.revision, {
    type: "confirm-transition",
    expectedRevision: state.revision,
    receipt: human(state, "skip-design", "prototype"),
  })
  const directory = await store.preparePrototypeDirectory("alpha")
  return {
    temporary,
    project,
    store,
    directory,
    variant: { id: "alpha", idea: "A local control", question: "Is it clear?", directory },
  }
}

for (const cwd of ["root", "below"] as const) {
  test(`report rejects a variant root redirected into production with cwd ${cwd}`, async () => {
    const f = await fixture()
    const production = path.join(f.project.root, "production")
    await mkdir(path.join(production, "nested"), { recursive: true })
    await rename(f.directory, `${f.directory}-original`)
    await symlink(production, f.directory, process.platform === "win32" ? "junction" : "dir")
    await expect(
      validatePrototypeReport(
        {
          runCommand: "bun main.ts",
          cwd: cwd === "root" ? f.directory : path.join(f.directory, "nested"),
          prerequisites: [],
          notes: "A local control",
        },
        f.directory,
      ),
    ).rejects.toThrow(/variant|canonical|redirect/i)
  })
}

test("report rejects redirected ancestors but accepts canonical root and nested cwd", async () => {
  const f = await fixture()
  const nested = path.join(f.directory, "nested")
  await mkdir(nested)
  for (const cwd of [f.directory, nested]) {
    const report = { runCommand: "bun main.ts", cwd, prerequisites: [], notes: "A local control" }
    expect(await validatePrototypeReport(report, f.directory)).toEqual(report)
  }
  const iteration = path.dirname(f.directory)
  await rename(iteration, `${iteration}-original`)
  await symlink(`${iteration}-original`, iteration, process.platform === "win32" ? "junction" : "dir")
  await expect(
    validatePrototypeReport(
      { runCommand: "bun main.ts", cwd: nested, prerequisites: [], notes: "A local control" },
      f.directory,
    ),
  ).rejects.toThrow(/variant|canonical|redirect/i)
})

test("historical prototype artifacts remain readable after disposable output is removed", async () => {
  const f = await fixture()
  const artifact = {
    kind: "prototype-manifest" as const,
    variants: [
      {
        ...f.variant,
        cwd: f.directory,
        runCommand: "bun main.ts",
        prerequisites: [],
        notes: "A local control",
        status: "ready" as const,
      },
    ],
  }
  const saved = await f.store.saveArtifact((await f.store.read()).revision, artifact)
  await rm(f.directory, { recursive: true })
  expect(await f.store.readArtifact(saved.artifact)).toEqual(artifact)
})

const [core, ai, apiModule, builtin] = await Promise.all([
  loadHostModule<typeof import("@amira/core")>("packages/core/src/index.ts", [
    "Agent",
    "AgentTree",
    "OwnedConversationManager",
    "ToolRegistry",
    "InterceptorRegistry",
  ]),
  loadHostModule<typeof import("@amira/ai")>("packages/ai/src/index.ts", ["createAi", "createMockDialect"]),
  loadHostModule<{ API_VERSION: string }>("packages/api/src/index.ts", ["API_VERSION"]),
  loadHostModule<{ applyPatchTool: import("@amira/api").ToolDefinition }>(
    "extensions/builtin-tools/src/apply-patch.ts",
    ["applyPatchTool"],
  ),
])
const available = [core, ai, apiModule, builtin].find((entry) => entry.module === undefined)

async function hostFixture() {
  const f = await fixture()
  const { Agent, AgentTree, OwnedConversationManager, ToolRegistry, InterceptorRegistry } =
    requireHostModule(core)
  const { createAi, createMockDialect } = requireHostModule(ai)
  const mock = createMockDialect([])
  const model = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://offline.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  tools.register(requireHostModule(builtin).applyPatchTool, "builtin-tools")
  const interceptors = new InterceptorRegistry()
  const tree = new AgentTree({ ai: model, sections: () => [] })
  let approvals = 0
  const main = new Agent({
    ai: model,
    model: model.model("mock/test"),
    cwd: f.project.root,
    tools,
    tree,
    interceptors,
    sections: [],
    providerSettings: { mock: { tools: { edit: "both" } } },
    approve: async () => {
      approvals++
      return { approved: true }
    },
  })
  cleanups.push(() => main.dispose())
  const manager = new OwnedConversationManager({
    ai: model,
    tools,
    tree,
    home: path.join(f.temporary, "owned-home"),
    agent: () => main,
  })
  cleanups.push(() => manager.drain())
  const conversations = manager.forOwner("project")
  const api = {
    apiVersion: requireHostModule(apiModule).API_VERSION,
    dataDir: path.join(f.temporary, "extension-data"),
    conversations,
    intercept: (point, handler, options) => interceptors.add(point, handler, options, "project"),
  } as ExtensionAPI
  const output: string[] = []
  const ctx = {
    print: (text: string) => output.push(text),
    focusConversation: () => true,
    ui: { ask: async () => undefined },
  } as unknown as CommandContext
  const key = `${f.project.marker.id}/iteration/1/prototype/alpha`
  const mappingFile = path.join(
    api.dataDir,
    "prototype-conversations",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  )
  return { ...f, api, ctx, conversations, output, mock, key, mappingFile, approvals: () => approvals }
}

function patch(file: string, before: string, after: string) {
  return { patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch` }
}

async function assertPatchCeiling(f: Awaited<ReturnType<typeof hostFixture>>, handle: OwnedConversation) {
  const sibling = await f.store.preparePrototypeDirectory("beta")
  const inside = path.join(f.directory, "sentinel.txt")
  const beside = path.join(sibling, "sentinel.txt")
  const production = path.join(f.project.root, "sentinel.txt")
  for (const file of [inside, beside, production]) await writeFile(file, "unchanged\n")
  // This is the actual registered builtin on the host's owned tool path, including approval.
  const allowed = await handle.runTool("apply_patch", patch("sentinel.txt", "unchanged", "patched"))
  expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true)
  expect(await readFile(inside, "utf8")).toBe("patched\n")
  expect(f.approvals()).toBeGreaterThan(0)
  for (const file of [beside, production]) {
    const denied = await handle.runTool("apply_patch", patch(file, "unchanged", "ESCAPED"))
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toMatch(/outside|writeRoots|write.root|ceiling/i)
    expect(await readFile(file, "utf8")).toBe("unchanged\n")
  }
  expect((await handle.runTool("patch", patch("sentinel.txt", "patched", "wrong tool"))).isError).toBe(true)
  expect(f.mock.requests).toHaveLength(0)
}

hostDescribe("prototype owned-conversation compatibility", available ?? { module: true }, () => {
  test("new sessions keep the canonical key and execute real apply_patch only in-root", async () => {
    const f = await hostFixture()
    const handle = await new PrototypeSessions(f.api).open(f.project, f.variant, f.ctx, "en", () => {})
    expect(handle.key).toBe(f.key)
    await assertPatchCeiling(f, handle)
    const saved = JSON.parse(await readFile(f.mappingFile, "utf8"))
    expect(saved.policy).toBe("apply_patch-v1")
    expect(saved.id).toBe(handle.id)
  })

  test("legacy patch sessions migrate visibly on edit, retaining the old transcript and deterministic mapping", async () => {
    const f = await hostFixture()
    const old = await f.conversations.openOrCreate(
      {
        key: f.key,
        name: "Legacy prototype",
        cwd: f.directory,
        writeRoots: [f.directory],
        callableTools: ["patch"],
        systemPrompt: "Legacy prototype",
      },
      { askUser: async () => undefined },
    )
    f.mock.push({ text: "Historical prototype report and discussion" })
    await old.send("Keep this original human discussion")
    const history = old.history()
    await old.release()
    await mkdir(path.dirname(f.mappingFile), { recursive: true })
    await writeFile(
      f.mappingFile,
      JSON.stringify({ key: f.key, root: f.project.root, directory: f.directory, id: old.id }),
    )
    const sessions = new PrototypeSessions(f.api)
    const historical = await sessions.inspect(f.project, f.variant, f.ctx, "en")
    expect(historical?.id).toBe(old.id)
    expect(historical?.history()).toEqual(history)
    expect(f.output).toHaveLength(0)
    const replacement = await sessions.open(f.project, f.variant, f.ctx, "en", () => {})
    expect(replacement.id).not.toBe(old.id)
    expect(replacement.key).toBe(`${f.key}/policy/apply_patch-v1`)
    expect(replacement.history()).toHaveLength(0)
    expect(f.output.join("\n")).toMatch(/new.*conversation|new.*session/i)
    expect(f.output.join("\n")).toContain(old.id)
    expect(f.output.join("\n")).toContain(replacement.id)
    const saved = JSON.parse(await readFile(f.mappingFile, "utf8"))
    expect(saved).toMatchObject({
      key: f.key,
      id: replacement.id,
      policy: "apply_patch-v1",
      sessionKey: replacement.key,
      previous: { id: old.id, key: f.key },
    })
    await replacement.release()
    const reopened = await new PrototypeSessions(f.api).open(f.project, f.variant, f.ctx, "en", () => {})
    expect(reopened.id).toBe(replacement.id)
    expect(JSON.parse(await readFile(f.mappingFile, "utf8"))).toEqual(saved)
    const original = await f.conversations.open(old.id, { askUser: async () => undefined })
    expect(original.key).toBe(f.key)
    expect(original.history()).toEqual(history)
    expect((await original.runTool("apply_patch", patch("sentinel.txt", "unchanged", "wrong"))).isError).toBe(
      true,
    )
    await original.release()
    // Migration and reopen are inert: only the explicit legacy turn reached the model.
    expect(f.mock.requests).toHaveLength(1)
    f.mock.requests.splice(0)
    await assertPatchCeiling(f, reopened)
  })
})
