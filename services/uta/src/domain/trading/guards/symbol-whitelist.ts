import type { OperationGuard, GuardContext } from './types.js'
import { getOperationSymbol } from '../git/types.js'
import { orderSide, positionFor, remainingQuantity } from './order-math.js'

/**
 * Only listed symbols may be traded. With `allowReducing: true`, a SELL of
 * an unlisted symbol is still allowed when it only reduces a held long
 * position (exiting holdings that predate the whitelist); buys of unlisted
 * symbols are always refused.
 */
export class SymbolWhitelistGuard implements OperationGuard {
  readonly name = 'symbol-whitelist'
  private allowed: Set<string>
  private allowReducing: boolean

  constructor(options: Record<string, unknown>) {
    const symbols = options.symbols as string[] | undefined
    if (!symbols || symbols.length === 0) {
      throw new Error('symbol-whitelist guard requires a non-empty "symbols" array in options')
    }
    this.allowed = new Set(symbols)
    this.allowReducing = options.allowReducing === true
  }

  check(ctx: GuardContext): string | null {
    const symbol = getOperationSymbol(ctx.operation)
    if (symbol === 'unknown') return null
    if (this.allowed.has(symbol)) return null

    const op = ctx.operation
    if (this.allowReducing) {
      if (op.action === 'closePosition') return null
      if (op.action === 'placeOrder' && orderSide(op.order) === 'SELL') {
        const held = positionFor(ctx.positions, op.contract)
        const qty = remainingQuantity(op.order)
        if (held && held.side === 'long' && qty && qty.lte(held.quantity)) return null
      }
    }
    return `Symbol ${symbol} is not in the allowed list`
  }
}
