import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { compileScript } from "../src/compile.ts"
import { estimate, parseMeta, sizeLine, workspaceLine } from "../src/meta.ts"

test("meta is read as a plain literal: comments, quotes, trailing commas", () => {
  const meta = parseMeta(`// a workflow
export const meta = {
  name: 'deep-review', // the name
  "description": "Review, then verify",
  phases: ["Review", \`Verify\`,],
}
return 1`)
  expect(meta).toEqual({
    name: "deep-review",
    description: "Review, then verify",
    phases: ["Review", "Verify"],
  })
})

test("meta that is not a pure literal, or misses fields, is refused without running anything", () => {
  expect(() => parseMeta("return 1")).toThrow(/must start with `export const meta/)
  expect(() => parseMeta('export const meta = { name: n, description: "d", phases: [] }')).toThrow(
    /plain literal/,
  )
  const substitution = "export const meta = { name: 'a', description: `x$" + "{1}`, phases: [] }"
  expect(() => parseMeta(substitution)).toThrow(/template substitutions/)
  expect(() => parseMeta('export const meta = { name: "a b", description: "d", phases: [] }')).toThrow(
    /meta.name/,
  )
  expect(() => parseMeta('export const meta = { name: "a", phases: [] }')).toThrow(/description/)
  expect(() => parseMeta('export const meta = { name: "a", description: "d", phases: [1] }')).toThrow(
    /phases/,
  )
})

test("the estimate counts agent() calls, and says dynamic for loops, maps and pipelines", () => {
  const fixed = `export const meta = { name: "a", description: "d", phases: [] }
    const [x, y] = await parallel([() => agent("one"), () => agent("two")])
    // agent("in a comment") is not counted, nor "agent(" in a string
    return await agent("three " + x + y)`
  expect(estimate(fixed)).toEqual({ calls: 3, dynamic: false })
  expect(sizeLine(estimate(fixed))).toBe("3")
  const loop = `export const meta = { name: "a", description: "d", phases: [] }
    return await parallel(args.map((f) => () => agent(f)))`
  expect(estimate(loop)).toEqual({ calls: 1, dynamic: true })
  expect(sizeLine(estimate(loop))).toBe("1 or more (some run in loops)")
  // Whether the run changes the user's files directly or through worktrees merged back.
  expect(workspaceLine(loop)).toContain("can change your files")
  expect(workspaceLine(`${loop}
agent("x", { isolation: "worktree" })`)).toContain("their own git worktrees")
  expect(workspaceLine(`${loop}
// agent("x", { isolation: "worktree" })`)).not.toContain("worktrees")
  expect(
    estimate(`export const meta = { name: "a", description: "d", phases: [] }\nreturn workflow("x")`).dynamic,
  ).toBe(true)
})

test("TypeScript compiles; export default is the result too", () => {
  const c = compileScript(`export const meta = { name: "a", description: "d", phases: [] }
    interface Finding { file: string }
    const f: Finding[] = []
    export default f.length`)
  expect(c.meta.name).toBe("a")
  expect(c.code).toContain("return f.length")
})

test("the skill's example scripts compile", () => {
  const skill = readFileSync(path.join(import.meta.dir, "..", "skills", "workflow", "SKILL.md"), "utf8")
  const blocks = [...skill.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)
  expect(blocks.length).toBeGreaterThanOrEqual(2)
  const META = 'export const meta = { name: "x", description: "d", phases: [] }\n'
  for (const b of blocks)
    expect(() => compileScript(b.includes("export const meta") ? b : META + b)).not.toThrow()
})
