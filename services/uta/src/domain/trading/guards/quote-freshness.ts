import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { readPercent } from './order-math.js'

/**
 * Refuses to place an order on missing or stale market data: the quote must
 * be at most `maxAgeSeconds` old (default 60) and, when `maxSpreadPercent`
 * is set, the bid/ask spread must not exceed it (measured on the mid).
 */
export class QuoteFreshnessGuard implements OperationGuard {
  readonly name = 'quote-freshness'
  readonly needs = { quote: true }
  private readonly maxAgeMs: number
  private readonly maxSpreadPercent?: number

  constructor(options: Record<string, unknown>) {
    this.maxAgeMs = readPercent(options, 'maxAgeSeconds', 60) * 1000
    if (options.maxSpreadPercent != null) this.maxSpreadPercent = readPercent(options, 'maxSpreadPercent')
  }

  check(ctx: GuardContext): string | null {
    const op = ctx.operation
    if (op.action !== 'placeOrder') return null
    const symbol = op.contract.symbol || op.contract.aliceId || 'instrument'
    const quote = ctx.quote
    if (!quote) return `No quote available for ${symbol} — refusing to trade blind`

    const at = quote.timestamp instanceof Date ? quote.timestamp : new Date(quote.timestamp)
    const now = ctx.now ?? new Date()
    const age = now.getTime() - at.getTime()
    if (!Number.isFinite(age) || age > this.maxAgeMs) {
      return `Quote for ${symbol} is stale (${Number.isFinite(age) ? Math.round(age / 1000) + 's' : 'unknown age'}, limit ${this.maxAgeMs / 1000}s)`
    }

    if (this.maxSpreadPercent != null) {
      let bid: Decimal, ask: Decimal
      try {
        bid = new Decimal(quote.bid)
        ask = new Decimal(quote.ask)
      } catch {
        return `Quote for ${symbol} has no usable bid/ask — cannot check the spread`
      }
      if (!bid.gt(0) || !ask.gt(0) || ask.lt(bid)) return `Quote for ${symbol} has no usable bid/ask — cannot check the spread`
      const spread = ask.minus(bid).div(ask.plus(bid).div(2)).mul(100)
      if (spread.gt(this.maxSpreadPercent)) {
        return `Spread for ${symbol} is ${spread.toFixed(2)}% (limit ${this.maxSpreadPercent}%)`
      }
    }
    return null
  }
}
