import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

// Load the installed SDK, bypassing the broker unit tests' SDK mock. These
// checks exercise the msgpack5 major upgrade without connecting to a venue.
const require = createRequire(import.meta.url)
const { AlpacaStocksClient } = require(
  '@alpacahq/alpaca-trade-api/dist/resources/datav2/stock_websocket_v2.js',
)

function stockClient() {
  return new AlpacaStocksClient({
    url: 'https://data.invalid',
    feed: 'iex',
    apcaKeyId: 'fixture-key',
    apcaSecretKey: 'fixture-secret',
  })
}

describe('installed Alpaca SDK MessagePack compatibility', () => {
  it('decodes a binary trade frame into the SDK trade event', () => {
    const client = stockClient()
    const onTrade = vi.fn()
    client.onStockTrade(onTrade)
    // Fixed wire fixture: [{ T: 't', S: 'AAPL', p: 190.5, s: 10, t: ... }].
    const frame = Buffer.from(
      '9185a154a174a153a44141504ca170ca433e8000a1730aa174b4323032362d31302d31325431323a30303a30305a',
      'hex',
    )

    client.handleMessage(client.msgpack.decode(frame))

    expect(onTrade).toHaveBeenCalledExactlyOnceWith({
      T: 't', Symbol: 'AAPL', Price: 190.5, Size: 10,
      Timestamp: '2026-10-12T12:00:00Z',
    })
  })

  it('encodes subscriptions through the installed SDK transport', () => {
    const client = stockClient()
    const send = vi.fn()
    client.conn = { send }

    client.subscribeForTrades(['AAPL'])

    expect(send).toHaveBeenCalledOnce()
    expect(client.msgpack.decode(send.mock.calls[0][0])).toEqual({
      action: 'subscribe', trades: ['AAPL'], quotes: [], bars: [],
      updatedBars: [], dailyBars: [], statuses: [], lulds: [],
    })
  })

  it('preserves input bytes when decoding negative int64 values', () => {
    const client = stockClient()
    const frame = Buffer.from('d3fffffffffffffff6', 'hex')
    const original = Buffer.from(frame)

    expect(client.msgpack.decode(frame)).toBe(-10)
    expect(frame).toEqual(original)
  })
})
