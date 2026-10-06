/**
 * The tests run the extension against a real agent tree, so they need Amira's packages:
 * `bun run link-amira <path to an Amira checkout>` links them into node_modules/@amira (the
 * checkout needs a `bun install`). At runtime the extension only imports @amira/api, which
 * Amira provides itself.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"

const repo = process.argv[2]
if (!repo) {
  console.error("usage: bun run link-amira <path to an Amira checkout>")
  process.exit(2)
}
const dir = path.join(import.meta.dir, "..", "node_modules", "@amira")
mkdirSync(dir, { recursive: true })
for (const name of ["api", "ai", "core", "proc"]) {
  const target = path.resolve(repo, "packages", name)
  if (!existsSync(path.join(target, "package.json"))) {
    console.error(`${target} is not an Amira package; is ${repo} an Amira checkout?`)
    process.exit(1)
  }
  const link = path.join(dir, name)
  rmSync(link, { recursive: true, force: true })
  // A junction on Windows needs no special rights.
  symlinkSync(target, link, "junction")
  console.log(`@amira/${name} -> ${target}`)
}
// Reuse the checkout's verification tools without adding runtime dependencies.
for (const name of [".bun", "@types", "@biomejs", "typescript", ".bin"]) {
  const target = path.resolve(repo, "node_modules", name)
  if (!existsSync(target)) continue
  const link = path.join(dir, "..", name)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, "junction")
}
