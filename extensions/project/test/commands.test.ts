import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  ExtensionAPI,
  Message,
  PanelDefinition,
  SessionControl,
  SessionData,
} from "@amira/api"
import { ATTACHMENT_KEY, createProjectExtension, panelLines, restoreAttachment, words } from "../src/index.ts"
import { conversationLanguage, resolveLanguage } from "../src/language.ts"
import { createProject, Registry } from "../src/store.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "project-commands-"))
  roots.push(root)
  return root
}
function sessionData(): SessionData {
  const records = new Map<string, unknown[]>()
  return {
    append(key, value) {
      records.set(key, [...(records.get(key) ?? []), structuredClone(value)])
    },
    read(key) {
      return structuredClone(records.get(key) ?? [])
    },
  }
}
async function fixture(extensionLanguage = "en") {
  const root = await directory()
  const cwd = path.join(root, "work")
  await mkdir(cwd)
  let id = "main-1"
  let data = sessionData()
  const output: { text: string; persist?: boolean; level?: string }[] = []
  let command!: CommandDefinition
  let panel!: PanelDefinition
  let select: string | undefined
  let pick: ((labels: string[]) => Promise<string | undefined>) | undefined
  const session = {
    info: () => ({ id, cwd, file: path.join(root, `${id}.jsonl`), busy: false }),
    get data() {
      return data
    },
    messages: () => [] as Message[],
  } as unknown as SessionControl
  const api = {
    cwd,
    dataDir: path.join(root, "extension-data"),
    session: () => session,
    settings: { declare: () => ({ get: () => ({ language: extensionLanguage }), onChange: () => () => {} }) },
    registerCommand(value: CommandDefinition) {
      command = value
    },
    registerPanel(value: PanelDefinition) {
      panel = value
    },
    on: () => () => {},
    requestRender() {},
    reportError() {},
    notify() {},
  } as unknown as ExtensionAPI
  await createProjectExtension()(api)
  const ctx = {
    cwd,
    frontend: "tui",
    signal: new AbortController().signal,
    session,
    ui: {
      input: async () => undefined,
      select: async (_title: string, labels: string[]) => (pick ? pick(labels) : select),
    },
    print(text: string, level?: string, options?: { persist?: boolean }) {
      output.push({ text, level, ...options })
    },
  } as unknown as CommandContext
  return {
    root,
    cwd,
    api,
    ctx,
    output,
    command,
    panel,
    setSelection(value: string | undefined) {
      select = value
    },
    picker(fn: (labels: string[]) => Promise<string | undefined>) {
      pick = fn
    },
    switchSession() {
      id = "main-2"
      data = sessionData()
    },
    data: () => data,
  }
}

