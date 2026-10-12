import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Order, OrderState } from '@traderalice/ibkr'
import { planRebalance, targetPortfolioId, validateTargetPortfolio, RebalanceError, type TargetPortfolio } from './rebalance.js'
import type { AccountInfo, OpenOrder, Position, Quote } from './brokers/types.js'
import { makeContract, makePosition } from './brokers/mock/index.js'
import './contract-ext.js'

const NOW = new Date('2026-10-09T15:00:00Z')

function target(weights: Record<string, string>, cashWeight: string, overrides: Partial<TargetPortfolio> = {}): TargetPortfolio {
  return {
    strategy: 'equal-weight',
    strategyVersion: '1',
    decisionAt: '2026-10-09T14:00:00Z',
    validUntil: '2026-10-10T14:00:00Z',
    source: 'snapshot:abc123',
    weights: Object.entries(weights).map(([aliceId, weight]) => ({ aliceId, weight })),
    cashWeight,
    ...overrides,
  }
}

const account = (netLiquidation = '10000', totalCashValue = netLiquidation): AccountInfo =>
  ({ baseCurrency: 'USD', netLiquidation, totalCashValue, unrealizedPnL: '0' })

function quote(aliceId: string, bid: string, ask: string, currency = 'USD'): Quote {
  return { contract: makeContract({ aliceId, symbol: aliceId.split('|')[1], currency }), bid, ask, last: ask, volume: '1', timestamp: NOW }
}

function quotes(...qs: Quote[]): Map<string, Quote> {
  return new Map(qs.map((q) => [q.contract.aliceId!, q]))
}

function held(aliceId: string, qty: string, price: string): Position {
  return makePosition({
    contract: makeContract({ aliceId, symbol: aliceId.split('|')[1] }),
    quantity: new Decimal(qty), marketPrice: price, marketValue: new Decimal(qty).mul(price).toFixed(),
  })
}

function workingOrder(aliceId: string, side: 'BUY' | 'SELL', qty: string, filled = '0'): OpenOrder {
  const order = new Order()
  order.action = side
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(qty)
  order.filledQuantity = new Decimal(filled)
  order.lmtPrice = new Decimal(100)
  const state = new OrderState()
  state.status = 'Submitted'
  return { contract: makeContract({ aliceId, symbol: aliceId.split('|')[1] }), order, orderState: state, orderId: 'w' }
}

describe('planRebalance', () => {
  it('turns 40/40/20 weights into whole-share buys from cash (the shared fixture: 40 and 80 units)', () => {
    const plan = planRebalance({
      target: target({ 'acc|TESTA': '0.4', 'acc|TESTB': '0.4' }, '0.2'),
      account: account('10000'),
      positions: [], openOrders: [],
      quotes: quotes(quote('acc|TESTA', '99.99', '100'), quote('acc|TESTB', '49.99', '50')),
      now: NOW,
    })
    expect(plan.orders.map((o) => [o.aliceId, o.action, o.quantity])).toEqual([
      ['acc|TESTA', 'BUY', '40'],
      ['acc|TESTB', 'BUY', '80'],
    ])
    expect(plan.projectedCash).toBe('2000.00')
  })

  it('nets out held positions and working orders, so re-planning an executed target is a no-op', () => {
    const t = target({ 'acc|TESTA': '0.4', 'acc|TESTB': '0.4' }, '0.2')
    const plan = planRebalance({
      target: t,
      account: account('10000', '6000'),
      positions: [held('acc|TESTA', '40', '100')],
      openOrders: [workingOrder('acc|TESTB', 'BUY', '80')],
      quotes: quotes(quote('acc|TESTA', '99.99', '100'), quote('acc|TESTB', '49.99', '50')),
      now: NOW,
    })
    expect(plan.orders).toEqual([])
  })

  it('sells what is no longer in the target, sells first, and never sells into a short', () => {
    const plan = planRebalance({
      target: target({ 'acc|TESTB': '0.5' }, '0.5'),
      account: account('10000', '5000'),
      positions: [held('acc|TESTA', '50', '100')],
      openOrders: [workingOrder('acc|TESTA', 'SELL', '20')],
      quotes: quotes(quote('acc|TESTA', '100', '100.1'), quote('acc|TESTB', '49.9', '50')),
      now: NOW,
    })
    expect(plan.orders.map((o) => [o.aliceId, o.action, o.quantity])).toEqual([
      ['acc|TESTA', 'SELL', '30'], // 50 held − 20 already being sold
      ['acc|TESTB', 'BUY', '100'],
    ])
  })

  it('skips trades below minTradeValue', () => {
    const plan = planRebalance({
      target: target({ 'acc|TESTA': '0.401' }, '0.599'),
      account: account('10000', '6000'),
      positions: [held('acc|TESTA', '40', '100')],
      openOrders: [],
      quotes: quotes(quote('acc|TESTA', '99.99', '100')),
      now: NOW,
      policy: { minTradeValue: '500' },
    })
    expect(plan.orders).toEqual([])
    // 0.401 × 10000 / 100 = 40.1 → 40 shares: no trade at all, not even a skipped one.
    expect(plan.skipped).toEqual([])
  })

  it('refuses invalid, expired, foreign-currency, short or unpriced inputs', () => {
    const base = { account: account(), positions: [], openOrders: [], now: NOW }
    const q = quotes(quote('acc|TESTA', '99', '100'))
    expect(() => planRebalance({ ...base, quotes: q, target: target({ 'acc|TESTA': '0.9' }, '0.2') })).toThrow(/sum to 1\.1/)
    expect(() => planRebalance({ ...base, quotes: q, target: target({ 'acc|TESTA': '-0.1' }, '1.1') })).toThrow(/within \[0, 1\]/)
    expect(() => planRebalance({ ...base, quotes: q, target: target({ 'acc|TESTA': '1' }, '0', { validUntil: '2026-10-09T14:30:00Z' }) })).toThrow(/expired/)
    expect(() => planRebalance({ ...base, quotes: new Map(), target: target({ 'acc|TESTA': '1' }, '0') })).toThrow(/no quote for acc\|TESTA/)
    expect(() => planRebalance({ ...base, quotes: quotes(quote('acc|TESTA', '99', '100', 'EUR')), target: target({ 'acc|TESTA': '1' }, '0') })).toThrow(/trades in EUR and the broker reports no rate to USD/)
    const short = makePosition({ contract: makeContract({ aliceId: 'acc|TESTA' }), side: 'short', quantity: new Decimal(5) })
    expect(() => planRebalance({ ...base, positions: [short], quotes: q, target: target({ 'acc|TESTA': '1' }, '0') })).toThrow(RebalanceError)
  })
})

