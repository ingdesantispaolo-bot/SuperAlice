import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Decimal from 'decimal.js'
import { Order, OrderState } from '@traderalice/ibkr'
import { LongOnlyGuard } from './long-only.js'
import { MaxGrossExposureGuard } from './max-gross-exposure.js'
import { MinCashGuard } from './min-cash.js'
import { MaxOrdersPerDayGuard } from './max-orders-per-day.js'
import { QuoteFreshnessGuard } from './quote-freshness.js'
import { MaxDailyLossGuard } from './max-daily-loss.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { resolveGuards } from './registry.js'
import { dayKey } from './order-math.js'
import type { GuardContext } from './types.js'
import type { Operation } from '../git/types.js'
import type { OpenOrder, Position, Quote } from '../brokers/types.js'
import { makeContract, makePosition } from '../brokers/mock/index.js'
import { createSnapshotStore } from '../snapshot/store.js'
import type { UTASnapshot } from '../snapshot/types.js'
import '../contract-ext.js'

// ==================== Helpers ====================

const AAPL = () => makeContract({ aliceId: 'acc|AAPL', symbol: 'AAPL' })
const MSFT = () => makeContract({ aliceId: 'acc|MSFT', symbol: 'MSFT' })

function order(side: 'BUY' | 'SELL', qty: string | null, opts: { type?: string; lmt?: string; cash?: string } = {}): Order {
  const o = new Order()
  o.action = side
  o.orderType = opts.type ?? (opts.lmt ? 'LMT' : 'MKT')
  if (qty !== null) o.totalQuantity = new Decimal(qty)
  if (opts.lmt) o.lmtPrice = new Decimal(opts.lmt)
  if (opts.cash) o.cashQty = new Decimal(opts.cash)
  return o
}

function place(contract = AAPL(), o = order('BUY', '10')): Operation {
  return { action: 'placeOrder', contract, order: o }
}

function working(contract = AAPL(), o = order('BUY', '10', { lmt: '100' }), status = 'Submitted'): OpenOrder {
  const state = new OrderState()
  state.status = status
  return { contract, order: o, orderState: state, orderId: 'w1' }
}

function quote(contract = AAPL(), opts: { bid?: string; ask?: string; last?: string; ageMs?: number } = {}): Quote {
  return {
    contract, bid: opts.bid ?? '99.9', ask: opts.ask ?? '100.1', last: opts.last ?? '100', volume: '1000',
    timestamp: new Date(Date.now() - (opts.ageMs ?? 0)),
  }
}

function ctx(overrides: Partial<GuardContext> & { netLiq?: string; cash?: string } = {}): GuardContext {
  return {
    operation: overrides.operation ?? place(),
    positions: overrides.positions ?? [],
    account: {
      baseCurrency: 'USD',
      netLiquidation: overrides.netLiq ?? '100000',
      totalCashValue: overrides.cash ?? '100000',
      unrealizedPnL: '0',
    },
    now: overrides.now ?? new Date(),
    accountId: overrides.accountId ?? 'acc',
    ...(overrides.quote !== undefined && { quote: overrides.quote }),
    openOrders: overrides.openOrders === undefined ? [] : overrides.openOrders,
    ...(overrides.placedOrdersOn && { placedOrdersOn: overrides.placedOrdersOn }),
  }
}

function held(contract = AAPL(), qty = '10', price = '100'): Position {
  return makePosition({ contract, quantity: new Decimal(qty), marketPrice: price, marketValue: new Decimal(qty).mul(price).toFixed() })
}

// ==================== long-only ====================

describe('LongOnlyGuard', () => {
  const guard = new LongOnlyGuard()

  it('allows buys and a sell within the held position', () => {
    expect(guard.check(ctx())).toBeNull()
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', '10')), positions: [held()] }))).toBeNull()
  })

  it('refuses a sell larger than the position (would open a short)', () => {
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', '11')), positions: [held()] })))
      .toMatch(/exceeds the available long position 10/)
  })

  it('counts working sells against the available position', () => {
    const result = guard.check(ctx({
      operation: place(AAPL(), order('SELL', '6')),
      positions: [held()],
      openOrders: [working(AAPL(), order('SELL', '5', { lmt: '110' }))],
    }))
    expect(result).toMatch(/available long position 5 .*working sells 5/)
  })

  it('refuses a sell with no position, a notional sell, or unknown open orders', () => {
    expect(guard.check(ctx({ operation: place(MSFT(), order('SELL', '1')), positions: [held()] }))).toMatch(/No long position in MSFT/)
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', null, { cash: '500' })), positions: [held()] }))).toMatch(/share quantity/)
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', '1')), positions: [held()], openOrders: null as unknown as undefined })))
      .toMatch(/Open orders unavailable/)
  })
})

// ==================== max-gross-exposure ====================

