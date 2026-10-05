import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { MemoryStore } from "../../src/store.ts"

const [home, id, barrier] = process.argv.slice(2)
if (!home || !id || !barrier || process.env.AMIRA_HOME !== home) throw new Error("Temporary home required")
const store = new MemoryStore(home, "global", "test")
const signal = new AbortController().signal
writeFileSync(path.join(barrier, `${id}.ready`), "ready")
const deadline = Date.now() + 30_000
while (!existsSync(path.join(barrier, "start"))) {
  if (Date.now() > deadline) throw new Error("Barrier timed out")
  await Bun.sleep(10)
}
for (let i = 0; i < 12; i++) {
  const input = {
    name: `${id}-${i}`,
    type: "user" as const,
    description: `Preference ${id} ${i}`,
    body: "The user prefers short answers.",
  }
  await store.write(input, 0, signal)
  await store.write({ ...input, body: "The user prefers examples too." }, 0, signal)
  await store.write({ ...input, name: "shared" }, 0, signal)
  await store.write({ ...input, name: `${id}-temporary` }, 0, signal)
  await store.delete(`${id}-temporary`, 0, signal)
}
