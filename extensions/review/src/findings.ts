import type { ToolDefinition } from "@amira/api"
import type { Bundle } from "./collect.ts"
import type { ReviewContext } from "./context.ts"
import { exclusion, redact, safePath } from "./privacy.ts"

type JSONSchema = ToolDefinition["parameters"]
export type Candidate = {
  path: string
  side: "old" | "new"
  startLine: number
  endLine: number
  severity: "P1" | "P2" | "P3"
  category: "correctness" | "security" | "contract" | "tests" | "standards"
  summary: string
  scenario: string
  evidence: { path: string; side: "old" | "new"; line: number; reason: string }[]
  suggestedFix: string
  rule?: string
}
export type Finding = Candidate & {
  id: string
  sources: string[]
  assessment: "supported" | "uncertain" | "refuted" | "unchecked"
  rationale?: string
  duplicateOf?: string
  ignored: boolean
  excerpt?: string
}

const text = (maxLength: number): JSONSchema => ({ type: "string", minLength: 1, maxLength })
const coordinate = { type: "integer", minimum: 1, maximum: 10_000_000 }
const side = { type: "string", enum: ["old", "new"] }
export const candidateSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "path",
    "side",
    "startLine",
    "endLine",
    "severity",
    "category",
    "summary",
    "scenario",
    "evidence",
    "suggestedFix",
  ],
  properties: {
    path: text(1024),
    side,
    startLine: coordinate,
    endLine: coordinate,
    severity: { type: "string", enum: ["P1", "P2", "P3"] },
    category: { type: "string", enum: ["correctness", "security", "contract", "tests", "standards"] },
    summary: text(160),
    scenario: text(1200),
    suggestedFix: text(1200),
    rule: text(1200),
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "side", "line", "reason"],
        properties: { path: text(1024), side, line: coordinate, reason: text(600) },
      },
    },
  },
}
export const reviewerSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "limitations"],
  properties: {
    findings: { type: "array", maxItems: 6, items: candidateSchema },
    limitations: { type: "array", maxItems: 12, items: text(500) },
  },
}
export const verifierSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assessments", "limitations"],
  properties: {
    assessments: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "assessment", "rationale"],
        properties: {
          id: { type: "string", pattern: "^F[0-9]{3}$" },
          assessment: { type: "string", enum: ["supported", "uncertain", "refuted"] },
          rationale: text(1200),
          duplicateOf: { type: "string", pattern: "^F[0-9]{3}$" },
        },
      },
    },
    limitations: { type: "array", maxItems: 12, items: text(500) },
  },
}

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const keys = (value: ObjectValue, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
const string = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000
const oneOf = (value: unknown, values: string[]) => typeof value === "string" && values.includes(value)
const bounded = (value: unknown): boolean => {
  try {
    const serialized = JSON.stringify(value)
    return !!serialized && Buffer.byteLength(serialized) <= 32 * 1024
  } catch {
    return false
  }
}
const limitationsShape = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 12 && value.every((item) => string(item, 500))

function shape(value: unknown): value is Candidate {
  if (
    !object(value) ||
    !keys(
      value,
      [
        "path",
        "side",
        "startLine",
        "endLine",
        "severity",
        "category",
        "summary",
        "scenario",
        "evidence",
        "suggestedFix",
      ],
      ["rule"],
    )
  )
    return false
  return (
    string(value.path, 1024) &&
    oneOf(value.side, ["old", "new"]) &&
    integer(value.startLine) &&
    integer(value.endLine) &&
    value.endLine >= value.startLine &&
    value.endLine - value.startLine < 10 &&
    oneOf(value.severity, ["P1", "P2", "P3"]) &&
    oneOf(value.category, ["correctness", "security", "contract", "tests", "standards"]) &&
    string(value.summary, 160) &&
    string(value.scenario, 1200) &&
    string(value.suggestedFix, 1200) &&
    (value.rule === undefined || string(value.rule, 1200)) &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.length <= 3 &&
    value.evidence.every(
      (entry) =>
        object(entry) &&
        keys(entry, ["path", "side", "line", "reason"]) &&
        string(entry.path, 1024) &&
        oneOf(entry.side, ["old", "new"]) &&
        integer(entry.line) &&
        string(entry.reason, 600),
    )
  )
}

function approved(name: string): string {
  safePath(name)
  if (exclusion(name) || redact(name) !== name) throw new Error("Unapproved finding path")
  return name
}

type SourceLine = { text: string; changed: boolean }
function patchLines(change: Bundle["changes"][number], selected: "old" | "new"): Map<number, SourceLine> {
  const source = new Map<number, SourceLine>()
  let old = 0
  let current = 0
  let inHunk = false
  for (const line of change.patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      old = Number(header[1])
      current = Number(header[3])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith("\\")) continue
    const prefix = line[0]
    if (![" ", "+", "-"].includes(prefix ?? "")) {
      inHunk = false
      continue
    }
    if (selected === "old" && prefix !== "+")
      source.set(old, { text: redact(line.slice(1)), changed: prefix === "-" })
    if (selected === "new" && prefix !== "-")
      source.set(current, { text: redact(line.slice(1)), changed: prefix === "+" })
    if (prefix !== "+") old++
    if (prefix !== "-") current++
  }
  return source
}

