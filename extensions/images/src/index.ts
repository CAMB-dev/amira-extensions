import { defineExtension } from "@amira/api"
import { ImageFiles } from "./provider.ts"

export { type ImageFormat, imageSize } from "./decode.ts"
export { canShow, encodeImage } from "./encode.ts"
export { ImageFiles, type ImageFilesOptions } from "./provider.ts"
export { localPath } from "./source.ts"

/**
 * Draws the images of replies in the terminal (D88): Amira finds out whether and how the
 * terminal draws them (`tui.images`) and places them; this reads, downloads, decodes and
 * encodes them.
 */
export default defineExtension((api) => {
  api.registerImageProvider(new ImageFiles())
})
