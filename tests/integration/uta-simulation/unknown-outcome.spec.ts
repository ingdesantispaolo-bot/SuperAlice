/**
 * Unknown dispatch outcomes — the closure criteria of the "lost
 * acknowledgement" defect: an order the broker accepted but whose answer was
 * lost used to be recorded as `rejected`, and a fresh identical proposal
 * bought a second time. Each scenario drives the real UTA + TradingGit +
 * MockBroker stack; broker subclasses only simulate the failure mode.
 */

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Contract, Order } from '@traderalice/ibkr'
import { UnifiedTradingAccount } from '../../../services/uta/src/domain/trading/UnifiedTradingAccount.js'
import { MockBroker } from '../../../services/uta/src/domain/trading/brokers/mock/index.js'
import { BrokerError, type PlaceOrderResult, type TpSlParams } from '../../../services/uta/src/domain/trading/brokers/types.js'
import { UnresolvedOutcomeError } from '../../../services/uta/src/domain/trading/git/TradingGit.js'
import type { GitExportState } from '../../../services/uta/src/domain/trading/git/types.js'
import { createTradingRoutes } from '../../../services/uta/src/http/routes-trading.js'
import { UTAManager } from '../../../services/uta/src/domain/trading/uta-manager.js'
import { FxService } from '../../../services/uta/src/domain/trading/fx-service.js'
import '../../../services/uta/src/domain/trading/contract-ext.js'

// ==================== Broker failure modes ====================

/** The venue executes the order, then the acknowledgement is lost. */
class LostAckBroker extends MockBroker {
  loseNextAck = true
  override async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    const result = await super.placeOrder(contract, order, tpsl)
    if (this.loseNextAck) {
      this.loseNextAck = false
      throw new Error('socket hang up')
    }
    return result
  }
}

/** Adapter-reported unknown outcome WITH the order id it assigned (IBKR-style
 *  timeout after send). `phantom`: the id never reached the venue. */
class TimeoutAfterSendBroker extends MockBroker {
  constructor(private readonly mode: 'reached-venue' | 'phantom' = 'reached-venue') { super() }
  override async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    if (this.mode === 'phantom') {
      return { success: false, outcomeUnknown: true, orderId: 'phantom-7', error: 'Order 7 timed out after 10000ms' }
    }
    const placed = await super.placeOrder(contract, order, tpsl)
    return { success: false, outcomeUnknown: true, orderId: placed.orderId, error: 'Order timed out after 10000ms' }
  }
}

/** The process dies while the broker call is in flight: it never returns. */
class HangingBroker extends MockBroker {
  override async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    await super.placeOrder(contract, order, tpsl)
    return new Promise(() => {})
  }
}

// ==================== Helpers ====================

