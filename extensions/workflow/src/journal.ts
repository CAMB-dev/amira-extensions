import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { WorkflowMeta } from "./meta.ts"

/** A finished agent() call, as the journal keeps it. */
export interface JournalEntry {
  /** hash(prompt, opts) and how many calls with that hash came before it: `<hash>#<n>`. */
  key: string
  label: string
  /** Missing on journals written before 0.1.5, which recorded only successes. */
  status?: "done" | "error" | "aborted" | "cached"
  error?: string
  startedAt?: number
  /** Script call order (journal lines retain completion order). */
  call?: number
  attempt?: number
  prompt?: string
  model?: string
  phase?: string
  nest?: string
  /** The agent's final answer. */
  text: string
  /** With a schema: the value it returned. */
  value?: unknown
  tokens?: number
  cost?: number
  durationMs: number
  sessionId?: string
}

export type RunStatus = "running" | "done" | "error" | "stopped"

/** What `run.json` holds about a run. */
export interface RunRecord {
  id: string
  meta: WorkflowMeta
  args: unknown
  /** Where the script came from: a saved workflow's file, or "inline". */
  source: string
  status: RunStatus
  /** The member that requested this run through workflow.runner, when present. */
  startedBy?: { sessionId: string; label: string }
  startedAt: number
  endedAt?: number
  result?: unknown
  error?: string
  /** Earlier attempts this run resumed from, oldest first. */
  resumes?: number
  /** This attempt only; cached calls spend no new tokens or cost. Null means unknown. */
  totals?: {
    tokens: number | null
    cost: number | null
    durationMs: number
    agents: number
    byStatus: Record<"queued" | "working" | "done" | "error" | "aborted" | "cached", number>
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

/** hash(prompt, opts): which call this is, whatever order the keys of opts were written in. */
export function callHash(prompt: string, opts: unknown, nest?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([nest ?? "", prompt, canonical(opts ?? {})]))
    .digest("hex")
    .slice(0, 16)
}

/**
 * The results of a run's agent() calls, kept in `journal.jsonl` so a run can be resumed after
 * the script was edited or Amira stopped. On resume, calls replay from the journal as long as
 * the run has not diverged from it: the first call that is not in the journal (a new or
 * edited prompt, or one that never finished) ends the replayed prefix, and every call the
 * script makes after it saw a later result runs for real, since it may depend on the changed
 * one. Calls made together with the diverging one (in the same parallel, say) still replay.
 */
export class Journal {
  readonly file: string
  #cache = new Map<string, JournalEntry>()
  #counts = new Map<string, number>()
  /** Results handed to the script when the run diverged from the journal. */
  #frontier: number | undefined

  constructor(
    readonly dir: string,
    previous: JournalEntry[] = [],
  ) {
    this.file = path.join(dir, "journal.jsonl")
    for (const e of previous) this.#cache.set(e.key, e)
  }

  /** The key of the next call with this hash. */
  key(hash: string): string {
    const n = this.#counts.get(hash) ?? 0
    this.#counts.set(hash, n + 1)
    return `${hash}#${n}`
  }

  /**
   * The journaled result of a call, if it may replay: `seen` is how many results the script
   * had when it made the call, `delivered` how many the run has handed it so far.
   */
  replay(key: string, seen: number, delivered: number): JournalEntry | undefined {
    if (this.#frontier !== undefined && seen > this.#frontier) return undefined
    const entry = this.#cache.get(key)
    // The latest outcome wins: an error must not uncover a stale success from an older attempt.
    const hit = entry && successful(entry) ? entry : undefined
    if (!hit) this.#frontier ??= delivered
    return hit
  }

  get diverged(): boolean {
    return this.#frontier !== undefined
  }

  get size(): number {
    return this.#cache.size
  }

  record(entry: JournalEntry): void {
    this.#cache.set(entry.key, entry)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch {}
  }
}

export function successful(entry: JournalEntry): boolean {
  return entry.status === undefined || entry.status === "done" || entry.status === "cached"
}

/** Reads a run's journal; lines that do not parse (a write cut short) are skipped. */
export function readJournal(dir: string): JournalEntry[] {
  let text: string
  try {
    text = readFileSync(path.join(dir, "journal.jsonl"), "utf8")
  } catch {
    return []
  }
  const out: JournalEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.key === "string" && typeof e.text === "string") out.push(e)
    } catch {}
  }
  return out
}

export function writeRun(dir: string, record: RunRecord, script?: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`)
    if (script !== undefined) writeFileSync(path.join(dir, "script.ts"), script)
  } catch {}
}

/** A finished run can be inspected even when its script is no longer available to resume. */
export function readRunRecord(dir: string): RunRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord
    if (
      !record ||
      typeof record.id !== "string" ||
      !record.meta ||
      typeof record.meta.name !== "string" ||
      !Array.isArray(record.meta.phases) ||
      !record.meta.phases.every((phase) => typeof phase === "string") ||
      !["running", "done", "error", "stopped"].includes(record.status) ||
      !Number.isFinite(record.startedAt)
    )
      return undefined
    return record
  } catch {
    return undefined
  }
}

export function readRun(dir: string): { record: RunRecord; script: string } | undefined {
  try {
    const record = readRunRecord(dir)
    if (!record) return undefined
    const script = readFileSync(path.join(dir, "script.ts"), "utf8")
    return { record, script }
  } catch {
    return undefined
  }
}

/** Runs kept under `root`, newest first. */
export function listRuns(root: string): RunRecord[] {
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: RunRecord[] = []
  for (const n of names) {
    const dir = path.join(root, n)
    if (!existsSync(path.join(dir, "run.json"))) continue
    const record = readRunRecord(dir)
    if (record) out.push(record)
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}
