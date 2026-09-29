/**
 * The tests need Amira's packages: `bun run link-amira <path to an Amira checkout>` links
 * @amira/api, and @amira/tui-kit (which draws what this encodes, for the tests that check the
 * two fit), into node_modules/@amira (the checkout needs a `bun install`). At runtime the
 * extension only imports @amira/api, which Amira provides itself.
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
for (const name of ["api", "tui-kit"]) {
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
