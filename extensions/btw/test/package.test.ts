import { expect, test } from "bun:test"
import manifest from "../package.json"

test("btw 0.2.0 requires the new Amira API", () => {
  expect(manifest.version).toBe("0.2.0")
  expect(manifest.amira.engines.amira).toBe("^0.1.44")
})
