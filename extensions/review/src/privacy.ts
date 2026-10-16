// biome-ignore-all lint/suspicious/noControlCharactersInRegex: Privacy boundaries intentionally identify and remove control characters.
import { createHash } from "node:crypto"

/** Only literal, portable repository-relative paths are accepted, never pathspecs. */
export function safePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 1024 ||
    /[\x00-\x1f\x7f-\x9f\\:*?[\]{}<>|"`$!;&()]/u.test(path) ||
    /[\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(path) ||
    path.startsWith("/") ||
    path.startsWith("-") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Expected a literal repository-relative path")
  return path
}

export function exclusion(path: string): string | undefined {
  safePath(path)
  if (redact(path) !== path) return "secret-bearing path"
  const parts = path.toLowerCase().split("/")
  const name = parts.at(-1)!
  if (parts.some((part) => [".git", ".hg", ".svn", ".amira"].includes(part)))
    return "repository/private metadata"
  if (
    parts.some((part) =>
      ["node_modules", "vendor", "third_party", "third-party", ".venv", "venv"].includes(part),
    )
  )
    return "vendor/dependencies"
  if (
    parts.some((part) =>
      ["dist", "build", "coverage", ".next", ".cache", "__pycache__", "generated"].includes(part),
    ) ||
    /(?:\.min\.(?:js|css)|\.map|\.generated\.[^.]+|\.snap)$/.test(name)
  )
    return "generated content"
  if (
    /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|uv\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum)$/.test(
      name,
    ) ||
    /\.lock$/.test(name)
  )
    return "lockfile"
  if (
    parts.some((part) => [".ssh", ".aws", ".azure", ".gnupg", "secrets", ".secrets"].includes(part)) ||
    /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(
      name,
    ) ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(name)
  )
    return "secret-bearing path"
  return undefined
}

const tokenShapes = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\b(?:hf|gsk|pplx|xai|npm|fw)_[A-Za-z0-9]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bhttps:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[^\s"'<>)]+/g,
]

/** Best-effort only. Never reads environment variables or user configuration. */
export function redact(text: string): string {
  let out = text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    (value) =>
      value
        .split(/(\r?\n)/)
        .map((part) => (/^(?:\r?\n)$/.test(part) ? part : part ? "[REDACTED]" : ""))
        .join(""),
  )
  // A diff, model diagnostic or saved excerpt may contain only the middle of a PEM body.
  // Treat long base64 runs conservatively, without requiring BEGIN/END markers. Hex-only
  // IDs/hashes are not key-body evidence; preserving them is essential to report identity.
  out = out.replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/_=-])/g, (value) =>
    /^[a-fA-F0-9]+$/.test(value) ? value : "[REDACTED]",
  )
  for (const shape of tokenShapes) out = out.replace(shape, "[REDACTED]")
  out = out.replace(/\b(Bearer|Basic|Token)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[REDACTED]")
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
  out = out.replace(
    /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|private[_-]?key|accountkey|sharedaccesskey|sharedaccesssignature|password|passwd|pwd|token|secret|credentials?)\b["']?[ \t]*[:=][ \t]*["']?)(?!\[REDACTED\])([^\s"'`,;)}\]]+)/gi,
    (whole, prefix: string, value: string) =>
      /^(?:string|number|boolean|null|undefined|true|false|void|never|unknown)$/.test(value) ||
      /^process\.env(?:\.|\[)/.test(value)
        ? whole
        : `${prefix}[REDACTED]`,
  )
  // Terminal escapes, bidi overrides and nonprinting controls must not survive model output.
  return out
    .replace(/\x1b\][^\x07\r\n]*(?:\x07|$)|\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
}

/** Public exposure metadata is separate from the operational ref used by Git/fingerprints. */
export function modelScope(
  scope: {
    readonly kind: "worktree" | "since"
    readonly paths: readonly string[]
    readonly includeUntracked: boolean
  },
  base: string,
) {
  return {
    kind: redact(scope.kind),
    paths: scope.paths.map(redact),
    includeUntracked: scope.includeUntracked,
    ...(scope.kind === "since" ? { base: redact(base) } : {}),
  }
}

export function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
