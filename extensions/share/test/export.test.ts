import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CommandContext, Message, StoredSession, SubagentInfo } from "@amira/api"
import { completeExport, parseExportArgs, runExport } from "../src/export.ts"
import { markdownToHtml, renderHtml } from "../src/html.ts"
import { fence, renderMarkdown } from "../src/markdown.ts"
import { createRedactor, REDACTED } from "../src/redact.ts"
import { DEFAULT_SETTINGS, readSettings } from "../src/settings.ts"
import { buildTranscript } from "../src/transcript.ts"
import { cleanup, tempDir } from "./harness.ts"

afterEach(cleanup)

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 }
const model = { provider: "deepseek", model: "deepseek-chat" }
const KEY = "sk-abcdefghijklmnopqrstuvwxyz123456"

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: `Use my key ${KEY} and fix <b>it</b>` }] },
  {
    role: "assistant",
    model,
    usage,
    content: [
      { type: "thinking", text: "Let me look." },
      { type: "text", text: "Running `ls`:\n\n```sh\nls -la\n```" },
      { type: "toolCall", id: "c1", name: "bash", args: { command: "ls -la" } },
      {
        type: "toolCall",
        id: "c2",
        name: "agent",
        args: { tasks: [{ title: "Explore api", prompt: "look" }] },
      },
    ],
    stopReason: "toolUse",
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "a.txt\n<script>alert(1)</script>" }],
  },
  {
    role: "toolResult",
    toolCallId: "c2",
    toolName: "agent",
    isError: true,
    content: [{ type: "text", text: "boom" }],
  },
  {
    role: "assistant",
    model,
    usage,
    content: [{ type: "text", text: "Done. **Bold** and [link](javascript:alert(1))." }],
  },
  {
    role: "user",
    content: [{ type: "text", text: "report from sub-agent" }],
    display: { text: "◆ explorer finished", origin: "subagent" },
  },
]

const sub: SubagentInfo = {
  id: "s_child1",
  parentSessionId: "s_root",
  depth: 1,
  role: "explorer",
  title: "Explore api",
  toolCallId: "c2",
  task: "look at the api",
  status: "done",
  model,
  usage,
  durationMs: 65_000,
}
const subMessages: Message[] = [
  { role: "user", content: [{ type: "text", text: "look at the api" }] },
  { role: "assistant", model, usage, content: [{ type: "text", text: "The api is in packages/api." }] },
]

const source = {
  sessionId: "s_root",
  cwd: "D:/work/project",
  createdAt: Date.UTC(2026, 8, 29, 10, 0),
  messages,
  subagents: [sub],
  subagentMessages: (id: string) => (id === "s_child1" ? subMessages : undefined),
}

test("the redactor removes keys by shape, by environment value, and in assignments and URLs", () => {
  const redact = createRedactor(
    { MY_SERVICE_TOKEN: "plainsecretvalue42", HOME: "/home/me", DEEPSEEK: "x" },
    [],
  )
  const text = [
    `key ${KEY}`,
    "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "aws AKIAABCDEFGHIJKLMNOP",
    "Authorization: Bearer abcdefghijklmnop.qrstuvwx",
    "api_key = 'q1w2e3r4t5y6u7i8'",
    '"password": "hunter2hunter2x9"',
    "https://user:pa55word@example.com/x",
    "env plainsecretvalue42 here",
    "bot 123456789:AAabcdefghijklmnopqrstuvwxyz0123456",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
  ].join("\n")
  const out = redact(text)
  for (const secret of [
    KEY,
    "ghp_abc",
    "AKIAABCD",
    "abcdefghijklmnop.qrst",
    "q1w2e3r4",
    "hunter2",
    "pa55word",
    "plainsecretvalue42",
    "AAabcdef",
    "MIIE",
  ])
    expect(out).not.toContain(secret)
  expect(out).toContain(`Authorization: Bearer ${REDACTED}`)
  expect(out).toContain(`api_key = '${REDACTED}'`)
  expect(out).toContain(`https://user:${REDACTED}@example.com/x`)
  // Ordinary code and prose stay.
  const code = "const token: string = getToken()\nmax_tokens: 4096\nthe password field is required\n/home/me"
  expect(redact(code)).toBe(code)
})

test("the redactor also removes the values of the providers' key variables, whatever their name", () => {
  const redact = createRedactor({ DS: "0123456789abcdef" }, ["ds"])
  expect(redact("key=0123456789abcdef!")).toBe(`key=${REDACTED}!`)
})

