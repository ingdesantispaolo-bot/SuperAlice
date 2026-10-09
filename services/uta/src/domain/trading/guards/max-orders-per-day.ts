import type { OperationGuard, GuardContext } from './types.js'
import { readPercent } from './order-math.js'

/**
 * Caps the number of orders sent to the broker per calendar day in
 * `timeZone` (default UTC). The count comes from the durable trading log,
 * so a restart does not reset it. Fails closed without that count.
 */
export class MaxOrdersPerDayGuard implements OperationGuard {
  readonly name = 'max-orders-per-day'
  private readonly maxOrders: number
  private readonly timeZone: string

  constructor(options: Record<string, unknown>) {
    this.maxOrders = Math.floor(readPercent(options, 'maxOrders'))
    this.timeZone = String(options.timeZone ?? 'UTC')
    // Throws RangeError on an unknown zone — surface misconfiguration at load.
    new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone })
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null
    if (!ctx.placedOrdersOn) return 'Order history unavailable — cannot enforce the daily order limit'
    const placed = ctx.placedOrdersOn(this.timeZone)
    if (placed >= this.maxOrders) {
      return `Daily order limit reached: ${placed} of ${this.maxOrders} sent today (${this.timeZone})`
    }
    return null
  }
}
