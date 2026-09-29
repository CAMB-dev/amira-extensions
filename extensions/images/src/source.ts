import { open, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** A path that goes to another machine: \\host\share, //host/share, \\?\UNC\..., \\.\device. */
const NETWORK_PATH = /^[\\/]{2}/
/** The NT object namespace (\??\UNC\host\..., \??\GLOBALROOT\...), which Windows accepts too. */
const NT_PATH = /^[\\/]\?\?[\\/]/

export const REMOTE = /^https?:\/\//i

/**
 * Where a local image is: a file: URL on this machine, or a path (percent-escapes decoded) from
 * `cwd`. Never a network path: opening one has Windows connect to that host with the user's
 * credentials, before anything could tell it is not an image.
 */
export function localPath(src: string, cwd: string): string | undefined {
  let path: string
  if (/^file:/i.test(src)) {
    try {
      const url = new URL(src)
      if (url.host !== "" && url.host.toLowerCase() !== "localhost") return undefined
      path = fileURLToPath(url)
    } catch {
      return undefined
    }
  } else {
    // Another scheme (data:, ftp:, ...), but not a Windows drive letter.
    if (/^[a-z][a-z0-9+.-]+:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return undefined
    path = src
    try {
      path = decodeURI(src)
    } catch {}
  }
  if (NETWORK_PATH.test(path) || NT_PATH.test(path)) return undefined
  const full = resolve(cwd, path)
  if (NETWORK_PATH.test(full)) return undefined
  // On Windows only a plain path on a drive: not \\?\, \\.\, \??\ or a share, however written.
  if (process.platform === "win32" && !/^[a-z]:\\(?![\\/])/i.test(full)) return undefined
  return full
}

/**
 * A local image file's bytes: a regular file (checked before it is opened, so a FIFO or a
 * device is never opened, and again once open), at most `maxBytes` read however it grows.
 */
export async function readLocal(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a file: ${path}`)
  if (info.size > maxBytes) throw new Error(`image too large: ${info.size} bytes`)
  const fh = await open(path, "r")
  try {
    const now = await fh.stat()
    if (!now.isFile() || now.size > maxBytes) throw new Error(`not a file, or too large: ${path}`)
    const buf = new Uint8Array(Math.min(maxBytes, now.size) + 1)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got)
      if (!bytesRead) break
      got += bytesRead
    }
    if (got > maxBytes) throw new Error(`image too large: over ${maxBytes} bytes`)
    return buf.subarray(0, got)
  } finally {
    await fh.close()
  }
}
