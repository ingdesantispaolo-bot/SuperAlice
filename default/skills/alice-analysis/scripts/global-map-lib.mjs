// Pure functions for the global market map: source parsing, measures and tables.
// No network, no clock, no model: the same inputs always produce the same output.
import { createHash } from 'node:crypto'

export const METHOD_VERSION = 'global-map-measures/1'

const ISO = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

// ---------------------------------------------------------------- dates

export const dayNumber = iso => Date.parse(`${iso}T00:00:00Z`) / DAY_MS
const isoFromDay = n => new Date(n * DAY_MS).toISOString().slice(0, 10)
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a)

/** Calendar shift; months clamp to the last day of the target month. */
export function shiftDate(iso, { days = 0, months = 0 }) {
  const [y, m, d] = iso.split('-').map(Number)
  if (months) {
    const total = y * 12 + (m - 1) + months
    const ty = Math.floor(total / 12), tm = total % 12
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
    return isoFromDay(Date.UTC(ty, tm, Math.min(d, last)) / DAY_MS + days)
  }
  return isoFromDay(dayNumber(iso) + days)
}

// ---------------------------------------------------------------- parsing

function finish(points) {
  const byDate = new Map()
  for (const p of points) {
    if (!ISO.test(p.date) || !Number.isFinite(p.value)) continue
    byDate.set(p.date, p) // a later file/row for the same date wins (current-month file over history)
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

const csvLines = text => text.replace(/^﻿/, '').split(/\r?\n/)

/** Parse one or more payloads of a source into sorted {date, value[, close]} points. */
export function parseSeries(source, texts, symbol) {
  const points = []
  for (const text of texts) {
    if (source === 'yahoo') {
      for (const b of JSON.parse(text).bars ?? []) {
        const value = Number.isFinite(b.adj_close) ? b.adj_close : b.close
        points.push({ date: b.date, value, close: b.close })
      }
    } else if (source === 'fred') {
      for (const r of JSON.parse(text)) points.push({ date: r.date, value: r[symbol] ?? NaN })
    } else if (source === 'bundesbank') {
      for (const line of csvLines(text)) {
        const m = /^(\d{4}-\d{2}-\d{2}),([^,]*),/.exec(line)
        if (m && m[2] !== '.' && m[2] !== '') points.push({ date: m[1], value: Number(m[2]) })
      }
    } else if (source === 'mof-jgb') {
      let column = -1
      for (const line of csvLines(text)) {
        const cells = line.split(',')
        if (cells[0] === 'Date') { column = cells.indexOf(symbol); continue }
        const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(cells[0])
        if (!m || column < 0 || cells[column] === '-' || cells[column] === '') continue
        points.push({ date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, value: Number(cells[column]) })
      }
    } else if (source === 'stoxx') {
      for (const line of csvLines(text)) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4});([^;]+);([-\d.]+)$/.exec(line.trim())
        if (m && m[4] === symbol) points.push({ date: `${m[3]}-${m[2]}-${m[1]}`, value: Number(m[5]) })
      }
    } else if (source === 'monitor') {
      // IbIvMonitor MCP envelope: verify the canonical text, keep only settled sessions.
      const envelope = JSON.parse(text)
      const canonical = envelope.content?.[0]?.text
      if (typeof canonical !== 'string' || createHash('sha256').update(canonical).digest('hex') !== envelope._meta?.['ibivmonitor/sha256']) {
        throw new Error('Monitor evidence hash mismatch')
      }
      for (const b of JSON.parse(canonical).bars ?? []) {
        if (b.finality === 'final') points.push({ date: b.session, value: b.close })
      }
    } else if (source === 'traderhub-valuation') {
      const card = (JSON.parse(text).cards ?? []).find(c => c.id === symbol)
      for (const p of card?.points ?? []) points.push({ date: p.date, value: p.value })
    } else {
      throw new Error(`Unknown source: ${source}`)
    }
  }
  return finish(points)
}

// ---------------------------------------------------------------- series math

/** Index of the last point dated on or before iso, or -1. */
export function indexOnOrBefore(points, iso) {
  let lo = 0, hi = points.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].date <= iso) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/** Value at a calendar date, tolerating a missing session up to maxGap days. */
