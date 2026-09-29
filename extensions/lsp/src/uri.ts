import path from "node:path"

const WIN = process.platform === "win32"

/**
 * A file URI for an absolute path, as the LSP spec writes them: `file:///C:/a/b.ts` on
 * Windows (UNC paths as `file://server/share/...`), `file:///a/b.ts` elsewhere. Each segment
 * is percent-encoded; a drive letter's colon is not.
 */
export function pathToUri(p: string, win = WIN): string {
  const encode = (segments: string) => segments.split("/").map(encodeURIComponent).join("/")
  if (win) {
    const slashed = p.replace(/\\/g, "/")
    if (slashed.startsWith("//")) return `file://${encode(slashed.slice(2))}`
    if (/^[A-Za-z]:\//.test(slashed)) return `file:///${slashed.slice(0, 3)}${encode(slashed.slice(3))}`
  }
  return `file://${encode(p)}`
}

/**
 * The path of a file URI, whichever way a server wrote it: `file:///c%3A/a/b.ts`,
 * `file:///C:/a/b.ts`, `file://server/share/x`. Undefined for other schemes.
 */
export function uriToPath(uri: string, win = WIN): string | undefined {
  if (!/^file:\/\//i.test(uri)) return undefined
  let rest: string
  try {
    rest = decodeURIComponent(uri.slice(7))
  } catch {
    return undefined
  }
  // `file://localhost/...` names this machine.
  if (/^localhost\//i.test(rest)) rest = rest.slice(9)
  if (!win) return rest.startsWith("/") ? rest : `//${rest}`
  if (/^\/[A-Za-z]:/.test(rest)) return rest.slice(1).replace(/\//g, "\\")
  if (rest.startsWith("/")) return rest.replace(/\//g, "\\")
  // file://server/share/x: a UNC path.
  return `\\\\${rest.replace(/\//g, "\\")}`
}

/**
 * A key under which one file is stored, whatever form its path or URI came in: resolved,
 * and on Windows with backslashes and in lower case (paths there ignore case).
 */
export function fileKey(p: string, win = WIN): string {
  if (!win) return path.posix.resolve(p)
  return path.win32.resolve(p).toLowerCase()
}

/** fileKey of a URI's path; undefined for URIs that are not files. */
export function uriKey(uri: string, win = WIN): string | undefined {
  const p = uriToPath(uri, win)
  return p === undefined ? undefined : fileKey(p, win)
}
