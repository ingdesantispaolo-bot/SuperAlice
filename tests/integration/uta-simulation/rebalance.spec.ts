/**
 * Target portfolio → plan → stage → push on the real UTA stack with the
 * in-memory MockBroker. Uses the shared 40/40/20 fixture shape from the
 * SuperAI evaluation (TESTA at 100, TESTB at 50, 10,000 cash).
 */

import { describe, it, expect } from 'vitest'
import { UnifiedTradingAccount } from '../../../services/uta/src/domain/trading/UnifiedTradingAccount.js'
import { MockBroker } from '../../../services/uta/src/domain/trading/brokers/mock/index.js'
import type { TargetPortfolio } from '../../../services/uta/src/domain/trading/rebalance.js'
import '../../../services/uta/src/domain/trading/contract-ext.js'

function equalWeight(validMs = 3_600_000): TargetPortfolio {
  const now = Date.now()
  return {
    strategy: 'equal-weight',
    strategyVersion: '1',
    decisionAt: new Date(now - 1000).toISOString(),
    validUntil: new Date(now + validMs).toISOString(),
    source: 'fixture:equal-weight-160-v1',
    weights: [
      { aliceId: 'mock-paper|TESTA', weight: '0.4' },
      { aliceId: 'mock-paper|TESTB', weight: '0.4' },
    ],
    cashWeight: '0.2',
  }
}

async function account(): Promise<{ uta: UnifiedTradingAccount; broker: MockBroker }> {
  const broker = new MockBroker({ cash: 10_000 })
  broker.setQuote('TESTA', 100)
  broker.setQuote('TESTB', 50)
  const uta = new UnifiedTradingAccount(broker)
  await uta.waitForConnect()
  return { uta, broker }
}

describe('UTA — target portfolio rebalance', () => {
  it('plans, stages and pushes the target; planning it again yields no orders', async () => {
    const { uta, broker } = await account()

    const staged = await uta.stageRebalance(equalWeight())
    expect(staged.plan.orders.map((o) => [o.aliceId, o.action, o.quantity])).toEqual([
      ['mock-paper|TESTA', 'BUY', '39'],
      ['mock-paper|TESTB', 'BUY', '79'],
    ])
    expect(staged.suggestedMessage).toMatch(/^rebalance equal-weight@1 → tp-[0-9a-f]{16} \(source fixture:equal-weight-160-v1\)$/)

    const { hash } = uta.commit(staged.suggestedMessage)
    const pushed = await uta.push(hash)
    expect(pushed.submitted).toHaveLength(2)
    expect(broker.callCount('placeOrder')).toBe(2)

    const again = await uta.planRebalance(equalWeight())
    expect(again.orders).toEqual([])
  })

  it('refuses to mix a rebalance into other staged work', async () => {
    const { uta } = await account()
    uta.stagePlaceOrder({ aliceId: 'mock-paper|TESTA', symbol: 'TESTA', action: 'BUY', orderType: 'MKT', totalQuantity: '1' })

    await expect(uta.stageRebalance(equalWeight())).rejects.toThrow(/Staging area is not empty/)
    expect(uta.status().staged).toHaveLength(1)
  })

  it('refuses an expired target before reading or staging anything', async () => {
    const { uta } = await account()
    await expect(uta.stageRebalance(equalWeight(-1000))).rejects.toThrow(/expired/)
    expect(uta.status().staged).toHaveLength(0)
  })
})
