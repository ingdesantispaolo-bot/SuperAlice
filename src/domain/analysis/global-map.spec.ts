import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyRelative, catalogEntries, computeSeries, computeValuation, extractValuation, deriveSeries, eurFactor, measureCatalog, parseSeries, renderTables,
  rsiWilder, shiftDate, valueAt, type MapEntry, type Point,
} from '../../../default/skills/alice-analysis/scripts/global-map-lib.mjs'

/** Weekday series from start, one point per business day, value from f(i). */
function weekdays(start: string, count: number, f: (i: number) => number): Point[] {
  const out: Point[] = []
  for (let d = Date.parse(`${start}T00:00:00Z`), i = 0; out.length < count; d += 86_400_000) {
    const day = new Date(d).getUTCDay()
    if (day === 0 || day === 6) continue
    out.push({ date: new Date(d).toISOString().slice(0, 10), value: f(i++) })
  }
  return out
}

describe('global map dates', () => {
  it('clamps month shifts to the end of the target month', () => {
    expect(shiftDate('2026-03-31', { months: -1 })).toBe('2026-02-28')
    expect(shiftDate('2024-03-31', { months: -1 })).toBe('2024-02-29')
    expect(shiftDate('2026-01-15', { months: -12 })).toBe('2025-01-15')
    expect(shiftDate('2026-10-13', { days: -7 })).toBe('2026-10-06')
  })

  it('tolerates a missing session but not a long gap', () => {
    const pts = [{ date: '2026-10-09', value: 1 }, { date: '2026-10-12', value: 2 }]
    expect(valueAt(pts, '2026-10-13')?.value).toBe(2)
    expect(valueAt(pts, '2026-10-30')).toBeNull()
  })
})

describe('global map source parsing', () => {
  it('reads Yahoo adjusted closes and keeps the latest duplicate', () => {
    const text = JSON.stringify({ bars: [
      { date: '2026-10-12', close: 10, adj_close: 9.5 },
      { date: '2026-10-12', close: 11, adj_close: 10.5 },
      { date: '2026-10-09', close: 8, adj_close: null },
    ] })
    expect(parseSeries('yahoo', [text], 'X')).toEqual([
      { date: '2026-10-09', value: 8, close: 8 },
      { date: '2026-10-12', value: 10.5, close: 11 },
    ])
  })

  it('skips missing FRED and Bundesbank values', () => {
    expect(parseSeries('fred', [JSON.stringify([{ date: '2026-10-08', DGS10: 5.2 }, { date: '2026-10-09', DGS10: null }])], 'DGS10'))
      .toEqual([{ date: '2026-10-08', value: 5.2 }])
    const csv = '﻿"",KEY\nunit,PROZENT\n2026-10-10,.,No value available\n2026-10-13,3.46,\n'
    expect(parseSeries('bundesbank', [csv], 'KEY')).toEqual([{ date: '2026-10-13', value: 3.46 }])
  })

  it('reads the JGB column by header and lets the current-month file win', () => {
    const history = 'Interest Rate,,(Unit : %)\nDate,1Y,10Y\n1974/9/24,10.3,-\n2026/10/1,1.6,3.09\n'
    const current = 'Date,1Y,10Y\n2026/10/1,1.6,3.10\n2026/10/2,1.6,3.11\n'
    expect(parseSeries('mof-jgb', [history, current], '10Y')).toEqual([
      { date: '2026-10-01', value: 3.1 }, { date: '2026-10-02', value: 3.11 },
    ])
  })

  it('reads only settled monitor sessions from a verified MCP envelope', () => {
    const canonical = JSON.stringify({ bars: [
      { session: '2026-10-12', close: 111.1, finality: 'final' },
      { session: '2026-10-13', close: 111.2, finality: 'partial' },
    ] })
    const envelope = (hash: string) => JSON.stringify({ content: [{ type: 'text', text: canonical }], _meta: { 'ibivmonitor/sha256': hash } })
    expect(parseSeries('monitor', [envelope(createHash('sha256').update(canonical).digest('hex'))], 'FUT:BTP'))
      .toEqual([{ date: '2026-10-12', value: 111.1 }])
    expect(() => parseSeries('monitor', [envelope('0'.repeat(64))], 'FUT:BTP')).toThrow('hash mismatch')
  })

  it('reads STOXX day.month.year rows and TraderHub valuation cards', () => {
    expect(parseSeries('stoxx', ['Date;Symbol;Indexvalue\n13.10.2026;V2TX;18.6678\n13.10.2026;OTHER;1\n'], 'V2TX'))
      .toEqual([{ date: '2026-10-13', value: 18.6678 }])
    const board = JSON.stringify({ cards: [{ id: 'pe_month', points: [{ date: '2026-10-13', value: 26.64 }] }] })
    expect(parseSeries('traderhub-valuation', [board], 'pe_month')).toEqual([{ date: '2026-10-13', value: 26.64 }])
    expect(() => parseSeries('unknown', ['x'], 'X')).toThrow('Unknown source')
  })
})

