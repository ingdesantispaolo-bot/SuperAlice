import { describe, it, expect, vi } from 'vitest'
import { Contract } from '@traderalice/ibkr'
import { IbkrBroker } from './IbkrBroker.js'
import type { TickSnapshot } from './ibkr-types.js'

/** Quote feed type: a delayed quote must say so, or freshness checks pass it as current. */
function brokerWithSnapshot(snap: TickSnapshot) {
  const broker = new IbkrBroker({ id: 'ibkr-test', host: '127.0.0.1', port: 7497, clientId: 91 })
  const resolved = Object.assign(new Contract(), { conId: 756733, symbol: 'SPY', secType: 'STK' as const, exchange: 'SMART', currency: 'USD' })
  ;(broker as unknown as { bridge: unknown }).bridge = {
    connectionDead: false,
    allocReqId: vi.fn(() => 21),
    requestCollector: vi.fn(async () => [{ contract: Object.assign(new Contract(), resolved) }]),
    requestSnapshot: vi.fn(async () => snap),
  }
  ;(broker as unknown as { client: unknown }).client = { reqContractDetails: vi.fn(), reqMktData: vi.fn() }
  return broker
}

const spy = () => Object.assign(new Contract(), { conId: 756733, symbol: 'SPY', secType: 'STK' as const, exchange: 'SMART', currency: 'USD' })

describe('IbkrBroker — quote feed type', () => {
  it('marks a quote built from delayed ticks as delayed and keeps its delayed timestamp', async () => {
    const quote = await brokerWithSnapshot({ bid: 500, ask: 500.1, last: 500.05, delayed: true, lastTimestamp: 1_790_000_000 }).getQuote(spy())
    expect(quote.dataType).toBe('delayed')
    expect(quote.timestamp.getTime()).toBe(1_790_000_000_000)
  })

  it('reports live and frozen from the marketDataType callback', async () => {
    expect((await brokerWithSnapshot({ bid: 1, ask: 1.01, marketDataType: 1 }).getQuote(spy())).dataType).toBe('live')
    expect((await brokerWithSnapshot({ bid: 1, ask: 1.01, marketDataType: 2 }).getQuote(spy())).dataType).toBe('frozen')
    expect((await brokerWithSnapshot({ bid: 1, ask: 1.01, marketDataType: 4 }).getQuote(spy())).dataType).toBe('delayed')
  })

  it('leaves the feed type unknown when TWS did not report it', async () => {
    expect((await brokerWithSnapshot({ bid: 1, ask: 1.01 }).getQuote(spy())).dataType).toBeUndefined()
  })
})

describe('IbkrBroker — init waits for managedAccounts', () => {
  function brokerForInit(accountAfterMs: number | null) {
    const broker = new IbkrBroker({ id: 'ibkr-test', host: '127.0.0.1', port: 7497, clientId: 91 })
    const startedAt = Date.now()
    const bridge = {
      connectionDead: false,
      waitForConnect: vi.fn(async () => {}),
      getAccountId: vi.fn(() => (accountAfterMs !== null && Date.now() - startedAt >= accountAfterMs ? 'DU1234567' : null)),
      startAccountSubscription: vi.fn(),
      waitForAccountReady: vi.fn(async () => {}),
      markAlive: vi.fn(),
    }
    ;(broker as unknown as { bridge: unknown }).bridge = bridge
    ;(broker as unknown as { client: unknown }).client = { isConnected: () => false, reqMarketDataType: vi.fn(), disconnect: vi.fn() }
    ;(broker as unknown as { startHeartbeat: unknown }).startHeartbeat = vi.fn()
    return { broker, bridge }
  }

  it('accepts an account list that arrives just after the handshake', async () => {
    const { broker, bridge } = brokerForInit(150)
    await broker.init()
    expect(bridge.startAccountSubscription).toHaveBeenCalledWith('DU1234567')
  })

  it('still fails when no account arrives within the wait', async () => {
    const previous = IbkrBroker.ACCOUNT_WAIT_MS
    IbkrBroker.ACCOUNT_WAIT_MS = 200
    try {
      const { broker } = brokerForInit(null)
      await expect(broker.init()).rejects.toThrow(/No account detected/)
    } finally {
      IbkrBroker.ACCOUNT_WAIT_MS = previous
    }
  })
})
