import { readFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "@amira/api"

export interface BrowserSettings {
  /** Default true. False shows the browser window. */
  headless: boolean
  /** Minutes without a browser tool call before the browser is closed. Default 10. */
  idleMinutes: number
  /** The page size, in CSS pixels. Default 1280×800. */
  viewport: { width: number; height: number }
  /** Characters of browser_eval output returned. Default 20000. */
  maxEvalChars: number
  /** Milliseconds a navigation or an action may take. Default 30000 and 10000. */
  navigationTimeoutMs: number
  actionTimeoutMs: number
  /** The browser to run; found automatically when unset. User settings only. */
  executablePath?: string
  /** Let pages open file:// URLs. Default false. User settings only. */
  allowFileUrls: boolean
  /**
   * Let pages reach private-network addresses (10.x, 192.168.x, link-local and so on).
   * Localhost is always allowed. Default false. User settings only.
   */
  allowPrivateNetwork: boolean
}

export const DEFAULTS: BrowserSettings = {
  headless: true,
  idleMinutes: 10,
  viewport: { width: 1280, height: 800 },
  maxEvalChars: 20_000,
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  allowFileUrls: false,
  allowPrivateNetwork: false,
}

/** Keys a project file must not set: they choose what runs and what pages may reach. */
export const USER_ONLY = ["executablePath", "allowFileUrls", "allowPrivateNetwork"] as const

type Section = Record<string, unknown>

const section = (s: Settings | undefined): Section => {
  const v = s?.extensions?.browser
  return v && typeof v === "object" ? (v as Section) : {}
}

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

/** The `extensions.browser` section of the user's own settings file, or {} when there is none. */
export function readUserSection(home: string): Section {
  try {
    const text = readFileSync(path.join(home, "settings.json"), "utf8").replace(/^﻿/, "")
    return section(JSON.parse(text) as Settings)
  } catch {
    return {}
  }
}

/**
 * The extension's settings: `merged` is every layer (user, project, flags), `user` the user
 * file's section alone, which is the only source of the USER_ONLY keys.
 */
export function readSettings(merged: Settings | undefined, user: Section): BrowserSettings {
  const s = section(merged)
  const vp = (s.viewport && typeof s.viewport === "object" ? s.viewport : {}) as Section
  const out: BrowserSettings = {
    headless: typeof s.headless === "boolean" ? s.headless : DEFAULTS.headless,
    idleMinutes: num(s.idleMinutes, DEFAULTS.idleMinutes, 0.1, 24 * 60),
    viewport: {
      width: Math.round(num(vp.width, DEFAULTS.viewport.width, 200, 3840)),
      height: Math.round(num(vp.height, DEFAULTS.viewport.height, 200, 2160)),
    },
    maxEvalChars: Math.round(num(s.maxEvalChars, DEFAULTS.maxEvalChars, 1000, 200_000)),
    navigationTimeoutMs: num(s.navigationTimeoutMs, DEFAULTS.navigationTimeoutMs, 1000, 300_000),
    actionTimeoutMs: num(s.actionTimeoutMs, DEFAULTS.actionTimeoutMs, 500, 120_000),
    allowFileUrls: user.allowFileUrls === true,
    allowPrivateNetwork: user.allowPrivateNetwork === true,
  }
  if (typeof user.executablePath === "string" && user.executablePath.trim())
    out.executablePath = user.executablePath.trim()
  return out
}

/** USER_ONLY keys set in the merged settings but not in the user file: a project file set them. */
export function ignoredProjectKeys(merged: Settings | undefined, user: Section): string[] {
  const s = section(merged)
  return USER_ONLY.filter((k) => s[k] !== undefined && s[k] !== user[k])
}
