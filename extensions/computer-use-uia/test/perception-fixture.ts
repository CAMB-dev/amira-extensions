import type { Screenshot } from "../src/perception.ts"
import { screenshotSize } from "../src/perception.ts"

/** Header-only PNG protocol fake: never captures or decodes an image. */
export function fakeScreenshot(id = "image-1", width = 1920, height = 1080, maxEdge = 1280): Screenshot {
  const size = screenshotSize(width, height, maxEdge)
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.write("IHDR", 12, "ascii")
  png.writeUInt32BE(size.width, 16)
  png.writeUInt32BE(size.height, 20)
  return {
    id,
    mimeType: "image/png",
    data: png.toString("base64"),
    ...size,
    bounds: { x: -1920, y: 100, width, height },
    dpi: 144,
  }
}
