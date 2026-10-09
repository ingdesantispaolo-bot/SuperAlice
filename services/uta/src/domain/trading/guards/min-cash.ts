import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { orderNotional, orderSide, positionFor, workingNotional } from './order-math.js'

/**
 * Keeps a cash reserve: cash after this buy and all working buys must stay
 * at or above `minCash` (absolute, account currency) and `minCashPercent` of
 * net liquidation, whichever is higher. Fails closed when the order or a
 * working buy cannot be priced, or the open orders cannot be read.
 */
export class MinCashGuard implements OperationGuard {
  readonly name = 'min-cash'
  readonly needs = { quote: true, openOrders: true }
  private readonly minCash: Decimal
  private readonly minPercent: Decimal

  constructor(options: Record<string, unknown>) {
    const minCash = new Decimal(String(options.minCash ?? '0'))
    const minPercent = new Decimal(String(options.minCashPercent ?? '0'))
    if (!minCash.isFinite() || minCash.lt(0) || !minPercent.isFinite() || minPercent.lt(0)) {
      throw new Error('min-cash guard requires non-negative "minCash" and/or "minCashPercent"')
    }
    if (minCash.isZero() && minPercent.isZero()) {
      throw new Error('min-cash guard requires "minCash" or "minCashPercent" greater than zero')
    }
    this.minCash = minCash
    this.minPercent = minPercent
  }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'BUY') return null
    if (!ctx.openOrders) return 'Open orders unavailable — cannot include working buys in the cash check'

    const added = orderNotional(op.contract, op.order, ctx.quote, positionFor(ctx.positions, op.contract))
    if (added === null) return 'Cannot price this order (no limit price, quote or position mark) — refusing'
    const working = workingNotional(ctx.openOrders, ctx.positions, 'BUY')
    if (working === null) return 'A working buy order cannot be priced — refusing to spend cash'

    const cash = new Decimal(ctx.account.totalCashValue || '0')
    const netLiq = new Decimal(ctx.account.netLiquidation || '0')
    const floor = Decimal.max(this.minCash, netLiq.mul(this.minPercent).div(100))
    const after = cash.minus(working).minus(added)
    if (after.lt(floor)) {
      return `Cash after this order would be ${after.toFixed(2)} (reserve ${floor.toFixed(2)}): ` +
        `cash ${cash.toFixed(2)} − working buys ${working.toFixed(2)} − this order ${added.toFixed(2)}`
    }
    return null
  }
}
