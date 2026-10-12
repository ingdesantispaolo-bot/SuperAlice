import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { orderNotional, orderNotionalBase, orderSide, positionFor, workingNotionalBase } from './order-math.js'
import { instrumentCurrency, isFxConversion } from '../fx.js'

/**
 * Keeps a cash reserve: cash after this buy and all working buys must stay
 * at or above `minCash` (absolute, account currency) and `minCashPercent` of
 * net liquidation, whichever is higher. Amounts are converted to the account
 * base currency with the broker's rates. Fails closed when the order or a
 * working buy cannot be priced or converted, or the open orders cannot be
 * read. Currency conversions (CASH) leave total cash unchanged and are not
 * checked against the reserve.
 *
 * `noCurrencyBorrowing: true` also refuses a buy whose own currency balance
 * would go negative (after working buys in that currency): buying USD assets
 * from a EUR account then needs an explicit conversion first instead of an
 * implicit margin loan.
 */
export class MinCashGuard implements OperationGuard {
  readonly name = 'min-cash'
  readonly needs = { quote: true, openOrders: true }
  private readonly minCash: Decimal
  private readonly minPercent: Decimal
  private readonly noCurrencyBorrowing: boolean

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
    this.noCurrencyBorrowing = options.noCurrencyBorrowing === true
  }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'BUY' || isFxConversion(op.contract, ctx.quote)) return null
    if (!ctx.openOrders) return 'Open orders unavailable — cannot include working buys in the cash check'

    const position = positionFor(ctx.positions, op.contract)
    const added = orderNotionalBase(ctx.account, op.contract, op.order, ctx.quote, position)
    if (added === null) return 'Cannot price this order in the account currency (no price, or no broker FX rate) — refusing'
    const working = workingNotionalBase(ctx.account, ctx.openOrders, ctx.positions, 'BUY')
    if (working === null) return 'A working buy order cannot be priced in the account currency — refusing to spend cash'

    const cash = new Decimal(ctx.account.totalCashValue || '0')
    const netLiq = new Decimal(ctx.account.netLiquidation || '0')
    const floor = Decimal.max(this.minCash, netLiq.mul(this.minPercent).div(100))
    const after = cash.minus(working).minus(added)
    if (after.lt(floor)) {
      return `Cash after this order would be ${after.toFixed(2)} (reserve ${floor.toFixed(2)}): ` +
        `cash ${cash.toFixed(2)} − working buys ${working.toFixed(2)} − this order ${added.toFixed(2)}`
    }

    if (this.noCurrencyBorrowing) return this.checkCurrencyBalance(ctx, position)
    return null
  }

  private checkCurrencyBalance(ctx: GuardContext, position: ReturnType<typeof positionFor>): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder') return null
    const currency = instrumentCurrency(op.contract, ctx.quote, position)
    if (!currency) return 'Order currency unknown — cannot verify it is funded without borrowing'
    const raw = ctx.account.cashBalances?.[currency]
    if (raw == null) return `No ${currency} cash balance reported by the broker — cannot verify the buy is funded without borrowing`
    const local = orderNotional(op.contract, op.order, ctx.quote, position)
    if (local === null) return 'Cannot price this order — refusing'

    let workingLocal = new Decimal(0)
    for (const w of ctx.openOrders ?? []) {
      if (orderSide(w.order) !== 'BUY' || isFxConversion(w.contract)) continue
      const status = w.orderState?.status
      if (status && status !== 'Submitted' && status !== 'PreSubmitted') continue
      const wPos = positionFor(ctx.positions, w.contract)
      if (instrumentCurrency(w.contract, undefined, wPos) !== currency) continue
      const value = orderNotional(w.contract, w.order, undefined, wPos)
      if (value === null) return 'A working buy order cannot be priced — refusing'
      workingLocal = workingLocal.plus(value)
    }

    const after = new Decimal(raw).minus(workingLocal).minus(local)
    if (after.lt(0)) {
      return `${currency} balance after this order would be ${after.toFixed(2)} (borrowing is disabled): ` +
        `${currency} cash ${new Decimal(raw).toFixed(2)} − working ${currency} buys ${workingLocal.toFixed(2)} − this order ${local.toFixed(2)}. ` +
        `Convert to ${currency} first.`
    }
    return null
  }
}
