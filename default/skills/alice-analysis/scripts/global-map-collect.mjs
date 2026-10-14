import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

// Bounded data collector for the global market map, not an Agent/model loop.
// Saves every original payload with its SHA-256 before any calculation.
const usage = 'Use: node global-map-collect.mjs [--start 2004-01-01] [--run-id <id>] [--universe <workspace path>]'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--start', '--run-id', '--universe'].includes(args[i]) || args[i + 1] === undefined) throw new Error(usage)
  options[args[i]] = args[i + 1]
}
const start = options['--start'] ?? '2004-01-01'
if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('start must be YYYY-MM-DD')
const runId = options['--run-id'] ?? `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}Z-global-map`
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(runId)) throw new Error('Invalid run id')

const workspaceId = process.env.AQ_WS_ID
if (!workspaceId || !/^[a-zA-Z0-9_-]+$/.test(workspaceId)) throw new Error('Run inside an injected Alice Workspace shell')
const endpoint = new URL(process.env.OPENALICE_TOOL_URL ?? '')
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('Expected the injected loopback CLI endpoint')
}
const root = await realpath(process.cwd())
await realpath(join(root, '.alice')) // Refuse accidental execution from the source repository.
const inside = target => { const r = relative(root, target); return !r.startsWith('..') && !isAbsolute(r) }

// Official sources sit behind the host's TLS inspection on some machines: trust system CAs too.
try { tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]) } catch { /* older Node */ }

const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'global-map-universe.json')
const deskUniverse = join(root, 'research/market-assistant/global-map/universe.json')
const universePath = options['--universe'] ? join(root, options['--universe']) : await realpath(deskUniverse).catch(() => bundled)
if (options['--universe'] && !inside(await realpath(universePath))) throw new Error('Universe escaped the Workspace')
const universeBytes = await readFile(universePath)
const universe = JSON.parse(universeBytes.toString('utf8'))
if (universe.schema !== 'superai.global-map.universe/1') throw new Error('Unsupported universe schema')

const runDir = join(root, 'research/market-assistant/runs', runId)
await mkdir(join(root, 'research/market-assistant/runs'), { recursive: true })
await mkdir(runDir) // Exclusive: a run directory is never reused.
if (!inside(await realpath(runDir))) throw new Error('Run directory escaped the Workspace')
await mkdir(join(runDir, 'evidence'))
await copyFile(universePath, join(runDir, 'global-map.universe.json'))

const headers = { 'content-type': 'application/json', ...(process.env.OPENALICE_PROJECT_ID ? { 'x-openalice-project': process.env.OPENALICE_PROJECT_ID } : {}) }
const gatewayBase = exportKey => `${endpoint.href.replace(/\/+$/, '')}/${encodeURIComponent(workspaceId)}/${exportKey}`
const MAX_BYTES = 20_000_000

async function toolName(exportKey, group, verb) {
  const res = await fetch(`${gatewayBase(exportKey)}/manifest`, { headers, signal: AbortSignal.timeout(30_000) })
  const manifest = await res.json()
  const tool = manifest?.groups?.[group]?.[verb]?.tool
  if (!tool) throw new Error(`Gateway does not expose ${exportKey} ${group} ${verb}`)
  return tool
}
const tools = {
  bars: await toolName('data', 'market', 'bars'),
  fred: await toolName('traderhub', 'economy', 'fred-series'),
  board: await toolName('traderhub', 'board', 'get'),
}

async function invoke(exportKey, tool, toolArgs) {
  const res = await fetch(`${gatewayBase(exportKey)}/invoke`, {
    method: 'POST', headers, body: JSON.stringify({ tool, args: toolArgs }), signal: AbortSignal.timeout(120_000),
  })
  const body = await res.json()
  if (!res.ok || body.isError) throw new Error(typeof body.error === 'string' ? body.error : body.content?.[0]?.text?.slice(0, 300) ?? `HTTP ${res.status}`)
  const text = body.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('Gateway returned no text payload')
  return text
}

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'SuperAI global-map collector' }, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return await res.text()
}

/** One request per unique source call; several series may share a payload. */
function requestsFor(spec) {
  const s = spec.source, sym = spec.symbol
  if (s === 'yahoo') return [{ key: `yahoo:${sym}`, describe: { tool: tools.bars, args: { symbol: sym, assetClass: spec.assetClass, interval: '1d', start } }, run: () => invoke('data', tools.bars, { symbol: sym, assetClass: spec.assetClass, interval: '1d', start }) }]
  if (s === 'fred') return [{ key: `fred:${sym}`, describe: { tool: tools.fred, args: { symbol: sym, start_date: start } }, run: () => invoke('traderhub', tools.fred, { symbol: sym, start_date: start }) }]
  if (s === 'traderhub-valuation') return [{ key: 'traderhub:valuation', describe: { tool: tools.board, args: { board: 'valuation' } }, run: () => invoke('traderhub', tools.board, { board: 'valuation' }) }]
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
].filter(s => s.source !== 'none')

const unique = new Map()
for (const spec of specs) for (const req of requestsFor(spec)) unique.set(req.key, req)

const fetched = new Map()
const queue = [...unique.values()]
async function worker() {
  for (let req = queue.shift(); req; req = queue.shift()) {
    const fetchedAt = new Date().toISOString()
    try {
      const text = await req.run()
      const bytes = Buffer.from(text, 'utf8')
      if (bytes.length > MAX_BYTES) throw new Error('Payload exceeds collector limit')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const file = `evidence/${req.key.replace(/[^A-Za-z0-9._-]+/g, '_')}.${sha256.slice(0, 12)}.txt`
      await writeFile(join(runDir, file), bytes, { flag: 'wx' })
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
  schema: 'superai.global-map.manifest/1', runId, workspaceId, start,
  universe: { file: 'global-map.universe.json', revision: universe.revision, sha256: createHash('sha256').update(universeBytes).digest('hex') },
  collectedFrom: [...fetched.values()].map(f => f.fetchedAt).sort()[0], collectedTo: new Date().toISOString(),
  payloads: [...fetched.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), series,
}
await writeFile(join(runDir, 'global-map.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
const failed = manifest.payloads.filter(p => p.status !== 'ok')
process.stdout.write(JSON.stringify({ runId, runDir: relative(root, runDir).replaceAll('\\', '/'), payloads: manifest.payloads.length, failed: failed.map(f => ({ key: f.key, error: f.error })) }, null, 2) + '\n')
if (failed.length) process.exitCode = 2
