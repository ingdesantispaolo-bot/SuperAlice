import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { monitorSnapshotSchema, readMonitorContext, type MonitorSnapshot } from './monitor-context.js'

const at = '2026-10-12T14:00:00.000Z'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

function sample(): MonitorSnapshot {
  return {
    schemaVersion: 1, generatedAt: at, connected: true,
    producer: { name: 'IbIvMonitor', version: '1.0.0.0', instanceId: 'synthetic-test-only', startedAt: '2026-10-12T13:00:00Z' },
    modules: [{ id: 'gex.SPX', active: true, metrics: [{
      id: 'netGex', value: -1500000, unit: 'USD-per-1pct-move', source: 'IBKR',
      instrument: { symbol: 'SPX', secType: 'BASKET', exchange: 'MULTI', currency: 'USD', tradingClass: 'SPXW+ES', multiplier: '', expiries: ['20261012'], referenceFrame: 'ES-price-space' },
      sourceAt: '2026-10-12T13:59:00Z', horizon: 'intraday', sessionDate: null, sessionComplete: false,
      dataType: 'live', quality: 'usable', reason: 'ok', coverage: 0.9,
      algorithm: { id: 'GexProfileEngine/sweep/confirmed', version: '1', parameters: { bucketSize: 5 } },
    }] }],
  }
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-context-')); dirs.push(dir)
  await mkdir(join(dir, 'snapshots')); await mkdir(join(dir, 'manifests'))
  return dir
}
async function publish(dir: string, snapshot: unknown, generatedAt = at) {
  const bytes = JSON.stringify(snapshot)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const manifest = { schemaVersion: 1, sha256: hash, file: `snapshots/${hash}.json`, generatedAt }
  const manifestName = new Date(generatedAt).toISOString().replace(/[-:.]/g, '').replace('Z', '0000Z') + `-${hash}.json`
  await writeFile(join(dir, manifest.file), bytes)
  await writeFile(join(dir, 'manifests', manifestName), JSON.stringify(manifest))
  await writeFile(join(dir, 'latest.json'), JSON.stringify(manifest))
  return hash
}
async function context(snapshot = sample(), now = new Date(at)) {
  const dir = await directory(); await publish(dir, snapshot)
  const result = await readMonitorContext(dir, {}, now)
  if (!('modules' in result)) throw new Error(JSON.stringify(result))
  return result
}
describe('monitor context archive', () => {
  it('preserves sign, units, expiry, parameters and content hash', async () => {
    const result = await context()
    expect(result.status).toBe('available')
    expect(result.modules[0].metrics[0]).toMatchObject({ value: -1500000, unit: 'USD-per-1pct-move', usableForResearch: true })
    expect(result.modules[0].metrics[0].instrument).toMatchObject({ expiries: ['20261012'], referenceFrame: 'ES-price-space' })
    expect(result.evidence.sha256).toBe(createHash('sha256').update(await readFile(result.evidence.file)).digest('hex'))
  })
  it('does not refresh an old observation when publication is new', async () => {
    const snapshot = sample(); snapshot.modules[0].metrics[0].sourceAt = '2026-10-12T13:50:00Z'
    expect((await context(snapshot)).modules[0].metrics[0]).toMatchObject({ quality: 'stale', usableForResearch: false })
  })
  it.each(['delayed', 'frozen', 'unknown'] as const)('exposes %s feed as degraded', async dataType => {
    const snapshot = sample(); snapshot.modules[0].metrics[0].dataType = dataType
    expect((await context(snapshot)).status).toBe('degraded')
  })
  it('makes stopped modules missing and a disconnected intraday feed stale', async () => {
    const stopped = sample(); stopped.modules[0].active = false
    expect((await context(stopped)).status).toBe('missing')
    const disconnected = sample(); disconnected.connected = false
    expect((await context(disconnected)).status).toBe('stale')
  })
  it('accepts a completed daily session but rejects a partial session and an expired heartbeat', async () => {
    const snapshot = sample(); Object.assign(snapshot.modules[0].metrics[0], { horizon: 'daily', sourceAt: '2026-10-09T00:00:00Z', sessionDate: '2026-10-09', sessionComplete: true, dataType: 'historical' })
    expect((await context(snapshot)).status).toBe('available')
    expect((await context(snapshot, new Date('2026-10-12T14:06:00Z'))).status).toBe('stale')
    snapshot.modules[0].metrics[0].sessionComplete = false
    expect((await context(snapshot)).status).toBe('missing')
  })
  it('selects only publications at or before asOf and pins archived hashes', async () => {
    const dir = await directory()
    const previous = sample(); previous.generatedAt = '2026-10-12T13:59:00.000Z'; previous.modules[0].metrics[0].value = -10
    const hash = await publish(dir, previous, previous.generatedAt)
    await publish(dir, sample())
    const result = await readMonitorContext(dir, { asOf: '2026-10-12T13:59:30Z' }, new Date(at))
    expect(result).toMatchObject({ snapshotId: hash, historical: true })
    const pinned = await readMonitorContext(dir, { snapshotId: hash }, new Date(at))
    expect(pinned).toMatchObject({ snapshotId: hash, asOf: previous.generatedAt })
    expect(await readMonitorContext(dir, { asOf: '2026-10-12T13:58:00Z' }, new Date(at))).toMatchObject({ status: 'missing' })
  })
  it('fails closed on corrupt, incompatible, injected or incomplete files', async () => {
    const dir = await directory(); const hash = await publish(dir, sample())
    await writeFile(join(dir, `snapshots/${hash}.json`), '{')
    expect(await readMonitorContext(dir, {}, new Date(at))).toMatchObject({ status: 'invalid', reason: 'snapshot-hash-mismatch' })
    await publish(dir, { ...sample(), schemaVersion: 2 })
    expect(await readMonitorContext(dir, {}, new Date(at))).toMatchObject({ status: 'invalid' })
    await publish(dir, { ...sample(), apiKey: 'synthetic-secret-must-be-rejected' })
    expect(await readMonitorContext(dir, {}, new Date(at))).toMatchObject({ status: 'invalid' })
    await writeFile(join(dir, 'latest.json'), '{')
    expect(await readMonitorContext(dir, {}, new Date(at))).toMatchObject({ status: 'invalid' })
  })
  it('rejects traversal, nonexistent files, future publications and unqualified selectors', async () => {
    const dir = await directory(); await publish(dir, sample())
    await writeFile(join(dir, 'latest.json'), JSON.stringify({ schemaVersion: 1, sha256: 'a'.repeat(64), file: '../secret.json', generatedAt: at }))
    expect(await readMonitorContext(dir, {}, new Date(at))).toMatchObject({ status: 'invalid' })
    expect(await readMonitorContext(dir, { snapshotId: '../secret' })).toMatchObject({ status: 'invalid' })
    expect(await readMonitorContext(dir, { asOf: '2026-10-12' })).toMatchObject({ status: 'invalid' })
    expect(await readMonitorContext(null)).toMatchObject({ status: 'missing' })
    const future = sample(); future.generatedAt = '2026-10-12T15:00:00Z'
    await publish(dir, future, future.generatedAt)
    expect(await readMonitorContext(dir, {}, new Date(at))).toMatchObject({ status: 'invalid' })
  })
  it('marks unknown or future observation times unusable', async () => {
    const snapshot = sample(); snapshot.modules[0].metrics[0].sourceAt = null
    expect((await context(snapshot)).status).toBe('missing')
    snapshot.modules[0].metrics[0].sourceAt = '2026-10-12T14:01:00Z'
    expect((await context(snapshot)).status).toBe('missing')
  })
  it('strictly bounds the wire contract', () => {
    expect(monitorSnapshotSchema.safeParse(sample()).success).toBe(true)
    const snapshot = sample(); snapshot.modules[0].metrics[0].value = Infinity
    expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false)
  })
})
