import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Diagnostic } from "../src/client.ts"
import { countsInText, describeCounts, diagnosticLine, formatReports } from "../src/format.ts"
import { editedFile, lspBlock, withDiagnostics } from "../src/index.ts"
import { encodeMessage, MessageReader, type RpcMessage } from "../src/rpc.ts"
import { DEFAULT_SERVERS, findCommand, findRoot, languageIdFor, serverFor } from "../src/servers.ts"
import { readSettings } from "../src/settings.ts"
import { parseTscOutput } from "../src/tsc.ts"
import { fileKey, pathToUri, uriKey, uriToPath } from "../src/uri.ts"

const diag = (line: number, character: number, message: string, severity = 1, code?: string): Diagnostic => ({
  range: { start: { line, character }, end: { line, character } },
  severity,
  message,
  ...(code ? { code } : {}),
})

test("Windows paths become file URIs with the drive's colon kept, and come back from any form", () => {
  expect(pathToUri("C:\\Users\\me\\my project\\a#1.ts", true)).toBe(
    "file:///C:/Users/me/my%20project/a%231.ts",
  )
  // One URI per file, whatever case the drive letter came in.
  expect(pathToUri("c:\\Users\\me\\a.ts", true)).toBe("file:///C:/Users/me/a.ts")
  expect(pathToUri("c:/Users/me/./x/../a.ts", true)).toBe("file:///C:/Users/me/a.ts")
  expect(uriKey(pathToUri("c:\\Users\\me\\a.ts", true), true)).toBe(fileKey("C:\\Users\\me\\a.ts", true))
  expect(pathToUri("\\\\server\\share\\x.ts", true)).toBe("file://server/share/x.ts")
  expect(pathToUri("/home/me/a b.ts", false)).toBe("file:///home/me/a%20b.ts")
  for (const uri of ["file:///C:/Users/me/a.ts", "file:///c%3A/Users/me/a.ts", "file:///c:/users/ME/a.ts"]) {
    expect(uriKey(uri, true)).toBe(fileKey("C:\\Users\\me\\a.ts", true))
  }
  expect(uriToPath("file:///c%3A/x/my%20file.ts", true)).toBe("c:\\x\\my file.ts")
  expect(uriToPath("file://server/share/x.ts", true)).toBe("\\\\server\\share\\x.ts")
  expect(uriToPath("file:///home/me/a%20b.ts", false)).toBe("/home/me/a b.ts")
  expect(uriToPath("untitled:Untitled-1", true)).toBeUndefined()
  expect(fileKey("C:/A/b.TS", true)).toBe(fileKey("c:\\a\\B.ts", true))
})

test("messages are framed by UTF-8 byte length, even when a character is split across chunks", () => {
  const got: RpcMessage[] = []
  const noise: string[] = []
  const reader = new MessageReader(
    (m) => got.push(m),
    (t) => noise.push(t),
  )
  const wire =
    encodeMessage({ method: "a", params: { text: "héllo ✓ 你好" } }) + encodeMessage({ id: 1, result: 2 })
  const bytes = Buffer.from(wire)
  // Feed it in pieces as the pipe would: decoded text, never splitting a character.
  const decoder = new TextDecoder()
  for (let i = 0; i < bytes.length; i += 7)
    reader.push(decoder.decode(bytes.subarray(i, i + 7), { stream: true }))
  expect(got).toEqual([
    { jsonrpc: "2.0", method: "a", params: { text: "héllo ✓ 你好" } },
    { jsonrpc: "2.0", id: 1, result: 2 },
  ])
  reader.push("some log line\r\n\r\n")
  reader.push(encodeMessage({ method: "b" }))
  expect(got.at(-1)).toMatchObject({ method: "b" })
  expect(noise).toEqual(["some log line"])
})

test("a message of several MB in small chunks is read whole, and the next one after it", () => {
  const got: RpcMessage[] = []
  const reader = new MessageReader((m) => got.push(m))
  const big = "é".repeat(2_000_000)
  const wire = encodeMessage({ method: "big", params: { big } }) + encodeMessage({ id: 7, result: null })
  const started = performance.now()
  for (let i = 0; i < wire.length; i += 4096) reader.push(wire.slice(i, i + 4096))
  // Joining the buffer once per chunk (the old way) took seconds here.
  expect(performance.now() - started).toBeLessThan(2000)
  expect(got).toHaveLength(2)
  expect((got[0]!.params as { big: string }).big).toBe(big)
  expect(got[1]).toMatchObject({ id: 7 })
})

