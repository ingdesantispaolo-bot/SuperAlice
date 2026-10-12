import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { orderNotionalBase, orderSide, positionFor, positionValueBase, readPercent, sameInstrument } from './order-math.js'
import { isFxConversion } from '../fx.js'

/**
 * Caps one instrument — held value plus working buys on it plus this buy —
 * at `maxPercentOfEquity` of net liquidation, in the account base currency
 * at the broker's rates. Unlike the original `max-position-size`, which
 * lets through an order it cannot value (a share-quantity buy of a new
 * instrument), this fails closed: no price, no FX rate or no open-order
 * list means no buy. Sells only reduce and pass.
 */
export class MaxPositionExposureGuard implements OperationGuard {
  readonly name = 'max-position-exposure'
  readonly needs = { quote: true, openOrders: true }
  private readonly maxPercent: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = readPercent(options, 'maxPercentOfEquity')
    if (!(this.maxPercent > 0)) throw new Error('max-position-exposure guard requires "maxPercentOfEquity" greater than zero')
  }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'BUY' || isFxConversion(op.contract, ctx.quote)) return null

    const netLiq = new Decimal(ctx.account.netLiquidation || '0')
    if (!netLiq.gt(0)) return 'Net liquidation unavailable or non-positive — cannot size the position'
    if (!ctx.openOrders) return 'Open orders unavailable — cannot include working buys in the position size'

    const symbol = op.contract.symbol || op.contract.aliceId || 'instrument'
    const position = positionFor(ctx.positions, op.contract)
    const held = position ? positionValueBase(ctx.account, position) : new Decimal(0)
    if (held === null) return `Holding in ${symbol} cannot be converted to the account currency — refusing`
    const added = orderNotionalBase(ctx.account, op.contract, op.order, ctx.quote, position)
    if (added === null) return 'Cannot price this order in the account currency (no price, or no broker FX rate) — refusing'

    let working = new Decimal(0)
    for (const w of ctx.openOrders) {
      if (orderSide(w.order) !== 'BUY' || !sameInstrument(w.contract, op.contract)) continue
      const status = w.orderState?.status
      if (status && status !== 'Submitted' && status !== 'PreSubmitted') continue
      // A working order on this instrument trades in the same currency as the
      // order being checked, so the quote's currency applies to it too.
      const value = orderNotionalBase(ctx.account, w.contract, w.order, ctx.quote, position)
      if (value === null) return `A working buy on ${symbol} cannot be priced — refusing`
      working = working.plus(value)
    }

    const projected = held.plus(working).plus(added)
    const percent = projected.div(netLiq).mul(100)
    if (percent.gt(this.maxPercent)) {
      return `Position in ${symbol} would be ${percent.toFixed(1)}% of equity (limit ${this.maxPercent}%): ` +
        `held ${held.toFixed(2)} + working buys ${working.toFixed(2)} + this order ${added.toFixed(2)}`
    }
    return null
  }
}
