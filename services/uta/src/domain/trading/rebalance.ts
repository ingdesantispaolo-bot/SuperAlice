/**
 * Target portfolio → order plan.
 *
 * The one object that crosses from research to execution is a
 * `TargetPortfolio`: long-only weights plus a cash weight, with its strategy
 * version, decision time, expiry and data provenance. `planRebalance` turns
 * it into the share deltas needed from what the account already holds AND
 * has already committed in working orders, so planning the same target twice
 * never doubles an order: once the first plan is executed (or still working)
 * the delta is zero.
 *
 * Pure: no broker calls. Anything that cannot be valued (missing quote,
 * foreign currency, short position) refuses the whole plan.
 */

import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { AccountInfo, OpenOrder, Position, Quote } from './brokers/types.js'
import type { PlannedOrder, RebalancePlan, RebalancePolicy, TargetPortfolio, TargetWeight } from '@traderalice/uta-protocol'

export type { PlannedOrder, RebalancePlan, RebalancePolicy, TargetPortfolio, TargetWeight }

export class RebalanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RebalanceError'
  }
}

function dec(value: string | undefined, what: string): Decimal {
  let d: Decimal
  try {
    d = new Decimal(value ?? '')
  } catch {
    throw new RebalanceError(`${what} is not a decimal: ${JSON.stringify(value)}`)
  }
  if (!d.isFinite()) throw new RebalanceError(`${what} is not finite`)
  return d
}

function remaining(order: OpenOrder['order']): Decimal {
  const total = order.totalQuantity && !order.totalQuantity.equals(UNSET_DECIMAL) ? order.totalQuantity : new Decimal(0)
  const filled = order.filledQuantity && !order.filledQuantity.equals(UNSET_DECIMAL) ? order.filledQuantity : new Decimal(0)
  return Decimal.max(total.minus(filled), 0)
}

/** Stable identity of a target's content (order-independent over weights). */
export function targetPortfolioId(target: TargetPortfolio): string {
  const canonical = JSON.stringify({
    strategy: target.strategy,
    strategyVersion: target.strategyVersion,
    decisionAt: target.decisionAt,
    validUntil: target.validUntil,
    source: target.source ?? null,
    cashWeight: new Decimal(target.cashWeight).toFixed(),
    weights: [...target.weights]
      .map((w) => ({ aliceId: w.aliceId, weight: new Decimal(w.weight).toFixed() }))
      .sort((a, b) => a.aliceId.localeCompare(b.aliceId)),
  })
  // FNV-1a 64-bit — deterministic, dependency-free; identity, not security.
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(canonical)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `tp-${hash.toString(16).padStart(16, '0')}`
}

export function validateTargetPortfolio(target: TargetPortfolio, now: Date, policy: RebalancePolicy = {}): void {
  if (!target.strategy?.trim() || !target.strategyVersion?.trim()) {
    throw new RebalanceError('target requires strategy and strategyVersion')
  }
  const decisionAt = Date.parse(target.decisionAt)
  const validUntil = Date.parse(target.validUntil)
  if (!Number.isFinite(decisionAt) || !Number.isFinite(validUntil)) {
    throw new RebalanceError('target requires ISO-8601 decisionAt and validUntil')
  }
  if (decisionAt > now.getTime()) throw new RebalanceError('target decisionAt is in the future')
  if (validUntil <= now.getTime()) throw new RebalanceError(`target expired at ${target.validUntil}`)

  const seen = new Set<string>()
  let sum = dec(target.cashWeight, 'cashWeight')
  if (sum.lt(0)) throw new RebalanceError('cashWeight must be non-negative')
  for (const w of target.weights) {
    if (!w.aliceId?.trim()) throw new RebalanceError('every weight needs an aliceId')
    if (seen.has(w.aliceId)) throw new RebalanceError(`duplicate weight for ${w.aliceId}`)
    seen.add(w.aliceId)
    const weight = dec(w.weight, `weight of ${w.aliceId}`)
    if (weight.lt(0) || weight.gt(1)) throw new RebalanceError(`weight of ${w.aliceId} must be within [0, 1] (long-only)`)
    sum = sum.plus(weight)
  }
  const tolerance = dec(policy.tolerance ?? '1e-6', 'tolerance')
  if (sum.minus(1).abs().gt(tolerance)) {
    throw new RebalanceError(`weights + cashWeight sum to ${sum.toFixed()}, expected 1 (tolerance ${tolerance.toFixed()})`)
  }
}

