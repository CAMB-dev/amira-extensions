import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  formatPrototypeReferenceReport,
  PROTOTYPE_REFERENCE_HEADER,
  reportProductionPrototypeReferences,
  scanProductionPrototypeImports,
  scanProductionPrototypeReferences,
} from "../src/prototype-boundary.ts"

setDefaultTimeout(60_000)
const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})
const directory = ".amira/project/prototypes"
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "project-prototype-references-"))
  temporary.push(root)
  return root
}
async function source(root: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

async function git(root: string, ...args: string[]): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT(?:_|$)/i.test(key)))
  const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(status, error).toBe(0)
}

const reviewCases = [
  [
    "template expression",
    "main.js",
    `const view = \`\${await import("./.amira/project/prototypes/1/a.js")}\``,
  ],
  [
    "nested template",
    "main.js",
    `const view = \`outer \${\`inner \${require("./.amira/project/prototypes/1/a.js")}\`}\``,
  ],
  ["division expression", "main.cjs", 'const ratio = {} / require("./.amira/project/prototypes/1/a.cjs")'],
  ["standalone text fragment", "main.cjs", '{} / require("./.amira/project/prototypes/1/a.cjs")'],
  ["JSX text (intentionally advisory)", "main.tsx", '<p>import "./.amira/project/prototypes/1/a.js"</p>'],
  ["JSX expression", "main.tsx", '<p>{require("./.amira/project/prototypes/1/a.cjs")}</p>'],
  ["parenthesized callee", "main.js", '(require)("./.amira/project/prototypes/1/a.js")'],
  ["parenthesized require argument", "main.js", 'require(("./.amira/project/prototypes/1/a.js"))'],
  ["parenthesized import argument", "main.js", 'import(("./.amira/project/prototypes/1/a.js"))'],
  ["erased TS as wrapper", "main.ts", 'require("./.amira/project/prototypes/1/a.js" as string)'],
  ["erased TS wrappers", "main.ts", 'import((("./.amira/project/prototypes/1/a.js" as const)!))'],
  ["type-only import", "main.ts", 'import type { Props } from "./.amira/project/prototypes/1/a"'],
  ["type-only export", "main.ts", 'export type { Props } from "./.amira/project/prototypes/1/a"'],
  ["import type", "main.ts", 'type Props = import("./.amira/project/prototypes/1/a").Props'],
  ["Sass second target", "main.scss", '@import "base", "./.amira/project/prototypes/1/a";'],
  ["Sass third target", "main.sass", '@import "reset", "base", "./.amira/project/prototypes/1/a"'],
] as const
for (const [name, file, content] of reviewCases) {
  test(`text scan reports ${name} without interpreting syntax`, async () => {
    const root = await project()
    await source(root, file, content)
    expect(await scanProductionPrototypeReferences(root)).toEqual([
      { file, line: 1, column: content.indexOf(directory) + 1, text: directory },
    ])
    expect(await readFile(path.join(root, file), "utf8")).toBe(content)
  })
}

