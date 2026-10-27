import { beforeAll, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const names = ["swarm", "workflow", "dashboard"] as const

// The linker itself finishes in milliseconds. Bun on Windows spends ~4s on a process's first
// child spawn, whatever the child: charge that once here, not to the first linker test. A later
// child can still take ~4s to be reaped, so a test that runs the linker twice gets room for both.
const SPAWN_TIMEOUT = 20_000
beforeAll(() => {
  Bun.spawnSync({ cmd: [process.execPath, "--version"], stdout: "ignore", stderr: "ignore" })
}, SPAWN_TIMEOUT)

function fixture(name: (typeof names)[number]) {
  const root = mkdtempSync(path.join(tmpdir(), "amira-api-link-"))
  const checkout = path.join(root, "checkout")
  const extension = path.join(root, "extension")
  for (const pkg of ["api", "ai", "core", "proc", "tui", "tui-kit"]) {
    const dir = path.join(checkout, "packages", pkg)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@amira/${pkg}` }))
  }
  mkdirSync(path.join(extension, "scripts"), { recursive: true })
  mkdirSync(path.join(extension, "node_modules"))
  cpSync(
    path.resolve(import.meta.dir, `../../${name}/scripts/link-amira.ts`),
    path.join(extension, "scripts/link-amira.ts"),
  )
  const run = () =>
    Bun.spawnSync({
      cmd: [process.execPath, path.join(extension, "scripts/link-amira.ts"), checkout],
      cwd: extension,
      env: { ...process.env, AMIRA_HOME: path.join(root, "home"), HOME: root, USERPROFILE: root },
      stdout: "pipe",
      stderr: "pipe",
    })
  return { root, checkout, extension, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

for (const name of names) {
  test(
    `${name} linker creates only @amira entries and does not install development dependencies`,
    () => {
      const f = fixture(name)
      try {
        expect(f.run().exitCode).toBe(0)
        expect(readdirSync(path.join(f.extension, "node_modules"))).toEqual(["@amira"])
        const expected =
          name === "dashboard" ? ["ai", "api", "tui", "tui-kit"] : ["ai", "api", "core", "proc"]
        expect(readdirSync(path.join(f.extension, "node_modules/@amira")).sort()).toEqual(expected)
        for (const pkg of expected) {
          const link = path.join(f.extension, "node_modules/@amira", pkg)
          expect(lstatSync(link).isSymbolicLink()).toBe(true)
          expect(realpathSync(link)).toBe(realpathSync(path.join(f.checkout, "packages", pkg)))
        }
        expect(f.run().exitCode).toBe(0)
        expect(readdirSync(path.join(f.extension, "node_modules"))).toEqual(["@amira"])
      } finally {
        f.cleanup()
      }
    },
    SPAWN_TIMEOUT,
  )
  test(
    `${name} linker leaves normally installed @types and tooling untouched`,
    () => {
      const f = fixture(name)
      try {
        const installed = ["@types/bun", "bun-types", "typescript", "@biomejs/biome"]
        for (const pkg of installed) {
          const dir = path.join(f.extension, "node_modules", pkg)
          mkdirSync(dir, { recursive: true })
          writeFileSync(path.join(dir, "SENTINEL"), `installed ${pkg}`)
        }
        expect(f.run().exitCode).toBe(0)
        for (const pkg of installed) {
          const dir = path.join(f.extension, "node_modules", pkg)
          expect(lstatSync(dir).isSymbolicLink()).toBe(false)
          expect(readFileSync(path.join(dir, "SENTINEL"), "utf8")).toBe(`installed ${pkg}`)
        }
      } finally {
        f.cleanup()
      }
    },
    SPAWN_TIMEOUT,
  )
  test(
    `${name} linker cannot introduce the reviewed transitive bun-types cycle`,
    () => {
      const f = fixture(name)
      try {
        const old = path.join(f.root, "old-types")
        mkdirSync(path.join(old, "runtime"), { recursive: true })
        writeFileSync(path.join(old, "runtime/package.json"), '{"name":"bun-types"}')
        mkdirSync(path.join(f.extension, "node_modules/@types"))
        const bun = path.join(f.extension, "node_modules/@types/bun")
        symlinkSync(old, bun, "junction")
        mkdirSync(path.join(f.checkout, "node_modules"))
        const source = path.join(f.checkout, "node_modules/bun-types")
        symlinkSync(path.join(bun, "runtime"), source, "junction")
        const before = realpathSync(source)
        expect(f.run().exitCode).toBe(0)
        expect(realpathSync(source)).toBe(before)
        expect(realpathSync(bun)).toBe(realpathSync(old))
        expect(existsSync(path.join(f.extension, "node_modules/bun-types"))).toBe(false)
        expect(readFileSync(path.join(source, "package.json"), "utf8")).toBe('{"name":"bun-types"}')
      } finally {
        f.cleanup()
      }
    },
    SPAWN_TIMEOUT,
  )
  test(
    `${name} linker refuses to recurse through a shared @amira container`,
    () => {
      const f = fixture(name)
      try {
        const shared = path.join(f.root, "shared-api")
        mkdirSync(shared)
        writeFileSync(path.join(shared, "SENTINEL"), "unchanged")
        symlinkSync(shared, path.join(f.extension, "node_modules/@amira"), "junction")
        expect(f.run().exitCode).not.toBe(0)
        expect(readFileSync(path.join(shared, "SENTINEL"), "utf8")).toBe("unchanged")
      } finally {
        f.cleanup()
      }
    },
    SPAWN_TIMEOUT,
  )
}
