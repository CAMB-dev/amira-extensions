import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ImageOpenContext, ImageProvider } from "@amira/api"
import { encode as encodePng } from "fast-png"
import extension from "../src/index.ts"
import { ImageFiles } from "../src/provider.ts"
import { localPath } from "../src/source.ts"

const dir = mkdtempSync(join(tmpdir(), "amira-images-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const png = (w: number, h: number) =>
  encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255), channels: 4 })
writeFileSync(join(dir, "cat.png"), png(40, 60))
writeFileSync(join(dir, "notes.txt"), "not an image")
// Noise does not compress: well over 1000 bytes.
writeFileSync(
  join(dir, "big.png"),
  encodePng({
    width: 100,
    height: 100,
    data: Uint8Array.from({ length: 100 * 100 * 4 }, (_, i) => (i * 2654435761) >>> 24),
    channels: 4,
  }),
)
const webp = new Uint8Array(30)
webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"), 0)
webp.set([9, 0, 0, 4, 0, 0], 24)
writeFileSync(join(dir, "pic.webp"), webp)

const ctx = (protocol: ImageOpenContext["protocol"] = "sixel", signal = new AbortController().signal) => ({
  protocol,
  cwd: dir,
  signal,
})
const fit = { width: 40, height: 60, cols: 4, rows: 3 }

test("local files: found from the working directory, checked, sized; never too large or not images", async () => {
  const files = new ImageFiles({ maxBytes: 1000 })
  const cat = await files.open({ url: "cat.png" }, ctx())
  expect(cat).toMatchObject({ width: 40, height: 60 })
  expect(await files.open({ url: join(dir, "cat.png") }, ctx())).toMatchObject({ width: 40 })
  // What fails fails: the next provider is asked, and in the end the alt text shows.
  expect(await files.open({ url: "notes.txt" }, ctx())).toBeUndefined()
  await expect(files.open({ url: "missing.png" }, ctx())).rejects.toThrow()
  await expect(files.open({ url: "big.png" }, ctx())).rejects.toThrow("too large")
  await expect(files.open({ url: "." }, ctx())).rejects.toThrow("not a file")
  expect(await files.open({ url: "data:image/png;base64,AAAA" }, ctx())).toBeUndefined()
  // WebP only where the terminal decodes it (iTerm2's protocol takes the file).
  expect(await files.open({ url: "pic.webp" }, ctx("sixel"))).toBeUndefined()
  expect(await files.open({ url: "pic.webp" }, ctx("iterm2"))).toMatchObject({ width: 10, height: 5 })
  // A network path is never opened.
  expect(await files.open({ url: "\\\\host\\share\\x.png" }, ctx())).toBeUndefined()
  // Encoded at the size asked for, in the protocol asked for.
  expect(await cat!.encode({ protocol: "kitty", fit, cellHeight: 20, whole: true })).toMatchObject({
    protocol: "kitty",
    width: 40,
    height: 60,
  })
})

test("bytes handed over (a rendered diagram) are opened as they are", async () => {
  const files = new ImageFiles()
  const opened = await files.open({ data: png(20, 10) }, ctx())
  expect(opened).toMatchObject({ width: 20, height: 10 })
  const p = await opened!.encode({
    protocol: "sixel",
    fit: { width: 20, height: 10, cols: 2, rows: 1 },
    cellHeight: 20,
    whole: true,
  })
  expect(p).toMatchObject({ protocol: "sixel", width: 20, height: 10 })
  expect(await files.open({ data: new TextEncoder().encode("<svg/>") }, ctx())).toBeUndefined()
})

const publicDns = async (host: string) => (host === "intranet.test" ? ["192.168.1.20"] : ["93.184.215.14"])

function net(handler: (url: string, signal: AbortSignal) => Response | Promise<Response>) {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input))
    return handler(String(input), init!.signal!)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

test("remote images: web_fetch's protection, image types only, a size limit and a time limit", async () => {
  const n = net((url, signal) => {
    if (url.includes("/redirect"))
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/x.png" } })
    if (url.endsWith("/page.png")) return new Response("<html>", { headers: { "content-type": "text/html" } })
    if (url.endsWith("/slow.png"))
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    if (url.endsWith("/huge.png"))
      return new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } })
    return new Response(png(20, 20), { headers: { "content-type": "image/png" } })
  })
  const files = new ImageFiles({ fetch: n.fetch, resolve: publicDns, timeoutMs: 50, maxBytes: 4000 })
  expect(await files.open({ url: "https://x.test/a.png" }, ctx())).toMatchObject({ width: 20, height: 20 })
  expect(n.calls).toEqual(["https://93.184.215.14/a.png"])
  // Private and local addresses are refused before anything is requested, redirects to them too.
  for (const url of [
    "http://127.0.0.1/a.png",
    "http://localhost:8080/a.png",
    "http://[::1]/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://intranet.test/a.png",
    "https://x.test/redirect",
  ])
    await expect(files.open({ url }, ctx())).rejects.toThrow("private-network")
  expect(n.calls).toEqual(["https://93.184.215.14/a.png", "https://93.184.215.14/redirect"])
  await expect(files.open({ url: "https://x.test/page.png" }, ctx())).rejects.toThrow("text/html")
  await expect(files.open({ url: "https://x.test/huge.png" }, ctx())).rejects.toThrow("too large")
  await expect(files.open({ url: "https://x.test/slow.png" }, ctx())).rejects.toThrow()
  await expect(files.open({ url: "https://u:p@x.test/a.png" }, ctx())).rejects.toThrow("credentials")
})

