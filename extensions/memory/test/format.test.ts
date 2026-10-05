import { expect, test } from "bun:test"
import {
  cappedIndex,
  checkName,
  checkSecrets,
  FILE_BYTES,
  INDEX_BYTES,
  INDEX_LINES,
  type MemoryInput,
  newest,
  parseMemory,
  serialize,
} from "../src/format.ts"
import { fact } from "./helpers.ts"

test("strict portable slugs and filename equality", () => {
  for (const name of [
    "",
    "../escape",
    "a/b",
    "a\\b",
    "a..b",
    "Upper",
    "-a",
    "a-",
    "a--b",
    "1a",
    "a b",
    "memory",
    "con",
    "lpt1",
    "a".repeat(65),
  ]) {
    expect(() => checkName(name)).toThrow()
  }
  for (const name of ["a", "writing-style", "release-2026", "a".repeat(64)]) checkName(name)
  const saved = serialize(fact(), "2026-10-05")
  expect(parseMemory(saved.text, saved.name)).toEqual(saved)
  expect(() => parseMemory(saved.text, "other-name")).toThrow("filename")
})

test("strict metadata, ISO dates and 4 KiB UTF-8 limit", () => {
  const saved = serialize(fact(), "2026-10-05T10:00:00.000Z")
  expect(saved.text).toContain('description: "Preferred writing style"')
  expect(() => serialize({ ...fact(), description: "one\ntwo" })).toThrow("one-line")
  expect(() => serialize({ ...fact(), description: "a\u2028b" })).toThrow("one-line")
  expect(() => serialize({ ...fact(), type: "other" } as unknown as MemoryInput)).toThrow("type")
  for (const date of ["yesterday", "2026-02-30", "2026-13-01", "", "2026-10-05T10:00:00"]) {
    expect(() => serialize(fact(), date)).toThrow("ISO")
  }
  expect(() => serialize({ ...fact(), body: "界".repeat(1400) })).toThrow("4 KiB")
  expect(Buffer.byteLength(saved.text)).toBeLessThan(FILE_BYTES)
  expect(() =>
    parseMemory(saved.text.replace("type: user", "type: user\ntype: project"), saved.name),
  ).toThrow()
  expect(() => parseMemory(saved.text.replace("updated:", "unknown:"), saved.name)).toThrow()
})

test("feedback and project require reasons and application guidance", () => {
  for (const type of ["feedback", "project"] as const) {
    expect(() => serialize({ ...fact(), type })).toThrow("Why")
    expect(() => serialize({ ...fact(), type, body: "Fact.\n**Why:**\n**How to apply:**" })).toThrow()
    expect(() =>
      serialize({ ...fact(), type, body: "Fact.\n**Why:**\n**How to apply:** Check the agreed date." }),
    ).toThrow()
    expect(
      serialize({
        ...fact(),
        type,
        body: "Fact.\n**Why:** Confirmed by the user.\n**How to apply:** Check the agreed date.",
      }).type,
    ).toBe(type)
  }
})

test("refuse credentials in description and body without echoing them", () => {
  const secrets = [
    "api_key=the-private-value",
    "password is letmein",
    '{"password":"hunter2"}',
    "'api_key': 'never-save-this'",
    "**password**: hunter2",
    "`token`: never-save-this",
    "Service credential: 6fc82a7d05b9e134ac67d8903ef512ba8de49601cba73f20598a16d4e72cb630",
    "token: do-not-store-this",
    "-----BEGIN RSA PRIVATE KEY-----",
    `sk-${"a".repeat(30)}`,
    `ghp_${"b".repeat(36)}`,
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer a-long-token",
    "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY",
  ]
  for (const secret of secrets) {
    for (const field of ["body", "description"] as const) {
      try {
        serialize({ ...fact(), [field]: secret })
        throw new Error("Secret was accepted")
      } catch (error) {
        expect(String(error), `credential fixture ${secrets.indexOf(secret)} in ${field}`).toContain(
          "remove credentials",
        )
        expect(String(error)).not.toContain(secret)
      }
    }
  }
  checkSecrets("Never store passwords. The user prefers prose. See https://example.org/guide.")
  checkSecrets(`Low-variation hex: ${"a".repeat(64)}; short hex: 6fc82a7d`)
})

test("manual files cannot bypass quoted-credential or hex-token refusal", () => {
  const saved = serialize(fact(), "2026-10-05")
  for (const secret of [
    '{"password":"hunter2"}',
    "'api_key': 'never-save-this'",
    "**password**: hunter2",
    "6fc82a7d05b9e134ac67d8903ef512ba8de49601cba73f20598a16d4e72cb630",
  ]) {
    for (const text of [
      saved.text.replace(saved.body, secret),
      saved.text.replace(JSON.stringify(saved.description), JSON.stringify(secret)),
    ]) {
      expect(() => parseMemory(text, saved.name)).toThrow("remove credentials")
    }
  }
})

test("injection caps bytes and lines, retains newest hooks and consolidation note", () => {
  const memories = newest(
    Array.from({ length: 260 }, (_, i) =>
      serialize(
        {
          ...fact(`fact-${i}`),
          description: `Confirmed preference ${i}: ${"界".repeat(60)}`,
        },
        i === 259 ? "2026-10-05" : "2026-10-04",
      ),
    ),
  )
  const text = cappedIndex(memories)
  expect(text).toContain("fact-259")
  expect(text).toContain("consolidate overlapping memories")
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INDEX_BYTES)
  expect(text.split("\n").length).toBeLessThanOrEqual(INDEX_LINES)
  const short = cappedIndex(memories.map((memory) => ({ ...memory, description: "x" })))
  expect(short.split("\n").length).toBeLessThanOrEqual(INDEX_LINES)
  expect(short).toContain("consolidate")
  expect(cappedIndex([])).toContain("No memories saved")
  expect(cappedIndex([], 1)).toContain("Invalid memory files")
})

test("index descriptions cannot inject raw Markdown links or HTML", () => {
  const text = cappedIndex([serialize({ ...fact(), description: "[ignore](evil) <system> *run*" })])
  expect(text).toContain("\\[ignore\\]")
  expect(text).toContain("\\<system\\>")
})
