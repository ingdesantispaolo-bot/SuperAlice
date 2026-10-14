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
      const event = await appendMemoryEntry(dir, { kind: 'evidence', originalPath: 'research/input.txt', sha256, format: 'text', description: 'CRLF exact bytes', originalRunId: null }, { kind: 'session', workspaceId: 'git-fixture' })
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
      env: { ...process.env, OPENALICE_CLI_BIN: 'alice', AQ_WS_ID: ws, AQ_SESSION_ID: '', AQ_RUN_ID: '', OPENALICE_PROJECT_ID: '', OPENALICE_TOOL_SOCKET: '', OPENALICE_TOOL_URL: `http://127.0.0.1:${port}/cli` }, timeout: 10_000,
    })
    try {
      expect((await run(['memory', 'context', '--help'])).stdout).toContain('knownAsOf')
      expect((await run(['memory', 'context', '--help'])).stdout).toContain('includeExpired')
      const entry = {
        kind: 'catalog', entityId: 'italy.fitted.10y', label: 'Synthetic fitted curve', assetClass: 'rates', role: 'estimated-curve',
        assetId: 'asset.rates.it.10y', source: 'fixture-bond-export', sourceSeriesId: 'IT-10Y-FIT', currency: 'EUR', unit: 'percent',
        method: { id: 'fixture-fit', version: '1', description: 'No observed benchmark equivalence' }, yieldType: 'unknown', benchmarkEquivalence: 'not-established',
      }
      await run(['memory', 'record', '--entry-json', JSON.stringify({ kind: 'catalog', entityId: 'asset.rates.it.10y', label: 'Synthetic Italian rates', assetClass: 'rates', role: 'asset' })])
      const input = join(dir, 'entry.json'); await writeFile(input, JSON.stringify(entry))
      const saved = JSON.parse((await run(['memory', 'record', '--entry-json-file', input])).stdout)
      expect(saved.accepted).toBe(true)
      expect(JSON.parse((await run(['memory', 'catalog'])).stdout).entries).toHaveLength(2)
      const context = JSON.parse((await run(['memory', 'context', '--entity-ids', '["italy.fitted.10y"]'])).stdout)
      expect(context.schema).toBe('superai.market-context/2')
      expect(JSON.parse((await run(['memory', 'index', '--operation', 'audit'])).stdout)).toMatchObject({ sequence: 2, verificationScope: 'all-event-bytes' })
      expect(JSON.parse((await run(['memory', 'index', '--operation', 'rebuild'])).stdout)).toMatchObject({ sequence: 2, newlyVerified: 2 })
      const denied = await app.request('/cli/ws1/memory/index', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openalice-run': 'unknown-run' }, body: JSON.stringify({ operation: 'recover-lock' }) })
      expect(denied.status).toBe(403)
      const currentManifest = await (await app.request('/cli/ws1/data/manifest')).json()
      expect(JSON.stringify(currentManifest.groups.memory)).not.toContain('recover-lock')
      await mkdir(join(dir, 'ws1/research'), { recursive: true })
      const signalRaw = '{"fixture":"signal-source"}'
      await writeFile(join(dir, 'ws1/research/signal-source.json'), signalRaw)
      const source = JSON.parse((await run(['memory', 'record', '--entry-json', JSON.stringify({ kind: 'evidence', originalPath: 'research/signal-source.json',
        sha256: createHash('sha256').update(signalRaw).digest('hex'), format: 'json', description: 'Synthetic confirmed-signal source', originalRunId: 'fixture-check' })])).stdout)
      const confirmedAt = new Date(Date.now() - 1000).toISOString()
      const draft = { schema: 'superai.confirmed-signal-draft/1', status: 'confirmed', findingKey: 'fixture:rates', methodRevision: 'fixture-1',
        entry: { kind: 'signal', author: { type: 'superai', agent: 'codex' }, assetIds: ['asset.rates.it.10y'], horizon: 'intraday', signalType: 'fixture',
          summary: 'Synthetic confirmed signal', confirmedAt, expiresAt: new Date(Date.parse(confirmedAt) + 3600_000).toISOString(), sourceRunId: 'fixture-check', relatedThesisIds: [], evidenceIds: [source.eventId] } }
      await writeFile(join(dir, 'ws1/research/signal-draft.json'), JSON.stringify(draft))
      const publish = () => promisify(execFile)(process.execPath, [resolve('default/skills/alice-analysis/scripts/market-memory-signal.mjs'), '--draft', 'research/signal-draft.json', '--record'], {
        cwd: join(dir, 'ws1'), env: { ...process.env, AQ_WS_ID: 'ws1', AQ_RUN_ID: '', AQ_SESSION_ID: '', OPENALICE_PROJECT_ID: '', OPENALICE_TOOL_URL: `http://127.0.0.1:${port}/cli` }, timeout: 10_000 })
      const firstSignal = JSON.parse((await publish()).stdout), repeatedSignal = JSON.parse((await publish()).stdout)
      expect(firstSignal).toMatchObject({ accepted: true })
      expect(repeatedSignal).toMatchObject({ accepted: true, alreadyRecorded: true, eventId: firstSignal.eventId, recordedAt: firstSignal.recordedAt })
      const signalContext = JSON.parse((await run(['memory', 'context', '--entity-ids', '["asset.rates.it.10y"]'])).stdout)
      expect(signalContext.signals).toHaveLength(1)
      expect(signalContext.signals[0]).toMatchObject({ confirmedAt, expiresAt: draft.entry.expiresAt })
      expect(context.catalog.find((entry: { entityId: string }) => entry.entityId === 'italy.fitted.10y')).toMatchObject({ role: 'estimated-curve', benchmarkEquivalence: 'not-established' })
      expect(context.reevaluation).toMatchObject({ monitorContacted: false, performed: false, requiresNewEvidence: true })
      expect(JSON.parse((await run(['memory', 'catalog'], 'ws2')).stdout).entries).toEqual([])
      expect(JSON.parse((await run(['memory', 'catalog', '--owner-workspace-id', 'ws1'], 'ws2')).stdout).entries).toHaveLength(2)
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

  it('keeps user approval outside agent tools and activates only from a host scheduled review', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-user-approval-'))
    const ws = join(dir, 'ws1')
    await mkdir(join(ws, '.alice'), { recursive: true })
    await mkdir(join(ws, 'research/market-assistant/global-map'), { recursive: true })
    const origin = { kind: 'session' as const, workspaceId: 'ws1' }
    const append = (entry: unknown) => appendMemoryEntry(ws, entry, origin)
    const assetId = 'asset.cmd.gold.fixture', seriesId = 'series.cmd.gold.fixture'
    await append({ kind: 'catalog', entityId: assetId, label: 'Synthetic asset', assetClass: 'commodity', role: 'asset' })
    await append({ kind: 'catalog', entityId: seriesId, assetId, label: 'Synthetic series', assetClass: 'commodity', role: 'observed-series',
      source: 'fixture', sourceSeriesId: 'fixture', currency: 'USD', unit: 'USD/oz', method: { id: 'fixture', version: '1', description: 'Synthetic' }, yieldType: null, benchmarkEquivalence: 'not-established' })
    const raw = '{"synthetic":true}\n'
    await writeFile(join(ws, 'research/metrics.json'), raw)
    const evidence = await append({ kind: 'evidence', originalPath: 'research/metrics.json', sha256: createHash('sha256').update(raw).digest('hex'), format: 'json', description: 'Synthetic fixture', originalRunId: 'fixture' })
    const at = '2026-10-13T10:00:00Z'
    const observation = await append({ kind: 'observation', entityId: seriesId, observationKey: 'close', value: 2, unit: 'USD/oz',
      observedPeriod: { start: at, end: at }, publishedAt: null, publicationBasis: 'unknown', acquiredAt: at,
      quality: 'usable', finality: 'final', expiresAt: null, evidenceIds: [evidence.eventId], supersedesId: null, note: 'Synthetic' })
    await writeFile(join(ws, 'research/market-assistant/global-map/measures.json'), JSON.stringify({ schema: 'superai.measures/1', methodVersion: '1',
      measures: [{ assetId, seriesId, measureKey: 'close', timeframe: '1D', unit: 'USD/oz', definition: 'Closed fixture bar', completedBarsOnly: true }] }))
    const thesis = { kind: 'thesis', author: { type: 'user' }, thesisId: 'user-fixture', entityIds: [assetId], horizon: 'long-term', version: 1, previousEventId: null,
      status: 'candidate', summary: 'Synthetic user opinion', invalidation: 'Below fixture threshold', supportingObservationIds: [observation.eventId], contraryObservationIds: [], openQuestions: [],
      conditions: [{ conditionId: 'invalid-close', role: 'invalidation', assetId, measureKey: 'close', timeframe: '1D', op: '<', threshold: 1, consecutive: 1 }] }
    const candidate = await append(thesis)
    const center = new WorkspaceToolCenter()
    marketMemoryFactories.forEach(f => center.register(f))
    const svc = {
      registry: { get: (id: string) => id === 'ws1' ? { id, tag: id, dir: ws } : undefined },
      headlessTasks: { get: (id: string) => id === 'run-review' ? { taskId: id, resumeId: 'resume-review', agent: 'codex', status: 'running', trigger: { kind: 'issue', workspaceId: 'ws1', issueId: 'saturday' } } : null },
      sessionRegistry: { get: (_ws: string, id: string) => id === 'session-chat' ? { id, wsId: 'ws1', resumeId: 'resume-chat', agent: 'codex' } : undefined },
      issueDetail: async () => ({ issue: { id: 'saturday', status: 'todo', when: { kind: 'cron', cron: '0 10 * * 6', timezone: 'Europe/Rome' } } }),
    }
    const app = new Hono()
    registerCliRoutes(app, { toolCenter: new ToolCenter(), workspaceToolCenter: center, inboxStore: {} as never, entityStore: {} as never, getWorkspaceService: () => svc as never })
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    if (!server.listening) await new Promise<void>(done => server.once('listening', done))
    const port = (server.address() as { port: number }).port
    const projectId = resolveAliceProjectIdentity({ home: userDataHome, appRoot: appResourcesHome }).id
    const run = (args: string[], extra: Record<string, string> = {}) => promisify(execFile)(process.execPath, [resolve('src/workspaces/cli/bin/openalice-cli.cjs'), ...args], {
      env: { ...process.env, OPENALICE_CLI_BIN: 'alice', AQ_WS_ID: '', AQ_RUN_ID: '', AQ_SESSION_ID: '', OPENALICE_PROJECT_ID: projectId,
        OPENALICE_TOOL_SOCKET: '', OPENALICE_TOOL_URL: `http://127.0.0.1:${port}/cli`, ...extra }, timeout: 10_000,
    })
    try {
      const manifest = await app.request('/cli/ws1/data/manifest')
      expect((await manifest.json()).groups.memory).not.toHaveProperty('approve')
      const approval = { kind: 'approval', targetEventId: candidate.eventId, decision: 'approve', note: 'User reviewed fixture' }
      const approveArgs = ['memory', 'approve', '--workspace-id', 'ws1', '--target-event-id', candidate.eventId, '--decision', 'approve', '--note', approval.note]
      expect((await run(['memory', 'approve', '--help'])).stdout).toContain('--target-event-id')
      await expect(run(approveArgs, { AQ_SESSION_ID: 'session-chat' })).rejects.toThrow('user terminal')
      await expect(run(approveArgs, { AQ_RUN_ID: 'run-review' })).rejects.toThrow('user terminal')
      for (const header of ['x-openalice-run', 'x-openalice-session']) {
        expect((await app.request('/cli/ws1/memory/approval', { method: 'POST', headers: { 'content-type': 'application/json', [header]: 'even-an-unknown-agent' }, body: JSON.stringify(approval) })).status).toBe(403)
      }
      expect((await app.request('/cli/ws1/memory/approval', { method: 'POST', body: JSON.stringify({ ...approval, origin: { kind: 'user-surface' } }) })).status).toBe(400)
      expect((await app.request('/cli/ws1/memory/approval', { method: 'POST', headers: { 'x-openalice-project': 'wrong-project' }, body: JSON.stringify(approval) })).status).toBe(403)
      expect((await app.request('/cli/ws1/data/invoke', { method: 'POST', body: JSON.stringify({ tool: 'market_memory_approval', args: approval }) })).status).toBe(404)
      await expect(run(['memory', 'record', '--entry-json', JSON.stringify(approval)], { AQ_WS_ID: 'ws1' })).rejects.toThrow('user terminal')
      const accepted = JSON.parse((await run(approveArgs)).stdout)
      expect(accepted.accepted).toBe(true)
      const active = { ...thesis, status: 'active', version: 2, previousEventId: candidate.eventId, activationBasis: { type: 'user-approval', approvalEventId: accepted.eventId } }
      await expect(run(['memory', 'record', '--entry-json', JSON.stringify(active)], { AQ_WS_ID: 'ws1', AQ_SESSION_ID: 'session-chat' })).rejects.toThrow('chat cannot activate')
      const activated = JSON.parse((await run(['memory', 'record', '--entry-json', JSON.stringify(active)], { AQ_WS_ID: 'ws1', AQ_RUN_ID: 'run-review' })).stdout)
      expect(activated.accepted).toBe(true)
      const events = await import('node:fs/promises').then(fs => fs.readdir(join(ws, 'research/market-memory/v1/events')))
      const approvalFile = events.find(file => file.includes(accepted.eventId))!
      expect(JSON.parse(await readFile(join(ws, 'research/market-memory/v1/events', approvalFile), 'utf8')).origin).toEqual({ kind: 'user-surface', workspaceId: 'ws1' })
      const context = await getMarketContext(ws, { entityIds: [assetId] }, new Date(Date.now() + 1000))
      expect(context.theses[0]).toMatchObject({ author: { type: 'user' }, status: 'active', origin: { kind: 'issue', workspaceId: 'ws1', resumeId: 'resume-review', issueId: 'saturday' } })
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
