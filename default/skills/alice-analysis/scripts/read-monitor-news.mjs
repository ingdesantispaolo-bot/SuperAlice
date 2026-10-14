import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// Bounded data reader, not an Agent/model loop. Persist pages before their cursor.
const args = process.argv.slice(2)
const allowed = new Set(['--symbols', '--limit', '--max-pages', '--bootstrap'])
const options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || args[i + 1] === undefined) throw new Error('Use --symbols AAPL,JPM --limit 200 --max-pages 3 --bootstrap recent|all')
  options[args[i]] = args[i + 1]
}
const limit = Number(options['--limit'] ?? 200), maxPages = Number(options['--max-pages'] ?? 3)
if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) {
  throw new Error('limit must be 1–1000; max-pages must be 1–20')
}
const bootstrap = options['--bootstrap'] ?? 'recent'
if (!['recent', 'all'].includes(bootstrap)) throw new Error('bootstrap must be recent|all')
const symbols = [...new Set((options['--symbols'] ?? '').split(',').filter(Boolean))].sort()
if (symbols.length > 50 || symbols.some(symbol => !/^[A-Za-z0-9._/-]{1,24}$/.test(symbol))) throw new Error('Invalid symbol filter')
const workspaceId = process.env.AQ_WS_ID, projectId = process.env.OPENALICE_PROJECT_ID
if (!workspaceId || !projectId || !/^[a-zA-Z0-9_-]+$/.test(workspaceId)) throw new Error('Run inside an injected Alice Workspace shell')
const endpoint = new URL(process.env.OPENALICE_TOOL_URL ?? '')
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('Expected the injected loopback CLI endpoint')
}
const root = await realpath(process.cwd())
await realpath(join(root, '.alice')) // Refuse accidental execution from the source repository.
const scope = {projectId, workspaceId, symbols}
const scopeKey = createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 16)
const directory = join(root, 'research/market-assistant/news/ibiv', scopeKey)
await mkdir(directory, {recursive: true})
const contained = relative(root, await realpath(directory))
if (contained.startsWith('..') || isAbsolute(contained)) throw new Error('News storage escaped the Workspace')
const lockPath = join(directory, '.reader.lock'), owner = randomUUID()
const lock = await open(lockPath, 'wx') // A busy/crashed owner requires explicit recovery, never age-only stealing.
await lock.writeFile(JSON.stringify({owner, pid: process.pid, scope, at: new Date().toISOString()})); await lock.close()
const statePath = join(directory, 'cursor.json')
let state
const files = []
let hasMore = false
try {
  try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (state && (state.schemaVersion !== 1 || !isDeepStrictEqual(state.scope, scope) || !Number.isSafeInteger(state.nextCursor) || state.nextCursor < 0)) {
    throw new Error('Invalid persisted cursor; refusing to skip or reset it')
  }
  let cursor = state?.nextCursor ?? (bootstrap === 'all' ? 0 : undefined)
  for (let page = 0; page < maxPages; page++) {
    const response = await fetch(`${endpoint.href.replace(/\/$/, '')}/${encodeURIComponent(workspaceId)}/data/invoke`, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'x-openalice-project': projectId,
        ...(process.env.AQ_RUN_ID ? {'x-openalice-run': process.env.AQ_RUN_ID} : {})},
      body: JSON.stringify({tool: 'ibiv_news_latest', args: {limit, ...(cursor === undefined ? {} : {cursor}), ...(symbols.length ? {symbols} : {})}}),
      signal: AbortSignal.timeout(70_000),
    })
    const envelope = await response.json(), text = envelope.content?.[0]?.text
    if (typeof text !== 'string' || createHash('sha256').update(text, 'utf8').digest('hex') !== envelope._meta?.['ibivmonitor/sha256']) {
      throw new Error('News MCP evidence missing or hash mismatch; cursor retained')
    }
    const payload = JSON.parse(text)
    if (envelope.structuredContent && !isDeepStrictEqual(payload, envelope.structuredContent)) throw new Error('News structured evidence differs from canonical text')
    if (!response.ok || envelope.isError) throw new Error(`News stream unavailable: ${payload.error ?? response.status}; cursor retained`)
    if (payload.schema !== 'ibivmonitor.news-latest/1' || !Number.isSafeInteger(payload.cursor) || !Number.isSafeInteger(payload.nextCursor)
      || payload.cursor < 0 || payload.nextCursor < payload.cursor || (cursor !== undefined && payload.cursor !== cursor)
      || !Array.isArray(payload.items) || payload.count !== payload.items.length || typeof payload.hasMore !== 'boolean') {
      throw new Error('Invalid news page; cursor retained')
    }
    let previous = payload.cursor
    for (const item of payload.items) {
      if (!Number.isSafeInteger(item.seq) || item.seq <= previous || item.seq > payload.nextCursor) throw new Error('Invalid news sequence; cursor retained')
      previous = item.seq
    }
    if (payload.nextCursor !== previous || payload.hasMore && !payload.items.length) throw new Error('Invalid news continuation; cursor retained')
    const filename = `${String(payload.cursor)}-${String(payload.nextCursor)}-${owner}-${page}.mcp.json`
    await writeFile(join(directory, filename), `${JSON.stringify(envelope, null, 2)}\n`, {flag: 'wx'})
    // Prior pages remain inspectable pending analysis; advancing collection never marks delivery/analysis complete.
    state = {schemaVersion: 1, scope, nextCursor: payload.nextCursor, initializedWith: state?.initializedWith ?? bootstrap,
      collectedAt: new Date().toISOString(), pages: [...(state?.pages ?? []), filename]}
    const temp = join(directory, `cursor-${owner}.tmp`)
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {flag: 'wx'})
    await rename(temp, statePath)
    files.push(relative(root, join(directory, filename)))
    cursor = payload.nextCursor; hasMore = payload.hasMore
    if (!hasMore) break
  }
  console.log(JSON.stringify({nextCursor: state.nextCursor, hasMore, pages: files, cursorFile: relative(root, statePath),
    note: 'Pages saved before cursor. Persist a separate analysis watermark after inspecting them; backfilled at dates are not new market events.'}))
} finally {
  const current = JSON.parse(await readFile(lockPath, 'utf8'))
  if (current.owner === owner) await unlink(lockPath)
}