export function planRebalance(input: {
  target: TargetPortfolio
  account: AccountInfo
  positions: readonly Position[]
  openOrders: readonly OpenOrder[]
  /** Quote per aliceId for every instrument in the target or held. */
  quotes: ReadonlyMap<string, Quote>
  now: Date
  policy?: RebalancePolicy
}): RebalancePlan {
  const { target, account, positions, openOrders, quotes, now } = input
  const policy = input.policy ?? {}
  validateTargetPortfolio(target, now, policy)

  const equity = dec(account.netLiquidation, 'account netLiquidation')
  if (!equity.gt(0)) throw new RebalanceError('account net liquidation must be positive')
  const baseCurrency = account.baseCurrency
  const minTrade = dec(policy.minTradeValue ?? '0', 'minTradeValue')

  const aliceIdOf = (c: { aliceId?: string }) => c.aliceId ?? ''
  const held = new Map<string, Position>()
  for (const p of positions) {
    if (p.quantity.isZero()) continue
    const id = aliceIdOf(p.contract)
    if (!id) throw new RebalanceError(`position ${p.contract.symbol ?? '?'} has no aliceId`)
    if (p.side !== 'long') throw new RebalanceError(`short position in ${id} — long-only rebalance refused`)
    if (p.currency && p.currency !== baseCurrency) {
      throw new RebalanceError(`position ${id} is in ${p.currency}, account base is ${baseCurrency} — FX conversion not supported`)
    }
    held.set(id, p)
  }

  const working = (id: string, side: 'BUY' | 'SELL'): Decimal => openOrders
    .filter((o) => aliceIdOf(o.contract) === id && (o.order.action ?? '').toUpperCase() === side)
    .filter((o) => !o.orderState?.status || o.orderState.status === 'Submitted' || o.orderState.status === 'PreSubmitted')
    .reduce((sum, o) => sum.plus(remaining(o.order)), new Decimal(0))

  const weights = new Map(target.weights.map((w) => [w.aliceId, new Decimal(w.weight)]))
  const universe = [...new Set([...weights.keys(), ...held.keys()])].sort()

  const sells: PlannedOrder[] = []
  const buys: PlannedOrder[] = []
  const skipped: RebalancePlan['skipped'] = []
  let cash = dec(account.totalCashValue, 'account totalCashValue')

  for (const id of universe) {
    const quote = quotes.get(id)
    if (!quote) throw new RebalanceError(`no quote for ${id} — refusing to plan blind`)
    const qc = (quote.contract as { currency?: string } | undefined)?.currency
    if (qc && qc !== baseCurrency) {
      throw new RebalanceError(`${id} trades in ${qc}, account base is ${baseCurrency} — FX conversion not supported`)
    }
    const ask = dec(quote.ask, `ask of ${id}`)
    const bid = dec(quote.bid, `bid of ${id}`)
    if (!ask.gt(0) || !bid.gt(0)) throw new RebalanceError(`quote for ${id} has no usable bid/ask`)
    const multiplier = new Decimal(held.get(id)?.multiplier ?? '1')

    const current = held.get(id)?.quantity ?? new Decimal(0)
    const workingBuy = working(id, 'BUY')
    const workingSell = working(id, 'SELL')
    const committed = current.plus(workingBuy).minus(workingSell)
    const weight = weights.get(id) ?? new Decimal(0)
    // Whole units, rounded down: never buy past the target.
    const targetQty = equity.mul(weight).div(ask.mul(multiplier)).floor()
    const delta = targetQty.minus(committed)

    const base = {
      aliceId: id,
      currentQuantity: current.toFixed(),
      workingBuy: workingBuy.toFixed(),
      workingSell: workingSell.toFixed(),
      targetQuantity: targetQty.toFixed(),
    }
    if (delta.isZero()) continue
    if (delta.gt(0)) {
      const notional = delta.mul(ask).mul(multiplier)
      if (notional.lt(minTrade)) { skipped.push({ aliceId: id, reason: `buy ${delta.toFixed()} below minTradeValue` }); continue }
      buys.push({ ...base, action: 'BUY', quantity: delta.toFixed(), estimatedPrice: ask.toFixed(), estimatedNotional: notional.toFixed(2) })
      cash = cash.minus(notional)
    } else {
      // Never sell more than is held and not already being sold: no shorts.
      const sellable = Decimal.max(current.minus(workingSell), 0)
      const qty = Decimal.min(delta.abs(), sellable)
      if (qty.isZero()) { skipped.push({ aliceId: id, reason: 'reduction already covered by working sells' }); continue }
      const notional = qty.mul(bid).mul(multiplier)
      if (notional.lt(minTrade)) { skipped.push({ aliceId: id, reason: `sell ${qty.toFixed()} below minTradeValue` }); continue }
      sells.push({ ...base, action: 'SELL', quantity: qty.toFixed(), estimatedPrice: bid.toFixed(), estimatedNotional: notional.toFixed(2) })
      cash = cash.plus(notional)
    }
  }

  return {
    targetId: targetPortfolioId(target),
    equity: equity.toFixed(),
    // Sells first: they free the cash the buys spend.
    orders: [...sells, ...buys],
    skipped,
    projectedCash: cash.toFixed(2),
  }
}
