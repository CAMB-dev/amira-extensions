// Encodes images for the terminal protocols. Kept free of @amira/api, which a worker cannot import.
import { deflateSync } from "node:zlib"
import { decodeImage, type ImageFormat, resizeBitmap } from "./decode.ts"
import { quantize, sixelBands, sixelPalette } from "./sixel.ts"

export type Protocol = "sixel" | "kitty" | "iterm2"

/** The size an image is drawn at, in pixels, and the cells that covers (Amira fits it). */
export interface Fit {
  width: number
  height: number
  cols: number
  rows: number
}

/** An image to encode at one fitted size (a copy of it goes to the worker). */
export interface EncodeJob {
  bytes: Uint8Array
  protocol: Protocol
  fit: Fit
  /** A cell's height in pixels: where each row of cells starts in the image. */
  cellHeight: number
  /** Drawn whole only: Sixel needs the bands from pixel row 0 alone. */
  whole: boolean
}

/** What Amira draws (ImagePayload of the API): the same shape, without importing it here. */
export type Payload =
  | { protocol: "sixel"; width: number; height: number; palette: string; phases: Record<number, string[]> }
  | { protocol: "kitty"; width: number; height: number; data: string }
  | { protocol: "iterm2"; data: string; size: number }

/** The formats each protocol can show: kitty and Sixel get pixels decoded here, iTerm2 the file. */
export function canShow(protocol: Protocol, format: ImageFormat): boolean {
  return protocol === "iterm2" || format !== "webp"
}

/**
 * Encodes an image for its protocol at the fitted size: iTerm2 takes the file as it is; the
 * others get it decoded and scaled, then kitty its pixels zlib-compressed, and Sixel a palette
 * of up to 256 colors and, for each phase a row of cells starts in, the bands of six pixel rows
 * from there (so any run of rows can be drawn without encoding again). Slow for large images:
 * it runs in a worker when it can.
 */
export function encodeImage(job: EncodeJob): Payload {
  const { fit } = job
  if (job.protocol === "iterm2")
    return { protocol: "iterm2", data: Buffer.from(job.bytes).toString("base64"), size: job.bytes.length }
  const bmp = resizeBitmap(decodeImage(job.bytes), fit.width, fit.height)
  const { width, height } = bmp
  if (job.protocol === "kitty")
    return { protocol: "kitty", width, height, data: Buffer.from(deflateSync(bmp.data)).toString("base64") }
  const { palette, index } = quantize(bmp, 256)
  const phases: Record<number, string[]> = {}
  for (let row = 0; row * job.cellHeight < height; row++) {
    const phase = (row * job.cellHeight) % 6
    if (job.whole && phase !== 0) continue
    phases[phase] ??= sixelBands(index, width, height, phase)
  }
  phases[0] ??= sixelBands(index, width, height, 0)
  return { protocol: "sixel", width, height, palette: sixelPalette(palette), phases }
}
