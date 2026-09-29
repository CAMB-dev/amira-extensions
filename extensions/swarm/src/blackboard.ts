/** One write to the blackboard, as its append-only log keeps it. */
export interface BoardWrite {
  /** 1 for the first write of the swarm. */
  seq: number
  at: number
  /** The member that wrote, or "user" / "commander". */
  by: string
  key: string
  /** What was written: the whole value, or with `append` the text added to it. */
  value: string
  append?: boolean
}

/** A key's current value. */
export interface BoardEntry {
  key: string
  value: string
  /** Who wrote it last, and when. */
  by: string
  at: number
  /** Writes to this key so far. */
  writes: number
}

/** Longest value a key may hold, in characters. */
export const MAX_VALUE_CHARS = 20_000

/**
 * The swarm's shared memory: keys with text values that any member reads and writes, and
 * the append-only log of every write. A write that leaves the value as it was changes
 * nothing, so it does not count as progress.
 */
export class Blackboard {
  #entries = new Map<string, BoardEntry>()
  #log: BoardWrite[] = []

  get log(): readonly BoardWrite[] {
    return this.#log
  }

  keys(): string[] {
    return [...this.#entries.keys()]
  }

  get(key: string): BoardEntry | undefined {
    const e = this.#entries.get(key)
    return e && { ...e }
  }

  /** Every key, in the order it was first written. */
  entries(): BoardEntry[] {
    return [...this.#entries.values()].map((e) => ({ ...e }))
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * Sets (or with `append`, extends on a new line) a key. Returns the write and whether the
   * value changed; an unchanged value is not logged.
   */
  write(
    by: string,
    key: string,
    value: string,
    opts: { append?: boolean; at?: number } = {},
  ): { changed: boolean; write?: BoardWrite; entry: BoardEntry } {
    const at = opts.at ?? Date.now()
    const old = this.#entries.get(key)
    const next = opts.append && old?.value ? `${old.value}\n${value}` : value
    if (old && old.value === next) return { changed: false, entry: { ...old } }
    if (next.length > MAX_VALUE_CHARS) {
      throw new Error(
        `the value of "${key}" would be ${next.length} characters long; keep it under ${MAX_VALUE_CHARS} (summarize, or split it over several keys)`,
      )
    }
    const entry: BoardEntry = { key, value: next, by, at, writes: (old?.writes ?? 0) + 1 }
    this.#entries.set(key, entry)
    const write: BoardWrite = {
      seq: this.#log.length + 1,
      at,
      by,
      key,
      value,
      ...(opts.append ? { append: true } : {}),
    }
    this.#log.push(write)
    return { changed: true, write, entry: { ...entry } }
  }

  /** A board holding what `writes` wrote, in order (e.g. read back from the session). */
  static replay(writes: readonly BoardWrite[]): Blackboard {
    const board = new Blackboard()
    for (const w of writes) {
      try {
        board.write(w.by, w.key, w.value, { append: w.append === true, at: w.at })
      } catch {
        // A value that no longer fits is skipped rather than losing the rest.
      }
    }
    return board
  }
}
