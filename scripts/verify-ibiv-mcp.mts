import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { MonitorMcpClient, MONITOR_MCP_COMMANDS } from '../src/domain/analysis/monitor-mcp.js'
import { MonitorService, monitorPlanSchema, readMonitorServiceStatus } from '../src/domain/analysis/monitor-service.js'
import { createMonitorMcpTools } from '../src/tool/monitor-mcp.js'
import { registerProjectCliRoutes } from '../src/server/project-cli.js'
import { ToolCenter } from '../src/core/tool-center.js'

// Actual SDK relay + WPF + CLI, same OS user. Only isolated stores and closed port 1.
const evidence = resolve('../evidence/ibiv-mcp', new Date().toISOString().replace(/[:.]/g, '-'))
const archive = join(evidence, 'archive'), config = join(evidence, 'config'), sqlite = join(evidence, 'sqlite')
for (const directory of [archive, config, sqlite]) await mkdir(directory, { recursive: true })
const executable = process.env.IBIV_MONITOR_PROBE_EXE ?? process.env.SUPERAI_MONITOR_SERVICE_EXE
if (!executable) throw new Error('Set IBIV_MONITOR_PROBE_EXE to the built monitor executable')
await writeFile(join(sqlite, 'ibivmonitor.db'), '')
await writeFile(join(config, 'config.json'), JSON.stringify({ DataDirectory: sqlite,
  IbHost: '127.0.0.1', IbPort: 1, IbClientId: 991, AutoReconnect: false, MacroAutoStart: false,
  AnalystAutoStart: false, CalendarEnabled: false, NewsEnabled: false, BackupEnabled: false,
  PredictionMarketsEnabled: false, MonitorBridgeEnabled: true, MonitorBridgeDirectory: archive,
  McpServerEnabled: true, McpAllowDataRequests: true }))
await writeFile(join(archive, 'service-policy.json'), JSON.stringify({ mode: 'research',
  plan: monitorPlanSchema.parse({ gexWindowSeconds: 0, backfillDaily: false }) }))
