import { expect, test } from "bun:test"
import { encode as encodePng } from "fast-png"
import { encode as encodeJpeg } from "jpeg-js"
import { GifWriter } from "omggif"
import { decodeImage, imageSize, resizeBitmap, sniffFormat } from "../src/decode.ts"
import { canShow, encodeImage } from "../src/encode.ts"
import { encodeSixel, quantize } from "../src/sixel.ts"
import { encodeOffThread, resetEncodeWorker } from "../src/worker.ts"

/** A bitmap from 0xRRGGBBAA pixels, row by row. */
function bitmap(width: number, pixels: number[]) {
  const data = new Uint8Array(pixels.length * 4)
  pixels.forEach((p, i) => {
    data[i * 4] = p >>> 24
    data[i * 4 + 1] = (p >>> 16) & 255
    data[i * 4 + 2] = (p >>> 8) & 255
    data[i * 4 + 3] = p & 255
  })
  return { width, height: pixels.length / width, data }
}

test("Sixel: a tiny image, byte for byte", () => {
  // Red, green / blue, transparent.
  const bmp = bitmap(2, [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0x00000000])
  expect(encodeSixel(bmp)).toBe('\x1bP0;1;0q"1;1;2;2#0;2;100;0;0#1;2;0;100;0#2;2;0;0;100#0@$#1?@$#2A\x1b\\')
  // Two bands, a run-length encoded row, and a trailing empty run left out.
  const wide = bitmap(6, [
    ...Array(6 * 6).fill(0xffffffff),
    0xffffffff,
    0xffffffff,
    0xffffffff,
    0xffffffff,
    0x00000000,
    0x00000000,
  ])
  expect(encodeSixel(wide)).toBe('\x1bP0;1;0q"1;1;6;7#0;2;100;100;100#0!6~-#0!4@\x1b\\')
})

test("Sixel: more colors than the palette holds are reduced to it, and dithered", () => {
  const pixels: number[] = []
  for (let i = 0; i < 64 * 64; i++) pixels.push((((i * 2654435761) >>> 0) & 0xffffff00) | 0xff)
  const bmp = bitmap(64, pixels)
  const { palette, index } = quantize(bmp, 16)
  expect(palette.length).toBeLessThanOrEqual(16)
  expect(Math.max(...index)).toBeLessThan(palette.length)
  expect(Math.min(...index)).toBe(0)
  const seq = encodeSixel(bmp, { maxColors: 16 })
  expect(seq).toStartWith('\x1bP0;1;0q"1;1;64;64#0;2;')
  expect(seq).not.toContain("#16;")
  expect(seq).toEndWith("\x1b\\")
  // 64 rows are 11 bands.
  expect(seq.split("-").length).toBe(11)
})

test("formats are told by their signature, and their size read from the header", () => {
  const png = encodePng({ width: 3, height: 2, data: new Uint8Array(3 * 2 * 4).fill(200), channels: 4 })
  expect(imageSize(png)).toEqual({ format: "png", width: 3, height: 2 })
  const jpeg = encodeJpeg({ width: 5, height: 4, data: Buffer.alloc(5 * 4 * 4, 128) }, 90).data
  expect(imageSize(jpeg)).toEqual({ format: "jpeg", width: 5, height: 4 })
  const gif = gifOf(4, 3)
  expect(imageSize(gif)).toEqual({ format: "gif", width: 4, height: 3 })
  const webp = new Uint8Array(30)
  webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"), 0)
  webp.set([9, 0, 0, 4, 0, 0], 24)
  expect(imageSize(webp)).toEqual({ format: "webp", width: 10, height: 5 })
  expect(sniffFormat(new TextEncoder().encode("<svg xmlns=..."))).toBeUndefined()
  // WebP needs a decoder only iTerm2's protocol has (the terminal's).
  expect(canShow("sixel", "webp")).toBe(false)
  expect(canShow("iterm2", "webp")).toBe(true)
})

