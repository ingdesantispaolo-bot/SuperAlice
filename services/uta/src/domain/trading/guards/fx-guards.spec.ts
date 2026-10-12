import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import { LongOnlyGuard } from './long-only.js'
import { MaxGrossExposureGuard } from './max-gross-exposure.js'
import { MaxPositionExposureGuard } from './max-position-exposure.js'
import { MinCashGuard } from './min-cash.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { resolveGuards } from './registry.js'
import type { GuardContext } from './types.js'
import type { Operation } from '../git/types.js'
import type { AccountInfo, OpenOrder, Position, Quote } from '../brokers/types.js'
import { makeContract, makePosition } from '../brokers/mock/index.js'
import '../contract-ext.js'

// A EUR-based account holding USD instruments — the shape of the IBKR paper
// paper account on 2026-10-12 (1 USD = 0.8925 EUR per TWS ExchangeRate).
const USD_TO_EUR = '0.8925'

const SPY = () => makeContract({ aliceId: 'acc|756733', symbol: 'SPY', currency: 'USD' })
/** EUR.USD as staged from an aliceId: only the conId is known. */
const EURUSD_BY_CONID = () => Object.assign(new Contract(), { aliceId: 'acc|12087792', conId: 12087792 })
const EURUSD = () => makeContract({ aliceId: 'acc|12087792', symbol: 'EUR', secType: 'CASH', currency: 'USD', exchange: 'IDEALPRO' })

function order(side: 'BUY' | 'SELL', qty: string, lmt?: string): Order {
  const o = new Order()
  o.action = side
  o.orderType = lmt ? 'LMT' : 'MKT'
  o.totalQuantity = new Decimal(qty)
  if (lmt) o.lmtPrice = new Decimal(lmt)
  return o
}

function place(contract: Contract, o: Order): Operation {
  return { action: 'placeOrder', contract, order: o }
}

function quote(contract: Contract, ask = '100', bid = '99.98'): Quote {
  return { contract, bid, ask, last: ask, volume: '1', timestamp: new Date(), dataType: 'live' }
}

function working(contract: Contract, o: Order): OpenOrder {
  const state = new OrderState()
  state.status = 'Submitted'
  return { contract, order: o, orderState: state, orderId: 'w1' }
}

function account(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    baseCurrency: 'EUR', netLiquidation: '100000', totalCashValue: '100000', unrealizedPnL: '0',
    fxRates: { EUR: '1', USD: USD_TO_EUR, CHF: '1.0745' },
    cashBalances: { EUR: '100000', USD: '0' },
    ...overrides,
  }
}

function ctx(operation: Operation, opts: { account?: AccountInfo; quote?: Quote; positions?: Position[]; openOrders?: OpenOrder[] } = {}): GuardContext {
  return {
    operation,
    positions: opts.positions ?? [],
    account: opts.account ?? account(),
    now: new Date(),
    ...(opts.quote && { quote: opts.quote }),
    openOrders: opts.openOrders ?? [],
  }
}