describe('global map measures', () => {
  it('computes RSI at the extremes', () => {
    expect(rsiWilder(Array.from({ length: 30 }, (_, i) => i))).toBe(100)
    const flat = rsiWilder(Array.from({ length: 200 }, (_, i) => (i % 2 ? 101 : 100)))
    expect(flat).toBeGreaterThan(45)
    expect(flat).toBeLessThan(55)
  })

  it('converts currencies to EUR through EUR/USD and USD crosses', () => {
    const fx = { EURUSD: [{ date: '2026-10-12', value: 1.25 }], USDJPY: [{ date: '2026-10-12', value: 160 }] }
    expect(eurFactor('EUR', fx, '2026-10-13')).toBe(1)
    expect(eurFactor('USD', fx, '2026-10-13')).toBeCloseTo(0.8)
    expect(eurFactor('JPY', fx, '2026-10-13')).toBeCloseTo(1 / 200)
    expect(eurFactor('INR', fx, '2026-10-13')).toBeNull()
  })

  it('reports a flat USD asset as a loss in EUR when the euro strengthens', () => {
    const asset = weekdays('2025-01-01', 300, () => 100)
    const eurusd = weekdays('2025-01-01', 300, i => 1 + 0.25 * (i / 299))
    const r = computeSeries({ kind: 'price', currency: 'USD', frequency: 'daily', source: 'yahoo' }, asset,
      { asOf: asset.at(-1)!.date, fx: { EURUSD: eurusd } })
    expect(r.status).toBe('ok')
    expect(r.measures.ret_12m_pct).toBe(0)
    expect(r.measures.ret_12m_pct_eur!).toBeLessThan(-15)
  })

  it('classifies a steady uptrend and respects the cutoff', () => {
    const pts = weekdays('2025-01-01', 320, i => 100 + i)
    const asOf = pts[299].date
    const r = computeSeries({ kind: 'price', currency: 'EUR', frequency: 'daily', source: 'yahoo' }, pts, { asOf })
    expect(r.lastDate).toBe(asOf)
    expect(r.excludedAfterCutoff).toBe(20)
    expect(r.measures).toMatchObject({ last: 399, trend_short: 1, trend_medium: 1, trend_long: 1, rsi14: 100 })
    expect(r.measures.ret_1m_pct_eur).toBe(r.measures.ret_1m_pct)
  })

  it('drops the still-forming day of a 24/7 market and flags stale or missing data', () => {
    const pts = weekdays('2026-09-01', 30, i => 100 + i)
    const today = pts.at(-1)!.date
    const live = computeSeries({ kind: 'price', calendar: '7d', frequency: 'daily', source: 'yahoo' }, pts, { asOf: today, incompleteFrom: today })
    expect(live.lastDate).toBe(pts.at(-2)!.date)
    expect(computeSeries({ kind: 'price', frequency: 'daily', source: 'yahoo' }, pts, { asOf: '2026-12-31' }).status).toBe('stale')
    expect(computeSeries({ kind: 'price', frequency: 'daily', source: 'yahoo' }, pts, { asOf: '2026-01-01' }).status).toBe('missing')
  })

  it('reports spreads in basis points and yield changes in basis points', () => {
    const spread = weekdays('2026-01-01', 200, i => 3 + i * 0.001)
    const s = computeSeries({ kind: 'spread', frequency: 'daily', source: 'fred' }, spread, { asOf: spread.at(-1)!.date })
    expect(s.measures.last).toBeCloseTo(319.9)
    const y = weekdays('2026-01-01', 200, i => (i < 199 ? 4 : 4.1))
    const r = computeSeries({ kind: 'yield', frequency: 'daily', source: 'fred' }, y, { asOf: y.at(-1)!.date })
    expect(r.measures.last).toBe(4.1)
    expect(r.measures.chg_1w).toBeCloseTo(10)
  })

  it('handles monthly series without moving averages', () => {
    const months = Array.from({ length: 24 }, (_, i) => ({ date: shiftDate('2024-09-01', { months: i }), value: 3 + i * 0.01 }))
    const r = computeSeries({ kind: 'yield', frequency: 'monthly', source: 'fred' }, months, { asOf: '2026-10-13' })
    expect(r.status).toBe('ok')
    expect(r.measures.dist_sma200).toBeUndefined()
    expect(r.measures.trend_short).toBeNull()
    expect(r.measures.trend_long).toBe(1)
  })

  it('derives spreads in basis points and matches monthly series by month', () => {
    const a = [{ date: '2026-08-01', value: 3.99 }], b = [{ date: '2026-08-15', value: 3.18 }]
    expect(deriveSeries('diff', a, b, true)[0].value).toBeCloseTo(81)
    expect(deriveSeries('ratio', [{ date: '2026-10-13', value: 10 }], [{ date: '2026-10-13', value: 4 }])).toEqual([{ date: '2026-10-13', value: 2.5 }])
  })
})