const escapedCases = [
  [
    "JS hex",
    "main.js",
    String.raw`const value = "./\x2eamira/project/prototypes/1/a"`,
    String.raw`\x2eamira/project/prototypes`,
  ],
  [
    "JS Unicode",
    "main.ts",
    String.raw`import "./\u002eamira/project/prototypes/1/a"`,
    String.raw`\u002eamira/project/prototypes`,
  ],
  [
    "JS braced Unicode",
    "main.json",
    String.raw`{"path":"./\u{2e}amira/project/prototypes/1/a"}`,
    String.raw`\u{2e}amira/project/prototypes`,
  ],
  [
    "all escaped namespace letters",
    "main.js",
    String.raw`"\x2e\u0061\u{6d}ira\x2fproject\u002fprototypes"`,
    String.raw`\x2e\u0061\u{6d}ira\x2fproject\u002fprototypes`,
  ],
  [
    "quoted CSS hex",
    "main.css",
    String.raw`@import "./.\61mira/project/prototypes/1/a.css";`,
    String.raw`.\61mira/project/prototypes`,
  ],
  [
    "unquoted CSS hex",
    "main.css",
    String.raw`@import url(./.\61mira/project/prototypes/1/a.css);`,
    String.raw`.\61mira/project/prototypes`,
  ],
  [
    "quoted CSS terminating space",
    "main.scss",
    String.raw`@import "./.\61 mira/project/prototypes/1/a";`,
    String.raw`.\61 mira/project/prototypes`,
  ],
  [
    "unquoted CSS terminating space",
    "main.css",
    String.raw`@import url(./.\000061 mira/project/prototypes/1/a.css);`,
    String.raw`.\000061 mira/project/prototypes`,
  ],
  [
    "CSS escaped separators",
    "main.less",
    String.raw`@import "./.amira\2f project\2f prototypes/1/a.css";`,
    String.raw`.amira\2f project\2f prototypes`,
  ],
  [
    "CSS terminating tab",
    "main.css",
    `${String.raw`@import "./.\61`}\tmira/project/prototypes/1/a.css";`,
    `${String.raw`.\61`}\tmira/project/prototypes`,
  ],
  [
    "plain Windows path",
    "main.ini",
    String.raw`path=C:\work\.amira\project\prototypes\1\a`,
    String.raw`.amira\project\prototypes`,
  ],
  [
    "escaped Windows separators",
    "main.json",
    String.raw`{"path":"C:\\work\\.amira\\project\\prototypes\\1\\a"}`,
    String.raw`.amira\\project\\prototypes`,
  ],
  ["ASCII case", "main.cfg", "path=./.AMIRA/PROJECT/PROTOTYPES/1/a", ".AMIRA/PROJECT/PROTOTYPES"],
] as const
for (const [name, file, content, matched] of escapedCases) {
  test(`normalizes ${name} and keeps the original match/column`, async () => {
    const root = await project()
    await source(root, file, `// prefix\r\n  ${content}\r\n`)
    expect(await scanProductionPrototypeReferences(root)).toEqual([
      { file, line: 2, column: content.indexOf(matched) + 3, text: matched },
    ])
  })
}

test("reports all occurrences, including comments, strings, regex, property calls and partial computed paths", async () => {
  const root = await project()
  const lines = [
    `// Reference: ${directory}/comment`,
    `/* ${directory}/block */`,
    `const example = '${directory}/string'`,
    `const pattern = /require("${directory}/regex")/`,
    `object.require("${directory}/property")`,
    `const computed = require("${directory}/" + suffix)`,
    `const dynamic = import(\`${directory}/\${suffix}\`)`,
    `"${directory}/a" + "${directory}/b"`,
    'throw new Error("The scanner must not execute this source")',
  ]
  await source(root, "main.cjs", lines.join("\n"))
  const found = await scanProductionPrototypeReferences(root)
  expect(found.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 8])
  expect(found.slice(-2).map(({ column }) => column)).toEqual([2, lines[7]!.lastIndexOf(directory) + 1])
  expect(found.every(({ text }) => text === directory)).toBe(true)
  // Preserve the old exported entry point without implying import semantics.
  expect(await scanProductionPrototypeImports(root)).toEqual(found)
})

test("keeps exact source columns despite decoded prefixes and Unicode", async () => {
  const root = await project()
  const content = `${String.raw`\u{1f600} \x41 `}😀  "${directory}/a"`
  await source(root, "main.ts", content)
  expect(await scanProductionPrototypeReferences(root)).toEqual([
    { file: "main.ts", line: 1, column: content.indexOf(directory) + 1, text: directory },
  ])
})