export function valueAt(points, iso, maxGap = 7) {
  const i = indexOnOrBefore(points, iso)
  return i >= 0 && daysBetween(points[i].date, iso) <= maxGap ? points[i] : null
}

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length
const stdev = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) }

export function sma(values, n, end = values.length - 1) {
  return end + 1 >= n ? mean(values.slice(end + 1 - n, end + 1)) : null
}

/** Wilder RSI over the whole history up to the last value. */
export function rsiWilder(values, n = 14) {
  if (values.length <= n) return null
  let gain = 0, loss = 0
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) gain += d; else loss -= d
  }
  gain /= n; loss /= n
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (n - 1) + Math.max(d, 0)) / n
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
}

/** Share of the sample at or below x (0–100). */
export function percentileRank(sample, x) {
  return sample.length ? (sample.filter(v => v <= x).length / sample.length) * 100 : null
}

function realizedVol(values, end, n, periodsPerYear) {
  if (end < n) return null
  const r = []
  for (let i = end - n + 1; i <= end; i++) r.push(Math.log(values[i] / values[i - 1]))
  return stdev(r) * Math.sqrt(periodsPerYear) * 100
}

const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0)
/** +1 when both readings agree upward, -1 when both agree downward, 0 when they disagree. */
function trend(a, b) {
  if (a === null || b === null) return null
  return sign(a) === sign(b) ? sign(a) : 0
}

const round = (x, digits) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)))

// ---------------------------------------------------------------- measures

export const PERIODS = [
  ['1w', { days: -7 }], ['1m', { months: -1 }], ['3m', { months: -3 }], ['12m', { months: -12 }],
]

/** Kinds and the unit in which levels and changes are reported. */
const LEVEL_KINDS = {
  rate: { scale: 1, unit: '%', changeUnit: 'bp', changeScale: 100 },
  yield: { scale: 1, unit: '%', changeUnit: 'bp', changeScale: 100 },
  spread: { scale: 100, unit: 'bp', changeUnit: 'bp', changeScale: 1 },
  'spread-bp': { scale: 1, unit: 'bp', changeUnit: 'bp', changeScale: 1 },
  level: { scale: 1, unit: 'pt', changeUnit: 'pt', changeScale: 1 },
  ratio: { scale: 1, unit: 'x', changeUnit: 'x', changeScale: 1 },
}

/** Value of an asset in EUR at a date, given its currency and the FX series. */
export function eurFactor(currency, fx, iso) {
  if (!currency || currency === 'EUR') return 1
  const eurusd = valueAt(fx.EURUSD ?? [], iso, 7)
  if (!eurusd) return null
  if (currency === 'USD') return 1 / eurusd.value
  const cross = fx[`USD${currency}`] && valueAt(fx[`USD${currency}`], iso, 7)
  return cross ? 1 / (eurusd.value * cross.value) : null
}

function priceMeasures(points, { currency, fx, periodsPerYear }) {
  const values = points.map(p => p.value)
  const last = points.at(-1), end = values.length - 1
  const m = { last: last.close ?? last.value }
  const lastEur = eurFactor(currency, fx, last.date)
  for (const [key, shift] of PERIODS) {
    const start = valueAt(points, shiftDate(last.date, shift))
    m[`ret_${key}_pct`] = start ? (last.value / start.value - 1) * 100 : null
    if (currency !== undefined) {
      const startEur = start && eurFactor(currency, fx, start.date)
      m[`ret_${key}_pct_eur`] = start && startEur && lastEur ? ((last.value * lastEur) / (start.value * startEur) - 1) * 100 : null
    }
  }
  const ytdStart = valueAt(points, `${Number(last.date.slice(0, 4)) - 1}-12-31`, 10)
  m.ret_ytd_pct = ytdStart ? (last.value / ytdStart.value - 1) * 100 : null
  for (const n of [20, 50, 200]) {
    const s = sma(values, n)
    m[`dist_sma${n}_pct`] = s === null ? null : (last.value / s - 1) * 100
  }
  const s200 = sma(values, 200), s200prev = sma(values, 200, end - 21)
  m.sma200_slope_1m_pct = s200 !== null && s200prev !== null ? (s200 / s200prev - 1) * 100 : null
  m.rsi14 = rsiWilder(values.slice(-400), 14)
  const tail20 = values.slice(-20)
  m.z20 = tail20.length === 20 ? (last.value - mean(tail20)) / stdev(tail20) : null
  m.vol20_ann_pct = realizedVol(values, end, 20, periodsPerYear)
  const vols = []
  for (let i = Math.max(21, end - 1259); i <= end; i++) vols.push(realizedVol(values, i, 20, periodsPerYear))
  m.vol20_pctile_5y = vols.length >= 250 && m.vol20_ann_pct !== null ? percentileRank(vols, m.vol20_ann_pct) : null
  const yearAgo = indexOnOrBefore(points, shiftDate(last.date, { months: -12 }))
  const window = values.slice(Math.max(yearAgo, 0))
  const hi = Math.max(...window), lo = Math.min(...window)
  m.dd_52w_pct = (last.value / hi - 1) * 100
  m.pos_52w = hi > lo ? (last.value - lo) / (hi - lo) : null
  m.trend_short = trend(m.dist_sma20_pct, m.ret_1m_pct)
  m.trend_medium = trend(m.dist_sma50_pct, m.ret_3m_pct)
  m.trend_long = trend(m.dist_sma200_pct, m.ret_12m_pct)
  return m
}

