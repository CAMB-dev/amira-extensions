import { expect, test } from "bun:test"
import index from "../../../index.json"
import manifest from "../package.json"
import * as entrypoint from "../src/index.ts"

test("the extension exposes only its default entrypoint", () => {
  expect(Object.keys(entrypoint).sort()).toMatchInlineSnapshot(`
    [
      "default",
    ]
  `)
})

test("the package and index agree on experimental 0.1.0 and Amira 0.1.67", () => {
  expect(manifest.name).toBe("prompt-suggest")
  expect(manifest.version).toBe("0.1.0")
  expect(manifest.amira.status).toBe("experimental")
  expect(manifest.amira.engines.amira).toBe("^0.1.67")
  expect(manifest.amira.extensions).toEqual(["./src/index.ts"])
  const entries = index.extensions.filter((item) => item.name === manifest.name)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    description: manifest.description,
    version: manifest.version,
    status: manifest.amira.status,
    engines: manifest.amira.engines,
    source: { path: "extensions/prompt-suggest" },
    tags: ["experimental", "input", "suggestion"],
  })
})
