import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Settings } from "@amira/api"
import { removeStaleProfiles } from "../src/browser.ts"
import type { DetectEnv } from "../src/detect.ts"
import { findBrowser, imageSize, isLoopback, readSettings, UrlPolicy } from "../src/index.ts"
import { ignoredProjectKeys } from "../src/settings.ts"

function fakeEnv(platform: NodeJS.Platform, files: string[], dirs: Record<string, string[]> = {}): DetectEnv {
  return {
    platform,
    env: {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      PATH: "/usr/bin:/bin",
    },
    home: platform === "win32" ? "C:\\Users\\u" : "/home/u",
    exists: (f) => files.includes(f),
    list: (d) => dirs[d] ?? [],
  }
}

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"

test("Windows: finds an installed Edge, and prefers Chrome when both are there", () => {
  expect(findBrowser(undefined, fakeEnv("win32", [EDGE]))).toEqual({ name: "Microsoft Edge", path: EDGE })
  expect(findBrowser(undefined, fakeEnv("win32", [EDGE, CHROME]))).toEqual({
    name: "Google Chrome",
    path: CHROME,
  })
})

test("falls back to the newest Chromium Playwright downloaded", () => {
  const cache = "C:\\Users\\u\\AppData\\Local\\ms-playwright"
  const exe = `${cache}\\chromium-1200\\chrome-win64\\chrome.exe`
  const env = fakeEnv("win32", [exe, `${cache}\\chromium-1100\\chrome-win64\\chrome.exe`], {
    [cache]: ["chromium-1100", "chromium-1200", "ffmpeg-1011"],
  })
  expect(findBrowser(undefined, env)).toEqual({ name: "Chromium", path: exe })
})

test("Linux: looks on PATH", () => {
  expect(findBrowser(undefined, fakeEnv("linux", ["/usr/bin/chromium"])).path).toBe("/usr/bin/chromium")
})

test("nothing installed: says how to get a browser", () => {
  expect(() => findBrowser(undefined, fakeEnv("win32", []))).toThrow(/playwright-core install chromium/)
  expect(() => findBrowser(undefined, fakeEnv("linux", []))).toThrow(/executablePath/)
})

test("a configured browser must exist, and wins over the ones found", () => {
  expect(findBrowser("/opt/b", fakeEnv("linux", ["/opt/b", "/usr/bin/chromium"]))).toEqual({
    name: "configured",
    path: "/opt/b",
  })
  expect(() => findBrowser("/opt/missing", fakeEnv("linux", []))).toThrow(/does not exist/)
})

test("browser_open takes http(s) and about:blank; file:// only when allowed", () => {
  const strict = new UrlPolicy({ allowFileUrls: false, allowPrivateNetwork: false })
  expect(strict.checkOpen("http://localhost:3000")).toEqual({ url: "http://localhost:3000/" })
  expect(strict.checkOpen("about:blank")).toEqual({ url: "about:blank" })
  expect(strict.checkOpen("file:///C:/x.html")).toMatchObject({
    refusal: expect.stringContaining("allowFileUrls"),
  })
  expect(strict.checkOpen("javascript:alert(1)")).toHaveProperty("refusal")
  expect(strict.checkOpen("chrome://settings")).toHaveProperty("refusal")
  expect(strict.checkOpen("localhost:3000")).toHaveProperty("refusal")
  expect(strict.checkOpen("http://u:p@example.com")).toHaveProperty("refusal")
  const loose = new UrlPolicy({ allowFileUrls: true, allowPrivateNetwork: false })
  expect(loose.checkOpen("file:///C:/x.html")).toEqual({ url: "file:///C:/x.html" })
})