function levelMeasures(points, kind, monthly) {
  const { scale, changeScale } = LEVEL_KINDS[kind]
  const values = points.map(p => p.value)
  const last = points.at(-1)
  const m = { last: last.value * scale }
  for (const [key, shift] of PERIODS) {
    const start = valueAt(points, shiftDate(last.date, shift), monthly ? 45 : 7)
    m[`chg_${key}`] = start ? (last.value - start.value) * scale * changeScale : null
  }
  if (monthly) {
    m.chg_1w = null
  } else {
    for (const n of [20, 50, 200]) {
      const s = sma(values, n)
      m[`dist_sma${n}`] = s === null ? null : (last.value - s) * scale * changeScale
    }
  }
  const fiveYears = values.slice(Math.max(indexOnOrBefore(points, shiftDate(last.date, { months: -60 })), 0))
  m.history_years = round(daysBetween(points[0].date, last.date) / 365.25, 1)
  m.level_pctile_5y = m.history_years >= 1 ? percentileRank(fiveYears, last.value) : null
  m.trend_short = monthly ? null : trend(m.dist_sma20, m.chg_1m)
  m.trend_medium = monthly ? trend(m.chg_3m, m.chg_3m) : trend(m.dist_sma50, m.chg_3m)
  m.trend_long = monthly ? trend(m.chg_12m, m.chg_12m) : trend(m.dist_sma200, m.chg_12m)
  return m
}

function maxLagDays(frequency, source) {
  if (frequency === 'monthly') return 75
  return source === 'fred' ? 6 : 5
}

/**
 * Measures for one series. points are already parsed; asOf is the inclusive
 * cutoff; incompleteFrom excludes a still-forming day (24/7 markets).
 */
export function computeSeries(spec, points, { asOf, fx = {}, incompleteFrom = null }) {
  const cutoff = incompleteFrom && incompleteFrom <= asOf ? shiftDate(incompleteFrom, { days: -1 }) : asOf
  const usable = points.filter(p => p.date <= cutoff)
  const base = { excludedAfterCutoff: points.length - usable.length, cutoff }
  if (!usable.length) return { ...base, status: 'missing', lastDate: null, staleDays: null, measures: {} }
  const last = usable.at(-1)
  const staleDays = daysBetween(last.date, asOf)
  const status = staleDays > maxLagDays(spec.frequency, spec.source) ? 'stale' : 'ok'
  const monthly = spec.frequency === 'monthly'
  let measures
  if (spec.kind === 'price' || spec.kind === 'fx' || spec.kind === 'price-ratio') {
    measures = priceMeasures(usable, {
      currency: spec.kind === 'price' ? (spec.currency ?? undefined) : undefined,
      fx, periodsPerYear: spec.calendar === '7d' ? 365 : 252,
    })
  } else if (spec.kind === 'index') {
    const last12 = valueAt(usable, shiftDate(last.date, { months: -12 }), 45)
    const prev = valueAt(usable, shiftDate(last.date, { months: -1 }), 45)
    measures = { last: last.value, yoy_pct: last12 ? (last.value / last12.value - 1) * 100 : null, mom_pct: prev ? (last.value / prev.value - 1) * 100 : null }
  } else if (LEVEL_KINDS[spec.kind]) {
    measures = levelMeasures(usable, spec.kind, monthly)
  } else {
    throw new Error(`Unknown kind: ${spec.kind}`)
  }
  for (const [k, v] of Object.entries(measures)) measures[k] = typeof v === 'number' ? round(v, 4) : v
  return { ...base, status, lastDate: last.date, staleDays, firstDate: usable[0].date, observations: usable.length, measures }
}

