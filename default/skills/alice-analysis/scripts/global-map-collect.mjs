import { createHash } from 'node:crypto'
import { copyFile, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { gateway, isInside, readLimited, safeDir, workspaceRoot } from './global-map-io.mjs'
import { extractValuation } from './global-map-lib.mjs'

// Bounded data collector for the global market map, not an Agent/model loop.
// Saves every original payload with its SHA-256 before any calculation.
const usage = 'Use: node global-map-collect.mjs [--start YYYY-MM-DD] [--run-id <id>] [--universe <workspace path>]'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--start', '--run-id', '--universe'].includes(args[i]) || args[i + 1] === undefined) throw new Error(usage)
  options[args[i]] = args[i + 1]
}
// Six years cover every current measure (5-year percentiles, 200-session means, 12-month changes).
// Long history belongs to IbIvMonitor once it persists external series (SUPERAI-EXTERNAL-SERIES-01).
const start = options['--start'] ?? `${new Date().getUTCFullYear() - 6}-01-01`
if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('start must be YYYY-MM-DD')
const runId = options['--run-id'] ?? `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}Z-global-map`
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(runId)) throw new Error('Invalid run id')

const gw = gateway()
const root = await workspaceRoot()

// Official sources sit behind the host's TLS inspection on some machines: trust system CAs too.
try { tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]) } catch { /* older Node */ }

const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'global-map-universe.json')
const deskUniverse = join(root, 'research/market-assistant/global-map/universe.json')
const universePath = options['--universe'] ? join(root, options['--universe']) : await realpath(deskUniverse).catch(() => bundled)
if (options['--universe'] && !isInside(root, await realpath(universePath))) throw new Error('Universe escaped the Workspace')
const universeBytes = await readFile(universePath)
const universe = JSON.parse(universeBytes.toString('utf8'))
if (universe.schema !== 'superai.global-map.universe/1') throw new Error('Unsupported universe schema')

// Every directory is checked component by component before anything is written.
const runsDir = await safeDir(root, 'research/market-assistant/runs')
const runDir = await safeDir(root, `research/market-assistant/runs/${runId}`, { exclusiveLast: true })
// Temporary payload cache, excluded from Workspace Git, until the monitor owns persistence.
const cacheRel = 'research/market-assistant/global-map/cache/payloads'
const cacheDir = await safeDir(root, cacheRel)
await writeFile(join(root, 'research/market-assistant/global-map/cache/.gitignore'), '*\n')
await copyFile(universePath, join(runDir, 'global-map.universe.json'))

const MAX_BYTES = 20_000_000
const tools = {
  bars: await gw.toolName('data', 'market', 'bars'),
  fred: await gw.toolName('traderhub', 'economy', 'fred-series'),
  board: await gw.toolName('traderhub', 'board', 'get'),
  monitorDaily: await gw.toolName('data', 'monitor', 'history-daily'),
}
const text = body => body.content[0].text

/** IbIvMonitor answers keep the full MCP envelope; its hash covers content[0].text. */
async function invokeMonitor(tool, toolArgs) {
  const body = await gw.invoke('data', tool, toolArgs)
  if (createHash('sha256').update(text(body)).digest('hex') !== body._meta?.['ibivmonitor/sha256']) throw new Error('Monitor envelope hash mismatch')
  return JSON.stringify(body)
}

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'SuperAI global-map collector' }, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return await readLimited(res, MAX_BYTES)
}

/** One request per unique source call; several series may share a payload. */
function requestsFor(spec) {
  const s = spec.source, sym = spec.symbol
  if (s === 'yahoo') {
    const a = { symbol: sym, assetClass: spec.assetClass, interval: '1d', start }
    return [{ key: `yahoo:${sym}`, describe: { tool: tools.bars, args: a }, run: async () => text(await gw.invoke('data', tools.bars, a)) }]
  }
  if (s === 'fred') {
    const a = { symbol: sym, start_date: start }
    return [{ key: `fred:${sym}`, describe: { tool: tools.fred, args: a }, run: async () => text(await gw.invoke('traderhub', tools.fred, a)) }]
  }
  if (s === 'monitor') return [{ key: `monitor:${sym}`, describe: { tool: tools.monitorDaily, args: { id: sym } }, run: () => invokeMonitor(tools.monitorDaily, { id: sym }) }]
  if (s === 'ishares' || s === 'ssga') {
    // Issuer pages are ~2 MB: keep the page hash and the verbatim value fragments, not the page.
    return [{ key: `${s}:${spec.fund}`, describe: { url: sym }, run: async () => {
      const html = await download(sym)
      const extracted = extractValuation(s, html)
      if (!Object.keys(extracted.values).length) throw new Error(`No fundamentals found on the ${spec.fund} page`)
      return JSON.stringify({ provider: s, fund: spec.fund, url: sym, pageSha256: createHash('sha256').update(html).digest('hex'), pageBytes: Buffer.byteLength(html), ...extracted })
    } }]
  }
  if (s === 'traderhub-valuation') return [{ key: 'traderhub:valuation', describe: { tool: tools.board, args: { board: 'valuation' } }, run: async () => text(await gw.invoke('traderhub', tools.board, { board: 'valuation' })) }]
  if (s === 'bundesbank') {
    const url = `https://api.statistiken.bundesbank.de/rest/data/${sym}?format=csv&lang=en&startPeriod=${start}`
    return [{ key: `bundesbank:${sym}`, describe: { url }, run: () => download(url) }]
  }
  if (s === 'mof-jgb') {
    const history = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv'
    const current = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv'
    return [{ key: 'mof:history', describe: { url: history }, run: () => download(history) }, { key: 'mof:current', describe: { url: current }, run: () => download(current) }]
  }
  if (s === 'stoxx') {
    const url = 'https://www.stoxx.com/document/Indices/Current/HistoricalData/h_v2tx.txt'
    return [{ key: 'stoxx:v2tx', describe: { url }, run: () => download(url) }]
  }
  throw new Error(`Unknown source ${s}`)
}

