/**
 * Trading-as-Git type definitions
 *
 * Operation is a discriminated union — each variant carries typed IBKR objects.
 * No more Record<string, unknown> type erasure.
 */

import type { Contract, Order, OrderCancel, Execution, OrderState } from '@traderalice/ibkr'
import type Decimal from 'decimal.js'
import type { Position, OpenOrder, TpSlParams, PlaceOrderLeg } from './broker.js'
import './contract-ext.js'

// ==================== Commit Hash ====================

/** 8-character short SHA-256 hash. */
export type CommitHash = string

// ==================== Operation ====================

export type OperationAction = Operation['action']

export type Operation =
  | { action: 'placeOrder'; contract: Contract; order: Order; tpsl?: TpSlParams }
  | { action: 'modifyOrder'; orderId: string; changes: Partial<Order> }
  | { action: 'closePosition'; contract: Contract; quantity?: Decimal }
  | { action: 'cancelOrder'; orderId: string; orderCancel?: OrderCancel }
  | { action: 'syncOrders' }
  | {
      // Wallet-only event: an open order observed on the broker that Alice
      // never placed (user trading on the exchange app directly). The log is
      // a faithful record, not the source of final state — untracked orders
      // are themselves "commits without a message": N of them observed in
      // one pass get squashed into one [observed] commit. Once recorded with
      // orderId + submitted status, the regular pending scanner + sync
      // poller take over their lifecycle (fill / cancel) for free.
      action: 'observeExternalOrder'
      contract: Contract
      order: Order
    }
  | {
      // Wallet-only event: bridges the gap between Alice's order log and a
      // broker-reported balance change Alice did not initiate (first-sight
      // bootstrap, external transfer, staking reward, off-platform trade).
      // Treated as a virtual market buy/sell at observed price for cost-basis
      // purposes — sign of quantityDelta determines direction.
      //
      // Numeric fields stored as Decimal-as-string so they survive JSON
      // round-trip through git-persistence; reconstruct via `new Decimal(...)`
      // at consumption sites.
      action: 'reconcileBalance'
      aliceId: string
      quantityDelta: string
      markPrice: string
    }
  | {
      // Explicit, evidence-backed resolution of an earlier operation whose
      // dispatch outcome was 'unknown'. Appended as its own commit — the
      // original commit is never rewritten. `original` is a copy of the
      // unresolved operation so projections (pending scan, cost basis, order
      // history) attribute the resolved order exactly as if it had been
      // acknowledged — see `effectiveOperation`.
      action: 'resolveOutcome'
      commitHash: CommitHash
      operationIndex: number
      outcome: 'not-placed' | 'placed'
      note: string
      original: Operation
    }

// ==================== Operation Result ====================

/**
 * `unknown` — the request may have reached the broker but no definitive
 * answer came back (lost acknowledgement, timeout after send, process stopped
 * mid-dispatch). It is NOT a rejection: the order may be live or filled.
 * The account blocks new writes until the outcome is resolved from broker
 * evidence (sync by orderId) or by an explicit `resolveOutcome` commit.
 */
export type OperationStatus = 'submitted' | 'filled' | 'rejected' | 'cancelled' | 'user-rejected' | 'unknown'

export interface OperationResult {
  action: OperationAction
  success: boolean
  orderId?: string
  status: OperationStatus
  execution?: Execution
  orderState?: OrderState
  /** Decimal as string — sub-satoshi fills must round-trip without loss. */
  filledQty?: string
  /** Decimal as string — see filledQty. */
  filledPrice?: string
  error?: string
  /** Bracket TP/SL child orders created alongside this placeOrder (tracked from birth). */
  legs?: PlaceOrderLeg[]
  /** Symbol for per-row attribution in multi-update sync commits (the op carries none). */
  symbol?: string
  raw?: unknown
}

// ==================== Wallet State ====================

/** State snapshot taken after each commit. All monetary fields are strings to prevent IEEE 754 artifacts. */
export interface GitState {
  netLiquidation: string
  totalCashValue: string
  unrealizedPnL: string
  realizedPnL: string
  positions: Position[]
  pendingOrders: OpenOrder[]
}

// ==================== Commit ====================

export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number
}

// ==================== API Results ====================

export interface AddResult {
  staged: true
  index: number
  operation: Operation
}

export interface CommitPrepareResult {
  prepared: true
  hash: CommitHash
  message: string
  operationCount: number
}

export interface PushResult {
  hash: CommitHash
  message: string
  operationCount: number
  submitted: OperationResult[]
  rejected: OperationResult[]
  /** Dispatched operations whose outcome is unknown — neither submitted nor
   *  rejected. The account blocks new writes until they are resolved. */
  unresolved: OperationResult[]
}

/** An operation whose dispatch outcome is still unknown. */
export interface UnresolvedOperation {
  commitHash: CommitHash
  operationIndex: number
  action: OperationAction
  symbol: string
  aliceId?: string
  /** Broker order id when the adapter knew it before the outcome was lost. */
  orderId?: string
  error?: string
  timestamp: string
}

export interface ResolveOutcomeParams {
  commitHash: CommitHash
  operationIndex: number
  /** `not-placed`: broker evidence shows the request never became an order.
   *  `placed`: broker evidence shows it did — requires `orderId` (sync then
   *  tracks it) or both `filledQty` and `filledPrice` (recorded once). */
  outcome: 'not-placed' | 'placed'
  orderId?: string
  /** Decimal as string. */
  filledQty?: string
  /** Decimal as string. */
  filledPrice?: string
  /** What evidence was checked (broker order/fill history, positions). Required. */
  note: string
}