describe('planRebalance — strategy sleeve', () => {
  // The paper account already holds unrelated stocks: the strategy must
  // manage only its own instruments, sized on its own budget.
  const existing = [held('acc|AAPL', '260', '336'), held('acc|MSFT', '400', '535')]

  it('scope "listed" leaves holdings outside the target untouched', () => {
    const plan = planRebalance({
      target: target({ 'acc|TESTA': '0.5', 'acc|TESTB': '0.5' }, '0'),
      account: account('1000000', '500000'),
      positions: existing, openOrders: [],
      quotes: quotes(quote('acc|TESTA', '99.99', '100'), quote('acc|TESTB', '49.99', '50')),
      now: NOW,
      policy: { scope: 'listed', capital: '100000' },
    })
    expect(plan.orders.map((o) => [o.aliceId, o.action, o.quantity])).toEqual([
      ['acc|TESTA', 'BUY', '500'],
      ['acc|TESTB', 'BUY', '1000'],
    ])
    expect(plan.equity).toBe('100000')
  })

  it('default scope "account" would sell the unrelated holdings', () => {
    const plan = planRebalance({
      target: target({ 'acc|TESTA': '1' }, '0'),
      account: account('1000000', '500000'),
      positions: existing, openOrders: [],
      quotes: quotes(quote('acc|TESTA', '99.99', '100'), quote('acc|AAPL', '336', '336.1'), quote('acc|MSFT', '535', '535.1')),
      now: NOW,
    })
    expect(plan.orders.filter((o) => o.action === 'SELL').map((o) => o.aliceId)).toEqual(['acc|AAPL', 'acc|MSFT'])
  })

  it('refuses a budget larger than the account', () => {
    expect(() => planRebalance({
      target: target({ 'acc|TESTA': '1' }, '0'), account: account('10000'), positions: [], openOrders: [],
      quotes: quotes(quote('acc|TESTA', '99', '100')), now: NOW, policy: { capital: '20000' },
    })).toThrow(/exceeds net liquidation/)
  })
})

