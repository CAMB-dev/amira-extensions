import { access, writeFile } from "node:fs/promises"
import path from "node:path"
import { Registry, readProject } from "../src/store.ts"

const [data, root, barrier, index] = process.argv.slice(2) as [string, string, string, string]
await writeFile(path.join(barrier, `ready-${index}`), "")
while (true) {
  try {
    await access(path.join(barrier, "go"))
    break
  } catch {
    await Bun.sleep(5)
  }
}
await new Registry(data).remember(await readProject(root))
