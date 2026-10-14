import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ToolCenter } from '../../../src/core/tool-center.js'
import { WorkspaceToolCenter } from '../../../src/core/workspace-tool-center.js'
import { registerCliRoutes } from '../../../src/server/cli.js'
import { createMonitorContextTools } from '../../../src/tool/monitor-context.js'
import { createMonitorServiceTools } from '../../../src/tool/monitor-service.js'

describe('monitor context through actual workspace CLI', () => {
  it('discovers and reads a hash-pinned archive without broker, agent, or order tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-cli-'))
    const now = new Date(Date.now() - 1000).toISOString()
    const sourceAt = new Date(Date.now() - 60_000).toISOString()
    const snapshot = {
      schemaVersion: 1, producer: { name: 'IbIvMonitor', version: '1', instanceId: 'synthetic-cli', startedAt: sourceAt }, generatedAt: now, connected: true,
      modules: [{ id: 'gex.SPX', active: true, metrics: [{ id: 'netGex', value: -1500000, unit: 'USD-per-1pct-move', source: 'IBKR',
        instrument: { symbol: 'SPX', secType: 'BASKET', exchange: 'MULTI', currency: 'USD', tradingClass: 'SPXW+ES', multiplier: '', expiries: ['20261012'], referenceFrame: 'ES-price-space' },
        sourceAt, horizon: 'intraday', sessionDate: null, sessionComplete: false, dataType: 'live', quality: 'usable', reason: 'ok', coverage: .9,
        algorithm: { id: 'GexProfileEngine', version: '1', parameters: { bucketSize: 5 } } }] }],
    }
    const bytes = JSON.stringify(snapshot)
    const hash = createHash('sha256').update(bytes).digest('hex')
    await mkdir(join(dir, 'snapshots')); await mkdir(join(dir, 'manifests'))
    await writeFile(join(dir, 'snapshots', hash + '.json'), bytes)
    const manifest = JSON.stringify({ schemaVersion: 1, sha256: hash, file: `snapshots/${hash}.json`, generatedAt: now })
    await writeFile(join(dir, 'latest.json'), manifest)
    const name = now.replace(/[-:.]/g, '').replace('Z', '0000Z') + `-${hash}.json`
    await writeFile(join(dir, 'manifests', name), manifest)
    const tools = new ToolCenter(); tools.register(createMonitorContextTools(async () => dir), 'monitor-context')
    tools.register(createMonitorServiceTools(null, async () => dir), 'monitor-service')
    const app = new Hono()
    registerCliRoutes(app, {
      toolCenter: tools, workspaceToolCenter: new WorkspaceToolCenter(), inboxStore: {} as never, entityStore: {} as never,
      getWorkspaceService: () => ({ registry: { get: () => ({ id: 'ws1', tag: 'fixture' }) } }) as never,
    })
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    if (!server.listening) await new Promise<void>(done => server.once('listening', done))
    const address = server.address() as { port: number }
    const execute = (args: string[]) => promisify(execFile)(process.execPath, [resolve('src/workspaces/cli/bin/openalice-cli.cjs'), ...args], {
      env: { ...process.env, OPENALICE_CLI_BIN: 'alice', AQ_WS_ID: 'ws1', OPENALICE_TOOL_SOCKET: '', OPENALICE_TOOL_URL: `http://127.0.0.1:${address.port}/cli` }, timeout: 10_000,
    })
    try {
      expect((await execute(['analysis', 'monitor-context', '--help'])).stdout).toContain('snapshot')
      const output = JSON.parse((await execute(['analysis', 'monitor-context', '--snapshot-id', hash])).stdout)
      expect(output).toMatchObject({ status: 'available', advisoryOnly: true, snapshotId: hash })
      expect(output.modules[0].metrics[0]).toMatchObject({ value: -1500000, unit: 'USD-per-1pct-move', sourceAt })
      expect((await execute(['analysis', 'monitor-context', '--as-of', now])).stdout).toContain(hash)
      expect(JSON.parse((await execute(['analysis', 'monitor-service-status'])).stdout)).toMatchObject({ controllerActive: false })
      expect(JSON.parse((await execute(['analysis', 'monitor-service-set', '--mode', 'research'])).stdout)).toMatchObject({ accepted: false })
      expect(JSON.parse((await execute(['analysis', 'monitor-history'])).stdout)).toMatchObject({ available: false })
      await expect(execute(['analysis', 'monitor-context', '--snapshot-id', '../../secret'])).rejects.toThrow()
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
