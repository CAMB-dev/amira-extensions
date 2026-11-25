import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { HandoffArtifact, HandoffKind } from "./types.ts"

export function computeHandoffHash(
  payload: Pick<
    HandoffArtifact,
    "id" | "version" | "kind" | "title" | "content" | "decisions" | "openQuestions" | "acceptanceCriteria"
  >,
): string {
  const canonical = JSON.stringify({
    id: payload.id,
    version: payload.version,
    kind: payload.kind,
    title: payload.title,
    content: payload.content,
    decisions: payload.decisions,
    openQuestions: payload.openQuestions,
    acceptanceCriteria: payload.acceptanceCriteria,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export function createHandoffDraft(input: {
  id?: string
  version?: number
  kind: HandoffKind
  title: string
  fromPeerId: string
  fromName: string
  toPeerId: string
  toName: string
  content: string
  decisions?: string[]
  openQuestions?: string[]
  acceptanceCriteria?: string[]
}): HandoffArtifact {
  const id = input.id ?? `h_${randomUUID().slice(0, 8)}`
  const version = input.version ?? 1
  const decisions = (input.decisions ?? []).map((s) => s.trim()).filter(Boolean)
  const openQuestions = (input.openQuestions ?? []).map((s) => s.trim()).filter(Boolean)
  const acceptanceCriteria = (input.acceptanceCriteria ?? []).map((s) => s.trim()).filter(Boolean)
  const sha256 = computeHandoffHash({
    id,
    version,
    kind: input.kind,
    title: input.title.trim(),
    content: input.content.trim(),
    decisions,
    openQuestions,
    acceptanceCriteria,
  })
  return {
    id,
    version,
    kind: input.kind,
    title: input.title.trim(),
    fromPeerId: input.fromPeerId,
    fromName: input.fromName,
    toPeerId: input.toPeerId,
    toName: input.toName,
    content: input.content.trim(),
    decisions,
    openQuestions,
    acceptanceCriteria,
    sha256,
    status: "proposed",
    createdAt: Date.now(),
  }
}

function yamlStr(val: string): string {
  return JSON.stringify(val)
}

export function serializeHandoffMarkdown(h: HandoffArtifact): string {
  const yaml = [
    "---",
    `id: ${yamlStr(h.id)}`,
    `version: v${h.version}`,
    `kind: ${yamlStr(h.kind)}`,
    `title: ${yamlStr(h.title)}`,
    `from: ${yamlStr(`${h.fromName} (${h.fromPeerId})`)}`,
    `to: ${yamlStr(`${h.toName} (${h.toPeerId})`)}`,
    `status: ${yamlStr(h.status)}`,
    `sha256: ${yamlStr(h.sha256)}`,
    `createdAt: ${yamlStr(new Date(h.createdAt).toISOString())}`,
    ...(h.acceptedAt ? [`acceptedAt: ${yamlStr(new Date(h.acceptedAt).toISOString())}`] : []),
    "---",
  ]
  const body = [
    `# ${h.title}`,
    "",
    h.content,
    ...(h.decisions.length ? ["", "## Decisions", ...h.decisions.map((d) => `- ${d}`)] : []),
    ...(h.acceptanceCriteria.length
      ? ["", "## Acceptance Criteria", ...h.acceptanceCriteria.map((c) => `- [ ] ${c}`)]
      : []),
    ...(h.openQuestions.length ? ["", "## Open Questions", ...h.openQuestions.map((q) => `- ${q}`)] : []),
    "",
  ]
  return `${yaml.join("\n")}\n\n${body.join("\n")}`
}

/** Atomically write an accepted immutable handoff snapshot to `.amira/handoffs/<id>-v<N>.md`. */
export function persistHandoff(cwd: string, handoff: HandoffArtifact): string {
  const dir = path.join(cwd, ".amira", "handoffs")
  mkdirSync(dir, { recursive: true })
  const safeId = handoff.id.replace(/[^a-zA-Z0-9_-]/g, "")
  const target = path.join(dir, `${safeId}-v${handoff.version}.md`)
  const tmp = `${target}.${randomUUID().slice(0, 6)}.tmp`
  writeFileSync(tmp, serializeHandoffMarkdown(handoff), "utf8")
  renameSync(tmp, target)
  return target
}

/** Concise line-level diff summary between two handoff versions. */
export function diffHandoffs(prev: HandoffArtifact, next: HandoffArtifact): string {
  const oldLines = new Set(
    prev.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const newLines = new Set(
    next.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const added = [...newLines].filter((l) => !oldLines.has(l)).map((l) => `+ ${l}`)
  const removed = [...oldLines].filter((l) => !newLines.has(l)).map((l) => `- ${l}`)
  if (!added.length && !removed.length) return "(no content changes)"
  return [...removed.slice(0, 10), ...added.slice(0, 10)].join("\n")
}