test("settings: defaults, a server of the user's own, and problems reported instead of failing", () => {
  const d = readSettings(undefined)
  expect(d).toMatchObject({
    enabled: true,
    severity: "error",
    maxItems: 20,
    tools: ["edit", "write"],
    problems: [],
  })
  expect(d.servers.map((s) => s.id)).toEqual(["typescript", "python", "rust", "go", "csharp"])

  const s = readSettings({
    severity: "warning",
    maxItems: 5,
    languages: ["typescript", "zig", "cobol"],
    servers: {
      zig: { command: ["zls"], extensions: ["zig"] },
      python: { enabled: false },
      typescript: { settings: { typescript: { tsserver: {} } } },
      bad: { command: "x" },
    },
    waitMs: -1,
  })
  expect(s.severity).toBe("warning")
  expect(s.maxItems).toBe(5)
  expect(s.waitMs).toBe(4000)
  expect(s.servers.map((x) => x.id).sort()).toEqual(["typescript", "zig"])
  expect(s.servers.find((x) => x.id === "zig")).toMatchObject({ commands: [["zls"]], extensions: [".zig"] })
  // Changing only its settings keeps the built-in command and the tsc fallback.
  expect(s.servers.find((x) => x.id === "typescript")).toMatchObject({
    commands: [["typescript-language-server", "--stdio"]],
    tscFallback: true,
    settings: { typescript: { tsserver: {} } },
  })
  expect(s.problems).toEqual([
    "extensions.lsp.servers.bad.command must be a non-empty list of strings",
    'extensions.lsp.servers.bad needs "command" and "extensions"',
    'extensions.lsp.languages: no server "cobol"',
    "extensions.lsp.waitMs must be a number of at least 0",
  ])
})

test("servers are found by extension and on PATH, first candidate installed wins", () => {
  const ts = serverFor(DEFAULT_SERVERS, "C:\\x\\App.TSX")!
  expect(ts.id).toBe("typescript")
  expect(languageIdFor(ts, "a.tsx")).toBe("typescriptreact")
  expect(languageIdFor(ts, "a.mjs")).toBe("javascript")
  expect(serverFor(DEFAULT_SERVERS, "Makefile")).toBeUndefined()
  const py = serverFor(DEFAULT_SERVERS, "a.py")!
  const which = (p: string) => (p === "basedpyright-langserver" ? "/bin/basedpyright-langserver" : null)
  expect(findCommand(py, which)).toEqual(["/bin/basedpyright-langserver", "--stdio"])
  expect(findCommand(ts, () => null)).toBeUndefined()
})

test("a server's root is the topmost marker folder inside the working directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lsp-root-"))
  mkdirSync(path.join(dir, "packages", "a", "src"), { recursive: true })
  writeFileSync(path.join(dir, "package.json"), "{}")
  writeFileSync(path.join(dir, "packages", "a", "package.json"), "{}")
  const file = path.join(dir, "packages", "a", "src", "x.ts")
  expect(findRoot(file, dir, ["package.json"])).toBe(dir)
  // Working in the package: its own folder.
  expect(findRoot(file, path.join(dir, "packages", "a"), ["package.json"])).toBe(
    path.join(dir, "packages", "a"),
  )
  // Outside the working directory: the nearest marker.
  expect(findRoot(file, path.join(dir, "elsewhere"), ["package.json"])).toBe(path.join(dir, "packages", "a"))
  // No marker at all: the working directory.
  expect(findRoot(file, dir, ["Cargo.toml"])).toBe(dir)
  writeFileSync(path.join(dir, "packages", "App.sln"), "")
  expect(findRoot(file, dir, ["*.sln"])).toBe(path.join(dir, "packages"))
})

