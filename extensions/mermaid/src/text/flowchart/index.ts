import { strWidth } from "../util.ts"
import { compactFlowchart } from "./compact.ts"
import { layoutFlowchart, type LayoutOptions } from "./layout.ts"
import { parseFlowchart, type Dir } from "./parse.ts"

export interface FlowchartRender {
  lines: string[]
  compact: boolean
}

/** Label widths to try, widest first. */
const WRAPS: ReadonlyArray<readonly [number, number]> = [
  [24, 16],
  [16, 12],
  [10, 8],
]

export function renderFlowchart(source: string, width: number): FlowchartRender | undefined {
  const fc = parseFlowchart(source)
  if (!fc) return undefined
  const fits = (lines: string[]) => lines.every((l) => strWidth(l) <= width)
  const dirs: Dir[] = fc.dir === "LR" || fc.dir === "RL" ? [fc.dir, "TD"] : [fc.dir]
  for (const dir of dirs)
    for (const [nodeWrap, edgeWrap] of WRAPS) {
      const opts: LayoutOptions = { dir, nodeWrap, edgeWrap }
      const lines = layoutFlowchart(fc, opts)
      if (fits(lines)) return { lines, compact: false }
    }
  return { lines: compactFlowchart(fc, width), compact: true }
}