/** Combine two series on common dates (monthly series are matched by month). */
export function deriveSeries(op, a, b, monthly = false) {
  const key = p => (monthly ? p.date.slice(0, 7) : p.date)
  const right = new Map(b.map(p => [key(p), p]))
  const out = []
  for (const p of a) {
    const q = right.get(key(p))
    if (!q) continue
    out.push({ date: p.date, value: op === 'diff' ? (p.value - q.value) * 100 : p.value / q.value })
  }
  return out
}

/** Relative strength and rank inside each group with a declared reference. */
export function applyRelative(groups, results) {
  const byId = new Map(results.map(r => [r.assetId, r]))
  const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null }
  const ranking = {}
  for (const [groupId, group] of Object.entries(groups)) {
    if (!group.relative) continue
    const members = results.filter(r => r.group === groupId && r.status !== 'missing')
    for (const period of ['1m', '3m', '12m']) {
      const key = `ret_${period}_pct_eur`
      const ref = group.relative === 'group-median'
        ? median(members.map(r => r.measures[key]).filter(v => v !== null && v !== undefined))
        : byId.get(group.relative)?.measures[key] ?? null
      for (const r of members) {
        const v = r.measures[key]
        r.measures[`rs_${period}_eur_pp`] = v === null || v === undefined || ref === null ? null : round(v - ref, 4)
      }
    }
    ranking[groupId] = members
      .filter(r => r.measures.ret_3m_pct_eur !== null && r.measures.ret_3m_pct_eur !== undefined)
      .sort((x, y) => y.measures.ret_3m_pct_eur - x.measures.ret_3m_pct_eur || (x.assetId < y.assetId ? -1 : 1))
      .map(r => r.assetId)
  }
  return ranking
}

// ---------------------------------------------------------------- measure catalog

const DEFS = {
  last: 'Ultimo valore (prezzo di chiusura, livello o rendimento) alla data del dato',
  ret_1w_pct: 'Variazione % in 7 giorni di calendario', ret_1m_pct: 'Variazione % in 1 mese di calendario',
  ret_3m_pct: 'Variazione % in 3 mesi', ret_12m_pct: 'Variazione % in 12 mesi', ret_ytd_pct: 'Variazione % da inizio anno',
  ret_1w_pct_eur: 'Variazione % in 7 giorni, convertita in EUR', ret_1m_pct_eur: 'Variazione % in 1 mese, in EUR',
  ret_3m_pct_eur: 'Variazione % in 3 mesi, in EUR', ret_12m_pct_eur: 'Variazione % in 12 mesi, in EUR',
  dist_sma20_pct: 'Distanza % dalla media mobile semplice a 20 osservazioni', dist_sma50_pct: 'Distanza % dalla media a 50 osservazioni',
  dist_sma200_pct: 'Distanza % dalla media a 200 osservazioni', sma200_slope_1m_pct: 'Variazione % della media a 200 rispetto a 21 osservazioni prima',
  rsi14: 'RSI di Wilder a 14 osservazioni', z20: 'Scarto dalla media a 20 in deviazioni standard',
  vol20_ann_pct: 'Volatilità realizzata a 20 osservazioni, annualizzata (%)', vol20_pctile_5y: 'Percentile della volatilità a 20 sugli ultimi 5 anni',
  dd_52w_pct: 'Distanza % dal massimo delle ultime 52 settimane', pos_52w: 'Posizione nel range di 52 settimane (0 = minimo, 1 = massimo)',
  trend_short: 'Trend breve: +1 su, -1 giù, 0 misto (media 20 e variazione 1 mese)',
  trend_medium: 'Trend medio: +1/-1/0 (media 50 e variazione 3 mesi)', trend_long: 'Trend lungo: +1/-1/0 (media 200 e variazione 12 mesi)',
  chg_1w: 'Variazione in 7 giorni', chg_1m: 'Variazione in 1 mese', chg_3m: 'Variazione in 3 mesi', chg_12m: 'Variazione in 12 mesi',
  dist_sma20: 'Distanza dalla media a 20 osservazioni', dist_sma50: 'Distanza dalla media a 50', dist_sma200: 'Distanza dalla media a 200',
  level_pctile_5y: 'Percentile del livello sugli ultimi 5 anni (o sulla storia disponibile, se più breve)', history_years: 'Anni di storia disponibili',
  yoy_pct: 'Variazione % su 12 mesi', mom_pct: 'Variazione % sul mese precedente',
  rs_1m_eur_pp: 'Forza relativa a 1 mese in EUR rispetto al riferimento del gruppo (punti %)',
  rs_3m_eur_pp: 'Forza relativa a 3 mesi in EUR (punti %)', rs_12m_eur_pp: 'Forza relativa a 12 mesi in EUR (punti %)',
  val_pe_trailing: "P/E sugli utili degli ultimi 12 mesi del fondo di riferimento, come pubblicato dall'emittente",
  val_pe_fy1: "P/E sugli utili attesi del prossimo anno fiscale (FY1) del fondo di riferimento, come pubblicato dall'emittente",
  val_pb: "Prezzo / valore di libro del fondo di riferimento, come pubblicato dall'emittente",
}

