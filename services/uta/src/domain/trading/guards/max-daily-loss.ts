import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import { dayKey, orderSide, readPercent } from './order-math.js'
import { createSnapshotStore } from '../snapshot/store.js'
import type { UTASnapshot } from '../snapshot/types.js'

/**
 * Stops new BUY orders once today's equity loss exceeds `maxLossPercent`.
 * The day's baseline is the earliest account snapshot of the calendar day in
 * `timeZone` (default UTC), read from the durable snapshot store — a restart
 * does not reset it. Sells (risk-reducing on a long-only account) stay
 * allowed. Without a snapshot for today the guard cannot measure the loss and
 * refuses, unless `allowWithoutBaseline` is set.
 */
export class MaxDailyLossGuard implements OperationGuard {
  readonly name = 'max-daily-loss'
  private readonly maxLossPercent: number
  private readonly timeZone: string
  private readonly allowWithoutBaseline: boolean
  private readonly baseDir?: string

  constructor(options: Record<string, unknown>) {
    this.maxLossPercent = readPercent(options, 'maxLossPercent')
    this.timeZone = String(options.timeZone ?? 'UTC')
    new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone })
    this.allowWithoutBaseline = options.allowWithoutBaseline === true
    if (typeof options.snapshotBaseDir === 'string') this.baseDir = options.snapshotBaseDir
  }

  async check(ctx: GuardContext): Promise<string | null> {
    const op = ctx.operation
    if (op.action !== 'placeOrder' || orderSide(op.order) !== 'BUY') return null
    if (!ctx.accountId) return 'Account id unavailable — cannot read today\'s equity baseline'

    const now = ctx.now ?? new Date()
    const today = dayKey(now, this.timeZone)
    const store = createSnapshotStore(ctx.accountId, this.baseDir ? { baseDir: this.baseDir } : undefined)
    // 36h always covers the whole local day, whatever the zone offset.
    const recent = await store.readRange({ startTime: new Date(now.getTime() - 36 * 3600_000).toISOString() })
    const first = recent
      .filter((s) => dayKey(new Date(s.timestamp), this.timeZone) === today)
      .reduce<UTASnapshot | null>((earliest, s) => (!earliest || s.timestamp < earliest.timestamp ? s : earliest), null)

    if (!first) {
      return this.allowWithoutBaseline ? null : `No account snapshot yet for ${today} (${this.timeZone}) — cannot measure the daily loss`
    }
    const baseline = new Decimal(first.account.netLiquidation)
    const current = new Decimal(ctx.account.netLiquidation || '0')
    if (!baseline.gt(0)) return 'Today\'s equity baseline is not positive — cannot measure the daily loss'

    const lossPercent = baseline.minus(current).div(baseline).mul(100)
    if (lossPercent.gt(this.maxLossPercent)) {
      return `Daily loss ${lossPercent.toFixed(2)}% exceeds the ${this.maxLossPercent}% limit ` +
        `(equity ${current.toFixed(2)} vs ${baseline.toFixed(2)} at ${first.timestamp}) — new buys stopped for today`
    }
    return null
  }
}
