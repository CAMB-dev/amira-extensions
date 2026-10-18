import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Read source only. Never import or run desktop.test.ts or any PowerShell script.
test("the windowed-child desktop fixture receives paths and title as parameters, not script interpolation", () => {
  const source = readFileSync(new URL("./desktop.test.ts", import.meta.url), "utf8")
  const start = source.indexOf("const child = scriptFile(", source.indexOf('"stop removes a windowed launch'))
  const fixture = source.slice(start, source.indexOf("rootPid = launched.pid", start))
  expect(fixture).toContain("param([string] $ChildScript, [string] $FixturePath, [string] $FixtureTitle)")
  expect(fixture).toContain("-Title $FixtureTitle")
  expect(fixture).toMatch(/"-ChildScript",\s*child/)
  expect(fixture).toMatch(/"-FixturePath",\s*fixturePath/)
  expect(fixture).toMatch(/"-FixtureTitle",\s*title/)
  expect(fixture).not.toMatch(/\$\{child\}/)
  expect(fixture).not.toMatch(/\$\{fixturePath\}/)
})
