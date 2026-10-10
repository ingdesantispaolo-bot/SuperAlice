/**
 * Target portfolio contract — the one object that crosses from research to
 * execution. Long-only weights plus cash, with strategy version, decision
 * time, expiry and data provenance. Planning (UTA) turns it into the share
 * deltas net of held positions and working orders.
 */

export interface TargetWeight {
  /** OpenAlice instrument identity (`<utaId>|<nativeKey>`). */
  aliceId: string
  /** Decimal string in [0, 1]. */
  weight: string
}

export interface TargetPortfolio {
  strategy: string
  strategyVersion: string
  /** When the decision was made (ISO-8601). */
  decisionAt: string
  /** After this instant the target is stale and is refused (ISO-8601). */
  validUntil: string
  /** Provenance of the inputs: dataset snapshot hash, research run id… */
  source?: string
  weights: TargetWeight[]
  /** Decimal string; weights + cashWeight must sum to 1 within tolerance. */
  cashWeight: string
}

export interface RebalancePolicy {
  /** Skip trades whose estimated notional is below this (account currency). Default 0. */
  minTradeValue?: string
  /** `account` (default): every held instrument not in the target is sold.
   *  `listed`: only instruments listed in the target are managed; other
   *  holdings are left untouched (a strategy sleeve beside existing positions). */
  scope?: 'account' | 'listed'
  /** Budget the weights apply to (account currency). Default: net
   *  liquidation. Must not exceed it. */
  capital?: string
  /** Allowed |Σweights + cash − 1|. Default 1e-6. */
  tolerance?: string
}

export interface PlannedOrder {
  aliceId: string
  action: 'BUY' | 'SELL'
  quantity: string
  estimatedPrice: string
  estimatedNotional: string
  currentQuantity: string
  workingBuy: string
  workingSell: string
  targetQuantity: string
}

export interface RebalancePlan {
  /** Content hash of the target — the decision event's identity. */
  targetId: string
  equity: string
  orders: PlannedOrder[]
  skipped: Array<{ aliceId: string; reason: string }>
  /** Cash after all planned orders at estimated prices — before fees and
   *  before working orders that are still open. */
  projectedCash: string
}
