import { expect, test } from "bun:test"
import { formatCost } from "../src/format.ts"

for (const [amount, expected] of [
  [1.2, "$1.20"],
  [12.345, "$12.35"],
  [0.01, "$0.010"],
  [0.125, "$0.125"],
  [0, "$0.000"],
  [0.000049, "<$0.0001"],
  [0.00005, "$0.0001"],
  [0.0004, "$0.0004"],
  [0.0099, "$0.0099"],
  [-1.2, "-$1.20"],
  [-0.01, "-$0.010"],
  [-0.0004, "-$0.0004"],
  [-0.000001, ">-$0.0001"],
] as const) {
  test(`host-style money keeps precision and corrections: ${amount}`, () => {
    expect(formatCost(amount)).toBe(expected)
  })
}
