/**
 * Shared arithmetic for the risk guards: order side, size and a conservative
 * notional estimate. Everything is Decimal; a value that cannot be priced is
 * `null`, never zero — callers fail closed on `null`.
 */

import Decimal from 'decimal.js'
import { UNSET_DECIMAL, type Contract, type Order } from '@traderalice/ibkr'
import type { OpenOrder, Position, Quote } from '../brokers/types.js'

export type Side = 'BUY' | 'SELL'

export function orderSide(order: Order): Side {
  return (order.action ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY'
}

function setDecimal(value: Decimal | undefined): Decimal | null {
  if (!value || value.equals(UNSET_DECIMAL) || !value.isFinite() || value.lte(0)) return null
  return value
}

function positiveDecimal(value: string | undefined): Decimal | null {
  if (value == null || value === '') return null
  try {
    const d = new Decimal(value)
    return d.isFinite() && d.gt(0) ? d : null
  } catch {
    return null
  }
}

/** Same instrument: aliceId when both carry one, else conId, else symbol + secType + currency. */
export function sameInstrument(a: Contract, b: Contract): boolean {
  if (a.aliceId && b.aliceId) return a.aliceId === b.aliceId
  if (a.conId && b.conId) return a.conId === b.conId
  return !!a.symbol && a.symbol === b.symbol
    && (a.secType || 'STK') === (b.secType || 'STK')
    && (!a.currency || !b.currency || a.currency === b.currency)
}

export function positionFor(positions: readonly Position[], contract: Contract): Position | undefined {
  return positions.find((p) => sameInstrument(p.contract, contract))
}

function multiplier(contract: Contract, position?: Position): Decimal {
  return positiveDecimal(position?.multiplier) ?? positiveDecimal(contract.multiplier ? String(contract.multiplier) : undefined) ?? new Decimal(1)
}

/**
 * Per-unit price used to value an order, most conservative source first for
 * the side: the order's own limit/stop, else the quote (ask for buys, bid for
 * sells, falling back to last), else the held position's mark.
 */
export function unitPrice(order: Order, quote?: Quote, position?: Position): Decimal | null {
  const limit = setDecimal(order.lmtPrice)
  if (limit) return limit
  const stop = setDecimal(order.auxPrice)
  if (stop && (order.orderType ?? '').toUpperCase().startsWith('STP')) return stop
  if (quote) {
    const side = orderSide(order)
    const preferred = positiveDecimal(side === 'BUY' ? quote.ask : quote.bid)
    const last = positiveDecimal(quote.last)
    if (preferred ?? last) return (preferred ?? last)!
  }
  return positiveDecimal(position?.marketPrice)
}

/** Remaining quantity of an order (total minus filled), or null when unset. */
export function remainingQuantity(order: Order): Decimal | null {
  const total = setDecimal(order.totalQuantity)
  if (!total) return null
  const filled = order.filledQuantity && !order.filledQuantity.equals(UNSET_DECIMAL) ? order.filledQuantity : new Decimal(0)
  const left = total.minus(filled)
  return left.gt(0) ? left : new Decimal(0)
}

/** Notional value of an order in account currency terms (no FX), or null when it cannot be priced. */
export function orderNotional(contract: Contract, order: Order, quote?: Quote, position?: Position): Decimal | null {
  const cash = setDecimal(order.cashQty)
  if (cash) return cash
  const qty = remainingQuantity(order)
  const price = unitPrice(order, quote, position)
  if (!qty || !price) return null
  return qty.mul(price).mul(multiplier(contract, position))
}

/**
 * Notional already committed by working orders on one side. Orders that
 * cannot be priced make the total unknown (null) rather than silently zero.
 */
export function workingNotional(openOrders: readonly OpenOrder[], positions: readonly Position[], side: Side): Decimal | null {
  let total = new Decimal(0)
  for (const working of openOrders) {
    if (orderSide(working.order) !== side) continue
    const status = working.orderState?.status
    if (status && status !== 'Submitted' && status !== 'PreSubmitted') continue
    const value = orderNotional(working.contract, working.order, undefined, positionFor(positions, working.contract))
    if (value === null) return null
    total = total.plus(value)
  }
  return total
}

/** Quantity committed by working SELL orders on one instrument. */
export function workingSellQuantity(openOrders: readonly OpenOrder[], contract: Contract): Decimal {
  let total = new Decimal(0)
  for (const working of openOrders) {
    if (orderSide(working.order) !== 'SELL' || !sameInstrument(working.contract, contract)) continue
    const status = working.orderState?.status
    if (status && status !== 'Submitted' && status !== 'PreSubmitted') continue
    total = total.plus(remainingQuantity(working.order) ?? 0)
  }
  return total
}

/** Calendar day (YYYY-MM-DD) of an instant in an IANA time zone. */
export function dayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

export function readPercent(options: Record<string, unknown>, key: string, fallback?: number): number {
  const raw = options[key] ?? fallback
  const value = Number(raw)
  if (raw == null || !Number.isFinite(value) || value < 0) {
    throw new Error(`guard option "${key}" must be a non-negative number`)
  }
  return value
}