test("a few are read or encoded at once; an inline one that waits past its time is skipped", async () => {
  const gates = new Map<string, () => void>()
  const started: string[] = []
  const files = new ImageFiles({
    timeoutMs: 40,
    concurrency: 2,
    encode: async (job) => {
      started.push(`${job.fit.width}`)
      await new Promise<void>((go) => gates.set(`${job.fit.width}`, go))
      return { protocol: "kitty", width: job.fit.width, height: job.fit.height, data: "AAAA" }
    },
  })
  const cat = (await files.open({ url: "cat.png" }, ctx()))!
  const at = (width: number, whole = true) =>
    cat.encode({ protocol: "kitty", fit: { width, height: 60, cols: 4, rows: 3 }, cellHeight: 20, whole })
  const a = at(1)
  const b = at(2)
  const c = at(3)
  const d = at(4)
  await Bun.sleep(5)
  expect(started).toEqual(["1", "2"])
  // c gets its turn in time.
  gates.get("1")!()
  expect(await a).toMatchObject({ width: 1 })
  await Bun.sleep(5)
  expect(started).toEqual(["1", "2", "3"])
  // d has waited too long by the time b ends.
  await Bun.sleep(50)
  gates.get("2")!()
  gates.get("3")!()
  await expect(d).rejects.toThrow("waited too long")
  expect(await Promise.all([b, c])).toEqual([expect.anything(), expect.anything()])
  expect(started).toEqual(["1", "2", "3"])
  // For the full screen, it is asked whether the image is still wanted instead.
  let wanted = false
  expect(
    await cat.encode({ protocol: "kitty", fit, cellHeight: 20, whole: false, wanted: () => wanted }),
  ).toBeNull()
  wanted = true
  const e = cat.encode({ protocol: "kitty", fit, cellHeight: 20, whole: false, wanted: () => wanted })
  await Bun.sleep(5)
  gates.get("40")!()
  expect(await e).toMatchObject({ width: 40 })
})

test("files' bytes are kept for other sizes up to a limit; one let go of is read again", async () => {
  writeFileSync(join(dir, "a.png"), png(40, 60))
  writeFileSync(join(dir, "b.png"), png(40, 60))
  const size = png(40, 60).length
  const files = new ImageFiles({ keepBytes: size + 10 })
  const a = (await files.open({ url: "a.png" }, ctx()))! as unknown as {
    bytesKept?: Uint8Array
  } & ImageProviderImage
  const b = (await files.open({ url: "b.png" }, ctx()))! as unknown as {
    bytesKept?: Uint8Array
  } & ImageProviderImage
  expect(a.bytesKept).toBeUndefined()
  expect(b.bytesKept).toBeDefined()
  // Encoding a reads it again, and b goes.
  expect(await a.encode({ protocol: "kitty", fit, cellHeight: 20, whole: true })).toMatchObject({ width: 40 })
  expect(a.bytesKept).toBeDefined()
  expect(b.bytesKept).toBeUndefined()
  // A file that changed meanwhile is not drawn at the size laid out for the old one.
  writeFileSync(join(dir, "b.png"), png(10, 10))
  await expect(b.encode({ protocol: "kitty", fit, cellHeight: 20, whole: true })).rejects.toThrow("changed")
})

type ImageProviderImage = NonNullable<Awaited<ReturnType<ImageProvider["open"]>>>

test("local paths: relative to the working directory, absolute, file: URLs, escapes decoded", () => {
  const cwd = process.platform === "win32" ? "C:\\work" : "/work"
  expect(localPath("img/a%20b.png", cwd)).toBe(join(cwd, "img", "a b.png"))
  // A file may have # or ? in its name.
  expect(localPath("c#1.png", cwd)).toBe(join(cwd, "c#1.png"))
  // Never a network path, which Windows would open with the user's credentials.
  for (const unc of [
    "\\\\evil.test\\share\\a.png",
    "//evil.test/share/a.png",
    "file://evil.test/share/a.png",
    "\\\\?\\UNC\\evil.test\\share\\a.png",
    "%5C%5Cevil.test%5Cshare%5Ca.png",
    // The NT object namespace reaches shares too.
    "\\??\\UNC\\evil.test\\share\\a.png",
    "/??/GLOBALROOT/Device/Mup/evil.test/share/a.png",
  ])
    expect([unc, localPath(unc, cwd)]).toEqual([unc, undefined])
  if (process.platform === "win32") {
    expect(localPath("D:\\pics\\a.png", cwd)).toBe("D:\\pics\\a.png")
    expect(localPath("file:///D:/pics/a.png", cwd)).toBe("D:\\pics\\a.png")
    expect(localPath("\\\\.\\pipe\\x", cwd)).toBeUndefined()
    // Rooted without a drive: on the working directory's drive.
    expect(localPath("\\pics\\a.png", cwd)).toBe("C:\\pics\\a.png")
  } else expect(localPath("file:///pics/a.png", cwd)).toBe("/pics/a.png")
  expect(localPath("data:image/png;base64,AA", cwd)).toBeUndefined()
})

test("the extension registers its provider", async () => {
  const providers: ImageProvider[] = []
  await extension({
    registerImageProvider: (p: ImageProvider) => providers.push(p),
  } as unknown as ExtensionAPI)
  expect(providers.map((p) => p.id)).toEqual(["images"])
})