describe('min-cash on a multi-currency account', () => {
  const guard = new MinCashGuard({ minCashPercent: 2 })

  it('converts a USD buy to the EUR base before checking the reserve', () => {
    const acc = account({ totalCashValue: '10000' })
    // 100 × 100 USD = 10 000 USD = 8 925 EUR → 1 075 EUR left, reserve 2 000
    const refused = guard.check(ctx(place(SPY(), order('BUY', '100')), { account: acc, quote: quote(SPY()) }))
    expect(refused).toMatch(/8925\.00/)
    // 80 × 100 USD = 7 140 EUR → 2 860 EUR left
    expect(guard.check(ctx(place(SPY(), order('BUY', '80')), { account: acc, quote: quote(SPY()) }))).toBeNull()
  })

  it('refuses when the currency has no broker rate, or cannot be known', () => {
    const noUsd = account({ fxRates: { EUR: '1', CHF: '1.07' } })
    expect(guard.check(ctx(place(SPY(), order('BUY', '1')), { account: noUsd, quote: quote(SPY()) })))
      .toMatch(/no broker FX rate/)
    const bare = Object.assign(new Contract(), { aliceId: 'acc|1', conId: 1 })
    expect(guard.check(ctx(place(bare, order('BUY', '1', '10')), { quote: quote(bare) })))
      .toMatch(/no broker FX rate/)
  })

  it('noCurrencyBorrowing refuses a buy its own currency cannot fund', () => {
    const strict = new MinCashGuard({ minCashPercent: 2, noCurrencyBorrowing: true })
    const acc = account({ cashBalances: { EUR: '90000', USD: '5000' } })
    expect(strict.check(ctx(place(SPY(), order('BUY', '60')), { account: acc, quote: quote(SPY()) })))
      .toMatch(/USD balance after this order would be -1000\.00.*Convert to USD first/)
    expect(strict.check(ctx(place(SPY(), order('BUY', '40')), { account: acc, quote: quote(SPY()) }))).toBeNull()
    // working USD buys use up the balance too
    const busy = [working(SPY(), order('BUY', '20', '100'))]
    expect(strict.check(ctx(place(SPY(), order('BUY', '40')), { account: acc, quote: quote(SPY()), openOrders: busy })))
      .toMatch(/working USD buys 2000\.00/)
    // without per-currency balances the guard cannot prove funding
    expect(strict.check(ctx(place(SPY(), order('BUY', '1')), { account: account({ cashBalances: undefined }), quote: quote(SPY()) })))
      .toMatch(/No USD cash balance/)
  })

  it('does not count a conversion against the reserve', () => {
    const acc = account({ totalCashValue: '100' })
    expect(guard.check(ctx(place(EURUSD_BY_CONID(), order('BUY', '50000')), { account: acc, quote: quote(EURUSD(), '1.1205', '1.1204') })))
      .toBeNull()
  })
})

describe('max-gross-exposure on a multi-currency account', () => {
  const guard = new MaxGrossExposureGuard({ maxPercentOfEquity: 100 })
  // 50 000 USD held = 44 625 EUR
  const positions = [makePosition({ contract: makeContract({ aliceId: 'acc|1', symbol: 'QQQ', currency: 'USD' }), quantity: new Decimal(100), marketPrice: '500', marketValue: '50000' })]

  it('sums held and new exposure in the base currency', () => {
    // + 60 000 USD = 53 550 EUR → 98 175 EUR = 98.2 % (raw USD sum would be 110 %)
    expect(guard.check(ctx(place(SPY(), order('BUY', '600')), { positions, quote: quote(SPY()) }))).toBeNull()
    // + 70 000 USD = 62 475 EUR → 107.1 %
    expect(guard.check(ctx(place(SPY(), order('BUY', '700')), { positions, quote: quote(SPY()) }))).toMatch(/107\.1%/)
  })

  it('refuses when a holding cannot be converted', () => {
    const jpy = [makePosition({ contract: makeContract({ aliceId: 'acc|2', symbol: '7203', currency: 'JPY' }), marketValue: '1000000' })]
    expect(guard.check(ctx(place(SPY(), order('BUY', '1')), { positions: jpy, quote: quote(SPY()) }))).toMatch(/JPY cannot be converted/)
  })
})