test("handles CRLF, CR and BOM-encoded text without executing config files", async () => {
  const root = await project()
  await source(root, "a.json", Buffer.from(`\ufeff{"path":"${directory}/a"}\r\n`, "utf8"))
  await source(root, "b.ini", Buffer.from(`\ufeffnone\rpath=${directory}/b`, "utf16le"))
  expect(await scanProductionPrototypeReferences(root)).toEqual([
    { file: "a.json", line: 1, column: 10, text: directory },
    { file: "b.ini", line: 2, column: 6, text: directory },
  ])
})

test("scans source/style/common config files, but excludes artifacts, build outputs, dependencies and docs", async () => {
  const root = await project()
  const scanned = [
    ".babelrc",
    ".env.local",
    ".hidden/source.ts",
    "config.cfg",
    "config.conf",
    "config.config",
    "config.ini",
    "config.json",
    "config.jsonc",
    "config.toml",
    "config.yaml",
    "config.yml",
    "main.cjs",
    "main.cts",
    "main.jsx",
    "main.mjs",
    "main.mts",
    "main.tsx",
    "style.css",
    "style.less",
    "style.sass",
    "style.scss",
  ]
  const excluded = [
    "README.md",
    "data.txt",
    ".git/hooks/pre-commit.js",
    "nested/node_modules/p/source.ts",
    ".amira/project/prototypes/1/a/main.ts",
    ".amira/project/iterations/1/evidence.json",
    "dist/main.ts",
    "nested/build/main.js",
    "out/main.ts",
    "target/main.ts",
    "coverage/report.json",
    ".next/main.js",
    ".nuxt/main.js",
    ".output/main.js",
    ".svelte-kit/main.js",
    ".cache/main.js",
    ".turbo/main.js",
    ".vite/main.js",
    ".parcel-cache/main.js",
  ]
  for (const file of [...scanned, ...excluded]) await source(root, file, directory)
  const before = await readdir(root)
  expect((await scanProductionPrototypeReferences(root)).map(({ file }) => file)).toEqual(
    [...scanned].sort((left, right) => left.localeCompare(right, "en")),
  )
  expect(await readdir(root)).toEqual(before)
})

test("honors nested gitignore rules and negations in a non-Git project without creating a .git tree", async () => {
  const root = await project()
  await source(root, ".gitignore", "ignored/\n*.generated.ts\n!keep.generated.ts\n")
  await source(root, "nested/.gitignore", "cache/\n")
  for (const file of [
    "ignored/main.ts",
    "skip.generated.ts",
    "keep.generated.ts",
    "nested/cache/main.ts",
    "nested/main.ts",
  ])
    await source(root, file, directory)
  const before = await readdir(root)
  expect((await scanProductionPrototypeReferences(root)).map(({ file }) => file)).toEqual([
    "keep.generated.ts",
    "nested/main.ts",
  ])
  expect(await readdir(root)).toEqual(before)
})

test("does not reconstruct a path split across source lines or concatenate fragments", async () => {
  const root = await project()
  await source(
    root,
    "main.ts",
    'const split = ".amira/project/" +\n "prototypes/1/a"\nconst other = ".amira/" + "project/" + "prototypes/1/a"',
  )
  expect(await scanProductionPrototypeReferences(root)).toEqual([])
  expect(formatPrototypeReferenceReport([])).toContain("not a dependency or isolation guarantee")
})

test("does not overrun malformed escapes or treat unrelated paths as references", async () => {
  const root = await project()
  await source(
    root,
    "main.json",
    String.raw`\u{110000} \u{no} \xGG \u123 ./other/prototypes .amira/other/prototypes`,
  )
  expect(await scanProductionPrototypeReferences(root)).toEqual([])
})