describe("project commands and attachments", () => {
  test("new creates, attaches, persists a receipt before the first prompt, and renders a panel", async () => {
    const f = await fixture()
    await f.command.run('new "Demo project" --language en', f.ctx)
    const attachment = restoreAttachment(f.data())!
    expect(attachment.root).toBe(f.cwd)
    expect(f.output.some((line) => line.persist && line.text.includes("Attached project Demo project"))).toBe(
      true,
    )
    const lines = f.panel.render({ sessionId: "main-1", data: f.data(), width: 60, now: 0, collapsed: false })
    expect(lines[0]?.text).toContain("Demo project · iteration 1 · design")
    expect(lines[1]?.text).toContain("/project design")
    expect(
      f.panel.render({ sessionId: "main-1", data: f.data(), width: 60, now: 0, collapsed: true }),
    ).toHaveLength(1)
    await f.command.run("status", f.ctx)
    expect(f.output.at(-1)?.text).toContain("coming later")
    expect(f.ctx.session.messages()).toEqual([])
  })

  test("list combines only registry and nearest discovery, picker attaches", async () => {
    const f = await fixture()
    const other = await directory()
    await new Registry(f.api.dataDir).remember(await createProject(other, "Known"))
    await createProject(f.cwd, "Discovered")
    f.picker(async (labels) => {
      expect(labels).toHaveLength(2)
      expect(labels[0]).toContain("Known")
      return labels[1]
    })
    await f.command.run("", f.ctx)
    expect(restoreAttachment(f.data())?.root).toBe(f.cwd)
  })

  test("missing registered project is visible and never replaced by discovery", async () => {
    const f = await fixture()
    const other = await directory()
    const old = await createProject(other, "Moved")
    await new Registry(f.api.dataDir).remember(old)
    await rm(path.join(other, ".amira", "project.json"))
    await createProject(f.cwd, "Nearest")
    await f.command.run("switch Moved", f.ctx)
    expect(f.output.at(-1)?.level).toBe("error")
    expect(f.output.at(-1)?.text).toContain("missing, moved")
    expect(restoreAttachment(f.data())).toBeUndefined()
  })

  test("restored attachment is not replaced when missing even if cwd discovers another project", async () => {
    const f = await fixture()
    f.data().append(ATTACHMENT_KEY, {
      projectId: "gone",
      root: path.join(f.root, "gone"),
      attachedAt: "today",
    })
    await createProject(f.cwd, "Nearby")
    await f.command.run("status", f.ctx)
    expect(f.output.at(-1)?.text).toContain("no replacement was attached")
    expect(restoreAttachment(f.data())?.projectId).toBe("gone")
  })

  test("session change during picker cannot attach to the replacement main", async () => {
    const f = await fixture()
    await createProject(f.cwd, "Race")
    f.picker(async (labels) => {
      f.switchSession()
      return labels[0]
    })
    await f.command.run("", f.ctx)
    expect(f.output.at(-1)?.text).toContain("Main session changed")
    expect(restoreAttachment(f.data())).toBeUndefined()
  })

  test("switch by id and cancellation, separate main attachments", async () => {
    const f = await fixture()
    const project = await createProject(f.cwd, "One")
    await f.command.run("list", f.ctx)
    expect(restoreAttachment(f.data())).toBeUndefined()
    await new Registry(f.api.dataDir).remember(project)
    await f.command.run(`switch ${project.marker.id}`, f.ctx)
    const data1 = f.data()
    f.switchSession()
    expect(restoreAttachment(f.data())).toBeUndefined()
    expect(restoreAttachment(data1)?.projectId).toBe(project.marker.id)
    expect(
      f.panel.render({ sessionId: "main-2", data: f.data(), width: 120, now: 0, collapsed: false }),
    ).toEqual([])
  })

  test("unsupported host design refuses persistence substitution and future flows say coming later", async () => {
    const f = await fixture()
    await f.command.run("new Demo --language en", f.ctx)
    await f.command.run("design", f.ctx)
    expect(f.output.at(-1)?.text).toMatch(/support|require|available/i)
    await f.command.run("ship", f.ctx)
    expect(f.output.at(-1)?.text).toContain("Coming later")
  })

  test("creation follows the extension default without pinning an implicit project override", async () => {
    const f = await fixture()
    await f.command.run("new Default language", f.ctx)
    const { readProject } = await import("../src/store.ts")
    expect((await readProject(f.cwd)).marker.settings.language).toBeUndefined()
  })

  test("project conversation sentinel beats an extension default during design", async () => {
    const f = await fixture()
    let observed: string | undefined
    const control = f.ctx.session as unknown as { messages: () => Message[] }
    control.messages = () => [{ role: "user", content: [{ type: "text", text: "请帮我设计项目" }] }]
    const api = f.api as unknown as { conversations: unknown }
    api.conversations = {
      openOrCreate: async (spec: { systemPrompt: string; key: string }) => {
        observed = spec.systemPrompt
        return { id: "native-design", key: spec.key, cwd: f.cwd }
      },
    }
    f.ctx.focusConversation = () => true
    f.ctx.unfocusConversation = () => true
    await f.command.run("new Follow conversation --language conversation", f.ctx)
    await f.command.run("design", f.ctx)
    expect(observed).toContain("zh-CN")
  })

  test("quoted Windows paths preserve their separators", () => {
    expect(words('new "My project" --root "D:\\my work\\src"')).toEqual([
      "new",
      "My project",
      "--root",
      "D:\\my work\\src",
    ])
  })
})

