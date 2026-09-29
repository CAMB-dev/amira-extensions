import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** Where to look; replaceable in tests. */
export interface DetectEnv {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
  exists(file: string): boolean
  /** Directory entries, or [] when it cannot be read. */
  list(dir: string): string[]
}

export const realDetectEnv = (): DetectEnv => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: (f) => existsSync(f),
  list: (d) => {
    try {
      return readdirSync(d)
    } catch {
      return []
    }
  },
})

export interface FoundBrowser {
  path: string
  /** "Microsoft Edge", "Google Chrome", "Chromium" or "configured". */
  name: string
}

function candidates(e: DetectEnv): FoundBrowser[] {
  const out: FoundBrowser[] = []
  const add = (name: string, file: string | undefined) => {
    if (file) out.push({ name, path: file })
  }
  if (e.platform === "win32") {
    const roots = [e.env.PROGRAMFILES, e.env["PROGRAMFILES(X86)"], e.env.LOCALAPPDATA].filter(
      (r): r is string => !!r,
    )
    // Edge comes with Windows, so it is usually there; Chrome first when both are.
    for (const r of roots)
      add("Google Chrome", path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe"))
    for (const r of roots)
      add("Microsoft Edge", path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe"))
    for (const r of roots) add("Chromium", path.win32.join(r, "Chromium", "Application", "chrome.exe"))
  } else if (e.platform === "darwin") {
    for (const base of ["/Applications", path.join(e.home, "Applications")]) {
      add("Google Chrome", path.join(base, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"))
      add("Microsoft Edge", path.join(base, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"))
      add("Chromium", path.join(base, "Chromium.app", "Contents", "MacOS", "Chromium"))
    }
  } else {
    const dirs = (e.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean)
    const names: [string, string][] = [
      ["Google Chrome", "google-chrome"],
      ["Google Chrome", "google-chrome-stable"],
      ["Microsoft Edge", "microsoft-edge"],
      ["Microsoft Edge", "microsoft-edge-stable"],
      ["Chromium", "chromium"],
      ["Chromium", "chromium-browser"],
    ]
    for (const [name, bin] of names) for (const d of dirs) add(name, path.posix.join(d, bin))
    add("Google Chrome", "/opt/google/chrome/chrome")
    add("Microsoft Edge", "/opt/microsoft/msedge/msedge")
  }
  // A Chromium that Playwright downloaded (`bunx playwright-core install chromium`).
  const cache =
    e.env.PLAYWRIGHT_BROWSERS_PATH ||
    (e.platform === "win32"
      ? e.env.LOCALAPPDATA && path.win32.join(e.env.LOCALAPPDATA, "ms-playwright")
      : e.platform === "darwin"
        ? path.join(e.home, "Library", "Caches", "ms-playwright")
        : path.join(e.env.XDG_CACHE_HOME || path.join(e.home, ".cache"), "ms-playwright"))
  if (cache) {
    const join = e.platform === "win32" ? path.win32.join : path.posix.join
    const builds = e
      .list(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    for (const b of builds) {
      if (e.platform === "win32") {
        add("Chromium", join(cache, b, "chrome-win64", "chrome.exe"))
        add("Chromium", join(cache, b, "chrome-win", "chrome.exe"))
      } else if (e.platform === "darwin") {
        for (const dir of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"])
          add("Chromium", join(cache, b, dir, "Chromium.app", "Contents", "MacOS", "Chromium"))
      } else {
        add("Chromium", join(cache, b, "chrome-linux64", "chrome"))
        add("Chromium", join(cache, b, "chrome-linux", "chrome"))
      }
    }
  }
  return out
}

/** An installed Chrome, Edge or Chromium; `configured` wins when set (and must exist). */
export function findBrowser(configured: string | undefined, e: DetectEnv = realDetectEnv()): FoundBrowser {
  if (configured) {
    if (!e.exists(configured))
      throw new Error(`extensions.browser.executablePath does not exist: ${configured}`)
    return { path: configured, name: "configured" }
  }
  const found = candidates(e).find((c) => e.exists(c.path))
  if (!found) throw new Error(installHint(e.platform))
  return found
}

export function installHint(platform: NodeJS.Platform): string {
  const get =
    platform === "win32"
      ? "Microsoft Edge normally comes with Windows; install it or Google Chrome"
      : platform === "darwin"
        ? "Install Google Chrome or Microsoft Edge"
        : "Install Google Chrome, Microsoft Edge or Chromium (e.g. your distribution's chromium package)"
  return [
    "No Chrome, Edge or Chromium was found.",
    `${get}, or download a Chromium for Playwright with \`bunx playwright-core install chromium\`,`,
    'or set "extensions.browser.executablePath" in ~/.amira/settings.json to a Chromium-based browser.',
  ].join(" ")
}