export function measureCatalog(entries) {
  const measures = []
  for (const e of entries) {
    if (e.status === 'missing' || e.status === 'gap') continue
    for (const measureKey of Object.keys(e.measures)) {
      measures.push({
        assetId: e.assetId, measureKey, timeframe: e.frequency === 'monthly' ? '1M' : '1D', seriesId: e.measureSeries?.[measureKey] ?? e.seriesId,
        unit: unitOf(e, measureKey), definition: DEFS[measureKey] ?? measureKey, completedBarsOnly: true,
      })
    }
  }
  return measures
}

function unitOf(e, key) {
  if (key.endsWith('_pct') || key.endsWith('_pct_eur') || key === 'vol20_ann_pct') return '%'
  if (key.endsWith('_pp')) return 'pp'
  if (key.startsWith('val_')) return 'ratio'
  if (key.startsWith('trend_')) return 'state'
  if (key === 'rsi14' || key.includes('pctile')) return 'score'
  if (key === 'z20') return 'sd'
  if (key === 'pos_52w') return 'ratio'
  if (key === 'history_years') return 'years'
  const lk = LEVEL_KINDS[e.kind]
  if (lk) return key === 'last' ? lk.unit : lk.changeUnit
  return e.kind === 'fx' || e.kind === 'price-ratio' ? 'index' : (e.currency ?? 'index')
}

// ---------------------------------------------------------------- valuations

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }
const isoFromText = (mon, day, year) => (MONTHS[mon] ? `${year}-${MONTHS[mon]}-${String(day).padStart(2, '0')}` : null)

/**
 * Extract issuer-published fund fundamentals from a product page. Returns the
 * verbatim page fragments (kept as evidence) and the parsed values.
 */
export function extractValuation(provider, html) {
  if (provider === 'ishares') {
    const text = html.replaceAll('&quot;', '"')
    const fragments = {}, values = {}
    let asOf = null
    for (const [key, measure] of [['priceEarnings', 'pe_trailing'], ['priceBook', 'pb']]) {
      const m = new RegExp(`"${key}":\\{"visible":(?:true|false),"label":"[^"]*","formattedValue":"([^"]*)"[^{}]*?"formattedAsOfDate":"([A-Z][a-z]{2}) (\\d{1,2}), (\\d{4})"`).exec(text)
      if (!m) continue
      fragments[key] = m[0].replace(/"infoBubble":"[^"]*",?/, '')
      const value = Number(m[1].replace(/,/g, ''))
      if (Number.isFinite(value) && m[1] !== '') values[measure] = value
      asOf = asOf ?? isoFromText(m[2], m[3], m[4])
    }
    return { asOf, values, fragments }
  }
  if (provider === 'ssga') {
    const fragments = {}, values = {}
    for (const [label, measure] of [['Price/Earnings Ratio FY1', 'pe_fy1'], ['Price/Book Ratio', 'pb']]) {
      const i = html.indexOf(`&#xfeff;${label}<`)
      if (i < 0) continue
      const window = html.slice(i, i + 3000)
      const m = />\s*(-?[0-9][0-9,]*\.[0-9]+)\s*</.exec(window)
      if (!m) continue
      fragments[label] = window.slice(0, m.index + m[0].length).replace(/<[^>]*>/g, '|').replace(/\s+/g, ' ').slice(-200)
      values[measure] = Number(m[1].replace(/,/g, ''))
    }
    const at = html.indexOf('&#xfeff;Price/Book Ratio<')
    const d = at > 0 ? /as of ([A-Z][a-z]{2}) (\d{1,2}) (\d{4})/.exec(html.slice(html.lastIndexOf('as of', at), at)) : null
    return { asOf: d ? isoFromText(d[1], d[2], d[3]) : null, values, fragments }
  }
  throw new Error(`Unknown valuation provider: ${provider}`)
}