describe('global map valuations', () => {
  it('extracts iShares and SPDR fund fundamentals with their dates', () => {
    const ishares = '{&quot;priceEarnings&quot;:{&quot;visible&quot;:true,&quot;label&quot;:&quot;P/E Ratio&quot;,&quot;formattedValue&quot;:&quot;19.50&quot;,&quot;sortOrder&quot;:35,&quot;infoBubble&quot;:&quot;text&quot;,&quot;formattedAsOfDate&quot;:&quot;Oct 09, 2026&quot;,&quot;name&quot;:&quot;priceEarnings&quot;},'
      + '&quot;priceBook&quot;:{&quot;visible&quot;:true,&quot;label&quot;:&quot;P/B Ratio&quot;,&quot;formattedValue&quot;:&quot;2.71&quot;,&quot;sortOrder&quot;:36,&quot;formattedAsOfDate&quot;:&quot;Oct 09, 2026&quot;,&quot;name&quot;:&quot;priceBook&quot;}}'
    const i = extractValuation('ishares', ishares)
    expect(i).toMatchObject({ asOf: '2026-10-09', values: { pe_trailing: 19.5, pb: 2.71 } })
    expect(i.fragments.priceEarnings).not.toContain('infoBubble')
    const ssga = '<span>as of Oct 13 2026</span><td>&#xfeff;Price/Earnings Ratio FY1</td><td>The weighted harmonic average</td><td> 24.58 </td>'
      + '<td>&#xfeff;Price/Book Ratio</td><td>description</td><td>12.20</td>'
    expect(extractValuation('ssga', ssga)).toMatchObject({ asOf: '2026-10-13', values: { pe_fy1: 24.58, pb: 12.2 } })
    expect(extractValuation('ishares', '<html>no data</html>').values).toEqual({})
  })

  it('keeps the first provider per measure and flags old issuer data', () => {
    const v = computeValuation([
      { seriesId: 's.ivv', fund: 'IVV', asOf: '2026-10-09', values: { pe_trailing: 29.6, pb: 5.7 } },
      { seriesId: 's.spy', fund: 'SPY', asOf: '2026-10-13', values: { pe_fy1: 20.8, pb: 5.9 } },
    ], '2026-10-13')
    expect(v.measures).toEqual({ val_pe_trailing: 29.6, val_pb: 5.7, val_pe_fy1: 20.8 })
    expect(v.sources.find(s => s.measureKey === 'val_pe_fy1')?.seriesId).toBe('s.spy')
    expect(v).toMatchObject({ status: 'ok', asOf: '2026-10-09', staleDays: 4 })
    expect(computeValuation([{ seriesId: 's', fund: 'X', asOf: '2026-09-01', values: { pb: 1 } }], '2026-10-13').status).toBe('stale')
    expect(computeValuation([], '2026-10-13').status).toBe('missing')
  })
})

