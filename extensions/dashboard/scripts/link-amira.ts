/** Link only Amira's checkout packages. Development dependencies belong to bun install. */
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"

const repo = process.argv[2]
if (!repo) {
  console.error("usage: bun run link-amira <path to an Amira checkout>")
  process.exit(2)
}
const names = ["api", "ai", "tui", "tui-kit"]
const optional = ["tui", "tui-kit"]
const modules = path.join(import.meta.dir, "..", "node_modules")
const scope = path.join(modules, "@amira")
try {
  const links = names.flatMap((name) => {
    const target = path.resolve(repo, "packages", name)
    if (!existsSync(path.join(target, "package.json"))) {
      if (optional.includes(name)) return []
      throw new Error(`${target} is not an Amira package; prepare the checkout with bun install first`)
    }
    return [{ name, target, destination: path.join(scope, name) }]
  })
  // Never traverse a shared container or recursively delete an installed package.
  for (const parent of [modules, scope]) {
    const entry = lstatSync(parent, { throwIfNoEntry: false })
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
      throw new Error(`Expected an extension-local directory, not a shared parent: ${parent}`)
  }
  for (const link of links) {
    const entry = lstatSync(link.destination, { throwIfNoEntry: false })
    if (entry && !entry.isSymbolicLink())
      throw new Error(`Refusing to replace an installed package directory: ${link.destination}`)
  }
  mkdirSync(scope, { recursive: true })
  for (const link of links) {
    if (lstatSync(link.destination, { throwIfNoEntry: false })) unlinkSync(link.destination)
    symlinkSync(link.target, link.destination, "junction")
    console.log(`@amira/${link.name} -> ${link.target}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
