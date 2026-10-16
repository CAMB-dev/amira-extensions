import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { createPrototypeScanIgnore } from "./prototype-scan-ignore.ts"

export interface PrototypeDirectoryReference {
  /** Project-relative path, with forward slashes. */
  file: string
  /** One-based source line and UTF-16 column, before escape decoding. */
  line: number
  column: number
  /** Original matched text, including any escapes/backslashes, not an inferred import. */
  text: string
}

export const PROTOTYPE_REFERENCE_HEADER = "Advisory: references to the prototype directory"
const ADVISORY =
  "Comments, strings and JSX text may also match. Review the context; this advisory never blocks implementation or acceptance."
const DIRECTORY = ".amira/project/prototypes"
const SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|jsonc?|ya?ml|toml|ini|cfg|conf|config)$/i
const CONFIG = /^(?:\.env(?:\..+)?|\.[a-z0-9-]*rc(?:\..+)?|\.gitignore|\.gitattributes)$/i
const HARD_EXCLUDED = new Set([".git", "node_modules"])
const OUTPUT_NAMES = new Set([
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".cache",
  ".turbo",
  ".vite",
  ".parcel-cache",
])
const JS_ESCAPE = /\\(?:x([\da-f]{2})|u\{([\da-f]{1,6})\}|u([\da-f]{4}))/iy
const CSS_ESCAPE = /\\([\da-f]{1,6})[ \t\f]?/iy

type NormalizedLine = { text: string; starts: number[]; ends: number[] }

/** Text normalization only: no language parser, string evaluation or path resolution. */
function normalizeLine(line: string): NormalizedLine {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  function append(value: string, start: number, end: number): void {
    // Keep a source span for each UTF-16 unit so decoding never shifts report columns.
    for (const unit of value.split("")) {
      const char = unit === "\\" ? "/" : unit.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      if (char === "/" && chars.at(-1) === "/") {
        ends[ends.length - 1] = end
      } else {
        chars.push(char)
        starts.push(start)
        ends.push(end)
      }
    }
  }
  for (let cursor = 0; cursor < line.length; ) {
    if (line[cursor] === "\\") {
      JS_ESCAPE.lastIndex = cursor
      const js = JS_ESCAPE.exec(line)
      if (js) {
        const point = Number.parseInt(js[1] ?? js[2] ?? js[3]!, 16)
        if (point <= 0x10ffff) {
          append(String.fromCodePoint(point), cursor, JS_ESCAPE.lastIndex)
          cursor = JS_ESCAPE.lastIndex
          continue
        }
      }
      CSS_ESCAPE.lastIndex = cursor
      const css = CSS_ESCAPE.exec(line)
      if (css) {
        const point = Number.parseInt(css[1]!, 16)
        const valid = point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        append(valid ? String.fromCodePoint(point) : "\ufffd", cursor, CSS_ESCAPE.lastIndex)
        cursor = CSS_ESCAPE.lastIndex
        continue
      }
    }
    append(line[cursor]!, cursor, cursor + 1)
    cursor++
  }
  return { text: chars.join(""), starts, ends }
}

function references(file: string, source: string): PrototypeDirectoryReference[] {
  const found: PrototypeDirectoryReference[] = []
  for (const [index, line] of source.split(/\r\n|[\r\n]/).entries()) {
    // Normalize every line before matching: a raw-text prefilter can hide paths
    // whose repeated separators or escapes only become recognizable afterwards.
    const normalized = normalizeLine(line)
    for (
      let at = normalized.text.indexOf(DIRECTORY);
      at >= 0;
      at = normalized.text.indexOf(DIRECTORY, at + DIRECTORY.length)
    ) {
      const start = normalized.starts[at]!
      const end = normalized.ends[at + DIRECTORY.length - 1]!
      found.push({ file, line: index + 1, column: start + 1, text: line.slice(start, end) })
    }
  }
  return found
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function decodeSource(bytes: Buffer): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8"
  return new TextDecoder(encoding).decode(bytes)
}

/**
 * Advisory text references, not import/dependency violations or an execution gate.
 * JS/TS, styles and common configs are searched even in comments, strings and JSX text.
 * Normalize JS hex/Unicode and CSS hex escapes, backslashes/repeated slashes and ASCII case.
 * Paths split across source lines or assembled from fragments are not reconstructed.
 * No project code/configuration is executed. Git is queried only for tracked/ignore metadata.
 * Symlinks/junctions are not followed; portable checks cannot defeat hostile concurrent swaps.
 */