describe('global map memory catalog', () => {
  it('lists every economic asset before its series, with economic classes and stable derived ids', () => {
    const universe = JSON.parse(readFileSync(new URL('../../../default/skills/alice-analysis/references/global-map-universe.json', import.meta.url), 'utf8'))
    const entries = catalogEntries(universe) as Array<Record<string, unknown>>
    const firstSeries = entries.findIndex(e => e.role !== 'asset')
    expect(entries.slice(firstSeries).every(e => e.role !== 'asset')).toBe(true)
    expect(entries.filter(e => e.role === 'asset')).toHaveLength(65)
    expect(entries.filter(e => String(e.entityId).startsWith('series.valuation.eq') || String(e.entityId).startsWith('series.valuation.s'))).toHaveLength(23)
    expect(entries.filter(e => e.role === 'asset').every(e => !('source' in e) && !('method' in e))).toBe(true)
    const byId = new Map(entries.map(e => [e.entityId, e]))
    expect(byId.get('series.vol.vix.yahoo')).toMatchObject({ assetClass: 'volatility', assetId: 'asset.vol.vix' })
    expect(byId.get('series.rates.de.10y.bundesbank')).toMatchObject({ yieldType: 'par', unit: '%', currency: 'EUR' })
    expect(byId.get('series.rates.it.10y.fred-monthly')).toMatchObject({ yieldType: 'unknown' })
    expect(byId.get('series.derived.ratio.btp-bund-futures')).toMatchObject({ role: 'proxy', unit: 'ratio', assetId: 'derived.ratio.btp-bund-futures' })
    for (const e of entries.filter(x => x.role !== 'asset')) expect(byId.get(e.assetId as string)?.assetClass).toBe(e.assetClass)
    expect(new Set(entries.map(e => e.entityId)).size).toBe(entries.length)
  })
})

describe('global map relative strength and output', () => {
  const entry = (assetId: string, group: string, ret: number | null): MapEntry =>
    ({ assetId, label: assetId, group, kind: 'price', currency: 'EUR', status: 'ok', measures: { ret_1m_pct_eur: ret, ret_3m_pct_eur: ret, ret_12m_pct_eur: ret } })

  it('measures strength against the declared benchmark or the group median and ranks by 3 months', () => {
    const results = [entry('bench', 'areas', 2), entry('a', 'areas', 5), entry('b', 'areas', -1), entry('x', 'cmd', 10), entry('y', 'cmd', 0), entry('z', 'cmd', 4)]
    const ranking = applyRelative({ areas: { relative: 'bench' }, cmd: { relative: 'group-median' }, fx: { relative: null } }, results)
    expect(results[1].measures.rs_3m_eur_pp).toBe(3)
    expect(results[3].measures.rs_3m_eur_pp).toBe(6)
    expect(ranking).toEqual({ areas: ['a', 'bench', 'b'], cmd: ['x', 'z', 'y'] })
  })

  it('catalogs measures with units and renders generated tables', () => {
    const e: MapEntry = { ...entry('asset.eq.it', 'eq', -5.2), lastDate: '2026-10-13', frequency: 'daily', seriesId: 's', measures: { last: 50057, ret_3m_pct: -5.2, trend_long: 1, rsi14: 40 } }
    const gap: MapEntry = { assetId: 'asset.credit.eu.ig', label: 'IG', group: 'credit', kind: 'spread', status: 'gap', measures: {} }
    const units = Object.fromEntries(measureCatalog([e, gap]).map(m => [m.measureKey, m.unit]))
    expect(units).toEqual({ last: 'EUR', ret_3m_pct: '%', trend_long: 'state', rsi14: 'score' })
    const md = renderTables({ methodVersion: 'm', runId: 'r', asOf: '2026-10-13', groups: { eq: { label: 'Azioni', relative: null }, credit: { label: 'Credito', relative: null } }, assets: [e, gap], derived: [] })
    expect(md).toContain('do not edit numbers by hand')
    expect(md).toContain('| asset.eq.it | 50.057 | 13/10 |')
    expect(md).toContain('−5,2%')
    expect(md).toContain('| lacuna |')
  })
})