describe('planRebalance — multi-currency account', () => {
  // EUR-based account buying USD ETFs (IBKR paper account shape): 1 USD = 0.8925 EUR.
  const eurAccount = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
    baseCurrency: 'EUR', netLiquidation: '1000000', totalCashValue: '1000000', unrealizedPnL: '0',
    fxRates: { EUR: '1', USD: '0.8925' }, cashBalances: { EUR: '1000000', USD: '0' }, ...overrides,
  })
  const usdHeld = (aliceId: string, qty: string, price: string): Position => makePosition({
    contract: makeContract({ aliceId, symbol: aliceId.split('|')[1], currency: 'USD' }),
    quantity: new Decimal(qty), marketPrice: price, marketValue: new Decimal(qty).mul(price).toFixed(),
  })
  const etfs = target({ 'acc|SPY': '0.49', 'acc|IEF': '0.49' }, '0.02')
  const etfQuotes = () => quotes(quote('acc|SPY', '699.9', '700'), quote('acc|IEF', '94.99', '95'))

  it('sizes USD instruments on EUR equity at the broker rate and reports the USD to convert', () => {
    const plan = planRebalance({ target: etfs, account: eurAccount(), positions: [], openOrders: [], quotes: etfQuotes(), now: NOW })
    // 490 000 EUR / (700 USD × 0.8925) = 784.3 → 784; / (95 × 0.8925) → 5779
    expect(plan.orders.map((o) => [o.aliceId, o.quantity, o.currency, o.estimatedNotional, o.estimatedNotionalBase])).toEqual([
      ['acc|IEF', '5779', 'USD', '549005.00', '489986.96'],
      ['acc|SPY', '784', 'USD', '548800.00', '489804.00'],
    ])
    expect(plan.projectedCash).toBe('20209.04')
    expect(plan.fundingNeeds).toEqual([{ currency: 'USD', amount: '1097805.00', baseEquivalent: '979790.96' }])
  })

  it('nets USD sells and USD cash against the USD the buys need', () => {
    const plan = planRebalance({
      target: etfs, account: eurAccount({ cashBalances: { EUR: '900000', USD: '50000' } }),
      positions: [usdHeld('acc|AAPL', '100', '300')], openOrders: [],
      quotes: new Map([...etfQuotes(), ['acc|AAPL', quote('acc|AAPL', '300', '300.1')]]), now: NOW,
    })
    expect(plan.orders[0]).toMatchObject({ aliceId: 'acc|AAPL', action: 'SELL', quantity: '100', estimatedNotionalBase: '26775.00' })
    // 1 097 805 bought − 30 000 sold − 50 000 held
    expect(plan.fundingNeeds).toEqual([{ currency: 'USD', amount: '1017805.00', baseEquivalent: '908390.96' }])
  })

  it('needs nothing converted when the currency is already funded, and cannot tell without balances', () => {
    const funded = planRebalance({ target: etfs, account: eurAccount({ cashBalances: { EUR: '0', USD: '1200000' } }), positions: [], openOrders: [], quotes: etfQuotes(), now: NOW })
    expect(funded.fundingNeeds).toEqual([])
    const unknown = planRebalance({ target: etfs, account: eurAccount({ cashBalances: undefined }), positions: [], openOrders: [], quotes: etfQuotes(), now: NOW })
    expect(unknown.fundingNeeds).toBeUndefined()
  })

  it('refuses a currency without a broker rate and ignores CASH balance positions', () => {
    expect(() => planRebalance({ target: etfs, account: eurAccount({ fxRates: { EUR: '1' } }), positions: [], openOrders: [], quotes: etfQuotes(), now: NOW }))
      .toThrow(/acc\|IEF trades in USD and the broker reports no rate to EUR/)
    const cashRow = makePosition({ contract: makeContract({ aliceId: 'acc|12087792', symbol: 'EUR', secType: 'CASH', currency: 'USD' }), quantity: new Decimal(1000) })
    const plan = planRebalance({ target: etfs, account: eurAccount(), positions: [cashRow], openOrders: [], quotes: etfQuotes(), now: NOW })
    expect(plan.orders.map((o) => o.aliceId)).toEqual(['acc|IEF', 'acc|SPY'])
  })
})

describe('target identity', () => {
  it('is stable across weight order and changes with any term', () => {
    const a = target({ 'acc|A': '0.5', 'acc|B': '0.5' }, '0')
    const b = target({ 'acc|B': '0.50', 'acc|A': '0.5' }, '0')
    expect(targetPortfolioId(a)).toBe(targetPortfolioId(b))
    expect(targetPortfolioId(a)).not.toBe(targetPortfolioId({ ...a, strategyVersion: '2' }))
    expect(targetPortfolioId(a)).toMatch(/^tp-[0-9a-f]{16}$/)
  })

  it('validates decision time and strategy identity', () => {
    expect(() => validateTargetPortfolio(target({}, '1', { decisionAt: '2026-10-09T16:00:00Z' }), NOW)).toThrow(/in the future/)
    expect(() => validateTargetPortfolio(target({}, '1', { strategyVersion: ' ' }), NOW)).toThrow(/strategyVersion/)
  })
})