function changedFile(bundle: Bundle, name: string, selected: "old" | "new") {
  return bundle.changes.find(
    (change) =>
      (selected === "old" ? change.oldPath || change.path : change.path) === name && !change.metadataOnly,
  )
}

async function sourceAvailable(
  bundle: Bundle,
  context: ReviewContext,
  name: string,
  selected: "old" | "new",
  line: number,
): Promise<boolean> {
  approved(name)
  if (bundle.excluded.some((entry) => entry.path === name)) return false
  if (selected === "old") {
    const change = changedFile(bundle, name, selected)
    if (
      !change ||
      change.untracked ||
      bundle.excluded.some((entry) => entry.path === change.path || entry.path === change.oldPath)
    )
      return false
    approved(change.path)
    if (change.oldPath) approved(change.oldPath)
    return patchLines(change, "old").has(line)
  }
  // New-side evidence must have a real, approved source snapshot, not just a plausible hunk number.
  try {
    await context.excerpt(name, line)
    return true
  } catch {
    return false
  }
}

function sanitized(candidate: Candidate): Candidate {
  return {
    ...candidate,
    summary: redact(candidate.summary),
    scenario: redact(candidate.scenario),
    suggestedFix: redact(candidate.suggestedFix),
    evidence: candidate.evidence.map((entry) => ({ ...entry, reason: redact(entry.reason) })),
    ...(candidate.rule !== undefined ? { rule: redact(candidate.rule) } : {}),
  }
}