test("Markdown export: messages in order, tool calls collapsible, sub-agents in their own section, redacted", () => {
  const t = buildTranscript(source, createRedactor({}), Date.UTC(2026, 8, 29, 11, 0))
  const md = renderMarkdown(t)
  expect(md).toStartWith("# Amira session s_root\n")
  expect(md).not.toContain(KEY)
  expect(md).toContain(REDACTED)
  expect(md).toContain("<summary>bash · ls -la</summary>")
  expect(md).toContain("<summary>agent · Explore api ✗</summary>")
  expect(md).toContain("<details>\n<summary>Thinking</summary>")
  expect(md).toContain("Sub-agent: [Explore api](#subagent-s_child1)")
  expect(md).toContain('<a id="subagent-s_child1"></a>')
  expect(md).toContain("explorer · done · `deepseek/deepseek-chat`")
  expect(md).toContain("The api is in packages/api.")
  expect(md).toContain("**Notice (subagent)**: ◆ explorer finished")
  // The user's text is in order before the reply.
  expect(md.indexOf("fix <b>it</b>")).toBeLessThan(md.indexOf("Running `ls`"))
  // A result holding backticks gets a longer fence.
  expect(fence("a ``` b")).toStartWith("````\n")
})

test("HTML export is self-contained and escapes everything the session said", () => {
  const t = buildTranscript(source, createRedactor({}), Date.UTC(2026, 8, 29, 11, 0))
  const html = renderHtml(t)
  expect(html).toStartWith("<!doctype html>")
  expect(html).not.toMatch(/<link|<script src|https?:\/\/(?!github)/)
  expect(html).not.toContain("<script>alert(1)</script>")
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  expect(html).not.toContain("<b>it</b>")
  expect(html).not.toContain('href="javascript')
  expect(html).not.toContain(KEY)
  expect(html).toContain('<details class="tool ok">')
  expect(html).toContain('<details class="tool error">')
  expect(html).toContain('<details class="subagent depth-0" id="subagent-s_child1">')
  expect(html).toContain('<a href="#subagent-s_child1">Explore api</a>')
  expect(html).toContain('<pre><code class="lang-sh">ls -la</code></pre>')
  expect(html).toContain("<strong>Bold</strong>")
  expect(html).toContain("prefers-color-scheme:dark")
})

test("the Markdown renderer for HTML handles lists, tables, quotes and inline code safely", () => {
  const html = markdownToHtml(
    "# Title\n\n- one `<x>`\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | <i>2</i> |\n\n> quoted\n\n[ok](https://e.com/?a=1&b=2) *em*",
  )
  expect(html).toContain("<h3>Title</h3>")
  expect(html).toContain("<li>one <code>&lt;x&gt;</code></li>")
  expect(html).toContain('<li class="task">[✓] done</li>')
  expect(html).toContain("<td>&lt;i&gt;2&lt;/i&gt;</td>")
  expect(html).toContain("<blockquote><p>quoted</p></blockquote>")
  expect(html).toContain('<a href="https://e.com/?a=1&amp;b=2" rel="noopener noreferrer">ok</a>')
  expect(html).toContain("<em>em</em>")
})

test("export arguments: format, path and --session in any order; completions", () => {
  expect(parseExportArgs("")).toEqual({})
  expect(parseExportArgs("html out/x.html --session s_1")).toEqual({
    format: "html",
    path: "out/x.html",
    session: "s_1",
  })
  expect(parseExportArgs('"my file.md"')).toEqual({ path: "my file.md" })
  expect(() => parseExportArgs("--session")).toThrow(/needs a session id/)
  expect(() => parseExportArgs("--bogus")).toThrow(/unknown option/)
  const session = { sessions: () => [{ id: "s_old", updatedAt: 1, firstUserText: "hello", messageCount: 2 }] }
  const ctx = { session } as unknown as CommandContext
  expect(completeExport("", ctx).map((c) => c.value)).toEqual(["md", "html", "--session ", "--force"])
  expect(completeExport("html --session ", ctx).map((c) => c.value)).toEqual(["html --session s_old"])
})