const specs = [
  ...universe.assets.map(a => ({ ...a.series, frequency: a.frequency })),
  ...universe.aux, ...universe.macro,
  ...(universe.valuations ?? []).map(v => ({ seriesId: v.seriesId, source: v.provider, symbol: v.url, fund: v.fund })),
].filter(s => s.source !== 'none')

const unique = new Map()
for (const spec of specs) for (const req of requestsFor(spec)) unique.set(req.key, req)

const fetched = new Map()
const queue = [...unique.values()]
async function worker() {
  for (let req = queue.shift(); req; req = queue.shift()) {
    const fetchedAt = new Date().toISOString()
    try {
      const bytes = Buffer.from(await req.run(), 'utf8')
      if (bytes.length > MAX_BYTES) throw new Error('Payload exceeds collector limit')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      // Content-addressed and compressed: an unchanged payload is stored once across runs.
      const file = `${cacheRel}/${sha256}.txt.gz`
      try { await writeFile(join(root, file), gzipSync(bytes), { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      fetched.set(req.key, { key: req.key, request: req.describe, fetchedAt, status: 'ok', file, sha256, bytes: bytes.length })
    } catch (error) {
      fetched.set(req.key, { key: req.key, request: req.describe, fetchedAt, status: 'error', error: String(error?.message ?? error).slice(0, 300) })
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker))

const series = specs.map(spec => {
  const parts = requestsFor(spec).map(r => fetched.get(r.key))
  return { seriesId: spec.seriesId, source: spec.source, symbol: spec.symbol, status: parts.every(p => p.status === 'ok') ? 'ok' : 'error', payloads: parts.map(p => p.key) }
})
const manifest = {
  schema: 'superai.global-map.manifest/1', runId, workspaceId: gw.workspaceId, start,
  universe: { file: 'global-map.universe.json', revision: universe.revision, sha256: createHash('sha256').update(universeBytes).digest('hex') },
  collectedFrom: [...fetched.values()].map(f => f.fetchedAt).sort()[0], collectedTo: new Date().toISOString(),
  payloads: [...fetched.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), series,
}
await writeFile(join(runDir, 'global-map.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
const pruned = await prunePayloads()
const failed = manifest.payloads.filter(p => p.status !== 'ok')
process.stdout.write(JSON.stringify({ runId, runDir: relative(root, runDir).replaceAll('\\', '/'), payloads: manifest.payloads.length, prunedPayloads: pruned, failed: failed.map(f => ({ key: f.key, error: f.error })) }, null, 2) + '\n')
if (failed.length) process.exitCode = 2

/**
 * Keep the payloads of the five latest map runs and of every pinned run (runs
 * used by a report, judgment or thesis; see global-map-pin.mjs). Other runs keep
 * their metrics but lose their raw payloads. The monitor will own long-term persistence.
 */
async function prunePayloads() {
  let pinned = []
  try { pinned = JSON.parse(await readFile(join(root, 'research/market-assistant/global-map/pinned-runs.json'), 'utf8')).runs.map(r => r.runId) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const runs = []
  for (const name of await readdir(runsDir)) {
    try {
      const m = JSON.parse(await readFile(join(runsDir, name, 'global-map.manifest.json'), 'utf8'))
      if (m.schema === 'superai.global-map.manifest/1' && m.collectedFrom) runs.push(m)
    } catch { /* not a map run */ }
  }
  runs.sort((a, b) => (a.collectedFrom < b.collectedFrom ? 1 : -1))
  const keep = runs.filter((m, i) => i < 5 || pinned.includes(m.runId))
  const referenced = new Set(keep.flatMap(m => m.payloads.filter(p => p.file).map(p => p.file.split('/').pop())))
  let removed = 0
  for (const name of await readdir(cacheDir)) {
    if (/^[a-f0-9]{64}\.txt(\.gz)?$/.test(name) && !referenced.has(name)) { await unlink(join(cacheDir, name)); removed++ }
  }
  return removed
}
