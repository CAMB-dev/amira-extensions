import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// Amira reads a skill's frontmatter as YAML and skips the skill when it does not parse
// (an unquoted ": " in the description is enough).
test("the workflow skill's frontmatter is valid YAML with a name and a description", () => {
  const text = readFileSync(path.join(import.meta.dir, "..", "skills", "workflow", "SKILL.md"), "utf8")
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  expect(yaml).toBeDefined()
  const data = Bun.YAML.parse(yaml!) as Record<string, unknown>
  expect(data.name).toBe("workflow")
  expect(typeof data.description).toBe("string")
  expect(data.description).toContain("propose")
})
