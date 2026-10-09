import type { OperationGuard, GuardContext } from './types.js'
import { orderSide, positionFor, remainingQuantity, workingSellQuantity } from './order-math.js'

/**
 * Long-only account: a SELL may only reduce a held long position. The size
 * already committed by working SELL orders on the same instrument counts
 * against what is available, so two sells cannot together cross into a
 * short. Fails closed when the open orders cannot be read or the sell has
 * no share quantity (a notional sell cannot be checked against the holding).
 */
export class LongOnlyGuard implements OperationGuard {
  readonly name = 'long-only'
  readonly needs = { openOrders: true }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'SELL') return null

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
}
