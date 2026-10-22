// Runs before application imports. All test subprocesses inherit an isolated home and cwd.
import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import tls from "node:tls"

const root = mkdtempSync(path.join(tmpdir(), "amira-project-offline-"))
const previousCwd = process.cwd()

// Source-root environment paths remain relative to the test invocation, not the isolated cwd.
export { previousCwd as testLaunchCwd }

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("AMIRA_LIVE_") ||
    /(?:API_KEY|TOKEN|PROXY|CREDENTIALS|SSH_AUTH_SOCK|SSH_AGENT_PID)$/i.test(key) ||
    key.startsWith("GIT_")
  )
    delete process.env[key]
}
for (const key of [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
])
  process.env[key] = root
process.env.AMIRA_HOME = path.join(root, "amira-home")
mkdirSync(process.env.AMIRA_HOME, { recursive: true })
const gitConfig = path.join(root, "empty-git-config")
writeFileSync(gitConfig, "")
process.env.GIT_CONFIG_GLOBAL = gitConfig
process.env.GIT_CONFIG_SYSTEM = gitConfig
process.env.GIT_CONFIG_NOSYSTEM = "1"
process.env.GIT_TERMINAL_PROMPT = "0"
process.env.GIT_ALLOW_PROTOCOL = "file"
process.env.GIT_SSH_COMMAND = "false"
process.env.GIT_TEMPLATE_DIR = path.join(root, "git-template")
mkdirSync(process.env.GIT_TEMPLATE_DIR)
process.chdir(root)
const denyNetwork = () => {
  throw new Error("Network is disabled in project extension tests; use a mock dialect.")
}
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork })
net.connect = net.createConnection = denyNetwork
http.request = http.get = denyNetwork
https.request = https.get = denyNetwork
tls.connect = denyNetwork
Bun.connect = denyNetwork
syncBuiltinESMExports()

afterAll(() => {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true })
})