test("formats references as advisory file:line:column plus original matched text", () => {
  const text = String.raw`.\61mira/project/prototypes`
  const report = formatPrototypeReferenceReport([{ file: "src/view.tsx", line: 3, column: 7, text }])
  expect(report.startsWith(PROTOTYPE_REFERENCE_HEADER)).toBe(true)
  expect(report).toContain("references to the prototype directory")
  expect(report).toContain(`src/view.tsx:3:7: ${JSON.stringify(text)}`)
  expect(report).toContain("Comments, strings and JSX text may also match")
  expect(report).toContain("never blocks implementation or acceptance")
  expect(report).not.toMatch(/violations|imports/i)
})

test("matching and unavailable reports remain advisory rather than automatic gates", async () => {
  const root = await project()
  await source(root, "main.ts", directory)
  const report = await reportProductionPrototypeReferences(root)
  expect(report).toContain("main.ts:1:1")
  expect(report).toContain("never blocks implementation or acceptance")
  const unavailable = await reportProductionPrototypeReferences(path.join(root, "missing"))
  expect(unavailable).toContain(PROTOTYPE_REFERENCE_HEADER)
  expect(unavailable).toContain("Scan unavailable:")
  expect(unavailable).toContain("never blocks implementation or acceptance")
  expect(unavailable).not.toContain("No references found")
  await expect(scanProductionPrototypeReferences(path.join(root, "missing"))).rejects.toThrow()
})

