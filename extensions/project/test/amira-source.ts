import { describe, test } from "bun:test"
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { testLaunchCwd } from "./offline.ts"

export type AmiraSource = { root: string; reason?: undefined } | { root?: undefined; reason: string }
export type HostModule<T> = { module: T; reason?: undefined } | { module?: undefined; reason: string }
const packageNames = ["core", "api", "ai", "proc"]
const extensionModules = path.resolve(import.meta.dir, "../node_modules")
const guidance = "Set AMIRA_SOURCE to an Amira checkout, or run bun run link-amira <checkout>."

function isCheckout(root: string): boolean {
  try {
    return ["core", "api"].every(
      (name) =>
        JSON.parse(readFileSync(path.join(root, "packages", name, "package.json"), "utf8")).name ===
        `@amira/${name}`,
    )
  } catch {
    return false
  }
}
const pathKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)

/** Explicit configuration wins; otherwise follow the local links, never a machine-specific default. */
export function resolveAmiraSource(
  options: { source?: string; cwd?: string; modulesDir?: string } = {},
): AmiraSource {
  const source = Object.hasOwn(options, "source") ? options.source : process.env.AMIRA_SOURCE
  if (source !== undefined) {
    try {
      if (source.trim()) {
        const root = realpathSync(path.resolve(options.cwd ?? testLaunchCwd, source))
        if (isCheckout(root)) return { root }
      }
    } catch {
      /* An invalid explicit override must not silently select a different checkout. */
    }
    return {
      reason: `AMIRA_SOURCE does not identify an Amira source root containing packages/core and packages/api. ${guidance}`,
    }
  }
  for (const name of packageNames) {
    try {
      const linked = realpathSync(path.join(options.modulesDir ?? extensionModules, "@amira", name))
      const root = realpathSync(path.resolve(linked, "../.."))
      if (isCheckout(root) && pathKey(realpathSync(path.join(root, "packages", name))) === pathKey(linked))
        return { root }
    } catch {
      /* Try the other @amira links when a package is absent or unlinked. */
    }
  }
  return {
    reason: `No Amira source checkout was found through the extension's linked @amira packages. ${guidance}`,
  }
}

export const amiraSource = resolveAmiraSource()

/** File URLs support drive letters, spaces and non-ASCII paths on every supported platform. */
export async function loadHostModule<T>(
  relative: string,
  requiredExports: readonly string[] = [],
): Promise<HostModule<T>> {
  if (amiraSource.root === undefined) return { reason: amiraSource.reason }
  const file = path.resolve(amiraSource.root, relative)
  const within = path.relative(amiraSource.root, file)
  if (within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within))
    return { reason: `Host module must be relative to the Amira checkout: ${relative}` }
  try {
    if (!statSync(file).isFile()) throw new Error("not a source file")
    const module = await import(pathToFileURL(file).href)
    if (requiredExports.some((name) => module[name] === undefined))
      throw new Error("required exports are unavailable")
    return { module: module as T }
  } catch (error) {
    return {
      reason: `Cannot load Amira host module ${relative}: ${error instanceof Error ? error.message : String(error)}. Check the checkout and its installed dependencies. ${guidance}`,
    }
  }
}

function reportSkip(reason: string): void {
  // Test files may have separate module registries; the process marker keeps the notice singular.
  const key = "AMIRA_PROJECT_HOST_TEST_SKIP_NOTICE"
  if (process.env[key]) return
  process.env[key] = "1"
  console.warn(`[project tests] Host-dependent suites skipped: ${reason}`)
}
export function hostTest(
  name: string,
  host: { module?: unknown; reason?: string },
  body: () => void | Promise<void>,
  timeout?: number,
): void {
  if (host.module !== undefined) {
    test(name, body, timeout)
    return
  }
  const reason = host.reason ?? guidance
  reportSkip(reason)
  test.skip(`${name} — ${reason}`, body, timeout)
}
export function hostDescribe(
  name: string,
  host: { module?: unknown; reason?: string },
  register: () => void,
): void {
  if (host.module !== undefined) {
    describe(name, register)
    return
  }
  const reason = host.reason ?? guidance
  reportSkip(reason)
  describe.skip(`${name} — ${reason}`, register)
}
export function requireHostModule<T>(host: HostModule<T>): T {
  if (host.module === undefined) throw new Error(host.reason)
  return host.module
}
