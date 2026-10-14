import { expect, test } from "bun:test"
import index from "../../../index.json"
import manifest from "../package.json"

test("btw 0.3.0 requires the unload-capable Amira API in both manifests", () => {
  expect(manifest.version).toBe("0.3.0")
  expect(manifest.amira.engines.amira).toBe("^0.1.46")
  const entry = index.extensions.find((item) => item.name === "btw")
  expect(entry?.version).toBe(manifest.version)
  expect(entry?.engines.amira).toBe(manifest.amira.engines.amira)
})