test("requests: localhost is always fine, the private network only when allowed", async () => {
  const names: Record<string, string[]> = {
    "intranet.example": ["10.1.2.3"],
    "mixed.example": ["93.184.216.34", "192.168.0.5"],
    "public.example": ["93.184.216.34"],
    "loop.example": ["127.0.0.1"],
  }
  const resolve = async (h: string) => {
    const a = names[h]
    if (!a) throw new Error("ENOTFOUND")
    return a
  }
  const strict = new UrlPolicy({ allowFileUrls: false, allowPrivateNetwork: false, resolve })
  for (const ok of [
    "http://localhost:5173/",
    "http://app.localhost/",
    "http://127.0.0.1:8080/x",
    "ws://[::1]:24678/",
    "https://public.example/",
    "http://loop.example/",
    "http://[::ffff:127.0.0.1]:3000/",
    "data:text/plain,hi",
  ])
    expect(await strict.checkRequest(ok)).toBeUndefined()
  for (const bad of [
    "http://10.0.0.1/",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://intranet.example/",
    "http://mixed.example/",
    "file:///etc/passwd",
    "chrome://settings/",
    // Fails closed when the name cannot be checked.
    "https://unknown.example/",
  ])
    expect(await strict.checkRequest(bad)).toBeString()
  const open = new UrlPolicy({ allowFileUrls: true, allowPrivateNetwork: true, resolve })
  expect(await open.checkRequest("http://10.0.0.1/")).toBeUndefined()
  expect(await open.checkRequest("file:///etc/passwd")).toBeUndefined()
})

test("loopback addresses", () => {
  expect(isLoopback("127.0.0.1")).toBe(true)
  expect(isLoopback("127.5.6.7")).toBe(true)
  expect(isLoopback("::ffff:7f00:1")).toBe(true)
  expect(isLoopback("::ffff:a00:1")).toBe(false)
  expect(isLoopback("[::1]")).toBe(true)
  expect(isLoopback("::ffff:127.0.0.1")).toBe(true)
  expect(isLoopback("10.0.0.1")).toBe(false)
  expect(isLoopback("::")).toBe(false)
})

test("settings: defaults, bounds, and keys only the user file may set", () => {
  const merged: Settings = {
    extensions: {
      browser: {
        headless: false,
        idleMinutes: 0,
        viewport: { width: 99999 },
        allowPrivateNetwork: true,
        allowFileUrls: true,
        executablePath: "/evil",
      },
    },
  }
  const s = readSettings(merged, { allowFileUrls: true })
  expect(s.headless).toBe(false)
  expect(s.idleMinutes).toBe(0.1)
  expect(s.viewport).toEqual({ width: 3840, height: 800 })
  expect(s.allowFileUrls).toBe(true)
  expect(s.allowPrivateNetwork).toBe(false)
  expect(s.executablePath).toBeUndefined()
  expect(ignoredProjectKeys(merged, { allowFileUrls: true })).toEqual([
    "executablePath",
    "allowPrivateNetwork",
  ])
  expect(readSettings(undefined, {})).toMatchObject({ headless: true, idleMinutes: 10, allowFileUrls: false })
})

test("imageSize reads PNG and JPEG headers", () => {
  const png = new Uint8Array(24)
  png.set([0x89, 0x50, 0x4e, 0x47])
  new DataView(png.buffer).setUint32(16, 640)
  new DataView(png.buffer).setUint32(20, 480)
  expect(imageSize(png)).toEqual({ width: 640, height: 480 })
  // SOI, an APP0 segment of 4 bytes, then SOF0 with height 300 and width 500.
  const jpg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 0x2c, 1, 0xf4, 3, 0, 0, 0,
  ])
  expect(imageSize(jpg)).toEqual({ width: 500, height: 300 })
})

test("profiles older than any browser can live are swept; newer ones and other directories stay", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-sweep-"))
  try {
    for (const name of ["amira-browser-old", "amira-browser-new", "something-else"])
      mkdirSync(path.join(dir, name))
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000)
    utimesSync(path.join(dir, "amira-browser-old"), old, old)
    utimesSync(path.join(dir, "something-else"), old, old)
    removeStaleProfiles(dir)
    expect(readdirSync(dir).sort()).toEqual(["amira-browser-new", "something-else"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
