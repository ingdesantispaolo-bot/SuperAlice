import type { OperationGuard, GuardContext } from './types.js'
import { getOperationSymbol } from '../git/types.js'
import { orderSide, positionFor, remainingQuantity } from './order-math.js'
import { fxLegs, isFxConversion } from '../fx.js'

/**
 * Only listed symbols may be traded. With `allowReducing: true`, a SELL of
 * an unlisted symbol is still allowed when it only reduces a held long
 * position (exiting holdings that predate the whitelist); buys of unlisted
 * symbols are always refused.
 *
 * With `fxPairs` (e.g. ["EUR.USD"]), currency conversions (CASH) are
 * matched against those pairs instead of `symbols`; any other pair is
 * refused. Without it, conversions go through the symbol check as before.
 */
export class SymbolWhitelistGuard implements OperationGuard {
  readonly name = 'symbol-whitelist'
  readonly needs?: { readonly quote?: boolean }
  private allowed: Set<string>
  private allowReducing: boolean
  private fxPairs: Set<string>

  constructor(options: Record<string, unknown>) {
    const symbols = options.symbols as string[] | undefined
    if (!symbols || symbols.length === 0) {
      throw new Error('symbol-whitelist guard requires a non-empty "symbols" array in options')
    }
    this.allowed = new Set(symbols)
    this.allowReducing = options.allowReducing === true
    const pairs = Array.isArray(options.fxPairs) ? options.fxPairs as unknown[] : []
    this.fxPairs = new Set(pairs.filter((p): p is string => typeof p === 'string').map((p) => p.trim().toUpperCase()))
    // A conversion staged by conId is only recognisable from the quote.
    if (this.fxPairs.size > 0) this.needs = { quote: true }
  }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (this.fxPairs.size > 0 && op.action === 'placeOrder' && isFxConversion(op.contract, ctx.quote)) {
      const legs = fxLegs(op.contract, ctx.quote)
      const pair = legs ? `${legs.base}.${legs.quoteCurrency}` : 'unknown pair'
      return legs && this.fxPairs.has(pair) ? null : `Currency conversion ${pair} is not in the allowed fxPairs`
    }

    const symbol = getOperationSymbol(op)
    if (symbol === 'unknown') return null
    if (this.allowed.has(symbol)) return null

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