/** Valuation measures for one asset from its issuer payloads (already extracted). */
export function computeValuation(payloads, asOf) {
  const measures = {}, sources = [], excluded = []
  for (const p of payloads) {
    // A value published after the map's cutoff was not knowable then: never use it.
    if (p.asOf && p.asOf > asOf) { excluded.push({ seriesId: p.seriesId, fund: p.fund, asOf: p.asOf, reason: 'after-cutoff' }); continue }
    for (const [k, v] of Object.entries(p.values)) {
      const key = `val_${k}`
      if (!(key in measures)) { measures[key] = v; sources.push({ measureKey: key, seriesId: p.seriesId, fund: p.fund, asOf: p.asOf }) }
    }
  }
  const dates = sources.map(s => s.asOf).filter(Boolean).sort()
  const oldest = dates[0] ?? null
  const staleDays = oldest ? daysBetween(oldest, asOf) : null
  return { status: !sources.length ? 'missing' : staleDays === null || staleDays > 10 ? 'stale' : 'ok', asOf: oldest, staleDays, measures, sources, excluded }
}

// ---------------------------------------------------------------- memory catalog

const SOURCE_LABEL = {
  yahoo: 'Yahoo Finance via OpenAlice market bars', fred: 'FRED via OpenAlice TraderHub', 'traderhub-valuation': 'OpenAlice TraderHub valuation board',
  bundesbank: 'Deutsche Bundesbank statistics API', 'mof-jgb': 'Japan Ministry of Finance JGB interest rates', stoxx: 'STOXX historical index data',
  monitor: 'IbIvMonitor daily archive (IBKR)', derived: 'SuperAI global map, derived from registered series',
  ishares: 'iShares (BlackRock) US product page', ssga: 'SPDR (State Street) US product page',
}
const RAW_UNIT = { rate: '%', yield: '%', spread: '%', level: 'index points', index: 'index points', ratio: 'ratio', fx: 'exchange rate' }
const PAR_SOURCES = new Set(['fred', 'bundesbank', 'mof-jgb'])

/**
 * Catalog events for the memory registry: every economic asset first, then the
 * series that measures it. Catalog identities are immutable, so this is derived
 * only from the versioned universe.
 */
