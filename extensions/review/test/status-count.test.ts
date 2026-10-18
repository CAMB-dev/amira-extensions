import { expect, test } from "bun:test"
import { completedChildren } from "../src/command.ts"

test("deep status counts failed and stopped workflow children as finished", () => {
  expect(completedChildren({ a: "done", b: "failed", c: "stopped", d: "working" })).toBe(3)
  expect(completedChildren({ a: "error", b: "aborted", c: "queued" })).toBe(2)
})