test("runs from a standalone copy without production dependencies or a TypeScript parser", async () => {
  const root = await project()
  const modules = path.join(root, "standalone")
  for (const name of ["prototype-boundary.ts", "prototype-scan-ignore.ts"])
    await source(modules, name, await readFile(path.resolve(import.meta.dir, "../src", name), "utf8"))
  const input = path.join(root, "input")
  await source(input, "main.tsx", `<p>${directory}/fixture</p>`)
  await source(
    modules,
    "check.ts",
    `import { scanProductionPrototypeReferences } from "./prototype-boundary.ts"\nconsole.log(JSON.stringify(await scanProductionPrototypeReferences(${JSON.stringify(input)})))`,
  )
  const child = Bun.spawn([process.execPath, "check.ts"], {
    cwd: modules,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(status, errors).toBe(0)
  expect(JSON.parse(output)).toEqual([{ file: "main.tsx", line: 1, column: 4, text: directory }])
  const manifest = JSON.parse(await readFile(path.resolve(import.meta.dir, "../package.json"), "utf8"))
  expect(manifest.dependencies?.typescript).toBeUndefined()
})

test("never follows file/directory symlinks, junction escapes, cycles or a linked root", async () => {
  const root = await project()
  const outside = await project()
  await source(outside, "outside.ts", directory)
  await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
  await symlink(root, path.join(root, "cycle"), process.platform === "win32" ? "junction" : "dir")
  await symlink(path.join(outside, "outside.ts"), path.join(root, "linked.ts"), "file")
  await symlink(path.join(outside, "missing.ts"), path.join(root, "dangling.ts"), "file")
  expect(await scanProductionPrototypeReferences(root)).toEqual([])
  expect(await readFile(path.join(outside, "outside.ts"), "utf8")).toBe(directory)
  await expect(scanProductionPrototypeReferences(path.join(root, "escape"))).rejects.toThrow(
    "must not be a symlink",
  )
})

for (const marker of [
  ".amira//project/prototypes",
  ".amira/project//prototypes",
  ".amira///project///prototypes",
  ".AMIRA//PROJECT//PROTOTYPES",
]) {
  test(`normalizes repeated forward slashes before matching: ${marker}`, async () => {
    const root = await project()
    const text = `import "./${marker}/1/a.js";`
    expect(text.includes("\\")).toBe(false)
    await source(root, "main.ts", `// ordinary prefix\r\n  ${text}`)
    expect(await scanProductionPrototypeReferences(root)).toEqual([
      { file: "main.ts", line: 2, column: text.indexOf(marker) + 3, text: marker },
    ])
  })
}

test("keeps original columns for multiple repeated-slash references on one line", async () => {
  const root = await project()
  const first = ".amira//project/prototypes"
  const second = ".amira/project///prototypes"
  const text = `😀 import "./${first}/1/a"; import "./${second}/1/b";`
  await source(root, "main.ts", text)
  expect(await scanProductionPrototypeReferences(root)).toEqual([
    { file: "main.ts", line: 1, column: text.indexOf(first) + 1, text: first },
    { file: "main.ts", line: 1, column: text.indexOf(second) + 1, text: second },
  ])
})

test("scans tracked production under output-name directories but not untracked outputs or hard exclusions", async () => {
  const root = await project()
  await git(root, "init", "--quiet", "--template=")
  const tracked = [
    "src/build/production.ts",
    "src/target/production.ts",
    "src/out/production.ts",
    "src/dist/production.ts",
    "src/coverage/production.ts",
    "src/.next/production.ts",
    "src/.nuxt/production.ts",
    "src/.output/production.ts",
    "src/.svelte-kit/production.ts",
    "src/.cache/production.ts",
    "src/.turbo/production.ts",
    "src/.vite/production.ts",
    "src/.parcel-cache/production.ts",
    "src/build/deep/target/nested/out/config.json",
    "src/target/styles/theme.scss",
    "src/out/settings/config.toml",
    "normal.ts",
  ]
  const hard = ["node_modules/p/main.ts", ".amira/project/prototypes/1/a/main.ts"]
  for (const file of [...tracked, ...hard]) await source(root, file, `import "../../${directory}/1/a";`)
  // Write only this disposable fixture's index; never commit.
  await git(root, "add", "-f", "--", ...tracked, ...hard)
  await source(root, ".gitignore", "src/build/\n")
  for (const file of [
    "src/build/untracked.ts",
    "src/target/untracked.ts",
    "src/out/untracked.ts",
    "src/build/deep/untracked.ts",
    "src/build/deep/target/nested/out/untracked.json",
    "src/dist/untracked.ts",
    "build/untracked.ts",
  ])
    await source(root, file, directory)
  const index = await readFile(path.join(root, ".git/index"))
  const listing = (await readdir(root, { recursive: true })).sort()
  expect((await scanProductionPrototypeReferences(root)).map(({ file }) => file)).toEqual(
    [...tracked].sort((left, right) => left.localeCompare(right, "en")),
  )
  expect(await readFile(path.join(root, ".git/index"))).toEqual(index)
  expect((await readdir(root, { recursive: true })).sort()).toEqual(listing)
})

test("tracked output-name eligibility is relative to a selected project within its parent repository", async () => {
  const repository = await project()
  await git(repository, "init", "--quiet", "--template=")
  const tracked = "apps/site/src/build/production.ts"
  await source(repository, tracked, directory)
  await source(repository, "other/build/unrelated.ts", directory)
  await git(repository, "add", "--", tracked, "other/build/unrelated.ts")
  await source(repository, "apps/site/src/build/untracked.ts", directory)
  await source(repository, "apps/site/build/unrelated.ts", directory)
  expect(await scanProductionPrototypeReferences(path.join(repository, "apps/site"))).toEqual([
    { file: "src/build/production.ts", line: 1, column: 1, text: directory },
  ])
})

test("tracked eligibility never follows a symlink beneath an output-named directory", async () => {
  const root = await project()
  const outside = await project()
  await git(root, "init", "--quiet", "--template=")
  await source(root, "src/build/main.ts", directory)
  await source(outside, "external.ts", directory)
  const linked = "src/build/link.ts"
  await symlink(path.join(outside, "external.ts"), path.join(root, linked), "file")
  await git(root, "add", "--", "src/build/main.ts", linked)
  expect(await scanProductionPrototypeReferences(root)).toEqual([
    { file: "src/build/main.ts", line: 1, column: 1, text: directory },
  ])
  expect(await readFile(path.join(outside, "external.ts"), "utf8")).toBe(directory)
})
