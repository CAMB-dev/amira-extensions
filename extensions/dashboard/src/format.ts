/** Host-style reported USD precision, retaining the sign of corrections. */
export function formatCost(usd: number): string {
  const amount = Math.abs(usd)
  const sign = usd < 0 ? "-" : ""
  if (amount >= 1) return `${sign}$${amount.toFixed(2)}`
  if (amount >= 0.01 || amount === 0) return `${sign}$${amount.toFixed(3)}`
  if (amount < 0.00005) return usd < 0 ? ">-$0.0001" : "<$0.0001"
  return `${sign}$${amount.toFixed(4)}`
}
