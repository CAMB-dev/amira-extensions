// Inherits test/offline.ts's isolated HOME, credentials and network policy from the parent.
import { writeFile } from "node:fs/promises"
import { IterationStore, readProject } from "../src/store.ts"

const [root, mode, ready] = process.argv.slice(2) as [string, string, string]
const project = await readProject(root)
if (mode === "read") {
  console.log(JSON.stringify(await new IterationStore(project).read()))
} else {
  const stop = async () => {
    if (mode === "hold") {
      await writeFile(ready, "ready")
      await new Promise(() => {})
    }
    process.exit(71)
  }
  const store = new IterationStore(
    project,
    mode === "after" ? { afterPublish: stop } : { beforePublish: stop },
  )
  await store.dispatch(0, { type: "start-work", expectedRevision: 0, attemptId: "attempt-1" })
}