function gifOf(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(1024)
  const w = new GifWriter(buf, width, height, { palette: [0xff0000, 0x0000ff] })
  w.addFrame(
    0,
    0,
    width,
    height,
    Array.from({ length: width * height }, (_, i) => i % 2),
  )
  return buf.subarray(0, w.end())
}

test("PNG, JPEG and GIF decode to RGBA", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128])
  expect(decodeImage(encodePng({ width: 2, height: 1, data: rgba, channels: 4 })).data).toEqual(rgba)
  // Gray with alpha, 16 bits.
  const gray = encodePng({
    width: 1,
    height: 1,
    data: new Uint16Array([0x8000, 0xffff]),
    channels: 2,
    depth: 16,
  })
  expect([...decodeImage(gray).data]).toEqual([128, 128, 128, 255])
  const gif = decodeImage(gifOf(2, 1))
  expect([...gif.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  const jpeg = decodeImage(encodeJpeg({ width: 8, height: 8, data: Buffer.alloc(256, 255) }, 90).data)
  expect(jpeg.width).toBe(8)
  expect(jpeg.data[3]).toBe(255)
  expect(() => decodeImage(new TextEncoder().encode("GIF"))).toThrow()
})

test("shrinking averages the pixels each target pixel covers, weighted by alpha", () => {
  const bmp = bitmap(2, [0xff0000ff, 0x00000000, 0x0000ffff, 0x0000ffff])
  expect([...resizeBitmap(bmp, 1, 1).data]).toEqual([85, 0, 170, 191])
})

const white = encodePng({ width: 40, height: 40, data: new Uint8Array(40 * 40 * 4).fill(255), channels: 4 })
const fit = { width: 18, height: 18, cols: 2, rows: 1 }

test("each protocol's payload, at the size Amira fitted", () => {
  const whole = encodeImage({ bytes: white, protocol: "sixel", fit, cellHeight: 20, whole: true })
  expect(whole).toEqual({
    protocol: "sixel",
    width: 18,
    height: 18,
    palette: "#0;2;100;100;100",
    phases: { 0: ["#0!18~", "#0!18~", "#0!18~"] },
  })
  // Drawn in slices (the full screen): the bands from every row's first pixel row, mod 6.
  const tall = { width: 10, height: 60, cols: 1, rows: 3 }
  const sliced = encodeImage({ bytes: white, protocol: "sixel", fit: tall, cellHeight: 20, whole: false })
  expect(Object.keys(sliced.protocol === "sixel" ? sliced.phases : {})).toEqual(["0", "2", "4"])
  const kitty = encodeImage({ bytes: white, protocol: "kitty", fit, cellHeight: 20, whole: true })
  expect(kitty).toMatchObject({ protocol: "kitty", width: 18, height: 18 })
  expect(kitty.protocol === "kitty" && /^[A-Za-z0-9+/]+=*$/.test(kitty.data)).toBe(true)
  // iTerm2 takes the file as it is: the terminal scales it into its cells.
  expect(encodeImage({ bytes: white, protocol: "iterm2", fit, cellHeight: 20, whole: true })).toEqual({
    protocol: "iterm2",
    data: Buffer.from(white).toString("base64"),
    size: white.length,
  })
})

test("encoding runs in a worker, the same as here; on this thread when the worker cannot load", async () => {
  const job = { bytes: white, protocol: "kitty" as const, fit, cellHeight: 20, whole: true }
  expect(await encodeOffThread(job)).toEqual(encodeImage(job))
  resetEncodeWorker({ url: new URL("./fixtures/no-such-worker.ts", import.meta.url).href })
  try {
    expect(await encodeOffThread(job)).toEqual(encodeImage(job))
    await expect(encodeOffThread({ ...job, bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow()
  } finally {
    resetEncodeWorker({ url: new URL("../src/encode-worker.ts", import.meta.url).href })
  }
})
