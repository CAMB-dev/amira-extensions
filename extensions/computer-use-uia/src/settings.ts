export interface UiaSettings {
  enabled: boolean
  overlay: boolean
  stopHotkey: string
  screenshot: boolean
  screenshotMaxEdge: number
  treeDensityThreshold: number
}

export function readSettings(value: unknown): UiaSettings {
  if (value === undefined) value = {}
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("computer-use-uia settings must be an object")
  const section = value as Record<string, unknown>
  for (const name of ["enabled", "overlay", "screenshot"])
    if (section[name] !== undefined && typeof section[name] !== "boolean")
      throw new Error(`computer-use-uia.${name} must be a boolean`)
  const rawHotkey = section.stopHotkey ?? "ctrl+alt+q"
  if (typeof rawHotkey !== "string") throw new Error("computer-use-uia.stopHotkey must be a key chord")
  const parts = rawHotkey
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
  const key = parts.pop() ?? ""
  if (
    parts.length === 0 ||
    new Set(parts).size !== parts.length ||
    parts.some((part) => !["ctrl", "alt", "shift"].includes(part)) ||
    !/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/.test(key)
  )
    throw new Error(
      "computer-use-uia.stopHotkey needs ctrl/alt/shift modifiers and a letter, digit or F1–F12",
    )
  const stopHotkey = [...parts, key].join("+")
  return {
    enabled: section.enabled === true,
    overlay: section.overlay !== false,
    stopHotkey,
    screenshot: section.screenshot !== false,
    screenshotMaxEdge: integerSetting(section.screenshotMaxEdge, 1280, 128, 4096, "screenshotMaxEdge"),
    treeDensityThreshold: integerSetting(section.treeDensityThreshold, 12, 0, 1000, "treeDensityThreshold"),
  }
}

function integerSetting(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`computer-use-uia.${name} must be an integer from ${min} to ${max}`)
  return value
}