const BUY_1_AAPL = { aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY' as const, orderType: 'MKT', totalQuantity: '1' }
const BUY_1_AAPL_LMT = { ...BUY_1_AAPL, orderType: 'LMT', lmtPrice: '99', totalQuantity: '4' }

function memoryPersister() {
  const writes: GitExportState[] = []
  const persist = vi.fn(async (state: GitExportState) => { writes.push(JSON.parse(JSON.stringify(state))) })
  return { persist, writes, last: () => writes.at(-1)! }
}

async function makeAccount(broker: MockBroker, options: ConstructorParameters<typeof UnifiedTradingAccount>[1] = {}) {
  const uta = new UnifiedTradingAccount(broker, options)
  await uta.waitForConnect()
  return uta
}

async function proposeAndPush(uta: UnifiedTradingAccount, params: Parameters<UnifiedTradingAccount['stagePlaceOrder']>[0] = BUY_1_AAPL) {
  uta.stagePlaceOrder(params)
  const { hash } = uta.commit('buy AAPL')
  return uta.push(hash)
}

async function positionQty(broker: MockBroker): Promise<string> {
  const positions = await broker.getPositions()
  return positions.find((p) => p.contract.symbol === 'AAPL')?.quantity.toString() ?? '0'
}

// ==================== Closure criteria ====================

describe('UTA — unknown dispatch outcomes (lost acknowledgement)', () => {
  it('1. a definitive refusal stays a rejection and does not block the account', async () => {
    const broker = new MockBroker()
    vi.spyOn(broker, 'placeOrder').mockRejectedValueOnce(new BrokerError('EXCHANGE', 'Order rejected: insufficient buying power'))
    const uta = await makeAccount(broker)

    const result = await proposeAndPush(uta)

    expect(result.rejected).toHaveLength(1)
    expect(result.unresolved).toHaveLength(0)
    expect(uta.getUnresolved()).toHaveLength(0)
    expect(() => uta.stagePlaceOrder(BUY_1_AAPL)).not.toThrow()
  })

  it('2. accepted order with a lost answer is unknown and blocks a fresh identical proposal', async () => {
    const broker = new LostAckBroker()
    const uta = await makeAccount(broker)

    const result = await proposeAndPush(uta)

    expect(result.rejected).toHaveLength(0)
    expect(result.unresolved).toEqual([expect.objectContaining({ status: 'unknown', error: expect.stringMatching(/socket hang up/) })])
    expect(await positionQty(broker)).toBe('1')
    // The defect: this used to be accepted and bought a second share.
    expect(() => uta.stagePlaceOrder(BUY_1_AAPL)).toThrow(UnresolvedOutcomeError)
    expect(broker.callCount('placeOrder')).toBe(1)
    expect(await positionQty(broker)).toBe('1')
  })

  it('3. crash after dispatch, before the answer: recovered as unknown after restart, nothing re-sent', async () => {
    const broker = new HangingBroker()
    const store = memoryPersister()
    const first = await makeAccount(broker, { onCommit: store.persist })
    first.stagePlaceOrder(BUY_1_AAPL)
    const { hash } = first.commit('buy AAPL')
    void first.push(hash)
    await vi.waitFor(() => expect(broker.callCount('placeOrder')).toBe(1))

    // "Restart": a new account object from what reached the disk.
    const restarted = await makeAccount(broker, { savedState: store.last() })

    expect(restarted.getUnresolved()).toEqual([
      expect.objectContaining({ commitHash: hash, operationIndex: 0, symbol: 'AAPL', action: 'placeOrder' }),
    ])
    expect(() => restarted.stagePlaceOrder(BUY_1_AAPL)).toThrow(UnresolvedOutcomeError)
    expect(broker.callCount('placeOrder')).toBe(1)
  })

  it('4. a healthy connection and a sync pass do not unblock an outcome without evidence', async () => {
    const broker = new LostAckBroker()
    const uta = await makeAccount(broker)
    await proposeAndPush(uta)

    expect(uta.health).toBe('healthy')
    await uta.sync()
    await uta.observeExternalOrders()

    expect(uta.getUnresolved()).toHaveLength(1)
    expect(() => uta.stagePlaceOrder(BUY_1_AAPL)).toThrow(UnresolvedOutcomeError)
  })

  it('5. a fill recovered from the broker by orderId resolves the outcome and is recorded once', async () => {
    const broker = new TimeoutAfterSendBroker('reached-venue')
    const uta = await makeAccount(broker)

    const result = await proposeAndPush(uta)
    expect(result.unresolved[0]).toMatchObject({ status: 'unknown', orderId: 'mock-ord-1' })
    expect(uta.getPendingOrderIds()).toEqual([expect.objectContaining({ orderId: 'mock-ord-1', status: 'unknown' })])

    const synced = await uta.sync()

    expect(synced.updates).toEqual([
      expect.objectContaining({ orderId: 'mock-ord-1', previousStatus: 'unknown', currentStatus: 'filled', filledQty: '1' }),
    ])
    expect(uta.getUnresolved()).toHaveLength(0)
    expect(await uta.tradeHistory()).toHaveLength(1)
    expect(() => uta.stagePlaceOrder(BUY_1_AAPL)).not.toThrow()
  })

  it('6. partial fill then cancel: the executed quantity is kept, distinct from a full rejection', async () => {
    const broker = new TimeoutAfterSendBroker('reached-venue')
    const uta = await makeAccount(broker)
    await proposeAndPush(uta, BUY_1_AAPL_LMT)

    // While still working, the listing alone resolves unknown → submitted.
    const listed = await uta.sync()
    expect(listed.updates).toEqual([expect.objectContaining({ previousStatus: 'unknown', currentStatus: 'submitted' })])
    expect(uta.getUnresolved()).toHaveLength(0)

    broker.fillOrder('mock-ord-1', { qty: 1, price: 98 })
    broker.cancelPendingOrder('mock-ord-1')
    const settled = await uta.sync()

    expect(settled.updates).toEqual([
      expect.objectContaining({ orderId: 'mock-ord-1', previousStatus: 'submitted', currentStatus: 'cancelled', filledQty: '1' }),
    ])
    expect(await positionQty(broker)).toBe('1')
  })

  it('7. an inconclusive broker search keeps the outcome unresolved and writes blocked', async () => {
    const broker = new TimeoutAfterSendBroker('phantom')
    const uta = await makeAccount(broker)
    await proposeAndPush(uta)

    await uta.sync()

    expect(uta.getUnresolved()).toEqual([expect.objectContaining({ orderId: 'phantom-7' })])
    expect(() => uta.stagePlaceOrder(BUY_1_AAPL)).toThrow(UnresolvedOutcomeError)
  })
})

describe('UTA — resolving an unknown outcome', () => {
  it('placed with fill evidence unblocks the account; a deliberate second order is then allowed', async () => {
    const broker = new LostAckBroker()
    const uta = await makeAccount(broker)
    const { hash } = await proposeAndPush(uta)

    await uta.resolveOutcome({
      commitHash: hash, operationIndex: 0, outcome: 'placed', filledQty: '1', filledPrice: '100', note: 'TWS execution report shows 1 AAPL @ 100',
    })

    expect(uta.getUnresolved()).toHaveLength(0)
    const trades = await uta.tradeHistory()
    expect(trades).toEqual([expect.objectContaining({ side: 'BUY', quantity: '1', price: '100' })])
    const history = await uta.orderHistory()
    expect(history).toEqual([expect.objectContaining({ status: 'filled', filledQty: '1' })])

    await proposeAndPush(uta)
    expect(await positionQty(broker)).toBe('2')
  })

  it('survives a restart: resolution and history reload from the persisted state', async () => {
    const broker = new LostAckBroker()
    const store = memoryPersister()
    const uta = await makeAccount(broker, { onCommit: store.persist })
    const { hash } = await proposeAndPush(uta)
    await uta.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'not-placed', note: 'checked: no order, no execution' })

    const restarted = await makeAccount(broker, { savedState: store.last() })

    expect(restarted.getUnresolved()).toHaveLength(0)
    expect(store.last().inflight).toBeUndefined()
  })

  it('HTTP: the resolve-outcome route validates input and clears the block', async () => {
    const broker = new LostAckBroker()
    const uta = await makeAccount(broker)
    const manager = new UTAManager()
    manager.add(uta)
    const app = new Hono()
    app.route('/api/trading', createTradingRoutes({ utaManager: manager, fxService: new FxService() }))
    const post = (path: string, body: unknown) => app.request(`/api/trading/uta/mock-paper/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    const { hash } = await proposeAndPush(uta)
    const status = await (await app.request('/api/trading/uta/mock-paper/wallet/status')).json()
    expect(status.unresolved).toHaveLength(1)

    const blocked = await post('wallet/stage-place-order', BUY_1_AAPL)
    expect(blocked.status).toBe(400)
    expect((await blocked.json()).error).toMatch(/unknown outcome/)

    const invalid = await post('wallet/resolve-outcome', { commitHash: hash, operationIndex: 0, outcome: 'maybe', note: 'x' })
    expect(invalid.status).toBe(400)

    const resolved = await post('wallet/resolve-outcome', {
      commitHash: hash, operationIndex: 0, outcome: 'placed', filledQty: '1', filledPrice: '100', note: 'TWS execution report',
    })
    expect(resolved.status).toBe(200)
    expect((await resolved.json()).unresolved).toEqual([])
    expect((await post('wallet/stage-place-order', BUY_1_AAPL)).status).toBe(200)
    await manager.closeAll()
  })
})
