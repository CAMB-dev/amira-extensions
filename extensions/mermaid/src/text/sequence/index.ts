import { strWidth } from "../util.ts"
import { compactSequence } from "./compact.ts"
import { parseSequence } from "./parse.ts"
import { layoutSequence, type SequenceOptions } from "./render.ts"

export interface SequenceRender {
  lines: string[]
  compact: boolean
}

/** Wrap widths and box gaps to try, most spacious first. */
const ATTEMPTS: readonly SequenceOptions[] = [
  { wrap: 40, gap: 3 },
  { wrap: 28, gap: 2 },
  { wrap: 20, gap: 2 },
  { wrap: 14, gap: 1 },
  { wrap: 10, gap: 1 },
]

export function renderSequence(source: string, width: number): SequenceRender | undefined {
  const seq = parseSequence(source)
  if (!seq) return undefined
  for (const o of ATTEMPTS) {
    const lines = layoutSequence(seq, o, width)
    if (lines && lines.every((l) => strWidth(l) <= width)) return { lines, compact: false }
  }
  return { lines: compactSequence(seq, width), compact: true }
}
