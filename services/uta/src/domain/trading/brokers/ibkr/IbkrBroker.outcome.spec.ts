import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { IbkrBroker } from './IbkrBroker.js'
import { BrokerError } from '../types.js'
import { classifyIbkrError } from './ibkr-contracts.js'

/**
 * Write outcomes after the request reached TWS. Before send, a failure is a
 * definitive refusal; after send, only IBKR's own refusal is — a timeout or a
 * dropped connection leaves the order possibly live (`outcomeUnknown`), and
 * the assigned orderId must survive so sync can look it up.
 */

function brokerWithTws() {
  const broker = new IbkrBroker({ id: 'ibkr-test', host: '127.0.0.1', port: 7497, clientId: 91 })
  const resolved = Object.assign(new Contract(), {
    conId: 265598, symbol: 'AAPL', localSymbol: 'AAPL', secType: 'STK' as const, exchange: 'SMART', primaryExchange: 'NASDAQ', currency: 'USD',
  })
  const bridge = {
    connectionDead: false,
    allocReqId: vi.fn(() => 17),
    requestCollector: vi.fn(async () => [{ contract: Object.assign(new Contract(), resolved) }]),
    requestSnapshot: vi.fn(async () => ({ last: 100, bid: 99.9, ask: 100.1, volume: 1 })),
    requestCurrentTime: vi.fn(async () => 1_784_289_600),
    getNextOrderId: vi.fn(() => 42),
    requestOrder: vi.fn(async () => ({ orderState: { status: 'Submitted' } })),
    markDead: vi.fn(),
  }
  const client = { reqContractDetails: vi.fn(), reqMktData: vi.fn(), placeOrder: vi.fn(), cancelOrder: vi.fn() }
  ;(broker as unknown as { bridge: unknown }).bridge = bridge
  ;(broker as unknown as { client: unknown }).client = client
  return { broker, bridge, client }
}

function aaplLimitBuy(): { contract: Contract; order: Order } {
  const contract = Object.assign(new Contract(), { conId: 265598, symbol: 'AAPL', secType: 'STK' as const, exchange: 'SMART', currency: 'USD' })
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(1)
  order.lmtPrice = new Decimal(100)
  return { contract, order }
}

describe('IbkrBroker — write outcome after send', () => {
  it('an acknowledgement timeout after send is an unknown outcome that keeps the orderId', async () => {
    const { broker, bridge, client } = brokerWithTws()
    bridge.requestOrder.mockRejectedValueOnce(new BrokerError('NETWORK', 'Order 42 timed out after 10000ms'))
    const { contract, order } = aaplLimitBuy()

    const result = await broker.placeOrder(contract, order)

    expect(client.placeOrder).toHaveBeenCalledOnce()
    expect(result).toEqual({ success: false, outcomeUnknown: true, orderId: '42', error: 'Order 42 timed out after 10000ms' })
  })

  it("IBKR's own refusal for the sent order stays definitive", async () => {
    const { broker, bridge } = brokerWithTws()
    bridge.requestOrder.mockRejectedValueOnce(new BrokerError('EXCHANGE', 'IBKR error 201: Order rejected - reason: insufficient funds'))
    const { contract, order } = aaplLimitBuy()

    const result = await broker.placeOrder(contract, order)

    expect(result.success).toBe(false)
    expect(result.outcomeUnknown).toBeUndefined()
    expect(result.orderId).toBe('42')
  })

  it('a request-validation refusal (e.g. Read-Only API, code 321) is definitive, not unknown', async () => {
    const { broker, bridge } = brokerWithTws()
    bridge.requestOrder.mockRejectedValueOnce(classifyIbkrError(321, "Error validating request.-'bN' : cause - The API interface is currently in Read-Only mode."))
    const { contract, order } = aaplLimitBuy()

    const result = await broker.placeOrder(contract, order)

    expect(result.success).toBe(false)
    expect(result.outcomeUnknown).toBeUndefined()
  })

  it('a failure before anything is sent is definitive', async () => {
    const { broker, bridge, client } = brokerWithTws()
    bridge.requestCollector.mockRejectedValueOnce(new BrokerError('NETWORK', 'contract details timed out'))
    const { contract, order } = aaplLimitBuy()

    const result = await broker.placeOrder(contract, order)

    expect(client.placeOrder).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, error: 'contract details timed out' })
  })

  it('a synchronous send failure is unknown and leaves no unhandled rejection behind', async () => {
    const { broker, bridge, client } = brokerWithTws()
    bridge.requestOrder.mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(new BrokerError('NETWORK', 'Order 42 timed out')), 5)
    }))
    client.placeOrder.mockImplementationOnce(() => { throw new Error('write EPIPE') })
    const { contract, order } = aaplLimitBuy()

    const result = await broker.placeOrder(contract, order)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(result).toMatchObject({ success: false, outcomeUnknown: true, orderId: '42', error: 'write EPIPE' })
  })

  it('a cancel whose confirmation times out is unknown, not a failed cancel', async () => {
    const { broker, bridge, client } = brokerWithTws()
    bridge.requestOrder.mockRejectedValueOnce(new BrokerError('NETWORK', 'Order 42 timed out after 10000ms'))

    const result = await broker.cancelOrder('42')

    expect(client.cancelOrder).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ success: false, outcomeUnknown: true, orderId: '42' })
  })
})