function exportContext(cwd: string, opts: { stored?: StoredSession; confirm?: boolean } = {}) {
  const printed: string[] = []
  const asked: string[] = []
  const ctx = {
    cwd,
    ui: {
      confirm: async (title: string) => {
        asked.push(title)
        return opts.confirm
      },
    },
    signal: new AbortController().signal,
    print: (t: string) => void printed.push(t),
    session: {
      info: () => ({ id: "s_root", cwd }),
      messages: () => messages,
      subagents: () => [sub],
      subagentMessages: (id: string) => source.subagentMessages(id),
      ...(opts.stored
        ? { readSession: (id: string) => (id === opts.stored!.id ? opts.stored : undefined) }
        : {}),
    },
  } as unknown as CommandContext
  return { ctx, printed, asked }
}

test("/export writes the current session under .amira/exports, git-ignored, and says where", async () => {
  const cwd = tempDir()
  const { ctx, printed } = exportContext(cwd)
  await runExport("", ctx, {
    settings: DEFAULT_SETTINGS,
    redact: createRedactor({}),
    now: () => Date.UTC(2026, 0, 2),
  })
  const dir = path.join(cwd, ".amira", "exports")
  const files = readdirSync(dir)
  expect(files).toContain(".gitignore")
  const file = files.find((f) => f.endsWith(".md"))!
  expect(file).toMatch(/^s_root-\d{8}-\d{6}\.md$/)
  expect(readFileSync(path.join(dir, file), "utf8")).toContain("# Amira session s_root")
  expect(printed[0]).toContain(
    `Exported session s_root (6 messages, 1 sub-agent) as Markdown to ${path.join(".amira", "exports", file)}`,
  )

  await runExport("html", ctx, { settings: DEFAULT_SETTINGS, redact: createRedactor({}) })
  expect(readdirSync(dir).some((f) => f.endsWith(".html"))).toBe(true)
  await runExport("out/session.html", ctx, { settings: DEFAULT_SETTINGS, redact: createRedactor({}) })
  expect(readFileSync(path.join(cwd, "out", "session.html"), "utf8")).toStartWith("<!doctype html>")
  expect(existsSync(path.join(cwd, "out", ".gitignore"))).toBe(false)
})

test("/export --session reads a stored session through the API; unknown ids are refused", async () => {
  const cwd = tempDir()
  const stored: StoredSession = {
    id: "s_old",
    cwd,
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: "user", content: [{ type: "text", text: "an old question" }] }],
    subagents: [],
    subagentMessages: () => undefined,
  }
  const { ctx } = exportContext(cwd, { stored })
  await runExport("--session s_old html old.html", ctx, {
    settings: DEFAULT_SETTINGS,
    redact: createRedactor({}),
  })
  expect(readFileSync(path.join(cwd, "old.html"), "utf8")).toContain("an old question")
  await expect(
    runExport("--session s_nope", ctx, { settings: DEFAULT_SETTINGS, redact: createRedactor({}) }),
  ).rejects.toThrow(/no stored session s_nope/)
  // A host without readSession says it needs a newer Amira.
  const plain = exportContext(cwd).ctx
  await expect(
    runExport("--session s_old", plain, { settings: DEFAULT_SETTINGS, redact: createRedactor({}) }),
  ).rejects.toThrow(/cannot read stored sessions/)
})

test("settings: bad fields are reported and fall back to defaults", () => {
  const problems: string[] = []
  const s = readSettings(
    {
      exportFormat: "pdf",
      conventional: "yes",
      model: "nope",
      base: "--evil",
      maxDiffChars: 5000,
      exportDir: "exp",
    },
    (p) => problems.push(p),
  )
  expect(s).toEqual({ ...DEFAULT_SETTINGS, exportDir: "exp", maxDiffChars: 5000 })
  expect(problems).toHaveLength(4)
})

test("a stored sub-agent without its call id is linked to the call whose result names it", () => {
  const { toolCallId: _, ...stored } = sub
  const msgs = messages.map((m) =>
    m.role === "toolResult" && m.toolCallId === "c2"
      ? {
          ...m,
          isError: false,
          content: [{ type: "text" as const, text: "Started in the background: s_child1 (explorer)" }],
        }
      : m,
  )
  const t = buildTranscript({ ...source, messages: msgs, subagents: [stored] }, createRedactor({}))
  expect(renderMarkdown(t)).toContain("Sub-agent: [Explore api](#subagent-s_child1)")
})

