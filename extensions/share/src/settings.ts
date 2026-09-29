/** settings.json `extensions.share`. */
export interface ShareSettings {
  /** Where /export writes when no path is given, relative to the project. */
  exportDir: string
  /** The format /export uses when neither the command nor the path says. */
  exportFormat: "md" | "html"
  /** "provider/model" for commit messages and PR drafts. Default: the session's model. */
  model?: string
  /** "provider/model" for /review. Default: agents.reviewer.model, then the session's model. */
  reviewModel?: string
  /**
   * Conventional Commits subjects ("feat(api): ..."): true always, false never, "auto" when
   * the repository's recent subjects use them.
   */
  conventional: boolean | "auto"
  /** The branch /pr and /review compare with. Default: origin's default branch, else main or master. */
  base?: string
  /** Characters of diff handed to the model; the rest is summarized by file. */
  maxDiffChars: number
}

export const DEFAULT_SETTINGS: ShareSettings = {
  exportDir: ".amira/exports",
  exportFormat: "md",
  conventional: "auto",
  maxDiffChars: 120_000,
}

const MODEL_REF = /^[^/\s]+\/\S+$/

/**
 * The `extensions.share` section, checked: a field that does not fit is reported and its
 * default used, so a typo never breaks the commands.
 */
export function readSettings(raw: unknown, report: (problem: string) => void): ShareSettings {
  const out: ShareSettings = { ...DEFAULT_SETTINGS }
  if (raw === undefined || raw === null) return out
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("settings: extensions.share must be an object; using the defaults")
    return out
  }
  const s = raw as Record<string, unknown>
  const bad = (field: string, want: string) =>
    report(`settings: extensions.share.${field} must be ${want}; using the default`)
  if (s.exportDir !== undefined) {
    if (typeof s.exportDir === "string" && s.exportDir.trim()) out.exportDir = s.exportDir.trim()
    else bad("exportDir", "a directory")
  }
  if (s.exportFormat !== undefined) {
    if (s.exportFormat === "md" || s.exportFormat === "html") out.exportFormat = s.exportFormat
    else bad("exportFormat", '"md" or "html"')
  }
  for (const field of ["model", "reviewModel"] as const) {
    const v = s[field]
    if (v === undefined) continue
    if (typeof v === "string" && MODEL_REF.test(v.trim())) out[field] = v.trim()
    else bad(field, '"provider/model"')
  }
  if (s.conventional !== undefined) {
    if (typeof s.conventional === "boolean" || s.conventional === "auto") out.conventional = s.conventional
    else bad("conventional", 'true, false or "auto"')
  }
  if (s.base !== undefined) {
    if (typeof s.base === "string" && isRefName(s.base.trim())) out.base = s.base.trim()
    else bad("base", "a branch name")
  }
  if (s.maxDiffChars !== undefined) {
    if (typeof s.maxDiffChars === "number" && Number.isInteger(s.maxDiffChars) && s.maxDiffChars >= 1000)
      out.maxDiffChars = s.maxDiffChars
    else bad("maxDiffChars", "a whole number of at least 1000")
  }
  return out
}

/** A plausible git ref name, and never an option (git would read "-x" as a flag). */
export function isRefName(ref: string): boolean {
  return /^[\w./@{}^~-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..")
}