describe('max-position-exposure', () => {
  const guard = new MaxPositionExposureGuard({ maxPercentOfEquity: 10 })

  it('sizes a new position from the quote, in the base currency', () => {
    // 120 × 100 USD = 10 710 EUR = 10.7 % of 100 000 EUR
    expect(guard.check(ctx(place(SPY(), order('BUY', '120')), { quote: quote(SPY()) }))).toMatch(/10\.7% of equity \(limit 10%\)/)
    // 110 × 100 USD = 9 817.50 EUR
    expect(guard.check(ctx(place(SPY(), order('BUY', '110')), { quote: quote(SPY()) }))).toBeNull()
  })

  it('counts the holding and working buys on the same instrument', () => {
    const positions = [makePosition({ contract: SPY(), quantity: new Decimal(50), marketPrice: '100', marketValue: '5000' })]
    const busy = [working(SPY(), order('BUY', '30', '100'))]
    // 4 462.50 held + 2 677.50 working + 2 677.50 new = 9 817.50 EUR
    expect(guard.check(ctx(place(SPY(), order('BUY', '30')), { positions, quote: quote(SPY()), openOrders: busy }))).toBeNull()
    // + 33 → 2 945.25 new → 10 085.25 EUR = 10.1 %
    expect(guard.check(ctx(place(SPY(), order('BUY', '33')), { positions, quote: quote(SPY()), openOrders: busy }))).toMatch(/10\.1% of equity/)
  })

  it('fails closed where the original max-position-size let the order through', () => {
    expect(guard.check(ctx(place(SPY(), order('BUY', '1'))))).toMatch(/Cannot price this order/)
    expect(guard.check({ ...ctx(place(SPY(), order('BUY', '1')), { quote: quote(SPY()) }), openOrders: undefined })).toMatch(/Open orders unavailable/)
    expect(() => new MaxPositionExposureGuard({})).toThrow(/maxPercentOfEquity/)
  })

  it('lets sells and conversions through', () => {
    expect(guard.check(ctx(place(SPY(), order('SELL', '1000'))))).toBeNull()
    expect(guard.check(ctx(place(EURUSD_BY_CONID(), order('BUY', '900000')), { quote: quote(EURUSD(), '1.12') }))).toBeNull()
  })
})

describe('long-only with currency conversions', () => {
  const guard = new LongOnlyGuard()
  const acc = account({ cashBalances: { EUR: '40000', USD: '10000' } })

  it('recognises a conversion staged by conId from the quote and funds the SELL leg in EUR', () => {
    expect(guard.check(ctx(place(EURUSD_BY_CONID(), order('SELL', '30000')), { account: acc, quote: quote(EURUSD(), '1.1205', '1.1204') }))).toBeNull()
    expect(guard.check(ctx(place(EURUSD_BY_CONID(), order('SELL', '50000')), { account: acc, quote: quote(EURUSD(), '1.1205', '1.1204') })))
      .toMatch(/leave EUR at -10000\.00/)
  })

  it('prices the USD paid by a BUY and counts working conversions', () => {
    // 10 000 EUR × 1.12 = 11 200 USD > 10 000 USD
    expect(guard.check(ctx(place(EURUSD(), order('BUY', '10000')), { account: acc, quote: quote(EURUSD(), '1.12') }))).toMatch(/leave USD at -1200\.00/)
    expect(guard.check(ctx(place(EURUSD(), order('BUY', '8000')), { account: acc, quote: quote(EURUSD(), '1.12') }))).toBeNull()
    const busy = [working(EURUSD(), order('SELL', '25000', '1.12'))]
    expect(guard.check(ctx(place(EURUSD(), order('SELL', '20000')), { account: acc, quote: quote(EURUSD()), openOrders: busy })))
      .toMatch(/working conversions 25000\.00/)
  })

  it('without a quote a conId-only conversion is treated as a sell of nothing held', () => {
    expect(guard.check(ctx(place(EURUSD_BY_CONID(), order('SELL', '1')), { account: acc }))).toMatch(/No long position/)
  })
})

describe('symbol-whitelist fxPairs', () => {
  it('allows only the listed conversion pairs', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['SPY'], fxPairs: ['eur.usd'] })
    expect(guard.needs).toEqual({ quote: true })
    expect(guard.check(ctx(place(EURUSD_BY_CONID(), order('SELL', '1000')), { quote: quote(EURUSD()) }))).toBeNull()
    const gbp = makeContract({ aliceId: 'acc|9', symbol: 'GBP', secType: 'CASH', currency: 'USD' })
    expect(guard.check(ctx(place(gbp, order('SELL', '1000')), { quote: quote(gbp) }))).toMatch(/GBP\.USD is not in the allowed fxPairs/)
  })

  it('without fxPairs a conversion goes through the symbol check as before', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['SPY'] })
    expect(guard.needs).toBeUndefined()
    expect(guard.check(ctx(place(EURUSD(), order('SELL', '1000'))))).toMatch(/Symbol EUR is not in the allowed list/)
  })
})

describe('registry', () => {
  it('resolves max-position-exposure', () => {
    const [guard] = resolveGuards([{ type: 'max-position-exposure', options: { maxPercentOfEquity: 10 } }])
    expect(guard.name).toBe('max-position-exposure')
  })
})
