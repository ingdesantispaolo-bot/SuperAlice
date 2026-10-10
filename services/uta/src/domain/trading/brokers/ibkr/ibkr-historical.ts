/**
 * IBKR historical bars — pure request/response mapping for reqHistoricalData.
 *
 * Kept free of socket state so the wire mapping is testable: interval → bar
 * size, window → duration string, end → endDateTime, BarData → Bar.
 */

import type { BarData } from '@traderalice/ibkr'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { Bar, BarInterval, BarParams, BarWhatToShow } from '../types.js'

const BAR_SIZE: Record<BarInterval, string> = {
  '1m': '1 min',
  '5m': '5 mins',
  '15m': '15 mins',
  '30m': '30 mins',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
  '1w': '1 week',
}

export const IBKR_BAR_INTERVALS = Object.keys(BAR_SIZE) as BarInterval[]

const INTERVAL_SECONDS: Record<BarInterval, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14_400, '1d': 86_400, '1w': 604_800,
}

export interface HistoricalRequest {
  endDateTime: string
  durationStr: string
  barSizeSetting: string
  whatToShow: BarWhatToShow
  useRTH: 0 | 1
  /** 2 = epoch seconds for intraday bars; daily/weekly come back as yyyymmdd. */
  formatDate: 2
}

/** `yyyymmdd-HH:mm:ss` in UTC — the explicit-UTC form TWS accepts. */
export function formatIbkrEndDateTime(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}:${p(at.getUTCMinutes())}:${p(at.getUTCSeconds())}`
}

/**
 * IBKR duration string covering [start, end]. Daily and weekly bars use days
 * up to a year, then whole years; intraday uses seconds up to a day, then days.
 * Without `start`, the window comes from `limit` bars (default: 1 year daily,
 * 1 day intraday).
 */
export function ibkrDuration(params: BarParams, end: Date): string {
  const intervalSeconds = INTERVAL_SECONDS[params.interval]
  const daily = intervalSeconds >= 86_400
  const spanSeconds = params.start
    ? Math.max(1, (end.getTime() - params.start.getTime()) / 1000)
    : params.limit
      ? params.limit * intervalSeconds * (daily ? 1.5 : 1) // daily: weekends and holidays
      : daily ? 365 * 86_400 : 86_400
  const days = Math.ceil(spanSeconds / 86_400) + (params.start ? 1 : 0)
  if (daily) return days <= 365 ? `${days} D` : `${Math.ceil(days / 365)} Y`
  return spanSeconds <= 86_400 ? `${Math.ceil(spanSeconds)} S` : `${days} D`
}

export function buildHistoricalRequest(params: BarParams, now: Date): HistoricalRequest {
  const barSizeSetting = BAR_SIZE[params.interval]
  if (!barSizeSetting) throw new Error(`Unsupported IBKR bar interval: ${String(params.interval)}`)
  const whatToShow = params.whatToShow ?? 'TRADES'
  // ADJUSTED_LAST only works with an empty endDateTime (TWS rule): the window
  // then runs to now, and start/end filtering happens on the result.
  const adjusted = whatToShow === 'ADJUSTED_LAST'
  const end = adjusted || !params.end ? now : params.end
  return {
    endDateTime: adjusted || !params.end ? '' : formatIbkrEndDateTime(params.end),
    durationStr: ibkrDuration(params, end),
    barSizeSetting,
    whatToShow,
    useRTH: 1,
    formatDate: 2,
  }
}

/** Bar time from IBKR's date field: yyyymmdd (daily/weekly, UTC midnight) or epoch seconds. */
export function parseIbkrBarTime(date: string): Date {
  const trimmed = date.trim()
  if (/^\d{8}$/.test(trimmed)) {
    return new Date(Date.UTC(Number(trimmed.slice(0, 4)), Number(trimmed.slice(4, 6)) - 1, Number(trimmed.slice(6, 8))))
  }
  if (/^\d{9,11}$/.test(trimmed)) return new Date(Number(trimmed) * 1000)
  const legacy = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(trimmed)
  if (legacy) {
    return new Date(Date.UTC(+legacy[1], +legacy[2] - 1, +legacy[3], +legacy[4], +legacy[5], +legacy[6]))
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) throw new Error(`Unparseable IBKR bar date: ${JSON.stringify(date)}`)
  return new Date(parsed)
}

function price(value: number): string {
  // Wire doubles carry binary noise; 8 dp keeps sub-cent ETF/FX prices exact.
  return String(Number(value.toFixed(8)))
}

export function toBars(raw: BarData[], params: BarParams): Bar[] {
  let bars = raw.map((b) => ({
    timestamp: parseIbkrBarTime(b.date),
    open: price(b.open),
    high: price(b.high),
    low: price(b.low),
    close: price(b.close),
    volume: b.volume && !b.volume.equals(UNSET_DECIMAL) ? b.volume.toFixed() : '0',
  }))
  if (params.start) bars = bars.filter((b) => b.timestamp >= params.start!)
  if (params.end) bars = bars.filter((b) => b.timestamp <= params.end!)
  if (params.limit && bars.length > params.limit) bars = bars.slice(-params.limit)
  return bars
}