describe("acceptance command regressions", () => {
  async function native(f: Awaited<ReturnType<typeof fixture>>) {
    let prompt = ""
    const api = f.api as unknown as { conversations: unknown }
    api.conversations = {
      openOrCreate: async (spec: { key: string; systemPrompt: string }) => {
        prompt = spec.systemPrompt
        return { id: "native-design", key: spec.key, cwd: f.cwd }
      },
    }
    f.ctx.focusConversation = () => true
    f.ctx.unfocusConversation = () => true
    return () => prompt
  }

  test("explicit healthy directory, registry name and ID work despite malformed cwd marker", async () => {
    const f = await fixture()
    await mkdir(path.join(f.cwd, ".amira"))
    await writeFile(path.join(f.cwd, ".amira", "project.json"), "{broken")
    const healthy = await createProject(await directory(), "Healthy")
    await new Registry(f.api.dataDir).remember(healthy)
    for (const target of [healthy.root, "Healthy", healthy.marker.id]) {
      await f.command.run(`switch "${target}"`, f.ctx)
      expect(restoreAttachment(f.data())?.projectId).toBe(healthy.marker.id)
      expect(f.output.at(-1)?.level).not.toBe("error")
    }
  })

  test("list keeps healthy registry entries and visibly reports malformed nearest discovery", async () => {
    const f = await fixture()
    await mkdir(path.join(f.cwd, ".amira"))
    await writeFile(path.join(f.cwd, ".amira", "project.json"), "{broken")
    await new Registry(f.api.dataDir).remember(await createProject(await directory(), "Healthy"))
    let offered: string[] | undefined
    f.picker(async (labels) => {
      offered = labels
      return undefined
    })
    await f.command.run("list", f.ctx)
    expect(offered?.some((label) => label.includes("Healthy"))).toBe(true)
    expect(f.output.some((line) => /discovery/i.test(line.text) && /Malformed/.test(line.text))).toBe(true)
    expect(restoreAttachment(f.data())).toBeUndefined()
  })

  test("valid project language wins even when the losing extension default is invalid", async () => {
    const f = await fixture("not_a_tag")
    const prompt = await native(f)
    await f.command.run("new Override --language en", f.ctx)
    await f.command.run("design", f.ctx)
    expect(prompt()).toContain('Human-facing new content must use "en"')
  })

  test("Japanese status and panel are localized; Japanese human text is inferred", async () => {
    const f = await fixture()
    await f.command.run("new 日本語 --language ja", f.ctx)
    await f.command.run("status", f.ctx)
    expect(f.output.at(-1)?.text).toContain("設計")
    const lines = f.panel.render({ sessionId: "main-1", data: f.data(), width: 60, now: 0, collapsed: false })
    expect(lines.map((line) => line.text).join("\n")).toContain("イテレーション")
    expect(
      conversationLanguage([
        { role: "user", content: [{ type: "text", text: "このプロジェクトを設計してください。" }] },
      ]),
    ).toBe("ja")
  })

  test("unsupported language announces English fallback once across status, panel and design", async () => {
    const f = await fixture()
    const prompt = await native(f)
    await f.command.run("new Français --language fr", f.ctx)
    await f.command.run("status", f.ctx)
    f.panel.render({ sessionId: "main-1", data: f.data(), width: 60, now: 0, collapsed: false })
    await f.command.run("design", f.ctx)
    await f.command.run("status", f.ctx)
    expect(prompt()).toContain('Human-facing new content must use "en"')
    expect(f.output.filter((line) => /fr/.test(line.text) && /using English/i.test(line.text))).toHaveLength(
      1,
    )
  })

  test("after design is opened, the panel cannot tell a focused user to open it again", async () => {
    const f = await fixture()
    await native(f)
    await f.command.run("new Active --language en", f.ctx)
    const options = { sessionId: "main-1", data: f.data(), width: 120, now: 0, collapsed: false }
    expect(
      f.panel
        .render(options)
        .map((line) => line.text)
        .join("\n"),
    ).toContain("Open design conversation")
    await f.command.run("design", f.ctx)
    const text = f.panel
      .render(options)
      .map((line) => line.text)
      .join("\n")
    expect(text).not.toContain("/project design")
    expect(text).toContain("F6")
    // Panels get the main ID even in native focus; no fictitious focus state is inferred.
    expect(text).toContain("from design")
  })

  test("missing status precedes path and remains visible in a truncated picker label", async () => {
    const f = await fixture()
    const project = await createProject(await directory(), "Short name")
    await new Registry(f.api.dataDir).remember(project)
    await rm(path.join(project.root, ".amira", "project.json"))
    let label: string | undefined
    f.picker(async (labels) => {
      label = labels[0]
      return undefined
    })
    await f.command.run("list", f.ctx)
    expect(label?.slice(0, 55)).toContain("[missing or invalid]")
  })
})

describe("language and panel", () => {
  test("project > extension > human language; previous content is untouched", () => {
    expect(resolveLanguage("zh-CN", "en", "fr")).toBe("zh-CN")
    expect(resolveLanguage(undefined, "en", "zh-CN")).toBe("en")
    expect(resolveLanguage(undefined, "conversation", "zh-CN")).toBe("zh-CN")
    expect(resolveLanguage("conversation", "conversation", "en")).toBe("en")
    expect(resolveLanguage("conversation", "en", "zh-CN")).toBe("zh-CN")
  })
  test("infer cautiously from human turns only", () => {
    expect(
      conversationLanguage([{ role: "user", content: [{ type: "text", text: "请帮我设计项目" }] }]),
    ).toBe("zh-CN")
    expect(
      conversationLanguage([
        { role: "user", content: [{ type: "text", text: "Please design this project" }] },
      ]),
    ).toBe("en")
    expect(
      conversationLanguage([
        {
          role: "user",
          content: [{ type: "text", text: "请帮我设计" }],
          display: { text: "notice", origin: "subagent" },
        },
      ]),
    ).toBeUndefined()
    expect(conversationLanguage([])).toBeUndefined()
  })
  test("Chinese panel and visible error need no optional dashboard", async () => {
    const root = await directory()
    const project = await createProject(root, "演示", { language: "zh-CN" })
    expect(panelLines(project, undefined, false)[0]?.text).toContain("迭代 1")
    expect(panelLines(undefined, "Missing project; restore its directory", true)[0]?.text).toContain(
      "Project unavailable",
    )
  })
})