export function catalogEntries(universe) {
  const method = description => ({ id: 'global-map-collect', version: universe.revision, description })
  const assets = [], series = []
  const asset = (assetId, label, assetClass, currency) => assets.push({
    kind: 'catalog', entityId: assetId, label, assetClass, role: 'asset', ...(currency ? { currency } : {}),
  })
  for (const a of universe.assets) {
    asset(a.assetId, a.label, a.assetClass, a.kind === 'price' ? a.currency : null)
    if (a.series.source === 'none') continue
    const yieldLike = a.kind === 'yield'
    series.push({
      kind: 'catalog', entityId: a.series.seriesId, label: `${a.label} (${a.series.symbol})`, assetClass: a.assetClass,
      role: a.series.role ?? 'observed-series', assetId: a.assetId, source: SOURCE_LABEL[a.series.source], sourceSeriesId: a.series.symbol,
      currency: a.kind === 'price' || yieldLike || a.kind === 'rate' || a.kind === 'spread' ? (a.currency ?? null) : null,
      unit: a.kind === 'price' ? (a.currency ?? 'index points') : RAW_UNIT[a.kind],
      method: method([a.frequency === 'monthly' ? 'Monthly series.' : 'Daily series.', a.notes ?? ''].join(' ').trim()),
      yieldType: yieldLike ? (PAR_SOURCES.has(a.series.source) && a.frequency !== 'monthly' ? 'par' : 'unknown') : null,
      benchmarkEquivalence: 'not-established', availability: 'source-verified',
    })
  }
  for (const m of universe.macro) {
    asset(m.assetId, m.label, m.assetClass, null)
    series.push({
      kind: 'catalog', entityId: m.seriesId, label: `${m.label} (${m.symbol})`, assetClass: m.assetClass, role: 'observed-series',
      assetId: m.assetId, source: SOURCE_LABEL[m.source], sourceSeriesId: m.symbol, currency: null, unit: RAW_UNIT[m.kind],
      method: method(`${m.frequency === 'monthly' ? 'Monthly' : 'Daily'} series.`),
      yieldType: m.kind === 'yield' ? (m.frequency === 'monthly' ? 'unknown' : 'par') : null,
      benchmarkEquivalence: 'not-established', availability: 'source-verified',
    })
  }
  for (const v of universe.valuations ?? []) {
    const owner = universe.assets.find(a => a.assetId === v.assetId)
    series.push({
      kind: 'catalog', entityId: v.seriesId, label: `${owner.label}: fondamentali del fondo ${v.fund} (${v.provider === 'ishares' ? 'iShares' : 'SPDR'})`,
      assetClass: owner.assetClass, role: 'proxy', assetId: v.assetId, source: SOURCE_LABEL[v.provider], sourceSeriesId: v.url,
      currency: null, unit: 'ratio', method: method(`Issuer-published fund fundamentals (${v.fields.join(', ')}), read from the product page; values as of the page date.`),
      yieldType: null, benchmarkEquivalence: 'not-established', availability: 'source-verified',
    })
  }
  for (const d of universe.derived) {
    asset(d.assetId, d.label, d.assetClass, null)
    const formula = d.op === 'ratio' ? `${d.a} / ${d.b}` : `(${d.a} - ${d.b}) x 100`
    series.push({
      kind: 'catalog', entityId: d.seriesId, label: d.label, assetClass: d.assetClass,
      role: d.assetId === 'derived.ratio.btp-bund-futures' ? 'proxy' : 'observed-series', assetId: d.assetId,
      source: SOURCE_LABEL.derived, sourceSeriesId: formula, currency: null, unit: d.op === 'ratio' ? 'ratio' : 'bp',
      method: method(`Derived: ${formula}. ${d.notes ?? ''}`.trim()), yieldType: null,
      benchmarkEquivalence: 'not-established', availability: 'source-verified',
    })
  }
  return [...assets, ...series]
}

// ---------------------------------------------------------------- tables

const fmt = (x, digits = 1, signed = false) => {
  if (x === null || x === undefined) return '–'
  const s = Math.abs(x).toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return x < 0 ? `−${s}` : signed && x > 0 ? `+${s}` : s
}
const arrow = t => (t === 1 ? '↑' : t === -1 ? '↓' : t === 0 ? '↔' : '–')
const quality = e => (e.status === 'ok' ? 'ok' : e.status === 'stale' ? `vecchio (${e.staleDays} g)` : e.status === 'gap' ? 'lacuna' : 'mancante')
const shortDate = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '–')

