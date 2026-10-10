import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import { BarData, Contract } from '@traderalice/ibkr'
import { buildHistoricalRequest, formatIbkrEndDateTime, ibkrDuration, parseIbkrBarTime, toBars } from './ibkr-historical.js'
import { IbkrBroker } from './IbkrBroker.js'

const NOW = new Date('2026-10-10T10:00:00Z')

function bar(date: string, close: number, volume = '1000'): BarData {
  return Object.assign(new BarData(), { date, open: close - 1, high: close + 1, low: close - 2, close, volume: new Decimal(volume) })
}

describe('IBKR historical mapping', () => {
  it('maps a multi-year daily window to years and a short one to days', () => {
    expect(ibkrDuration({ interval: '1d', start: new Date('2019-01-02T00:00:00Z') }, NOW)).toBe('8 Y')
    expect(ibkrDuration({ interval: '1d', start: new Date('2026-09-01T00:00:00Z') }, NOW)).toBe('41 D')
    expect(ibkrDuration({ interval: '5m', start: new Date('2026-10-10T08:00:00Z') }, NOW)).toBe('7200 S')
    expect(ibkrDuration({ interval: '1d', limit: 20 }, NOW)).toBe('30 D')
  })

  it('uses explicit-UTC end times, except ADJUSTED_LAST which must end now', () => {
    expect(formatIbkrEndDateTime(new Date('2026-10-09T21:00:00Z'))).toBe('20261009-21:00:00')
    const raw = buildHistoricalRequest({ interval: '1d', start: new Date('2026-01-02'), end: new Date('2026-10-09T21:00:00Z') }, NOW)
    expect(raw).toMatchObject({ endDateTime: '20261009-21:00:00', barSizeSetting: '1 day', whatToShow: 'TRADES', useRTH: 1 })
    const adjusted = buildHistoricalRequest({ interval: '1d', start: new Date('2026-01-02'), end: new Date('2026-10-09T21:00:00Z'), whatToShow: 'ADJUSTED_LAST' }, NOW)
    expect(adjusted.endDateTime).toBe('')
  })

  it('parses daily and epoch bar dates', () => {
    expect(parseIbkrBarTime('20261009').toISOString()).toBe('2026-10-09T00:00:00.000Z')
    expect(parseIbkrBarTime('1791583200').toISOString()).toBe('2026-10-09T22:00:00.000Z')
    expect(() => parseIbkrBarTime('not a date')).toThrow(/Unparseable/)
  })

  it('converts, filters to the window and trims to the limit', () => {
    const raw = [bar('20261006', 100.123456789), bar('20261007', 101), bar('20261008', 102), bar('20261009', 103)]
    const bars = toBars(raw, { interval: '1d', start: new Date('2026-10-07T00:00:00Z'), limit: 2 })
    expect(bars.map((b) => [b.timestamp.toISOString().slice(0, 10), b.close])).toEqual([['2026-10-08', '102'], ['2026-10-09', '103']])
    expect(toBars([bar('20261006', 100.123456789)], { interval: '1d' })[0].close).toBe('100.12345679')
  })
})

describe('IbkrBroker.getHistorical', () => {
  it('sends reqHistoricalData for the routed contract and returns bars', async () => {
    const broker = new IbkrBroker({ id: 'ibkr-test', host: '127.0.0.1', port: 7497, clientId: 91 })
    const routed = Object.assign(new Contract(), { conId: 15547851, symbol: 'SHY', secType: 'STK' as const, exchange: 'SMART', currency: 'USD' })
    const client = { reqContractDetails: vi.fn(), reqHistoricalData: vi.fn() }
    ;(broker as unknown as { bridge: unknown }).bridge = {
      connectionDead: false,
      allocReqId: vi.fn(() => 31),
      // 1st collector: contract details (routing); 2nd: the historical bars.
      requestCollector: vi.fn()
        .mockResolvedValueOnce([{ contract: routed }])
        .mockResolvedValueOnce([bar('20261008', 82.5), bar('20261009', 82.6)]),
    }
    ;(broker as unknown as { client: unknown }).client = client

    const bars = await broker.getHistorical(routed, { interval: '1d', start: new Date('2026-10-08T00:00:00Z') })

    expect(client.reqHistoricalData).toHaveBeenCalledOnce()
    const [, contract, , duration, size, whatToShow, useRTH] = client.reqHistoricalData.mock.calls[0]
    expect([contract.conId, duration, size, whatToShow, useRTH]).toEqual([15547851, expect.stringMatching(/ D$/), '1 day', 'TRADES', 1])
    expect(bars.map((b) => b.close)).toEqual(['82.5', '82.6'])
    expect(broker.getCapabilities().historicalBars?.supported).toBe(true)
  })
})
