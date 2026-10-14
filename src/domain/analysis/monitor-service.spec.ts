import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MonitorService, monitorPlanSchema, readMonitorHistory, readMonitorServiceStatus } from './monitor-service.js'

const now = Date.parse('2026-10-13T14:00:00Z')
const status = { schemaVersion: 1, instanceId: 'actual-monitor-fixture', pid: 123, updatedAt: new Date(now).toISOString(),
  owner: 'user', mode: 'manual', connected: true, status: 'Trading', led: '#22C55E', gexCollecting: true,
  macroRunning: true, activeLines: 23, peakLines: 30, instruments: [
    { id: 'ES', symbol: 'ES', secType: 'FUT', exchange: 'CME', realtimeAllowed: true },
    { id: 'XLK', symbol: 'XLK', secType: 'STK', exchange: 'SMART', realtimeAllowed: false },
  ] }
describe('monitor acquisition supervisor', () => {
  it('starts only the configured executable, refreshes a bounded lease, excludes a second controller and expires on shutdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-supervisor-'))
    const launches: string[][] = []
    const service = await MonitorService.start({ directory: dir, executable: process.execPath, now: () => now, periodic: false, launch: (exe, path) => { launches.push([exe, path]) } })
    try {
      expect(service).not.toBeNull(); expect(launches).toEqual([[process.execPath, dir]])
      const control = JSON.parse(await readFile(join(dir, 'control.json'), 'utf8'))
      expect(control.mode).toBe('research'); expect(control.plan.refreshSeconds).toBe(300)
      expect(Date.parse(control.expiresAt) - Date.parse(control.issuedAt)).toBe(90_000)
      expect(await MonitorService.start({ directory: dir, executable: process.execPath, periodic: false, launch: () => { throw Error('duplicate') } })).toBeNull()
      await service!.tick(); expect(launches).toHaveLength(1)
    } finally { await service?.dispose(); expect(JSON.parse(await readFile(join(dir, 'control.json'), 'utf8')).mode).toBe('off'); await rm(dir, { recursive: true, force: true }) }
  })
  it('reports manual priority, permits daily ETF history and rejects unapproved realtime instruments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-priority-'))
    await writeFile(join(dir, 'service-status.json'), JSON.stringify(status))
    const service = await MonitorService.start({ directory: dir, executable: process.execPath, now: () => now, periodic: false, launch: () => { throw Error('manual app already present') } })
    try {
      const outcome = await service!.setPolicy({ mode: 'research', plan: { realtimeIds: ['ES'], dailyIds: ['XLK'] } })
      expect(outcome.manualPriority).toBe(true)
      await expect(service!.setPolicy({ mode: 'research', plan: { realtimeIds: ['XLK'] } })).rejects.toThrow('eligibility')
      await expect(service!.setPolicy({ mode: 'research', plan: { dailyIds: ['UNKNOWN'] } })).rejects.toThrow('catalogue')
      expect((await service!.status()).requested.plan.dailyIds).toEqual(['XLK'])
      expect(await readMonitorServiceStatus(dir, now + 91_000)).toMatchObject({ available: false })
      expect(() => monitorPlanSchema.parse({ refreshSeconds: 1 })).toThrow()
      expect(() => monitorPlanSchema.parse({ gexWindowSeconds: 10 })).toThrow()
    } finally { await service?.dispose(); await rm(dir, { recursive: true, force: true }) }
  })
  it('keeps off persistent across controller restart without launching the monitor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-off-'))
    let service = await MonitorService.start({ directory: dir, executable: process.execPath, now: () => now, periodic: false, launch: () => {} })
    try {
      await service!.setPolicy({ mode: 'off', plan: {} }); await service!.dispose()
      service = await MonitorService.start({ directory: dir, executable: process.execPath, now: () => now, periodic: false, launch: () => { throw Error('off profile launched') } })
      expect((await service!.status()).requested.mode).toBe('off')
    } finally { await service?.dispose(); await rm(dir, { recursive: true, force: true }) }
  })
  it('does not replace a malformed persisted policy with automatic research', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-corrupt-'))
    await writeFile(join(dir, 'service-policy.json'), '{ incomplete')
    const service = await MonitorService.start({ directory: dir, executable: process.execPath, now: () => now, periodic: false,
      launch: () => { throw Error('Malformed policy started acquisition') } })
    try { expect((await service!.status()).requested.mode).toBe('off'); expect(await readFile(join(dir, 'service-policy.json'), 'utf8')).toBe('{ incomplete') }
    finally { await service?.dispose(); await rm(dir, { recursive: true, force: true }) }
  })
  it('verifies immutable daily history identity, units, times and original bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-history-'))
    try {
      await mkdir(join(dir, 'history'))
      const bars = [{ timestamp: '2026-10-12T20:00:00+00:00', price: 6123, open: 6000, high: 6200, low: 5990, volume: 100, fetchedAt: '2026-10-13T06:00:00+00:00' }]
      const bytes = JSON.stringify({ schemaVersion: 1, source: 'IBKR', horizon: 'daily', adjustment: 'source-native', unit: 'USD',
        instrument: { id: 'ES', symbol: 'ES', currency: 'USD' }, contract: { secType: 'CONTFUT' }, bars })
      const hash = createHash('sha256').update(bytes).digest('hex')
      await writeFile(join(dir, 'history', hash + '.json'), bytes)
      await writeFile(join(dir, 'history', 'index.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), instruments: [{ id: 'ES', snapshotId: hash, count: 1, lastSourceAt: bars[0].timestamp }] }))
      expect(await readMonitorHistory(dir, 'ES')).toMatchObject({ available: true, snapshotId: hash, bars, lineageComplete: true, contract: { secType: 'CONTFUT' } })
      expect(await readMonitorHistory(dir, '../secret')).toMatchObject({ available: false })
      await writeFile(join(dir, 'history', hash + '.json'), bytes.replace('6123', '9999'))
      expect(await readMonitorHistory(dir, 'ES')).toMatchObject({ available: false })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