test("the redactor: more key shapes and short passwords go; words that only look like keys stay", () => {
  const redact = createRedactor({
    GIT_AUTHOR_NAME: "Christopher",
    AUTH_MODE: "production",
    SIGNING_KEY: "k3y-f0r-s1gning",
  })
  const secrets = [
    `PRIVATE_KEY=0x${"ab12".repeat(16)}`,
    "SERVICE_KEY=Zq81kfLr0cX2mB7t",
    // Put together here, so the file holds no key-shaped string of its own.
    `STRIPE=${["sk", "live", "0000fake0000fake0000"].join("_")}`,
    '"password": "Summer2024!"',
    `token ${"ya29"}.fake0fake0fake0fake0fake`,
    `AccountName=me;${"Account"}Key=fake0fake0fake==;EndpointSuffix=core`,
    `Authorization: Basic ${Buffer.from("admin:hunter22").toString("base64")}`,
    "signed with k3y-f0r-s1gning",
  ]
  for (const s of secrets) expect(redact(s)).toContain(REDACTED)
  expect(redact('"password": "Summer2024!"')).not.toContain("Summer2024")
  const prose = [
    "Christopher deployed to production",
    "Basic configuration/settings are in the README",
    "the sk-spinner-wave-animation class",
    "password: string",
  ].join("\n")
  expect(redact(prose)).toBe(prose)
})

test("the redactor stays fast on long runs of hyphenated words", () => {
  const started = performance.now()
  createRedactor({})("ab-".repeat(40_000))
  expect(performance.now() - started).toBeLessThan(500)
})

test("Markdown export: a reply cut off inside a code block, or holding </details>, cannot swallow what follows", () => {
  const cut: Message[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      model,
      usage,
      content: [
        { type: "thinking", text: "hmm </details> <details>" },
        { type: "text", text: "Here:\n\n```ts\nconst a = 1\n" },
      ],
      stopReason: "aborted",
    },
    { role: "user", content: [{ type: "text", text: "and then" }] },
  ]
  const render = (msgs: Message[]) =>
    renderMarkdown(buildTranscript({ ...source, messages: msgs, subagents: [] }, createRedactor({})))
  const md = render(cut)
  expect(md).toContain("```ts\nconst a = 1\n```")
  expect(md).toContain("hmm &lt;/details> &lt;details>")
  // Outside the code block again: the next message is a heading.
  expect(md).toContain("### User\n\nand then")
  // Inside code, tags stay as written.
  const inCode: Message = {
    role: "assistant",
    model,
    usage,
    content: [{ type: "text", text: "```\n</details>\n```" }],
  }
  expect(render([cut[0]!, inCode])).toContain("```\n</details>\n```")
})

test("HTML export: protocol-relative and UNC links are not links", () => {
  const html = markdownToHtml("[a](//evil.example/x) [b](\\\\host\\share) [c](./ok.md)")
  expect(html).not.toContain('href="//')
  expect(html).not.toContain('href="\\\\')
  expect(html).toContain('<a href="./ok.md"')
})

test("/export to an existing file asks first; --force replaces it; a path without an extension gets one", async () => {
  const cwd = tempDir()
  const settings = { settings: DEFAULT_SETTINGS, redact: createRedactor({}) }
  const target = path.join(cwd, "README.md")
  writeFileSync(target, "mine\n")
  // Nobody can answer (print mode): refused, with how to force it.
  const nobody = exportContext(cwd)
  await runExport("README.md", nobody.ctx, settings)
  expect(readFileSync(target, "utf8")).toBe("mine\n")
  expect(nobody.asked).toEqual(["Replace README.md?"])
  expect(nobody.printed.at(-1)).toBe("Not exported: README.md exists. Add --force to replace it.")
  // The user says no.
  const no = exportContext(cwd, { confirm: false })
  await runExport("README.md", no.ctx, settings)
  expect(readFileSync(target, "utf8")).toBe("mine\n")
  expect(no.printed.at(-1)).toBe("Not exported: README.md exists.")
  // Yes, or --force without asking.
  const yes = exportContext(cwd, { confirm: true })
  await runExport("README.md", yes.ctx, settings)
  expect(readFileSync(target, "utf8")).toContain("# Amira session s_root")
  const forced = exportContext(cwd)
  writeFileSync(target, "mine\n")
  await runExport("README.md --force", forced.ctx, settings)
  expect(forced.asked).toEqual([])
  expect(readFileSync(target, "utf8")).toContain("# Amira session s_root")
  await runExport("html notes", forced.ctx, settings)
  expect(readFileSync(path.join(cwd, "notes.html"), "utf8")).toStartWith("<!doctype html>")
  // A format that does not match the extension is written, with a warning.
  await runExport("md page.html", forced.ctx, settings)
  expect(forced.printed.some((p) => p.includes("Writing Markdown to a .html file."))).toBe(true)
})
