/**
 * Takes secrets out of text that leaves the machine in an export: API keys and tokens by
 * their well-known shapes, credentials in URLs and `key = value` assignments, and the values
 * of this process's secret-looking environment variables wherever they appear.
 */

export const REDACTED = "[REDACTED]"

/** Shapes of keys and tokens providers hand out; the whole match is replaced. */
const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // OpenAI, Anthropic, DeepSeek, OpenRouter and most OpenAI-compatible providers.
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:hf|gsk|pplx|xai|tvly|fw)_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // Telegram bot tokens.
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Discord and Slack webhooks carry their secret in the path.
  /\bhttps:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[^\s"'<>)]+/g,
]

/** `Authorization: Bearer <token>` and the like: the scheme stays. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{16,}/g

/** `scheme://user:password@host`: the password goes. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi

/**
 * `api_key = "..."`, `"token": "..."`, `PASSWORD=...`: the name and quotes stay. Only values
 * that look generated (long, with letters and digits) go, so `token: string` in code stays.
 */
const ASSIGNMENT =
  /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]{12,})/gi

/** Names of environment variables whose values are secrets. */
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE)/i

export type Redactor = (text: string) => string

/**
 * A redactor that also removes the values of `env`'s secret-looking variables and of the
 * variables named in `extraEnvNames` (e.g. each provider's apiKeyEnv), whatever their shape.
 */
export function createRedactor(
  env: Record<string, string | undefined> = process.env,
  extraEnvNames: string[] = [],
): Redactor {
  const extra = new Set(extraEnvNames.map((n) => n.toUpperCase()))
  const literals = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue
    if (!SECRET_ENV_NAME.test(name) && !extra.has(name.toUpperCase())) continue
    // Paths and flags in variables such as GIT_ASKPASS or SSH_AUTH_SOCK are not secrets.
    if (/[\\/]/.test(value) || /^(true|false|\d+)$/i.test(value)) continue
    literals.add(value)
  }
  // Longest first, so a value that contains another is replaced whole.
  const sorted = [...literals].sort((a, b) => b.length - a.length)
  return (text: string) => {
    if (!text) return text
    let out = text
    for (const value of sorted) if (out.includes(value)) out = out.split(value).join(REDACTED)
    for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
    out = out.replace(AUTH_SCHEME, `$1$2${REDACTED}`)
    out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    out = out.replace(ASSIGNMENT, (whole, head: string, value: string) =>
      /\d/.test(value) && /[A-Za-z]/.test(value) && !value.startsWith("$") && !value.includes(REDACTED)
        ? `${head}${REDACTED}`
        : whole,
    )
    return out
  }
}