export interface RejectResult {
  hash: CommitHash
  message: string
  operationCount: number
}

export interface GitStatus {
  staged: Operation[]
  pendingMessage: string | null
  pendingHash: CommitHash | null
  head: CommitHash | null
  commitCount: number
  /** Non-empty → new writes are refused until each entry is resolved. */
  unresolved: UnresolvedOperation[]
}

export interface OperationSummary {
  symbol: string
  action: OperationAction
  change: string
  status: OperationStatus
  /** Structured order terms for review surfaces. Kept alongside `change` so
   * text-only CLI consumers remain useful while UI clients can render exact
   * price, size, and time-in-force without fetching the full commit. */
  order?: {
    side?: string
    orderType?: string
    totalQuantity?: string
    cashQuantity?: string
    limitPrice?: string
    auxPrice?: string
    timeInForce?: string
  }
}

export interface CommitLogEntry {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  timestamp: string
  round?: number
  operations: OperationSummary[]
}

// ==================== Export State ====================

export interface GitExportState {
  commits: GitCommit[]
  head: CommitHash | null
  /** Present only while a push is dispatching. Persisted before each broker
   *  call so a crash leaves durable evidence; on restore it becomes a commit
   *  whose interrupted operation is `unknown`. */
  inflight?: InflightPush
}

export interface InflightPush {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  /** Results of the operations that completed, in order. */
  results: OperationResult[]
  /** Index of the operation handed to the broker most recently. */
  dispatchIndex: number
  startedAt: string
  round?: number
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string
  symbol: string
  previousStatus: OperationStatus
  currentStatus: OperationStatus
  /** Decimal as string — same precision invariant as OperationResult. */
  filledPrice?: string
  filledQty?: string
}

export interface SyncResult {
  hash: CommitHash
  updatedCount: number
  updates: OrderStatusUpdate[]
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  /** Contract aliceId or symbol, or "all". */
  symbol: string
  /** "@88000" (absolute) or "+10%" / "-5%" (relative). */
  change: string
}

export interface SimulationPositionCurrent {
  symbol: string
  side: 'long' | 'short'
  qty: string
  avgCost: string
  marketPrice: string
  unrealizedPnL: string
  marketValue: string
}

export interface SimulationPositionAfter {
  symbol: string
  side: 'long' | 'short'
  qty: string
  avgCost: string
  simulatedPrice: string
  unrealizedPnL: string
  marketValue: string
  pnlChange: string
  priceChangePercent: string
}

export interface SimulatePriceChangeResult {
  success: boolean
  error?: string
  currentState: {
    equity: string
    unrealizedPnL: string
    totalPnL: string
    positions: SimulationPositionCurrent[]
  }
  simulatedState: {
    equity: string
    unrealizedPnL: string
    totalPnL: string
    positions: SimulationPositionAfter[]
  }
  summary: {
    totalPnLChange: string
    equityChange: string
    equityChangePercent: string
    worstCase: string
  }
}

// ==================== Stage params (used by AI tool layer + SDK) ====================
//
// All numeric fields are decimal strings — Decimal precision is
// preserved through the staging layer into the persisted git operation
// records. Callers (AI tools, HTTP routes) that have a number must
// convert via `String(x)` at the boundary; that's deliberate friction
// so the precision-loss point is explicit.

export interface StagePlaceOrderParams {
  aliceId: string
  symbol?: string
  /**
   * Target sub-account (wallet) for multi-sub-account brokers (CCXT Binance:
   * 'spot' / 'derivatives'). REQUIRED when the broker exposes >1 sub-account —
   * the UTA layer loud-refuses a write without it rather than guessing. Ignored
   * by single-sub-account brokers. Not persisted in the Operation schema; it is
   * validated against the instrument and stamped into the commit message.
   */
  subAccountId?: string
  action: 'BUY' | 'SELL'
  orderType: string
  totalQuantity?: string
  cashQty?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  tif?: string
  goodTillDate?: string
  outsideRth?: boolean
  parentId?: string
  ocaGroup?: string
  takeProfit?: { price: string }
  stopLoss?: { price: string; limitPrice?: string }
}

export interface StageModifyOrderParams {
  orderId: string
  totalQuantity?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  orderType?: string
  tif?: string
  goodTillDate?: string
}

export interface StageClosePositionParams {
  aliceId: string
  symbol?: string
  /** Empty / undefined closes the full position. */
  qty?: string
  /**
   * Target sub-account — same semantics as `StagePlaceOrderParams.subAccountId`.
   * REQUIRED for multi-sub-account brokers, ignored otherwise.
   */
  subAccountId?: string
}

// ==================== Operation Helpers ====================

/** Extract the symbol from any Operation variant. */
export function getOperationSymbol(op: Operation | undefined): string {
  if (!op) return 'unknown'
  switch (op.action) {
    case 'placeOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'modifyOrder': return 'unknown' // modifyOrder doesn't carry contract
    case 'closePosition': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'cancelOrder': return 'unknown'
    case 'syncOrders': return 'unknown'
    case 'observeExternalOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'reconcileBalance': return op.aliceId
    case 'resolveOutcome': return getOperationSymbol(op.original)
  }
}

/** The operation whose order/contract semantics a result belongs to: a
 *  `resolveOutcome` stands in for the operation it resolves. */
export function effectiveOperation(op: Operation): Operation
export function effectiveOperation(op: Operation | undefined): Operation | undefined
export function effectiveOperation(op: Operation | undefined): Operation | undefined {
  return op?.action === 'resolveOutcome' ? op.original : op
}
