import { fileURLToPath } from "node:url"

export interface App {
  command: string
  args?: string[]
}

export interface UiaSettings {
  enabled: boolean
  apps: Record<string, App>
}

const DEFAULT_APPS: Record<string, App> = {
  testWindow: {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("../helper/test-window.ps1", import.meta.url)),
    ],
  },
}

export function readSettings(value: unknown): UiaSettings {
  if (value === undefined) return { enabled: false, apps: DEFAULT_APPS }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("computer-use-uia settings must be an object")
  const section = value as Record<string, unknown>
  if (section.enabled !== undefined && typeof section.enabled !== "boolean")
    throw new Error("computer-use-uia.enabled must be a boolean")
  if (section.apps === undefined) return { enabled: section.enabled === true, apps: DEFAULT_APPS }
  if (!section.apps || typeof section.apps !== "object" || Array.isArray(section.apps))
    throw new Error("computer-use-uia.apps must be a map of names to { command, args? }")
  const apps: Record<string, App> = Object.create(null)
  for (const [name, raw] of Object.entries(section.apps)) {
    if (!name || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid computer-use-uia app entry")
    const app = raw as Record<string, unknown>
    if (typeof app.command !== "string" || !app.command.trim() || /[\r\n\0]/.test(app.command))
      throw new Error(`computer-use-uia.apps.${name}.command must be an executable`)
    if (app.args !== undefined && (!Array.isArray(app.args) || app.args.some((a) => typeof a !== "string")))
      throw new Error(`computer-use-uia.apps.${name}.args must be an array of strings`)
    apps[name] = { command: app.command, ...(app.args ? { args: app.args as string[] } : {}) }
  }
  return { enabled: section.enabled === true, apps }
}
