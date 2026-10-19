import type { CostLedger, CostPersistence } from "./cost.ts"
import { CostRevisionConflict, validateCostLedger } from "./cost.ts"
import { type Project, ProjectDocumentStore } from "./store.ts"

/** Project-claim CAS, with conservative dead-writer recovery shared with lifecycle storage. */
export class FileCostPersistence implements CostPersistence {
  constructor(private readonly selected: Project | (() => Project)) {}
  private store(): ProjectDocumentStore {
    return new ProjectDocumentStore(typeof this.selected === "function" ? this.selected() : this.selected)
  }
  private get projectId(): string {
    return (typeof this.selected === "function" ? this.selected() : this.selected).marker.id
  }
  async read(): Promise<CostLedger | undefined> {
    const value = await this.store().read("costs.json")
    if (value === undefined) return undefined
    validateCostLedger(value, this.projectId)
    return value
  }
  async save(ledger: CostLedger, expectedRevision: number | undefined, administrative = true): Promise<void> {
    validateCostLedger(ledger, this.projectId)
    await this.store().update(
      "costs.json",
      (value) => {
        if (value !== undefined) validateCostLedger(value, this.projectId)
        const saved = value as CostLedger | undefined
        if (saved?.revision !== expectedRevision) throw new CostRevisionConflict()
        if (administrative && saved?.coverage.policyInitialized !== false && saved) {
          const humanPolicy = (row: CostLedger) =>
            JSON.stringify([
              row.policy.capUsd,
              row.policy.continuedThroughUsd,
              row.policy.acknowledgedUnknown,
              row.receipts,
            ])
          if (humanPolicy(saved) !== humanPolicy(ledger))
            throw new Error(
              "Accounting reconciliation cannot publish an uncommitted human cost-policy change.",
            )
        }
        return ledger
      },
      { administrative },
    )
  }
}
