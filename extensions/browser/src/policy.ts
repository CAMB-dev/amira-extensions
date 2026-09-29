import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { isPrivateAddress } from "@amira/api"

/** Resolves a host name to all its addresses. Replaceable in tests. */
export type Resolver = (host: string) => Promise<string[]>

export const dnsResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

export interface PolicyOptions {
  allowFileUrls: boolean
  allowPrivateNetwork: boolean
  resolve?: Resolver
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase()

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopback(ip: string): boolean {
  const a = bare(ip)
  if (isIP(a) === 4) return a.startsWith("127.")
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  return !!mapped && (mapped[1] as string).startsWith("127.")
}

const isLocalhostName = (host: string) => host === "localhost" || host.endsWith(".localhost")

const PRIVATE_HINT =
  'Private-network addresses are refused; set "extensions.browser.allowPrivateNetwork": true in ~/.amira/settings.json to allow them.'
const FILE_HINT =
  'file:// URLs are refused; set "extensions.browser.allowFileUrls": true in ~/.amira/settings.json to allow them.'

/**
 * Which URLs the browser may load. Localhost is always allowed (dev servers are the point);
 * file:// and the private network only when the user's settings say so. Answers are cached
 * per host for a minute; a host whose answer changes after that is checked again.
 */
export class UrlPolicy {
  private readonly cache = new Map<string, { at: number; refusal: string | undefined }>()
  private readonly resolve: Resolver

  constructor(private readonly opts: PolicyOptions) {
    this.resolve = opts.resolve ?? dnsResolver
  }

  /** What browser_open accepts: http(s), file:// when allowed, and about:blank. */
  checkOpen(raw: string): { url: string } | { refusal: string } {
    let url: URL
    try {
      url = new URL(raw.trim())
    } catch {
      return { refusal: `not a valid URL: ${raw} (include the scheme, e.g. http://localhost:3000)` }
    }
    if (url.href === "about:blank") return { url: url.href }
    if (url.protocol === "file:") return this.opts.allowFileUrls ? { url: url.href } : { refusal: FILE_HINT }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return {
        refusal: `only http, https${this.opts.allowFileUrls ? ", file" : ""} and about:blank URLs can be opened`,
      }
    if (url.username || url.password) return { refusal: "URLs with credentials are not opened" }
    return { url: url.href }
  }

  /** Why a request (a page, a script, an XHR, a WebSocket) must not go out, or undefined. */
  async checkRequest(raw: string): Promise<string | undefined> {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return `not a valid URL: ${raw}`
    }
    switch (url.protocol) {
      case "http:":
      case "https:":
      case "ws:":
      case "wss:":
        break
      case "file:":
        return this.opts.allowFileUrls ? undefined : FILE_HINT
      case "data:":
      case "blob:":
      case "about:":
        return undefined
      default:
        return `${url.protocol} URLs are not loaded`
    }
    if (this.opts.allowPrivateNetwork) return undefined
    return this.checkHost(bare(url.hostname))
  }

  private async checkHost(host: string): Promise<string | undefined> {
    if (isLocalhostName(host)) return undefined
    if (isIP(host)) return isLoopback(host) || !isPrivateAddress(host) ? undefined : this.refuse(host)
    const hit = this.cache.get(host)
    if (hit && Date.now() - hit.at < 60_000) return hit.refusal
    let refusal: string | undefined
    try {
      const addresses = await this.resolve(host)
      // Every address must be fine: a name may answer with a public and a private one.
      const bad = addresses.find((a) => !isLoopback(a) && isPrivateAddress(a))
      refusal = bad ? this.refuse(host, bad) : undefined
    } catch {
      // Unresolvable: the browser will fail to load it on its own.
      refusal = undefined
    }
    this.cache.set(host, { at: Date.now(), refusal })
    return refusal
  }

  private refuse(host: string, ip?: string): string {
    return `${host}${ip ? ` (${ip})` : ""} is a private-network address. ${PRIVATE_HINT}`
  }
}
