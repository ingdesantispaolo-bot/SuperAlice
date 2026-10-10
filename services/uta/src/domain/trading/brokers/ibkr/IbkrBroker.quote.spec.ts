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
