import { describe, expect, it, vi } from 'vitest'
import { Contract } from '@traderalice/ibkr'
import { IbkrBroker } from './IbkrBroker.js'

describe('IBKR physical snapshot line limit', () => {
  it('caps mixed ordinary/early option snapshots across two clients of the same TWS and cancels before releasing', async () => {
    let nextId = 0, active = 0, peak = 0, sent = 0, cancelled = 0
    const pending = new Map<number, (snap: { bid: number; ask: number; last: number }) => void>()
    function broker(id: string) {
      const broker = new IbkrBroker({ id, host: '127.0.0.1', port: 9127, clientId: id === 'a' ? 31 : 32 })
      Object.assign(broker, {
        resolveRoutableContract: async (contract: Contract) => contract,
        bridge: { connectionDead: false, allocReqId: () => ++nextId,
          requestSnapshot: (reqId: number) => new Promise(resolve => pending.set(reqId, resolve)), markDead: vi.fn() },
        client: { reqMktData: () => { sent++; active++; peak = Math.max(peak, active) },
          cancelMktData: () => { cancelled++; active-- } },
      })
      return broker
    }
    const a = broker('a'), b = broker('b'), contract = new Contract()
    const jobs = Array.from({ length: 24 }, (_, index) => {
      const owner = index % 2 ? a : b
      return index % 3 ? owner.getQuote(contract)
        : (owner as unknown as { requestSnapshot(c: Contract, opts: { resolveOnBidAsk: boolean }): Promise<unknown> })
          .requestSnapshot(contract, { resolveOnBidAsk: true })
    })
    await vi.waitFor(() => expect(sent).toBe(10))
    expect(active).toBe(10)
    for (let index = 0; index < 24; index++) {
      await vi.waitFor(() => expect(pending.size).toBeGreaterThan(0))
      const [reqId, complete] = pending.entries().next().value!
      pending.delete(reqId); complete({ bid: 1, ask: 2, last: 1.5 })
    }
    await Promise.all(jobs)
    expect({ sent, cancelled, active, peak }).toEqual({ sent: 24, cancelled: 24, active: 0, peak: 10 })
  })
  it('releases a failed request and cancels its line before the next read', async () => {
    const broker = new IbkrBroker({ id: 'failure', host: 'localhost', port: 9128, clientId: 41 })
    const requestSnapshot = vi.fn().mockRejectedValueOnce(new Error('subscription unavailable')).mockResolvedValue({ bid: 1, ask: 2, last: 1.5 })
    const cancelMktData = vi.fn()
    Object.assign(broker, { resolveRoutableContract: async (c: Contract) => c,
      bridge: { connectionDead: false, allocReqId: () => 1, requestSnapshot, markDead: vi.fn() },
      client: { reqMktData: vi.fn(), cancelMktData } })
    await expect(broker.getQuote(new Contract())).rejects.toThrow('subscription unavailable')
    expect(cancelMktData).toHaveBeenCalledOnce()
    await expect(broker.getQuote(new Contract())).resolves.toMatchObject({ bid: '1', ask: '2' })
    expect(cancelMktData).toHaveBeenCalledTimes(2)
  })
})
