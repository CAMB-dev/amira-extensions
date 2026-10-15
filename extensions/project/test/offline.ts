// Runs before application imports. All test subprocesses inherit an isolated home and cwd.
import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "amira-project-offline-"))
const previousCwd = process.cwd()
for (const key of Object.keys(process.env)) {
  if (key.startsWith("AMIRA_LIVE_") || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROXY)$/i.test(key))
    delete process.env[key]
}
for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[key] = root
process.env.AMIRA_HOME = path.join(root, "amira-home")
mkdirSync(process.env.AMIRA_HOME, { recursive: true })
process.chdir(root)
const denyNetwork = () => {
  throw new Error("Network is disabled in project extension tests; use a mock dialect.")
}
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork })

afterAll(() => {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true })
})
