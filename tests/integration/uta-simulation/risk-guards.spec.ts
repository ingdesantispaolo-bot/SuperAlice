/**
 * Risk guards through the real UTA → TradingGit → guard pipeline → MockBroker
 * path: a refusal never reaches the broker, the daily order count survives a
 * restart, and broker reads happen only when a configured guard needs them.
 */

import { describe, it, expect, vi } from 'vitest'
import { UnifiedTradingAccount } from '../../../services/uta/src/domain/trading/UnifiedTradingAccount.js'
import { MockBroker } from '../../../services/uta/src/domain/trading/brokers/mock/index.js'
import type { GitExportState } from '../../../services/uta/src/domain/trading/git/types.js'
import '../../../services/uta/src/domain/trading/contract-ext.js'

type Guards = NonNullable<ConstructorParameters<typeof UnifiedTradingAccount>[1]>['guards']

async function account(broker: MockBroker, guards: Guards, extra: Partial<ConstructorParameters<typeof UnifiedTradingAccount>[1]> = {}) {
  const uta = new UnifiedTradingAccount(broker, { guards, ...extra })
  await uta.waitForConnect()
  return uta
}

async function push(uta: UnifiedTradingAccount, action: 'BUY' | 'SELL', qty: string, symbol = 'AAPL') {
  uta.stagePlaceOrder({ aliceId: `mock-paper|${symbol}`, symbol, action, orderType: 'MKT', totalQuantity: qty })
  const { hash } = uta.commit(`${action} ${qty} ${symbol}`)
  return uta.push(hash)
}

describe('UTA — risk guards', () => {
  it('long-only: a sell beyond the position is refused before the broker is called', async () => {
    const broker = new MockBroker()
    broker.setQuote('AAPL', 100)
    const uta = await account(broker, [{ type: 'long-only' }])
    await push(uta, 'BUY', '5')
    const placeSpy = vi.spyOn(broker, 'placeOrder')

    const result = await push(uta, 'SELL', '6')

    expect(result.rejected[0].error).toMatch(/\[guard:long-only\] Sell 6 AAPL exceeds the available long position 5/)
    expect(placeSpy).not.toHaveBeenCalled()
    expect(uta.getUnresolved()).toHaveLength(0)
  })

  it('max-gross-exposure: refuses a buy that would lever the account', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    broker.setQuote('AAPL', 100)
    const uta = await account(broker, [{ type: 'max-gross-exposure', options: { maxPercentOfEquity: 100 } }])

    expect((await push(uta, 'BUY', '90')).submitted).toHaveLength(1)
    const refused = await push(uta, 'BUY', '20')

    expect(refused.rejected[0].error).toMatch(/\[guard:max-gross-exposure\] Gross exposure would be 1\d\d\.\d% of equity/)
  })

  it('max-orders-per-day: the count comes from the durable log and survives a restart', async () => {
    const broker = new MockBroker()
    broker.setQuote('AAPL', 100)
    let saved: GitExportState | undefined
    const onCommit = (state: GitExportState) => { saved = JSON.parse(JSON.stringify(state)) }
    const guards: Guards = [{ type: 'max-orders-per-day', options: { maxOrders: 2 } }]
    const first = await account(broker, guards, { onCommit })
    await push(first, 'BUY', '1')
    await push(first, 'BUY', '1')

    const restarted = await account(broker, guards, { savedState: saved, onCommit })
    const refused = await push(restarted, 'BUY', '1')

    expect(refused.rejected[0].error).toMatch(/\[guard:max-orders-per-day\] Daily order limit reached: 2 of 2/)
    expect(broker.callCount('placeOrder')).toBe(2)
  })

  it('counts each dispatched order of a multi-order push toward the daily limit', async () => {
    const broker = new MockBroker()
    const uta = await account(broker, [{ type: 'max-orders-per-day', options: { maxOrders: 2 } }])
    for (const symbol of ['AAPL', 'MSFT', 'NVDA']) {
      uta.stagePlaceOrder({ aliceId: `mock-paper|${symbol}`, symbol, action: 'BUY', orderType: 'MKT', totalQuantity: '1' })
    }
    const { hash } = uta.commit('three buys')

    const result = await uta.push(hash)

    expect(result.submitted).toHaveLength(2)
    expect(result.rejected[0].error).toMatch(/Daily order limit reached: 2 of 2/)
  })

  it('reads quotes and open orders only when a configured guard needs them', async () => {
    const broker = new MockBroker()
    const cooldownOnly = await account(broker, [{ type: 'cooldown', options: { minIntervalMs: 0 } }])
    await push(cooldownOnly, 'BUY', '1')
    expect(broker.callCount('getQuote')).toBe(0)
    expect(broker.callCount('getOpenOrders')).toBe(0)

    const fresh = new MockBroker()
    const withQuote = await account(fresh, [{ type: 'quote-freshness', options: { maxAgeSeconds: 60 } }])
    await push(withQuote, 'BUY', '1')
    expect(fresh.callCount('getQuote')).toBe(1)
    expect(fresh.callCount('getOpenOrders')).toBe(0)
  })
})
