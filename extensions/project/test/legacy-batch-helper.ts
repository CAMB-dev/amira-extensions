import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { IterationState } from "../src/stage.ts"
import type { Project } from "../src/store.ts"

/** Encode pre-batch-accounting snapshots, with their original valid hash/projection format. */
export async function legacyJournal(project: Project, append?: IterationState): Promise<void> {
  const directory = path.join(
    project.root,
    ".amira",
    "project",
    "iterations",
    String(project.marker.currentIteration),
  )
  const journal = path.join(directory, ".state")
  const names = (await readdir(journal)).filter((name) => /^\d{16}\.json$/.test(name)).sort()
  const snapshots: IterationState[] = []
  for (const name of names) snapshots.push(JSON.parse(await readFile(path.join(journal, name), "utf8")).state)
  if (append) snapshots.push(append)
  const strip = (state: IterationState) => {
    delete state.batchManifests
    delete state.batchResolutions
    for (const attempt of state.attempts) delete attempt.manualTrial
    return state
  }
  for (const name of await readdir(directory)) {
    if (!/^\.state\.json\.[a-f0-9-]+\.preserved$/.test(name)) continue
    const file = path.join(directory, name)
    const state = strip(JSON.parse(await readFile(file, "utf8")))
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  }
  let previousHash: string | null = null
  let projection = ""
  for (const state of snapshots) {
    strip(state)
    const text: string = `${JSON.stringify({ schemaVersion: 1, previousHash, state }, null, 2)}\n`
    previousHash = createHash("sha256").update(text).digest("hex")
    const prefix = String(state.revision).padStart(16, "0")
    await writeFile(path.join(journal, `${prefix}.json`), text)
    await writeFile(path.join(journal, `${prefix}.projected`), `${previousHash}\n`)
    projection = `${JSON.stringify(state, null, 2)}\n`
  }
  await writeFile(path.join(directory, "state.json"), projection)
}
