import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveAmiraSource } from "./amira-source.ts"

setDefaultTimeout(30_000)
const extension = path.resolve(import.meta.dir, "..")
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), "project-source-root-"))
  roots.push(root)
  return root
}
async function checkout(parent: string, name = "Amira checkout 空間") {
  const root = path.join(parent, name)
  for (const pkg of ["api", "core", "ai", "proc"]) {
    const directory = path.join(root, "packages", pkg)
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: `@amira/${pkg}`, type: "module" }),
    )
  }
  return root
}
async function link(modules: string, name: string, target: string) {
  await mkdir(path.join(modules, "@amira"), { recursive: true })
  const { symlink } = await import("node:fs/promises")
  await symlink(target, path.join(modules, "@amira", name), process.platform === "win32" ? "junction" : "dir")
}
async function child(
  entries: string[],
  source: string | undefined,
  cwd = extension,
  preload = path.join(extension, "test/offline.ts"),
) {
  const env = { ...process.env }
  delete env.AMIRA_PROJECT_HOST_TEST_SKIP_NOTICE
  if (source === undefined) delete env.AMIRA_SOURCE
  else env.AMIRA_SOURCE = source
  const proc = Bun.spawn([process.execPath, "test", "--preload", preload, ...entries], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, text: `${stdout}\n${stderr}` }
}

test("an explicit source root wins over links to a different checkout", async () => {
  const root = await temp()
  const selected = await checkout(root, "selected")
  const linked = await checkout(root, "linked")
  const modules = path.join(root, "node_modules")
  await link(modules, "core", path.join(linked, "packages/core"))
  expect(resolveAmiraSource({ source: selected, modulesDir: modules })).toEqual({
    root: await realpath(selected),
  })
})
test("relative AMIRA_SOURCE resolves against the invocation cwd, not the isolated test cwd", async () => {
  const root = await temp()
  const selected = await checkout(root)
  expect(resolveAmiraSource({ source: path.relative(root, selected), cwd: root })).toEqual({
    root: await realpath(selected),
  })
})
for (const source of ["", "missing-checkout"]) {
  test(`invalid explicit source ${JSON.stringify(source)} does not silently fall back to links`, async () => {
    const root = await temp()
    const selected = await checkout(root)
    const modules = path.join(root, "node_modules")
    await link(modules, "core", path.join(selected, "packages/core"))
    const result = resolveAmiraSource({ source, cwd: root, modulesDir: modules })
    expect(result.root).toBeUndefined()
    expect(result.reason).toContain("AMIRA_SOURCE")
  })
}
test("the linked core package realpath determines the checkout independently of cwd", async () => {
  const root = await temp()
  const selected = await checkout(root)
  const modules = path.join(root, "extension/node_modules")
  await link(modules, "core", path.join(selected, "packages/core"))
  expect(resolveAmiraSource({ source: undefined, cwd: tmpdir(), modulesDir: modules })).toEqual({
    root: await realpath(selected),
  })
})
test("other @amira links work when core is absent", async () => {
  const root = await temp()
  const selected = await checkout(root)
  const modules = path.join(root, "node_modules")
  await link(modules, "api", path.join(selected, "packages/api"))
  expect(resolveAmiraSource({ source: undefined, modulesDir: modules })).toEqual({
    root: await realpath(selected),
  })
})
test("ordinary installed packages and absent links are not mistaken for source checkouts", async () => {
  const root = await temp()
  const modules = path.join(root, "node_modules")
  await mkdir(path.join(modules, "@amira/core"), { recursive: true })
  await writeFile(path.join(modules, "@amira/core/package.json"), JSON.stringify({ name: "@amira/core" }))
  const result = resolveAmiraSource({ source: undefined, modulesDir: modules })
  expect(result.root).toBeUndefined()
  expect(result.reason).toContain("link-amira")
})
test("lookalike directory layouts with different package identities are rejected", async () => {
  const root = await temp()
  const selected = await checkout(root)
  await writeFile(path.join(selected, "packages/api/package.json"), JSON.stringify({ name: "unrelated-api" }))
  expect(resolveAmiraSource({ source: selected }).root).toBeUndefined()
})

for (const relative of [false, true]) {
  test(`dynamic host modules use ${relative ? "relative" : "absolute"} AMIRA_SOURCE and file URLs for spaces and Unicode`, async () => {
    const root = await temp()
    const selected = await checkout(root)
    const probe = path.join(selected, "packages/tui/src/probe.ts")
    await mkdir(path.dirname(probe), { recursive: true })
    await writeFile(probe, 'export const value = "portable checkout"\n')
    const entry = path.join(root, "dynamic-root.test.ts")
    const helper = pathToFileURL(path.join(import.meta.dir, "amira-source.ts")).href
    await writeFile(
      entry,
      `import { expect, test } from "bun:test"\nimport { amiraSource, loadHostModule } from ${JSON.stringify(helper)}\ntest("explicit dynamic source", async () => {\nexpect(amiraSource.root).toBe(${JSON.stringify(await realpath(selected))})\nconst loaded = await loadHostModule("packages/tui/src/probe.ts", ["value"])\nexpect(loaded.module?.value).toBe("portable checkout")\nconst missing = await loadHostModule("packages/tui/src/absent.ts")\nexpect(missing.reason).toContain("Cannot load Amira host module")\nconst incompatible = await loadHostModule("packages/tui/src/probe.ts", ["absent"])\nexpect(incompatible.reason).toContain("required exports")\n})\n`,
    )
    const result = await child(
      [entry],
      relative ? path.relative(root, selected) : selected,
      relative ? root : extension,
    )
    expect(result.code).toBe(0)
    expect(result.text).toContain("1 pass")
    expect(result.text).not.toContain("1 fail")
  })
}

for (const source of [undefined, "missing-explicit-source"]) {
  test(`frontend suites skip clearly without source or development packages (${source ?? "unlinked"})`, async () => {
    const root = await temp()
    const copy = path.join(root, "extension")
    await mkdir(copy)
    // No node_modules: this also catches eager public-package/production imports before the skip gate.
    await cp(path.join(extension, "src"), path.join(copy, "src"), { recursive: true })
    await cp(path.join(extension, "test"), path.join(copy, "test"), { recursive: true })
    await cp(path.join(extension, "bunfig.toml"), path.join(copy, "bunfig.toml"))
    const names = [
      "frontend.test.ts",
      "frontend-batch.test.ts",
      "frontend-trial.test.ts",
      "frontend-manual-repair.test.ts",
    ]
    const result = await child(
      names.map((name) => path.join(copy, "test", name)),
      source,
      copy,
      path.join(copy, "test/offline.ts"),
    )
    expect(result.code).toBe(0)
    // Fullscreen-only: 10 general + 2 batch + 2 trial + 1 manual-repair case.
    expect(result.text).toContain("15 skip")
    expect(result.text.match(/\[project tests\] Host-dependent suites skipped:/g)).toHaveLength(1)
    expect(result.text).toContain("AMIRA_SOURCE")
    expect(result.text).not.toContain("Cannot find module")
    expect(result.text).not.toContain("error:")
  })
}

// Keep URL conversion exercised without baking any platform-specific drive/home into fixtures.
test("the resolver helper is anchored to the extension, not a developer checkout", () => {
  expect(fileURLToPath(new URL("./amira-source.ts", import.meta.url))).toBe(
    path.join(import.meta.dir, "amira-source.ts"),
  )
})
