import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { orderSide, positionFor, remainingQuantity, unitPrice, workingSellQuantity } from './order-math.js'
import { fxLegs, isFxConversion } from '../fx.js'

/**
 * Long-only account: a SELL may only reduce a held long position. The size
 * already committed by working SELL orders on the same instrument counts
 * against what is available, so two sells cannot together cross into a
 * short. Fails closed when the open orders cannot be read or the sell has
 * no share quantity (a notional sell cannot be checked against the holding).
 *
 * Currency conversions (CASH, e.g. EUR.USD) are not positions: the currency
 * paid must be covered by its cash balance, counting working conversions
 * that pay the same currency, so a conversion never shorts a currency.
 */
export class LongOnlyGuard implements OperationGuard {
  readonly name = 'long-only'
  // The quote identifies a conversion staged by conId and prices a BUY leg.
  readonly needs = { openOrders: true, quote: true }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder') return null
    if (isFxConversion(op.contract, ctx.quote)) return this.checkConversion(ctx)
    if (orderSide(op.order) !== 'SELL') return null

    const qty = remainingQuantity(op.order)
    if (!qty) return 'Sell orders must specify a share quantity on a long-only account'
    if (!ctx.openOrders) return 'Open orders unavailable — cannot verify the sell stays within the held position'

    const held = positionFor(ctx.positions, op.contract)
    const long = held && held.side === 'long' ? held.quantity : null
    const symbol = op.contract.symbol || op.contract.aliceId || 'instrument'
    if (!long || long.lte(0)) return `No long position in ${symbol} to sell (long-only account)`

    const committed = workingSellQuantity(ctx.openOrders, op.contract)
    const available = long.minus(committed)
    if (qty.gt(available)) {
      return `Sell ${qty.toFixed()} ${symbol} exceeds the available long position ${available.toFixed()} ` +
        `(held ${long.toFixed()}, already in working sells ${committed.toFixed()})`
    }
    return null
  }

  private checkConversion(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder') return null
    const legs = fxLegs(op.contract, ctx.quote)
    if (!legs) return 'Currency conversion without both currencies — cannot verify it is funded'
    const qty = remainingQuantity(op.order)
    if (!qty) return `Conversion ${legs.base}.${legs.quoteCurrency} must specify a quantity in ${legs.base}`
    if (!ctx.openOrders) return 'Open orders unavailable — cannot include working conversions'

    const side = orderSide(op.order)
    const paid = side === 'SELL' ? legs.base : legs.quoteCurrency
    let amount: Decimal
    if (side === 'SELL') {
      amount = qty
    } else {
      const price = unitPrice(op.order, ctx.quote)
      if (!price) return `Cannot price the ${legs.quoteCurrency} paid for this conversion — refusing`
      amount = qty.mul(price)
    }

    let working = new Decimal(0)
    for (const w of ctx.openOrders) {
      if (!isFxConversion(w.contract)) continue
      const status = w.orderState?.status
      if (status && status !== 'Submitted' && status !== 'PreSubmitted') continue
      const wLegs = fxLegs(w.contract)
      const wQty = remainingQuantity(w.order)
      if (!wLegs || !wQty) return 'A working conversion cannot be sized — refusing'
      if (orderSide(w.order) === 'SELL' && wLegs.base === paid) {
        working = working.plus(wQty)
      } else if (orderSide(w.order) === 'BUY' && wLegs.quoteCurrency === paid) {
        const wPrice = unitPrice(w.order)
        if (!wPrice) return 'A working conversion paying the same currency cannot be priced — refusing'
        working = working.plus(wQty.mul(wPrice))
      }
    }

    const raw = ctx.account.cashBalances?.[paid]
    if (raw == null) return `No ${paid} cash balance reported by the broker — cannot verify the conversion is funded`
    const after = new Decimal(raw).minus(working).minus(amount)
    if (after.lt(0)) {
      return `Conversion would leave ${paid} at ${after.toFixed(2)} (a currency short): ` +
        `${paid} cash ${new Decimal(raw).toFixed(2)} − working conversions ${working.toFixed(2)} − this order ${amount.toFixed(2)}`
    }
    return null
  }
}