export async function scanProductionPrototypeReferences(
  root: string,
): Promise<PrototypeDirectoryReference[]> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Project root must not be a symlink or junction")
  const canonicalRoot = await realpath(root)
  const artifacts = path.join(canonicalRoot, ".amira", "project")
  const found: PrototypeDirectoryReference[] = []
  const ignore = await createPrototypeScanIgnore(canonicalRoot)
  const trackedFiles = new Set<string>()
  const trackedDirectories = new Set<string>()
  const pathKey = (relative: string) => (process.platform === "win32" ? relative.toLowerCase() : relative)
  async function walk(directory: string, withinOutput = false): Promise<void> {
    if ((await realpath(directory)) !== directory || !inside(canonicalRoot, directory))
      throw new Error("Project directory changed during prototype reference scan")
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    const candidates: {
      file: string
      relative: string
      stat: Awaited<ReturnType<typeof lstat>>
      output: boolean
      tracked: boolean
    }[] = []
    for (const entry of entries) {
      if (HARD_EXCLUDED.has(entry.name) || path.join(directory, entry.name) === artifacts) continue
      const file = path.join(directory, entry.name)
      const stat = await lstat(file)
      if (
        stat.isSymbolicLink() ||
        !(stat.isDirectory() || (stat.isFile() && (SOURCE.test(entry.name) || CONFIG.test(entry.name))))
      )
        continue
      const relative = path.relative(canonicalRoot, file).split(path.sep).join("/")
      const tracked =
        trackedFiles.has(pathKey(relative)) ||
        (stat.isDirectory() && trackedDirectories.has(pathKey(relative)))
      const output = withinOutput || (stat.isDirectory() && OUTPUT_NAMES.has(entry.name))
      // An output-like name is only a heuristic. Traverse ancestors of tracked
      // candidates, but do not thereby admit their untracked output siblings.
      if (output && !tracked) continue
      candidates.push({ file, relative, stat, output, tracked })
    }
    const ignored = await ignore.ignored(
      candidates.map(({ relative, stat }) => relative + (stat.isDirectory() ? "/" : "")),
    )
    for (const { file, relative, stat, output, tracked } of candidates) {
      if (!tracked && ignored.has(relative + (stat.isDirectory() ? "/" : ""))) continue
      if ((await realpath(file)) !== file)
        throw new Error("Project entry changed during prototype reference scan")
      if (stat.isDirectory()) await walk(file, output)
      else {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const opened = await handle.stat()
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || (await realpath(file)) !== file)
            throw new Error("Project source changed during prototype reference scan")
          found.push(...references(relative, decodeSource(await handle.readFile())))
        } finally {
          await handle.close()
        }
      }
    }
  }
  try {
    // Git's index is the authority for tracked production, not directory names.
    // Snapshot it once, and retain all ancestors needed to reach those files.
    for (const file of await ignore.tracked()) {
      trackedFiles.add(pathKey(file))
      for (let parent = path.posix.dirname(file); parent !== "."; parent = path.posix.dirname(parent))
        trackedDirectories.add(pathKey(parent))
    }
    await walk(canonicalRoot)
  } finally {
    await ignore.close()
  }
  return found
}

/** Compatibility name; results are now advisory text references, NOT import violations. */
export const scanProductionPrototypeImports = scanProductionPrototypeReferences

export function formatPrototypeReferenceReport(found: readonly PrototypeDirectoryReference[]): string {
  const matches = found.length
    ? found
        .map(
          (reference) =>
            `${JSON.stringify(reference.file).slice(1, -1)}:${reference.line}:${reference.column}: ${JSON.stringify(reference.text)}`,
        )
        .join("\n")
    : "No references found in the scanned files. This is not a dependency or isolation guarantee."
  return `${PROTOTYPE_REFERENCE_HEADER}\n${ADVISORY}\n\n${matches}`
}

/** Implementation/acceptance can display this without turning findings or scan failures into a gate. */
export async function reportProductionPrototypeReferences(root: string): Promise<string> {
  try {
    return formatPrototypeReferenceReport(await scanProductionPrototypeReferences(root))
  } catch (error) {
    return `${PROTOTYPE_REFERENCE_HEADER}\n${ADVISORY}\n\nScan unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}
