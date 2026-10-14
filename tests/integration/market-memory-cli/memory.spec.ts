import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ToolCenter } from '../../../src/core/tool-center.js'
import { WorkspaceToolCenter } from '../../../src/core/workspace-tool-center.js'
import { registerCliRoutes } from '../../../src/server/cli.js'
import { resolveAliceProjectIdentity } from '@traderalice/guardian-runtime'
import { appResourcesHome, userDataHome } from '../../../src/core/paths.js'
import { marketMemoryFactories } from '../../../src/tool/market-memory.js'
import { appendMemoryEntry, getMarketContext } from '../../../src/domain/analysis/market-memory.js'
import { createHash } from 'node:crypto'

describe('scoped market memory through real CLI and filesystem', () => {
  it('restores identical evidence/event bytes with Git autocrlf enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-git-'))
    const restored = await mkdtemp(join(tmpdir(), 'memory-restored-'))
    const git = (args: string[]) => promisify(execFile)('git', ['-c', `safe.directory=${dir.replaceAll('\\', '/')}`, '-C', dir, ...args], { timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'absent-global-config') } })
    try {
      await mkdir(join(dir, '.alice')); await mkdir(join(dir, 'research'))
      await mkdir(join(restored, '.alice'))
      const original = 'Line one\r\nLine two\r\n'
      const sha256 = createHash('sha256').update(original).digest('hex')
      await writeFile(join(dir, 'research/input.txt'), original)
      const event = await appendMemoryEntry(dir, { kind: 'evidence', originalPath: 'research/input.txt', sha256, format: 'text', description: 'CRLF exact bytes', originalRunId: null }, { workspaceId: 'git-fixture', resumeId: null })
      await git(['init', '-q'])
      await git(['config', 'core.autocrlf', 'true'])
      await git(['add', '--', 'research/market-memory/v1'])
      await git(['-c', 'user.name=Memory test', '-c', 'user.email=memory@example.invalid', 'commit', '-qm', 'Exact-byte fixture'])
      const files = (await git(['ls-files', 'research/market-memory/v1'])).stdout.trim().split(/\r?\n/)
      await git(['checkout-index', `--prefix=${restored.replaceAll('\\', '/')}/`, '--', ...files])
      const name = `research/market-memory/v1/events/00000001-${event.eventId}.json`
      expect(await readFile(join(restored, name))).toEqual(await readFile(join(dir, name)))
      expect(await readFile(join(restored, `research/market-memory/v1/evidence/${sha256}.txt`), 'utf8')).toBe(original)
      expect((await getMarketContext(restored, { entityIds: ['test'] })).coverage.firstRecordedAt).toBe(event.recordedAt)
    } finally {
      await rm(dir, { recursive: true, force: true }); await rm(restored, { recursive: true, force: true })
    }
  })
  it('records a catalog locally, reads it with the monitor absent and isolates desks/project scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-cli-'))
    for (const desk of ['ws1', 'ws2']) await mkdir(join(dir, desk, '.alice'), { recursive: true })
    const center = new WorkspaceToolCenter()
    for (const factory of marketMemoryFactories) center.register(factory)
    const app = new Hono(), global = new ToolCenter()
    registerCliRoutes(app, {
      toolCenter: global, workspaceToolCenter: center, inboxStore: {} as never, entityStore: {} as never,
      getWorkspaceService: () => ({ registry: { get: (id: string) => ['ws1', 'ws2'].includes(id) ? { id, tag: id, dir: join(dir, id) } : undefined } }) as never,
    })
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    if (!server.listening) await new Promise<void>(done => server.once('listening', done))
    const port = (server.address() as { port: number }).port
    const run = (args: string[], ws = 'ws1') => promisify(execFile)(process.execPath, [resolve('src/workspaces/cli/bin/openalice-cli.cjs'), ...args], {
      env: { ...process.env, OPENALICE_CLI_BIN: 'alice', AQ_WS_ID: ws, OPENALICE_PROJECT_ID: '', OPENALICE_TOOL_SOCKET: '', OPENALICE_TOOL_URL: `http://127.0.0.1:${port}/cli` }, timeout: 10_000,
    })
    try {
      expect((await run(['memory', 'context', '--help'])).stdout).toContain('knownAsOf')
      const entry = {
        kind: 'catalog', entityId: 'italy.fitted.10y', label: 'Synthetic fitted curve', assetClass: 'rates', role: 'estimated-curve',
        source: 'fixture-bond-export', sourceSeriesId: 'IT-10Y-FIT', currency: 'EUR', unit: 'percent',
        method: { id: 'fixture-fit', version: '1', description: 'No observed benchmark equivalence' }, yieldType: 'unknown', benchmarkEquivalence: 'not-established',
      }
      const input = join(dir, 'entry.json'); await writeFile(input, JSON.stringify(entry))
      const saved = JSON.parse((await run(['memory', 'record', '--entry-json-file', input])).stdout)
      expect(saved.accepted).toBe(true)
      expect(JSON.parse((await run(['memory', 'catalog'])).stdout).entries).toHaveLength(1)
      const context = JSON.parse((await run(['memory', 'context', '--entity-ids', '["italy.fitted.10y"]'])).stdout)
      expect(context.catalog[0]).toMatchObject({ role: 'estimated-curve', benchmarkEquivalence: 'not-established' })
      expect(context.reevaluation).toMatchObject({ monitorContacted: false, performed: false, requiresNewEvidence: true })
      expect(JSON.parse((await run(['memory', 'catalog'], 'ws2')).stdout).entries).toEqual([])
      expect(JSON.parse((await run(['memory', 'catalog', '--owner-workspace-id', 'ws1'], 'ws2')).stdout).entries).toHaveLength(1)
      await expect(run(['memory', 'catalog', '--owner-workspace-id', 'unknown-project-desk'])).rejects.toThrow()
      await expect(run(['memory', 'record', '--entry-json', JSON.stringify(entry), '--workspace-id', 'ws2'])).rejects.toThrow()
      await expect(run(['memory', 'context', '--entity-ids', '["italy.fitted.10y"]', '--as-of', '2025-01-01T00:00:00Z'])).rejects.toThrow()
      const projectId = resolveAliceProjectIdentity({ home: userDataHome, appRoot: appResourcesHome }).id
      const response = await app.request('/cli/project/data/manifest', { headers: { 'x-openalice-project': projectId } })
      expect(response.status).toBe(200)
      expect((await response.json()).groups).not.toHaveProperty('memory')
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
