import type { Operation } from '../git/types.js'
import type { Position, AccountInfo, OpenOrder, Quote } from '../brokers/types.js'

/** Read-only context assembled by the pipeline, consumed by guards. */
export interface GuardContext {
  readonly operation: Operation
  readonly positions: readonly Position[]
  readonly account: Readonly<AccountInfo>
  /** Account (UTA) id — lets a guard read account-scoped history such as snapshots. */
  readonly accountId?: string
  /** Evaluation time. */
  readonly now?: Date
  /** Quote for a placeOrder contract; absent when the broker could not provide one. */
  readonly quote?: Readonly<Quote>
  /** Working orders at the broker; absent when the broker cannot list them or the read failed. */
  readonly openOrders?: readonly OpenOrder[]
  /** placeOrder operations already handed to the broker on `now`'s calendar
   *  day in `timeZone`, counted from the durable log (survives restarts). */
  readonly placedOrdersOn?: (timeZone: string) => number
}

/** A guard that can reject operations. Returns null to allow, or a rejection reason string. */
export interface OperationGuard {
  readonly name: string
  /** Broker reads this guard needs for placeOrder; the pipeline performs
   *  them only when at least one configured guard asks. */
  readonly needs?: { readonly quote?: boolean; readonly openOrders?: boolean }
  check(ctx: GuardContext): Promise<string | null> | string | null
}

/** Registry entry: type identifier + factory function. */
export interface GuardRegistryEntry {
  type: string
  create(options: Record<string, unknown>): OperationGuard
}