describe('MaxGrossExposureGuard', () => {
  const guard = new MaxGrossExposureGuard({ maxPercentOfEquity: 100 })

  it('allows a buy that keeps exposure within equity', () => {
    expect(guard.check(ctx({ operation: place(AAPL(), order('BUY', '100')), quote: quote(), positions: [held(MSFT(), '400', '100')] }))).toBeNull()
  })

  it('refuses a buy that would lever the account, counting working buys', () => {
    // held 50000 + working 10000 + 500 × ask 100.1 = 110050 on 100000 equity
    const result = guard.check(ctx({
      operation: place(AAPL(), order('BUY', '500')),
      quote: quote(),
      positions: [held(MSFT(), '500', '100')],
      openOrders: [working(MSFT(), order('BUY', '100', { lmt: '100' }))],
    }))
    expect(result).toMatch(/Gross exposure would be 110\.1% of equity \(limit 100%\)/)
    expect(result).toMatch(/working buys 10000\.00/)
  })

  it('prices with the limit price before the quote, and fails closed when nothing prices the order', () => {
    expect(guard.check(ctx({ operation: place(AAPL(), order('BUY', '2000', { lmt: '10' })) }))).toBeNull()
    expect(guard.check(ctx({ operation: place(AAPL(), order('BUY', '10')) }))).toMatch(/Cannot price this order/)
  })

  it('ignores sells', () => {
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', '1')), positions: [held(AAPL(), '1000', '200')] }))).toBeNull()
  })
})

// ==================== min-cash ====================

describe('MinCashGuard', () => {
  it('keeps the larger of the absolute and percentage reserve', () => {
    const guard = new MinCashGuard({ minCash: '1000', minCashPercent: 5 })
    // cash 10000 − 9000 = 1000 < reserve max(1000, 5% of 100000 = 5000)
    expect(guard.check(ctx({ cash: '10000', operation: place(AAPL(), order('BUY', '90', { lmt: '100' })) })))
      .toMatch(/Cash after this order would be 1000\.00 \(reserve 5000\.00\)/)
    expect(guard.check(ctx({ cash: '10000', operation: place(AAPL(), order('BUY', '40', { lmt: '100' })) }))).toBeNull()
  })

  it('subtracts working buys', () => {
    const guard = new MinCashGuard({ minCash: '1000' })
    expect(guard.check(ctx({
      cash: '5000',
      operation: place(AAPL(), order('BUY', '20', { lmt: '100' })),
      openOrders: [working(MSFT(), order('BUY', '25', { lmt: '100' }))],
    }))).toMatch(/− working buys 2500\.00/)
  })

  it('requires a reserve to be configured', () => {
    expect(() => new MinCashGuard({})).toThrow(/greater than zero/)
  })
})

// ==================== max-orders-per-day ====================

describe('MaxOrdersPerDayGuard', () => {
  it('refuses once the durable daily count reaches the limit', () => {
    const guard = new MaxOrdersPerDayGuard({ maxOrders: 3, timeZone: 'America/New_York' })
    let zone = ''
    expect(guard.check(ctx({ placedOrdersOn: (tz) => { zone = tz; return 2 } }))).toBeNull()
    expect(zone).toBe('America/New_York')
    expect(guard.check(ctx({ placedOrdersOn: () => 3 }))).toMatch(/Daily order limit reached: 3 of 3/)
  })

  it('fails closed without a count and rejects an unknown time zone at load', () => {
    expect(new MaxOrdersPerDayGuard({ maxOrders: 3 }).check(ctx())).toMatch(/Order history unavailable/)
    expect(() => new MaxOrdersPerDayGuard({ maxOrders: 3, timeZone: 'Mars/Olympus' })).toThrow()
  })
})

// ==================== quote-freshness ====================

describe('QuoteFreshnessGuard', () => {
  it('refuses a missing or stale quote', () => {
    const guard = new QuoteFreshnessGuard({ maxAgeSeconds: 30 })
    expect(guard.check(ctx())).toMatch(/No quote available for AAPL/)
    expect(guard.check(ctx({ quote: quote(AAPL(), { ageMs: 45_000 }) }))).toMatch(/stale \(45s, limit 30s\)/)
    expect(guard.check(ctx({ quote: quote(AAPL(), { ageMs: 5_000 }) }))).toBeNull()
  })

  it('refuses delayed or frozen feeds unless explicitly allowed', () => {
    const delayed = { ...quote(AAPL()), dataType: 'delayed' as const }
    expect(new QuoteFreshnessGuard({}).check(ctx({ quote: delayed }))).toMatch(/comes from a delayed feed, not live market data/)
    expect(new QuoteFreshnessGuard({ allowDelayed: true }).check(ctx({ quote: delayed }))).toBeNull()
    expect(new QuoteFreshnessGuard({}).check(ctx({ quote: { ...quote(AAPL()), dataType: 'live' } }))).toBeNull()
  })

  it('refuses a spread wider than the limit', () => {
    const guard = new QuoteFreshnessGuard({ maxSpreadPercent: 0.5 })
    expect(guard.check(ctx({ quote: quote(AAPL(), { bid: '99', ask: '101' }) }))).toMatch(/Spread for AAPL is 2\.00%/)
    expect(guard.check(ctx({ quote: quote(AAPL(), { bid: '99.9', ask: '100.1' }) }))).toBeNull()
  })
})

