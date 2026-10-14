import { createHash } from 'node:crypto'
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { isInside, safeDir, workspaceRoot } from './global-map-io.mjs'
import {
  METHOD_VERSION, applyRelative, computeSeries, computeValuation, deriveSeries, measureCatalog, parseSeries, renderTables,
} from './global-map-lib.mjs'

// Offline, deterministic calculation over a collected run: no network, no model, no clock.
const usage = 'Use: node global-map-calc.mjs --run-id <id> --as-of YYYY-MM-DD [--publish-measures]'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--publish-measures') { options.publish = true; continue }
  if (!['--run-id', '--as-of'].includes(args[i]) || args[i + 1] === undefined) throw new Error(usage)
  options[args[i]] = args[++i]
}
const runId = options['--run-id'], asOf = options['--as-of']
if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(runId) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) throw new Error(usage)

const root = await workspaceRoot()
const runDir = await realpath(join(root, 'research/market-assistant/runs', runId))
if (!isInside(root, runDir)) throw new Error('Run directory escaped the Workspace')

const manifest = JSON.parse(await readFile(join(runDir, 'global-map.manifest.json'), 'utf8'))
if (manifest.schema !== 'superai.global-map.manifest/1' || manifest.runId !== runId) throw new Error('Unexpected manifest')
const universeBytes = await readFile(join(runDir, manifest.universe.file))
if (createHash('sha256').update(universeBytes).digest('hex') !== manifest.universe.sha256) throw new Error('Universe copy integrity mismatch')
const universe = JSON.parse(universeBytes.toString('utf8'))

// Verify every payload against the manifest before parsing anything.
const payloadText = new Map()
for (const p of manifest.payloads) {
  if (p.status !== 'ok') continue
  // Payloads live in the Workspace's temporary cache (content-addressed by SHA-256).
  if (!/^research\/market-assistant\/global-map\/cache\/payloads\/[a-f0-9]{64}\.txt(\.gz)?$/.test(p.file)) throw new Error(`Unexpected payload path: ${p.file}`)
  const path = join(root, p.file)
  if (!isInside(root, await realpath(path).catch(() => { throw new Error(`Payload no longer cached: ${p.file}`) }))) throw new Error('Payload escaped the Workspace')
  const stored = await readFile(path)
  const bytes = p.file.endsWith('.gz') ? gunzipSync(stored, { maxOutputLength: 40_000_000 }) : stored
  if (createHash('sha256').update(bytes).digest('hex') !== p.sha256) throw new Error(`Evidence integrity mismatch: ${p.file}`)
  payloadText.set(p.key, { text: bytes.toString('utf8'), fetchedAt: p.fetchedAt })
}

const warnings = []
const parsed = new Map()
const VALUATION_SOURCES = new Set(['ishares', 'ssga'])
const valuationPayloads = new Map()
for (const s of manifest.series) {
  if (s.status !== 'ok') { warnings.push(`${s.seriesId}: collection failed`); continue }
  if (VALUATION_SOURCES.has(s.source)) {
    const v = JSON.parse(payloadText.get(s.payloads[0]).text)
    valuationPayloads.set(s.seriesId, { seriesId: s.seriesId, fund: v.fund, asOf: v.asOf, values: v.values })
    continue
  }
  try {
    parsed.set(s.seriesId, parseSeries(s.source, s.payloads.map(k => payloadText.get(k).text), s.symbol))
  } catch (error) {
    warnings.push(`${s.seriesId}: unparseable payload (${error.message})`)
  }
}
const fetchedDay = s => {
  const series = manifest.series.find(x => x.seriesId === s)
  return series ? payloadText.get(series.payloads[0])?.fetchedAt.slice(0, 10) : null
}

const fx = {
  EURUSD: parsed.get('series.fx.eurusd.yahoo') ?? [], USDJPY: parsed.get('series.fx.usdjpy.yahoo') ?? [],
  USDCNY: parsed.get('series.fx.usdcny.yahoo') ?? [], USDINR: parsed.get('series.fx.usdinr.yahoo') ?? [],
}

function entry(spec, base) {
  const points = parsed.get(spec.seriesId)
  if (spec.source === 'none') return { ...base, status: 'gap', lastDate: null, staleDays: null, measures: {} }
  if (!points) return { ...base, status: 'missing', lastDate: null, staleDays: null, measures: {} }
  // A 24/7 market's bar for the collection day (UTC) is still forming.
  const incompleteFrom = spec.calendar === '7d' ? fetchedDay(spec.seriesId) : null
  return { ...base, ...computeSeries(spec, points, { asOf, fx, incompleteFrom }) }
}

