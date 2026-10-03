import { expect, test } from "bun:test"
import { Journal, type JournalEntry } from "../src/journal.ts"

const entry = (key: string, status?: JournalEntry["status"]): JournalEntry => ({
  key,
  label: key,
  text: "answer",
  tokens: 10,
  durationMs: 1,
  ...(status !== undefined ? { status } : {}),
})

test("legacy successes and cached results replay, but errors and aborts do not", () => {
  const journal = new Journal("unused", [
    entry("legacy"),
    entry("cache", "cached"),
    entry("error", "error"),
    entry("stop", "aborted"),
  ])
  expect(journal.replay("legacy", 0, 0)?.text).toBe("answer")
  expect(journal.replay("cache", 0, 1)?.status).toBe("cached")
  expect(journal.replay("error", 0, 2)).toBeUndefined()
  expect(journal.replay("stop", 0, 2)).toBeUndefined()
  expect(journal.diverged).toBe(true)
})

test("a later failed attempt hides an older success and invalidates dependent replay", () => {
  const journal = new Journal("unused", [
    entry("same", "done"),
    entry("same", "error"),
    entry("peer", "done"),
    entry("later", "done"),
  ])
  expect(journal.replay("same", 0, 0)).toBeUndefined()
  // Calls made in the same fan-out are still independent of the retry's result.
  expect(journal.replay("peer", 0, 1)?.text).toBe("answer")
  expect(journal.replay("later", 1, 2)).toBeUndefined()
})

test("identical prompt occurrences keep their order even with failed occurrences", () => {
  const journal = new Journal("unused", [entry("hash#1", "done"), entry("hash#0", "error")])
  expect(journal.key("hash")).toBe("hash#0")
  expect(journal.replay("hash#0", 0, 0)).toBeUndefined()
  expect(journal.key("hash")).toBe("hash#1")
  expect(journal.replay("hash#1", 0, 0)?.status).toBe("done")
  expect(journal.key("hash")).toBe("hash#2")
})
