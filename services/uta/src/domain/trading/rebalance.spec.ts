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
    expect(() => planRebalance({ ...base, quotes: quotes(quote('acc|TESTA', '99', '100', 'EUR')), target: target({ 'acc|TESTA': '1' }, '0') })).toThrow(/FX conversion not supported/)
    const short = makePosition({ contract: makeContract({ aliceId: 'acc|TESTA' }), side: 'short', quantity: new Decimal(5) })
    expect(() => planRebalance({ ...base, positions: [short], quotes: q, target: target({ 'acc|TESTA': '1' }, '0') })).toThrow(RebalanceError)
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