// ==================== max-daily-loss ====================

describe('MaxDailyLossGuard', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'uta-daily-loss-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function snapshot(at: Date, netLiquidation: string): Promise<void> {
    const snap = {
      accountId: 'acc', timestamp: at.toISOString(), trigger: 'scheduled',
      account: { baseCurrency: 'USD', netLiquidation, totalCashValue: netLiquidation, unrealizedPnL: '0', realizedPnL: '0' },
      positions: [], openOrders: [], health: 'healthy',
    } as unknown as UTASnapshot
    await createSnapshotStore('acc', { baseDir: dir }).append(snap)
  }

  it('stops new buys once today\'s loss from the first snapshot exceeds the limit; sells stay allowed', async () => {
    const now = new Date('2026-10-09T15:00:00Z')
    await snapshot(new Date('2026-10-08T20:00:00Z'), '120000') // yesterday: ignored
    await snapshot(new Date('2026-10-09T08:00:00Z'), '100000') // today's baseline
    await snapshot(new Date('2026-10-09T12:00:00Z'), '99000')
    const guard = new MaxDailyLossGuard({ maxLossPercent: 2, snapshotBaseDir: dir })

    expect(await guard.check(ctx({ now, netLiq: '98500' }))).toBeNull()
    expect(await guard.check(ctx({ now, netLiq: '97900' }))).toMatch(/Daily loss 2\.10% exceeds the 2% limit/)
    expect(await guard.check(ctx({ now, netLiq: '97900', operation: place(AAPL(), order('SELL', '1')) }))).toBeNull()
  })

  it('refuses without a baseline unless explicitly allowed', async () => {
    const now = new Date('2026-10-09T15:00:00Z')
    expect(await new MaxDailyLossGuard({ maxLossPercent: 2, snapshotBaseDir: dir }).check(ctx({ now }))).toMatch(/No account snapshot yet for 2026-10-09/)
    expect(await new MaxDailyLossGuard({ maxLossPercent: 2, snapshotBaseDir: dir, allowWithoutBaseline: true }).check(ctx({ now }))).toBeNull()
  })
})

// ==================== symbol-whitelist allowReducing ====================

describe('SymbolWhitelistGuard allowReducing', () => {
  const whitelist = (allowReducing: boolean) => new SymbolWhitelistGuard({ symbols: ['MSFT'], allowReducing })

  it('lets an unlisted holding be sold down, never bought', () => {
    const guard = whitelist(true)
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', '10')), positions: [held(AAPL(), '10')] }))).toBeNull()
    expect(guard.check(ctx({ operation: place(AAPL(), order('SELL', '11')), positions: [held(AAPL(), '10')] }))).toMatch(/not in the allowed list/)
    expect(guard.check(ctx({ operation: place(AAPL(), order('BUY', '1')), positions: [held(AAPL(), '10')] }))).toMatch(/not in the allowed list/)
  })

  it('without the option an unlisted sell is refused as before', () => {
    expect(whitelist(false).check(ctx({ operation: place(AAPL(), order('SELL', '10')), positions: [held(AAPL(), '10')] }))).toMatch(/not in the allowed list/)
  })
})

// ==================== registry & helpers ====================

describe('risk guards registry', () => {
  it('resolves every new guard type from config', () => {
    const guards = resolveGuards([
      { type: 'long-only' },
      { type: 'max-gross-exposure', options: { maxPercentOfEquity: 100 } },
      { type: 'min-cash', options: { minCashPercent: 2 } },
      { type: 'max-orders-per-day', options: { maxOrders: 10 } },
      { type: 'quote-freshness', options: { maxAgeSeconds: 60 } },
      { type: 'max-daily-loss', options: { maxLossPercent: 3 } },
    ])
    expect(guards.map((g) => g.name)).toEqual([
      'long-only', 'max-gross-exposure', 'min-cash', 'max-orders-per-day', 'quote-freshness', 'max-daily-loss',
    ])
  })

  it('dayKey follows the configured zone', () => {
    const at = new Date('2026-10-09T02:00:00Z')
    expect(dayKey(at, 'UTC')).toBe('2026-10-09')
    expect(dayKey(at, 'America/New_York')).toBe('2026-10-08')
  })
})