export async function validateReview(
  value: unknown,
  bundle: Bundle,
  context: ReviewContext,
): Promise<{ findings: Candidate[]; limitations: string[]; complete: boolean }> {
  if (
    !bounded(value) ||
    !object(value) ||
    !keys(value, ["findings", "limitations"]) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 6 ||
    !limitationsShape(value.limitations)
  ) {
    return {
      findings: [],
      complete: false,
      limitations: [
        "Reviewer result was missing, invalid or exceeded the 32 KiB result cap; coverage is incomplete.",
      ],
    }
  }
  const limitations = value.limitations.map((entry) => redact(entry).slice(0, 500))
  const findings: Candidate[] = []
  for (const [index, item] of value.findings.entries()) {
    try {
      if (!shape(item)) throw new Error("Invalid candidate shape")
      approved(item.path)
      const change = changedFile(bundle, item.path, item.side)
      if (
        !change ||
        bundle.excluded.some((entry) => entry.path === change.path || entry.path === change.oldPath)
      )
        throw new Error("Not an approved textual change")
      approved(change.path)
      if (change.oldPath) approved(change.oldPath)
      const source = patchLines(change, item.side)
      let changed = false
      for (let line = item.startLine; line <= item.endLine; line++) {
        if (!source.has(line) || !(await sourceAvailable(bundle, context, item.path, item.side, line)))
          throw new Error("Unavailable anchor")
        changed ||= source.get(line)!.changed
      }
      const hunk = change.hunks.some((entry) => {
        const start = item.side === "old" ? entry.oldStart : entry.newStart
        const count = item.side === "old" ? entry.oldCount : entry.newCount
        return count > 0 && item.startLine >= start && item.endLine < start + count
      })
      if (!changed || !hunk) throw new Error("No changed-line anchor")
      for (const evidence of item.evidence) {
        if (!(await sourceAvailable(bundle, context, evidence.path, evidence.side, evidence.line)))
          throw new Error("Unavailable evidence")
      }
      if (item.category === "standards") {
        // A rule must cite an admitted guidance file, not an invented convention or URL.
        const guidance = await context.guidance()
        let cited = false
        for (const name of guidance.paths) {
          const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : ""
          if (directory && !item.path.startsWith(directory)) continue
          const offset = item.rule?.indexOf(`${name}:`) ?? -1
          if (offset < 0 || (offset > 0 && !/[\s`'"(]/.test(item.rule![offset - 1]!))) continue
          const coordinate = /^(\d+)(?:\D|$)/.exec(item.rule!.slice(offset + name.length + 1))
          if (!coordinate) continue
          try {
            await context.excerpt(name, Number(coordinate[1]))
            cited = true
            break
          } catch {
            /* unavailable rule */
          }
        }
        if (!cited) throw new Error("Missing applicable rule citation")
      }
      const candidate = sanitized(item)
      if (!shape(candidate)) throw new Error("Candidate empty after sanitization")
      findings.push(candidate)
    } catch {
      limitations.push(
        `Candidate ${index + 1} omitted: invalid shape, unavailable source/evidence, unapproved location or missing changed-line/rule anchor.`,
      )
    }
  }
  return { findings, limitations, complete: findings.length === value.findings.length }
}

/** Saved excerpts come from the frozen patch side, never a live/new-side file for an old-side anchor. */
export function changeExcerpt(bundle: Bundle, finding: Candidate): string {
  const change = changedFile(bundle, finding.path, finding.side)
  if (!change) return "Frozen change context unavailable."
  const source = patchLines(change, finding.side)
  const rows = [...source]
    .filter(([line]) => line >= Math.max(1, finding.startLine - 2) && line <= finding.endLine + 2)
    .slice(0, 10)
    .map(([line, value]) => `${line}: ${value.text}`)
  const admitted: string[] = []
  for (const row of rows) {
    if (Buffer.byteLength([...admitted, row].join("\n")) > 8000) {
      admitted.push("[excerpt limited]")
      break
    }
    admitted.push(row)
  }
  return admitted.join("\n")
}

/** Exact facts only: same-line distinct defects and differing scenarios are intentionally retained. */
export function dedupe(candidates: { candidate: Candidate; lens: string }[]): Finding[] {
  const findings: Finding[] = []
  const seen = new Map<string, Finding>()
  for (const { candidate: raw, lens } of candidates) {
    const candidate = sanitized(raw)
    const normalized = (value: string) => value.trim().replace(/\s+/g, " ")
    const key = JSON.stringify([
      candidate.path,
      candidate.side,
      candidate.startLine,
      candidate.endLine,
      candidate.category,
      normalized(candidate.summary),
      normalized(candidate.scenario),
      candidate.evidence.map((entry) => [entry.path, entry.side, entry.line, normalized(entry.reason)]),
    ])
    const source = redact(lens).slice(0, 160)
    const existing = seen.get(key)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      continue
    }
    const finding: Finding = {
      ...candidate,
      id: `F${String(findings.length + 1).padStart(3, "0")}`,
      sources: [source],
      assessment: "unchecked",
      ignored: false,
    }
    findings.push(finding)
    seen.set(key, finding)
  }
  return findings
}

export function assess(findings: Finding[], value: unknown): string[] {
  for (const finding of findings) {
    finding.assessment = "unchecked"
    delete finding.rationale
    delete finding.duplicateOf
  }
  if (
    !bounded(value) ||
    !object(value) ||
    !keys(value, ["assessments", "limitations"]) ||
    !Array.isArray(value.assessments) ||
    value.assessments.length > 12 ||
    !limitationsShape(value.limitations)
  ) {
    return [
      "Verifier result was missing, invalid or exceeded the 32 KiB result cap; findings remain unchecked.",
    ]
  }
  const limitations = value.limitations.map((entry) => redact(entry).slice(0, 500))
  const known = new Map(findings.map((finding) => [finding.id, finding]))
  const counts = new Map<string, number>()
  for (const entry of value.assessments)
    if (object(entry) && typeof entry.id === "string") counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  const valid = new Map<
    string,
    { assessment: Finding["assessment"]; rationale: string; duplicateOf?: string }
  >()
  for (const entry of value.assessments) {
    if (
      !object(entry) ||
      !keys(entry, ["id", "assessment", "rationale"], ["duplicateOf"]) ||
      typeof entry.id !== "string" ||
      !known.has(entry.id) ||
      counts.get(entry.id) !== 1 ||
      !oneOf(entry.assessment, ["supported", "uncertain", "refuted"]) ||
      !string(entry.rationale, 1200) ||
      !redact(entry.rationale).trim() ||
      (entry.duplicateOf !== undefined &&
        (typeof entry.duplicateOf !== "string" ||
          !known.has(entry.duplicateOf) ||
          entry.duplicateOf === entry.id))
    ) {
      limitations.push(
        "Invalid, unknown or duplicate verifier entry omitted; affected findings remain unchecked.",
      )
      continue
    }
    valid.set(entry.id, {
      assessment: entry.assessment as Finding["assessment"],
      rationale: redact(entry.rationale).slice(0, 1200),
      ...(typeof entry.duplicateOf === "string" ? { duplicateOf: entry.duplicateOf } : {}),
    })
  }
  for (const finding of findings) {
    const entry = valid.get(finding.id)
    if (!entry) {
      limitations.push(`${finding.id}: no valid independent assessment; unchecked.`)
      continue
    }
    const visited = new Set([finding.id])
    let target = entry.duplicateOf
    let cycle = false
    while (target) {
      if (visited.has(target)) {
        cycle = true
        break
      }
      visited.add(target)
      target = valid.get(target)?.duplicateOf
    }
    if (cycle) {
      limitations.push(`${finding.id}: cyclic duplicate assessment omitted; unchecked.`)
      continue
    }
    finding.assessment = entry.assessment
    finding.rationale = entry.rationale
    if (entry.duplicateOf) finding.duplicateOf = entry.duplicateOf
  }
  return limitations
}