const client = new MonitorMcpClient({ executable, directory: archive, configDirectory: config, mcpEnabled: '1' })
let child: ChildProcess | undefined, service: MonitorService | null = null
let server: ReturnType<typeof serve> | undefined
const checks: string[] = []
const result: Record<string, unknown> = { startedAt: new Date().toISOString(),
  scope: 'Actual SDK, 20 remote schemas, WPF controller and Project CLI; same user, isolated SQLite, closed port 1', checks }
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.call(name, args)
  await writeFile(join(evidence, `${name}-${Date.now()}.json`), JSON.stringify(response, null, 2))
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text) }
}
try {
  const definitions = await client.discover()
  assert.equal(definitions.length, 20); checks.push('20 tools discovered while monitor stopped')
  await writeFile(join(evidence, 'tools.json'), JSON.stringify(definitions, null, 2))
  assert.equal((await call('monitor_status')).payload.running, false); checks.push('offline status with verified evidence')
  assert.equal((await call('monitor_context')).response.isError, true); checks.push('offline tool error preserved')
  const center = new ToolCenter(); center.register(await createMonitorMcpTools(client), 'monitor-mcp')
  const app = new Hono(); registerProjectCliRoutes(app, center, { id: 'ibiv-probe' } as never)
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>(done => server!.once('listening', done))
  const port = (server.address() as { port: number }).port
  const cli = (args: string[]) => promisify(execFile)(process.execPath,
    [resolve('src/workspaces/cli/bin/openalice-cli.cjs'), ...args], { timeout: 20_000,
      env: { ...process.env, OPENALICE_CLI_BIN: 'alice', AQ_WS_ID: '', OPENALICE_TOOL_SOCKET: '',
        OPENALICE_PROJECT_ID: 'ibiv-probe', OPENALICE_TOOL_URL: `http://127.0.0.1:${port}/cli` } })
  const manifest = await app.request('/cli/project/data/manifest', { headers: { 'x-openalice-project': 'ibiv-probe' } })
  assert.equal(Object.keys((await manifest.json()).groups.monitor).length, 20); checks.push('20 tools exposed through Project CLI')
  assert.ok((await cli(['monitor', 'history-request', '--help'])).stdout.includes('--years')); checks.push('live CLI schema discovery')
  service = await MonitorService.start({ directory: archive, executable, periodic: false, launch: exe => {
    child = spawn(exe, ['--background'], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, IBIVMONITOR_CONFIG_DIR: config, SUPERAI_MONITOR_CONTEXT_DIR: archive, IBIVMONITOR_MCP: '1' } })
    child.on('error', () => {})
  } })
  assert.ok(service && child)
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await readMonitorServiceStatus(archive)
    if (state.available) { assert.equal(state.connected, false); break }
    if (attempt === 39) throw new Error('Isolated monitor failed to start')
    await delay(500)
  }
  let online = false
  for (let attempt = 0; attempt < 20; attempt++) {
    online = (await call('monitor_status')).payload.running === true
    if (online) break
    await delay(500)
  }
  assert.ok(online); checks.push('same relay reconnects after controller starts monitor')
  const tracked = await call('instrument_track', { symbol: 'ASML', secType: 'STK', exchange: 'SMART', currency: 'USD' })
  assert.equal(tracked.payload.verified, false)
  const id = tracked.payload.instrument.id as string
  const second = (await call('instrument_track', { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' })).payload.instrument.id as string
  checks.push('offline tracking is explicitly unverified')
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date().toISOString()
  const argumentsByName: Record<string, Record<string, unknown>> = {
    instrument_resolve: { symbol: 'ASML', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    instrument_track: { symbol: 'ASML', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    history_request: { ids: [id], years: 2 },
    history_daily: { id, from, to }, history_intraday: { id, from, to },
    correlation_matrix: { ids: [id, second] }, relation_pair: { a: id, b: second },
    news_search: { text: 'earnings OR results', symbols: ['JPM'], from, to },
    news_latest: { cursor: 0, limit: 20 },
    news_article: { provider: 'DJ-N', articleId: 'isolated-nonexistent' },
    news_stats: { from, to }, analyst_actions: { tickers: ['AAPL'], limit: 20 },
  }
  for (const name of Object.values(MONITOR_MCP_COMMANDS)) {
    const read = await call(name, argumentsByName[name] ?? {})
    if (name === 'history_daily') { assert.equal(read.payload.count, 0); assert.notEqual(read.response.isError, true) }
    if (name === 'instrument_resolve') assert.equal(read.response.isError, true)
    if (name === 'news_latest') { assert.equal(read.payload.count, 0); assert.equal(read.payload.nextCursor, 0); assert.equal(read.response.isError, false) }
    if (name === 'news_article') assert.equal(read.response.isError, true)
    checks.push(`${name}: canonical evidence verified`)
  }
  const saved = join(evidence, 'cli-daily.json')
  await cli(['monitor', 'history-daily', '--id', id, '--limit', '300', '--from', from, '--output', saved])
  assert.ok(JSON.parse(await readFile(saved, 'utf8'))._meta['ibivmonitor/sha256'])
  checks.push('CLI numeric flags and --output preserve full MCP envelope')
  await assert.rejects(client.call('history_daily', { id, from: '2026-10-13T12:00:00' })); checks.push('timezone-less arguments rejected')
  await service.setPolicy({ mode: 'off', plan: {} })
  for (let attempt = 0; child!.exitCode === null && attempt < 40; attempt++) await delay(500)
  assert.equal(child!.exitCode, 0); checks.push('controller shuts down isolated monitor cleanly')
  assert.equal((await call('monitor_status')).payload.running, false)
  assert.equal((await call('history_daily', { id })).response.isError, true); checks.push('same relay returns offline after monitor exit')
  result.accepted = true
} catch (error) {
  result.accepted = false; result.error = error instanceof Error ? error.message : String(error); process.exitCode = 1
} finally {
  await client.dispose(); await service?.dispose()
  if (child && child.exitCode === null) child.kill()
  if (server && 'closeAllConnections' in server) server.closeAllConnections()
  if (server) await new Promise<void>(done => server!.close(() => done()))
  result.completedAt = new Date().toISOString(); result.ordersSubmitted = 0; result.modelCalls = 0
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ evidence, accepted: result.accepted, checks: checks.length, error: result.error }))
}
