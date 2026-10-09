import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { orderNotional, orderSide, positionFor, readPercent, workingNotional } from './order-math.js'

/**
 * Caps gross exposure — held positions plus working buys plus this buy — as
 * a percentage of net liquidation (100 = no leverage). Fails closed when the
 * order or a working buy cannot be priced, or the open orders cannot be read:
 * an exposure that cannot be measured is not allowed to grow.
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
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'BUY') return null

    const netLiq = new Decimal(ctx.account.netLiquidation || '0')
    if (!netLiq.gt(0)) return 'Net liquidation unavailable or non-positive — cannot size exposure'
    if (!ctx.openOrders) return 'Open orders unavailable — cannot include working buys in exposure'

    const added = orderNotional(op.contract, op.order, ctx.quote, positionFor(ctx.positions, op.contract))
    if (added === null) return 'Cannot price this order (no limit price, quote or position mark) — refusing'
    const working = workingNotional(ctx.openOrders, ctx.positions, 'BUY')
    if (working === null) return 'A working buy order cannot be priced — refusing to add exposure'

    const held = ctx.positions.reduce((sum, p) => sum.plus(new Decimal(p.marketValue || '0').abs()), new Decimal(0))
    const projected = held.plus(working).plus(added)
    const percent = projected.div(netLiq).mul(100)
    if (percent.gt(this.maxPercent)) {
      return `Gross exposure would be ${percent.toFixed(1)}% of equity (limit ${this.maxPercent}%): ` +
        `held ${held.toFixed(2)} + working buys ${working.toFixed(2)} + this order ${added.toFixed(2)}`
    }
    return null
  }
}