const assets = universe.assets.map(a => entry(
  { ...a.series, kind: a.kind, currency: a.currency, frequency: a.frequency, calendar: a.calendar },
  { assetId: a.assetId, label: a.label, group: a.group, assetClass: a.assetClass, kind: a.kind, currency: a.currency, frequency: a.frequency, seriesId: a.series.seriesId, source: a.series.source, notes: a.notes ?? null },
))
const macro = universe.macro.map(m => entry(m, { assetId: m.assetId, label: m.label, assetClass: m.assetClass, kind: m.kind, frequency: m.frequency, seriesId: m.seriesId, source: m.source, notes: null }))

const frequencyOf = id => [...universe.assets.map(x => ({ ...x.series, frequency: x.frequency })), ...universe.aux, ...universe.macro].find(s => s.seriesId === id)?.frequency
const derived = universe.derived.map(d => {
  const a = parsed.get(d.a), b = parsed.get(d.b)
  const kind = d.op === 'ratio' ? 'price-ratio' : 'spread-bp'
  const monthly = [d.a, d.b].some(id => frequencyOf(id) === 'monthly')
  const formula = d.op === 'ratio' ? `${d.a} / ${d.b}` : `(${d.a} − ${d.b}) × 100 (bp)`
  const base = { assetId: d.assetId, label: d.label, assetClass: d.assetClass, kind, frequency: monthly ? 'monthly' : 'daily', seriesId: d.seriesId, formula, source: 'derived', notes: d.notes ?? null }
  if (!a || !b) return { ...base, status: 'missing', lastDate: null, staleDays: null, measures: {} }
  return { ...base, ...computeSeries({ kind, frequency: base.frequency, source: 'derived' }, deriveSeries(d.op, a, b, monthly), { asOf }) }
})

// Issuer fundamentals attach to their asset; each valuation measure keeps its own series id.
for (const a of assets) {
  const payloads = (universe.valuations ?? []).filter(v => v.assetId === a.assetId).map(v => valuationPayloads.get(v.seriesId)).filter(Boolean)
  if (!(universe.valuations ?? []).some(v => v.assetId === a.assetId)) continue
  const v = computeValuation(payloads, asOf)
  a.valuation = { status: v.status, asOf: v.asOf, staleDays: v.staleDays, sources: v.sources, excluded: v.excluded }
  Object.assign(a.measures, v.measures)
  a.measureSeries = Object.fromEntries(v.sources.map(x => [x.measureKey, x.seriesId]))
}

const ranking = applyRelative(universe.groups, assets)
const groups = Object.fromEntries(Object.entries(universe.groups).map(([id, g]) => [id, { ...g, rankingByRet3mEur: ranking[id] ?? null }]))

const metrics = {
  schema: 'superai.global-map.metrics/1', methodVersion: METHOD_VERSION, runId, asOf,
  universeRevision: universe.revision, baseCurrency: universe.baseCurrency,
  inputs: manifest.payloads.map(p => ({ key: p.key, status: p.status, fetchedAt: p.fetchedAt, file: p.file ?? null, sha256: p.sha256 ?? null })),
  coverage: {
    assets: assets.length,
    ok: assets.filter(a => a.status === 'ok').length,
    stale: assets.filter(a => a.status === 'stale').map(a => a.assetId),
    missing: assets.filter(a => a.status === 'missing').map(a => a.assetId),
    gaps: assets.filter(a => a.status === 'gap').map(a => a.assetId),
  },
  groups, assets, derived, macro, warnings,
}
const catalog = { schema: 'superai.measures/1', methodVersion: METHOD_VERSION, runId, asOf, measures: measureCatalog([...assets, ...derived, ...macro]) }

const write = (name, data) => writeFile(join(runDir, name), data, { flag: 'wx' })
await write('global-map.metrics.json', JSON.stringify(metrics, null, 2) + '\n')
await write('global-map.measures.json', JSON.stringify(catalog, null, 2) + '\n')
await write('global-map.tables.md', renderTables(metrics))

if (options.publish) {
  // Publish the measure catalog used to validate thesis conditions (atomic replace).
  const dir = await safeDir(root, 'research/market-assistant/global-map')
  const temp = join(dir, `.measures.${process.pid}.tmp`)
  await writeFile(temp, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' })
  await rename(temp, join(dir, 'measures.json'))
}
process.stdout.write(JSON.stringify({ runId, asOf, methodVersion: METHOD_VERSION, coverage: metrics.coverage, warnings, measures: catalog.measures.length }, null, 2) + '\n')
