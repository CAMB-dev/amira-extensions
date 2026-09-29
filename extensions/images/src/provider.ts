import {
  fetchPublic,
  type ImageEncodeRequest,
  type ImageInput,
  type ImageOpenContext,
  type ImagePayload,
  type ImageProvider,
  type OpenedImage,
  type Resolver,
} from "@amira/api"
import { type ImageFormat, imageSize } from "./decode.ts"
import { canShow, type EncodeJob, type Payload } from "./encode.ts"
import { localPath, REMOTE, readLocal } from "./source.ts"
import { encodeOffThread } from "./worker.ts"

export interface ImageFilesOptions {
  /** Largest file read or downloaded. Default 10 MB. */
  maxBytes?: number
  /** Time a download may take, and a turn may be waited for by an inline image. Default 10 s. */
  timeoutMs?: number
  /** Images read or encoded at once; the others wait their turn. Default 2. */
  concurrency?: number
  /** Bytes of image files kept for encoding them at other sizes. Default 64 MB. */
  keepBytes?: number
  /** How images are encoded; default in a worker. */
  encode?: (job: EncodeJob) => Promise<Payload>
  /** For tests: the network and name resolution of downloads. */
  fetch?: typeof fetch
  resolve?: Resolver
}

const MB = 1024 * 1024
/** Content types that are images this can show (the signature is checked as well). */
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp)\b/i

/** Waited its turn longer than the time an inline image has: its fallback went long ago. */
export class Skipped extends Error {}

/**
 * The images extension's provider (D88): reads local image files (relative to the session's
 * working directory, or absolute, never on another machine) and downloads http(s) ones with
 * web_fetch's protection (fetchPublic: no private-network address, every redirect checked, the
 * connection pinned), at most `maxBytes`; checks they are a PNG, JPEG, GIF or WebP the protocol
 * can show; encodes them for Sixel, kitty or iTerm2 at the size Amira fits them to, off the main
 * thread. A file's bytes are kept (up to `keepBytes` for all) to encode it at other sizes; one
 * let go of is read again when needed.
 */
export class ImageFiles implements ImageProvider {
  readonly id = "images"
  private readonly maxBytes: number
  readonly timeoutMs: number
  private active = 0
  private queue: (() => void)[] = []
  /** Files whose bytes are kept, oldest first, by source. */
  private kept = new Map<string, OpenedFile>()
  private keptBytes = 0

  constructor(private readonly opts: ImageFilesOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 10 * MB
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  async open(input: ImageInput, ctx: ImageOpenContext): Promise<OpenedImage | undefined> {
    let source: string
    let read: (signal: AbortSignal) => Promise<Uint8Array>
    if ("data" in input) {
      if (!(input.data instanceof Uint8Array) || input.data.length > this.maxBytes) return undefined
      const data = input.data
      source = ""
      read = async () => data
    } else if (REMOTE.test(input.url)) {
      source = input.url
      read = (signal) => this.download(input.url, signal)
    } else {
      const path = localPath(input.url, ctx.cwd)
      if (path === undefined) return undefined
      source = path
      read = () => readLocal(path, this.maxBytes)
    }
    // Amira gave up on it while it waited its turn: nothing is read. A download's own time
    // starts only now, when it gets its turn.
    const bytes = await this.limited(() => {
      ctx.signal.throwIfAborted()
      return read(ctx.signal)
    }, false)
    const size = imageSize(bytes)
    if (!size || !canShow(ctx.protocol, size.format)) return undefined
    const file = new OpenedFile(this, source, size, bytes, read)
    if (source) this.keep(file)
    return file
  }

  /** Remembers a file's bytes, letting go of the oldest past the limit (they are read again when wanted). */
  keep(file: OpenedFile): void {
    const had = this.kept.get(file.source)
    if (had) {
      this.kept.delete(file.source)
      this.keptBytes -= had.bytesKept?.length ?? 0
      if (had !== file) had.drop()
    }
    if (!file.bytesKept) return
    this.kept.set(file.source, file)
    this.keptBytes += file.bytesKept.length
    const limit = this.opts.keepBytes ?? 64 * MB
    for (const [k, f] of this.kept) {
      if (this.keptBytes <= limit || this.kept.size <= 1) break
      this.kept.delete(k)
      this.keptBytes -= f.bytesKept?.length ?? 0
      f.drop()
    }
  }

  async encode(file: OpenedFile, req: ImageEncodeRequest): Promise<ImagePayload | null> {
    return this.limited(async () => {
      // Waited its turn behind others: skipped if nobody wants it any more.
      if (req.wanted && !req.wanted()) return null
      const bytes = await file.bytes()
      const job: EncodeJob = {
        bytes,
        protocol: req.protocol,
        fit: { width: req.fit.width, height: req.fit.height, cols: req.fit.cols, rows: req.fit.rows },
        cellHeight: req.cellHeight,
        whole: req.whole,
      }
      return (this.opts.encode ?? encodeOffThread)(job)
    }, req.whole)
  }

  private async download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const { bytes } = await fetchPublic(url, {
      maxBytes: this.maxBytes,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      types: IMAGE_TYPES,
      headers: { accept: "image/png,image/jpeg,image/gif,image/webp;q=0.9" },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.resolve ? { resolve: this.opts.resolve } : {}),
    })
    return bytes
  }

  /**
   * Runs `task` once fewer than `concurrency` run: decoding and encoding are heavy, and a reply
   * with dozens of images would otherwise start them all at once. With `skip`, one that waited
   * longer than the timeout is not run (Skipped): its fallback was committed long before.
   */
  private async limited<T>(task: () => Promise<T>, skip: boolean): Promise<T> {
    if (this.active >= (this.opts.concurrency ?? 2)) {
      const queued = performance.now()
      // The turn is handed over by the task that ends: `active` already counts this one.
      await new Promise<void>((go) => this.queue.push(go))
      if (skip && performance.now() - queued > this.timeoutMs) {
        this.release()
        throw new Skipped("waited too long")
      }
    } else this.active++
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
  }
}

/** An image the provider opened: its size, and its bytes while they are kept. */
export class OpenedFile implements OpenedImage {
  readonly width: number
  readonly height: number
  readonly format: ImageFormat
  bytesKept: Uint8Array | undefined
  private reading: Promise<Uint8Array> | undefined

  constructor(
    private readonly files: ImageFiles,
    /** Where it is: its URL or path; "" for bytes handed over, which are always kept. */
    readonly source: string,
    size: { width: number; height: number; format: ImageFormat },
    bytes: Uint8Array,
    private readonly read: (signal: AbortSignal) => Promise<Uint8Array>,
  ) {
    this.width = size.width
    this.height = size.height
    this.format = size.format
    this.bytesKept = bytes
  }

  /** Lets go of its bytes; they are read again when it is encoded next. */
  drop(): void {
    if (this.source) this.bytesKept = undefined
  }

  /** Its bytes: kept, or read again (once, however many sizes ask). */
  async bytes(): Promise<Uint8Array> {
    if (this.bytesKept) return this.bytesKept
    this.reading ??= this.read(AbortSignal.timeout(this.files.timeoutMs)).finally(() => {
      this.reading = undefined
    })
    const bytes = await this.reading
    const size = imageSize(bytes)
    // The file changed meanwhile: what was laid out for it no longer holds.
    if (!size || size.width !== this.width || size.height !== this.height)
      throw new Error("the image changed")
    this.bytesKept = bytes
    this.files.keep(this)
    return bytes
  }

  encode(req: ImageEncodeRequest): Promise<ImagePayload | null> {
    return this.files.encode(this, req)
  }
}
