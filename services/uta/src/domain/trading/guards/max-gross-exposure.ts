import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { orderNotionalBase, orderSide, positionFor, positionValueBase, readPercent, workingNotionalBase } from './order-math.js'
import { isFxConversion } from '../fx.js'

/**
 * Caps gross exposure — held positions plus working buys plus this buy — as
 * a percentage of net liquidation (100 = no leverage), all in the account
 * base currency at the broker's rates. Fails closed when the order, a
 * working buy or a holding cannot be priced or converted, or the open
 * orders cannot be read: an exposure that cannot be measured is not allowed
 * to grow. Currency conversions (CASH) are cash, not exposure.
 */
export class MaxGrossExposureGuard implements OperationGuard {
  readonly name = 'max-gross-exposure'
  readonly needs = { quote: true, openOrders: true }
  private readonly maxPercent: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = readPercent(options, 'maxPercentOfEquity', 100)
  }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'BUY' || isFxConversion(op.contract, ctx.quote)) return null

    const netLiq = new Decimal(ctx.account.netLiquidation || '0')
    if (!netLiq.gt(0)) return 'Net liquidation unavailable or non-positive — cannot size exposure'
    if (!ctx.openOrders) return 'Open orders unavailable — cannot include working buys in exposure'

    const added = orderNotionalBase(ctx.account, op.contract, op.order, ctx.quote, positionFor(ctx.positions, op.contract))
    if (added === null) return 'Cannot price this order in the account currency (no price, or no broker FX rate) — refusing'
    const working = workingNotionalBase(ctx.account, ctx.openOrders, ctx.positions, 'BUY')
    if (working === null) return 'A working buy order cannot be priced in the account currency — refusing to add exposure'

    let held = new Decimal(0)
    for (const p of ctx.positions) {
      if (isFxConversion(p.contract)) continue
      const value = positionValueBase(ctx.account, p)
      if (value === null) return `Holding ${p.contract.symbol ?? '?'} in ${p.currency} cannot be converted to the account currency — refusing`
      held = held.plus(value)
    }
    const projected = held.plus(working).plus(added)
    const percent = projected.div(netLiq).mul(100)
    if (percent.gt(this.maxPercent)) {
      return `Gross exposure would be ${percent.toFixed(1)}% of equity (limit ${this.maxPercent}%): ` +
        `held ${held.toFixed(2)} + working buys ${working.toFixed(2)} + this order ${added.toFixed(2)}`
    }
    return null
  }
}
