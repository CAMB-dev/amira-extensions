import { describe, expect, test } from "bun:test"
import { exclusion, hash, modelScope, redact, safePath } from "../src/privacy.ts"

describe("literal review paths", () => {
  test("accepts portable literals, spaces, apostrophes and Unicode", () => {
    for (const name of ["src/a.ts", "O'Brien/a b.ts", "文档/😀.md"]) expect(safePath(name)).toBe(name)
  })
  test("rejects traversal, absolute paths, pathspecs, aliases and control characters", () => {
    for (const name of [
      "",
      "/tmp/a",
      "C:/a",
      "\\\\host\\a",
      "src\\a",
      "../a",
      "a/../b",
      "a/./b",
      "a//b",
      "a/",
      "--file",
      ":(glob)*",
      "*.ts",
      "a?[0]",
      "a\nb",
      "a\u0000b",
      "a\u202eb",
      "a.",
      "a ",
      "NUL.txt",
      "src/COM1",
      "$(cmd)",
      "a\ud800",
    ]) {
      expect(() => safePath(name)).toThrow()
    }
  })
  test("excludes secret, metadata, vendor, generated and lock paths on either side", () => {
    for (const name of [
      ".env",
      ".env.example",
      "a/.git/config",
      "a/.amira/state.json",
      "keys/private.pem",
      ".ssh/id_rsa",
      ".npmrc",
      "secrets/config.ts",
      "node_modules/x/a.js",
      "vendor/a",
      "dist/a.js",
      "a/foo.generated.ts",
      "foo.js.map",
      "pnpm-lock.yaml",
      "bun.lock",
      "Cargo.lock",
      "yarn.lock",
    ])
      expect(exclusion(name)).toBeString()
    expect(exclusion("src/unlocked.ts")).toBeUndefined()
  })
})

describe("privacy redaction", () => {
  test("redacts added/removed secrets without changing line count or CRLF", () => {
    const secret = `ghp_${"a".repeat(36)}`
    const input = `-const token = '${secret}'\r\n+password = "hunter22"\r\ncontext\r\n`
    const out = redact(input)
    expect(out).not.toContain(secret)
    expect(out).not.toContain("hunter22")
    expect(out.split("\n").length).toBe(input.split("\n").length)
    expect(out.split("\r\n").length).toBe(4)
    expect(out).toContain("context")
  })
  test("private key blocks preserve every line, including incomplete blocks", () => {
    for (const end of ["-----END RSA PRIVATE KEY-----\nnext", ""]) {
      const input = `-----BEGIN RSA PRIVATE KEY-----\nabc123\nxyz\n${end}`
      expect(redact(input)).not.toContain("abc123")
      expect(redact(input).split("\n").length).toBe(input.split("\n").length)
    }
  })
  test("removes URL credentials, authorization, common token shapes and terminal controls", () => {
    const input = `https://user:p4ssword@example.com Bearer abcdefgh12345678 AKIA1234567890ABCDEF\n\u001b[31mred\u001b[0m\u202e`
    const out = redact(input)
    expect(out).not.toContain("p4ssword")
    expect(out).not.toContain("abcdefgh12345678")
    expect(out).not.toContain("AKIA1234567890ABCDEF")
    expect(out).not.toContain("\u001b")
    expect(out).not.toContain("\u202e")
    expect(out).toContain("red")
  })
  test("leaves type annotations and environment variable references intact", () => {
    const code = "token: string\npassword: undefined\napi_key = process.env.API_KEY"
    expect(redact(code)).toBe(code)
  })
  test("redaction remains stable across collection, findings, persistence and display", () => {
    const once = redact("password=hunter22\napi_key=abc123456\nAuthorization: Bearer abcdefgh12345678")
    expect(redact(once)).toBe(once)
    expect(redact(redact(once))).toBe(once)
  })
  test("hashes original text deterministically, even when redacted output is identical", () => {
    expect(hash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(hash("password=one")).not.toBe(hash("password=two"))
  })
})

describe("private-key fragments", () => {
  test("redacts long base64 key-body runs without PEM boundaries in prose and Markdown", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDLy3MqkS8uVnZ4"
    for (const value of [body, `key body: ${body}`, `1: ${body}  `, `\`${body}\``]) {
      expect(redact(value)).not.toContain(body)
      expect(redact(value)).toContain("[REDACTED]")
    }
    const hexHash = hash("canonical repository")
    expect(redact(hexHash)).toBe(hexHash)
  })
})

describe("model-facing scope metadata", () => {
  test("allowlists and sanitizes scope fields without changing operational identity", () => {
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    const base = "a".repeat(40)
    const scope = {
      kind: "since" as const,
      ref: credential,
      paths: [`src/${credential}.ts`],
      includeUntracked: false,
      futureMetadata: credential,
    }
    const exposed = modelScope(scope, base)
    expect(exposed).toEqual({ kind: "since", paths: ["src/[REDACTED].ts"], includeUntracked: false, base })
    expect(JSON.stringify(exposed)).not.toContain(credential)
    expect(scope.ref).toBe(credential)
    expect(scope.paths).toEqual([`src/${credential}.ts`])
    expect(modelScope({ ...scope, kind: "worktree", includeUntracked: true }, base)).toEqual({
      kind: "worktree",
      paths: ["src/[REDACTED].ts"],
      includeUntracked: true,
    })
  })
})
