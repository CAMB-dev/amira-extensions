import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Set before any host-backed fixture imports. Never consult or create the real Amira home.
const home = mkdtempSync(path.join(tmpdir(), "amira-review-home-"))
process.env.AMIRA_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))