test("diagnostics are listed compactly, most severe first, capped, with counts in the header", () => {
  const cwd = path.resolve("/proj")
  const text = formatReports(
    [
      {
        file: path.join(cwd, "src", "a.ts"),
        diagnostics: [
          diag(9, 0, "unused", 2),
          diag(2, 6, "Type 'string' is not assignable to type 'number'.\n  more detail", 1, "2322"),
          diag(0, 0, "a hint", 4),
        ],
      },
      { file: path.join(cwd, "b.ts"), diagnostics: [diag(0, 0, "x"), diag(1, 0, "y")] },
      { file: path.join(cwd, "c.ts"), diagnostics: [], cleared: true },
      { file: path.join(cwd, "d.ts"), diagnostics: [] },
    ],
    { cwd, threshold: 2, maxItems: 3 },
  )
  expect(text).toBe(
    [
      "LSP diagnostics: 3 errors · 1 warning",
      "src/a.ts:3:7 error Type 'string' is not assignable to type 'number'. (2322)",
      "src/a.ts:10:1 warning unused",
      "b.ts:1:1 error x",
      "c.ts: no problems now",
      "… 1 more (the diagnostics tool lists them all)",
    ].join("\n"),
  )
  expect(countsInText(text!)).toEqual({ errors: 3, warnings: 1, other: 0 })
  expect(
    formatReports([{ file: path.join(cwd, "d.ts"), diagnostics: [diag(0, 0, "w", 2)] }], {
      cwd,
      threshold: 1,
      maxItems: 5,
    }),
  ).toBeUndefined()
  expect(
    formatReports([{ file: path.join(cwd, "d.ts"), diagnostics: [], cleared: true }], {
      cwd,
      threshold: 1,
      maxItems: 5,
    }),
  ).toBe("LSP diagnostics: no problems\nd.ts: no problems now")
  expect(describeCounts({ errors: 1, warnings: 2, other: 0 })).toBe("1 error · 2 warnings")
  expect(diagnosticLine(diag(0, 0, "no severity", undefined as never), "x.ts")).toBe(
    "x.ts:1:1 error no severity",
  )
})

test("tsc output is read into diagnostics by file, with continuation lines", () => {
  const cwd = path.resolve("/proj")
  const out = parseTscOutput(
    [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The expected type comes from here.",
      "src/b.ts(1,1): warning TS6133: 'x' is declared but never used.",
      "Found 2 errors.",
    ].join("\r\n"),
    cwd,
  )
  expect(out.get(fileKey(path.join(cwd, "src/a.ts")))).toEqual([
    {
      range: { start: { line: 2, character: 6 }, end: { line: 2, character: 6 } },
      severity: 1,
      code: "TS2322",
      source: "tsc",
      message: "Type 'string' is not assignable to type 'number'.\nThe expected type comes from here.",
    },
  ])
  expect(out.get(fileKey(path.join(cwd, "src/b.ts")))?.[0]?.severity).toBe(2)
})

test("the file an edit changed: the absolute path in its details, else its path argument", () => {
  const cwd = path.resolve("/proj")
  const abs = path.join(cwd, "x.ts")
  expect(editedFile({ args: { path: "y.ts" }, cwd, result: { content: [], details: { path: abs } } })).toBe(
    abs,
  )
  expect(editedFile({ args: { path: "y.ts" }, cwd, result: { content: [] } })).toBe(path.join(cwd, "y.ts"))
  expect(editedFile({ args: {}, cwd, result: { content: [] } })).toBeUndefined()
})

test("the edit presenter gets the counts on its result line and the diagnostics above its diff", () => {
  const below = {
    summary: () => "a.ts",
    result: () => "+1 −1",
    body: () => [{ kind: "diff-add" as const, text: "x", lineNo: 1 }],
  }
  const p = withDiagnostics(below)
  const block =
    "LSP diagnostics: 4 errors\na.ts:1:1 error a\na.ts:2:1 error b\na.ts:3:1 error c\na.ts:4:1 warning d"
  const call = {
    args: {},
    result: {
      content: [
        { type: "text" as const, text: "Edited a.ts" },
        { type: "text" as const, text: block },
      ],
    },
    text: "",
  }
  expect(lspBlock(call.result)).toBe(block)
  expect(p.summary?.({})).toBe("a.ts")
  expect(p.result?.(call)).toBe("+1 −1 · 4 errors")
  expect(p.body?.(call, { detail: "summary", width: 80 })).toEqual([
    { kind: "error", text: "a.ts:1:1 error a" },
    { kind: "error", text: "a.ts:2:1 error b" },
    { kind: "error", text: "a.ts:3:1 error c" },
    { kind: "muted", text: "… 1 more line" },
    { kind: "diff-add", text: "x", lineNo: 1 },
  ])
  expect(p.body?.(call, { detail: "full", width: 80 })).toHaveLength(5)
  const plain = { ...call, result: { content: [{ type: "text" as const, text: "Edited a.ts" }] } }
  expect(p.result?.(plain)).toBe("+1 −1")
  expect(p.body?.(plain, { detail: "full", width: 80 })).toHaveLength(1)
})
