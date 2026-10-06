export interface UiaSettings {
  enabled: boolean
  overlay: boolean
  stopHotkey: string
}

export function readSettings(value: unknown): UiaSettings {
  if (value === undefined) return { enabled: false, overlay: true, stopHotkey: "ctrl+alt+q" }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("computer-use-uia settings must be an object")
  const section = value as Record<string, unknown>
  for (const name of ["enabled", "overlay"])
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
  }
}