export function renderTables(metrics) {
  const out = [`<!-- generated by global-map-calc ${metrics.methodVersion}, run ${metrics.runId}, as of ${metrics.asOf}; do not edit numbers by hand -->`]
  const all = [...metrics.assets, ...metrics.derived]
  for (const [groupId, group] of Object.entries(metrics.groups)) {
    const rows = metrics.assets.filter(a => a.group === groupId)
    if (!rows.length) continue
    out.push('', `### ${group.label}`, '')
    const priceLike = rows.every(r => r.kind === 'price' || r.kind === 'fx')
    if (priceLike) {
      const eur = rows.some(r => r.kind === 'price' && r.currency && r.currency !== 'EUR')
      out.push(`| Voce | Ultimo | Dato al | 1S | 1M | 3M | 12M |${eur ? ' 12M in EUR |' : ''}${group.relative ? ' Forza rel. 3M |' : ''} Trend B/M/L | RSI | Dist. media 200 | Qualità |`)
      out.push(`|---|---:|---|---:|---:|---:|---:|${eur ? '---:|' : ''}${group.relative ? '---:|' : ''}---|---:|---:|---|`)
      for (const r of rows) {
        const m = r.measures
        out.push(`| ${r.label} | ${fmt(m.last, m.last >= 1000 ? 0 : 2)} | ${shortDate(r.lastDate)} | ${fmt(m.ret_1w_pct, 1, true)}% | ${fmt(m.ret_1m_pct, 1, true)}% | ${fmt(m.ret_3m_pct, 1, true)}% | ${fmt(m.ret_12m_pct, 1, true)}% |`
          + `${eur ? ` ${fmt(m.ret_12m_pct_eur, 1, true)}% |` : ''}${group.relative ? ` ${fmt(m.rs_3m_eur_pp, 1, true)} |` : ''}`
          + ` ${arrow(m.trend_short)} ${arrow(m.trend_medium)} ${arrow(m.trend_long)} | ${fmt(m.rsi14, 0)} | ${fmt(m.dist_sma200_pct, 1, true)}% | ${quality(r)} |`)
      }
    } else {
      out.push('| Voce | Livello | Dato al | Δ 1S | Δ 1M | Δ 3M | Δ 12M | Percentile 5 anni | Trend B/M/L | Qualità |')
      out.push('|---|---:|---|---:|---:|---:|---:|---:|---|---|')
      for (const r of rows) {
        const m = r.measures, unit = r.status === 'gap' ? '' : (LEVEL_KINDS[r.kind]?.unit ?? '')
        const cu = r.status === 'gap' ? '' : (LEVEL_KINDS[r.kind]?.changeUnit ?? '')
        out.push(`| ${r.label}${r.frequency === 'monthly' ? ' (mensile)' : ''} | ${fmt(m.last, unit === 'bp' ? 0 : 2)}${unit && m.last !== undefined && m.last !== null ? ` ${unit}` : ''} | ${shortDate(r.lastDate)} | ${fmt(m.chg_1w, 0, true)} | ${fmt(m.chg_1m, 0, true)} | ${fmt(m.chg_3m, 0, true)} | ${fmt(m.chg_12m, 0, true)}${cu ? ` ${cu}` : ''} | ${fmt(m.level_pctile_5y, 0)} | ${arrow(m.trend_short)} ${arrow(m.trend_medium)} ${arrow(m.trend_long)} | ${quality(r)} |`)
      }
    }
  }
  const valued = metrics.assets.filter(a => a.valuation)
  if (valued.length) {
    out.push('', '### Valutazioni (fondi di riferimento, dati degli emittenti)', '', '| Voce | Fondo | P/E 12 mesi | P/E atteso | P/B | Dato al | Qualità |', '|---|---|---:|---:|---:|---|---|')
    for (const a of valued) {
      const v = a.valuation, m = a.measures
      const funds = [...new Set(v.sources.map(x => x.fund))].join(', ')
      const q = v.status === 'ok' ? 'ok' : v.status === 'stale' ? `vecchio (${v.staleDays} g)` : 'mancante'
      out.push(`| ${a.label} | ${funds || '–'} | ${fmt(m.val_pe_trailing, 1)} | ${fmt(m.val_pe_fy1, 1)} | ${fmt(m.val_pb, 2)} | ${shortDate(v.asOf)} | ${q} |`)
    }
  }
  const derived = all.filter(r => r.assetId.startsWith('derived.'))
  if (derived.length) {
    out.push('', '### Rapporti e differenze', '', '| Voce | Ultimo | Dato al | Δ / var. 3M | Δ / var. 12M | Trend B/M/L | Qualità |', '|---|---:|---|---:|---:|---|---|')
    for (const r of derived) {
      const m = r.measures, ratio = r.kind === 'price-ratio'
      out.push(`| ${r.label} | ${fmt(m.last, ratio ? 3 : 0)}${ratio ? '' : ' bp'} | ${shortDate(r.lastDate)} | ${ratio ? `${fmt(m.ret_3m_pct, 1, true)}%` : fmt(m.chg_3m, 0, true)} | ${ratio ? `${fmt(m.ret_12m_pct, 1, true)}%` : fmt(m.chg_12m, 0, true)} | ${arrow(m.trend_short)} ${arrow(m.trend_medium)} ${arrow(m.trend_long)} | ${quality(r)} |`)
    }
  }
  return out.join('\n') + '\n'
}
