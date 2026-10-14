import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getMarketContext, manageMemoryIndex } from './market-memory.js'
import { memoryEntrySchema, memoryEventSchema } from './market-memory-schema.js'
import { memoryContextSchema, selectMarketContext } from './market-memory-context.js'
import { indexedContextEvents, indexedEvents, withMemoryIndex } from './market-memory-index.js'
import { acquireMemoryLock, recoverMemoryLock } from './market-memory-lock.js'

const dirs: string[] = [], base = Date.parse('2026-10-14T10:00:00Z'), now = new Date(base + 100_000_000)
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex')
async function fixture(count = 8) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-index-')); dirs.push(dir)
  const root = join(dir, 'research/market-memory/v1'), eventDir = join(root, 'events')
  await mkdir(join(dir, '.alice')); await mkdir(eventDir, { recursive: true }); await mkdir(join(root, 'evidence'))
  await writeFile(join(root, '.gitattributes'), 'events/** -text\nevidence/** -text\n')
  const raw = '{"fixture":true}', evidenceHash = sha(raw)
  await writeFile(join(root, `evidence/${evidenceHash}.json`), raw)
  let previousHash: string | null = null, evidenceId = '', observationId = ''
  let pending: Promise<unknown>[] = []
  for (let sequence = 1; sequence <= count; sequence++) {
    const recordedAt = new Date(base + sequence * 1000).toISOString()
    const entry = sequence === 1 ? { kind: 'catalog', entityId: 'asset.gold', role: 'asset', assetClass: 'commodity', label: 'Synthetic gold' }
      : sequence === 2 ? { kind: 'catalog', entityId: 'series.gold', assetId: 'asset.gold', role: 'observed-series', assetClass: 'commodity', label: 'Synthetic series', source: 'fixture', sourceSeriesId: 'gold', unit: 'USD', currency: 'USD', method: { id: 'fixture', version: '1', description: 'Synthetic' }, yieldType: null, benchmarkEquivalence: 'not-established' }
        : sequence === 3 ? { kind: 'evidence', originalPath: 'research/input.json', sha256: evidenceHash, storedPath: `evidence/${evidenceHash}.json`, format: 'json', description: 'Synthetic metrics', originalRunId: null }
          : sequence === 5 ? { kind: 'thesis', thesisId: 'gold-long', entityIds: ['asset.gold'], horizon: 'long-term', version: 1, previousEventId: null, status: 'candidate', author: { type: 'superai' }, summary: 'Synthetic', invalidation: 'Synthetic', conditions: [], supportingObservationIds: [observationId], contraryObservationIds: [], openQuestions: [] }
            : memoryEntrySchema.parse({ kind: 'observation', entityId: 'series.gold', observationKey: 'close', value: sequence, unit: 'USD',
              observedPeriod: { start: new Date(base + sequence * 1000 - 1000).toISOString(), end: new Date(base + sequence * 1000 - 1000).toISOString() }, acquiredAt: recordedAt,
              publishedAt: null, publicationBasis: 'unknown', quality: 'usable', finality: 'final', expiresAt: '2030-01-01T00:00:00Z', evidenceIds: [evidenceId], supersedesId: null, note: 'Synthetic load observation' })
    const event = memoryEventSchema.parse({ schemaVersion: 2, sequence, recordedAt, previousHash, origin: { kind: 'session', workspaceId: 'fixture' }, entry })
    const bytes = JSON.stringify(event) + '\n', eventId = sha(bytes)
    if (sequence === 3) evidenceId = eventId
    if (sequence === 4) observationId = eventId
    previousHash = eventId
    pending.push(writeFile(join(eventDir, `${String(sequence).padStart(8, '0')}-${eventId}.json`), bytes))
    if (pending.length === 128) { await Promise.all(pending); pending = [] }
  }
  await Promise.all(pending)
  return { dir, root, eventDir, count }
}
const read = (_root: string, path: string) => readFile(path)
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) }, 60_000)

describe('derived market memory index', () => {
  it('rebuilds identical context from immutable events and verifies only new events plus the checkpoint', async () => {
    const f = await fixture()
    const first = await withMemoryIndex(f.root, read, (_db, receipt) => receipt)
    expect(first).toMatchObject({ sequence: 8, newlyVerified: 8 })
    const second = await withMemoryIndex(f.root, read, (_db, receipt) => receipt)
    expect(second).toMatchObject({ sequence: 8, newlyVerified: 0, hash: first.hash })
    const filename = (await readdir(f.eventDir)).sort().at(-1)!
    const prior = JSON.parse(await readFile(join(f.eventDir, filename), 'utf8'))
    const next = { ...prior, sequence: 9, previousHash: first.hash, recordedAt: new Date(base + 9000).toISOString(),
      entry: { ...prior.entry, observedPeriod: { start: new Date(base + 8000).toISOString(), end: new Date(base + 8000).toISOString() }, acquiredAt: new Date(base + 9000).toISOString() } }
    const bytes = JSON.stringify(next) + '\n'
    await writeFile(join(f.eventDir, `00000009-${sha(bytes)}.json`), bytes)
    expect(await withMemoryIndex(f.root, read, (_db, receipt) => receipt)).toMatchObject({ sequence: 9, newlyVerified: 1 })
    const query = memoryContextSchema.parse({ entityIds: ['asset.gold'], maxChars: 64000 })
    const full = await withMemoryIndex(f.root, read, db => selectMarketContext(indexedEvents(db), query, now.toISOString()).output)
    const indexed = await getMarketContext(f.dir, query, now)
    const { evidence: _evidence, ...packet } = indexed
    expect(packet).toEqual(full)
    const all = await withMemoryIndex(f.root, read, db => indexedEvents(db))
    for (const filter of [
      { knownAsOf: new Date(base - 1000).toISOString() },
      { knownAsOf: new Date(base + 7000).toISOString(), limit: 2 },
      { horizon: 'long-term', observedFrom: new Date(base + 7000).toISOString(), limit: 2 },
    ]) {
      const scoped = memoryContextSchema.parse({ ...query, ...filter })
      const at = scoped.knownAsOf ?? now.toISOString()
      const expected = selectMarketContext(all, scoped, at).output
      const { evidence: _sources, ...actual } = await getMarketContext(f.dir, scoped, now)
      expect(actual).toEqual(expected)
    }
    const receipt = await manageMemoryIndex(f.dir, 'rebuild')
    expect(receipt).toMatchObject({ sequence: 9, newlyVerified: 9, verificationScope: 'all-event-bytes' })
    expect(await getMarketContext(f.dir, query, now)).toEqual(indexed)
    expect((await readFile(join(f.root, '.gitignore'), 'utf8'))).toContain('index/')
  })
  it('full audit catches old-body corruption beyond the incremental checkpoint', async () => {
    const f = await fixture()
    await getMarketContext(f.dir, { entityIds: ['asset.gold'] }, now)
    const first = (await readdir(f.eventDir)).sort()[0]
    await writeFile(join(f.eventDir, first), '{}\n')
    await expect(manageMemoryIndex(f.dir, 'audit')).rejects.toThrow('integrity mismatch')
    await expect(manageMemoryIndex(f.dir, 'rebuild')).rejects.toThrow('integrity mismatch')
  })
  it('rejects replaced archive inventories and can rebuild a damaged derived database', async () => {
    const f = await fixture()
    const before = await getMarketContext(f.dir, { entityIds: ['asset.gold'], maxChars: 64000 }, now)
    await writeFile(join(f.root, 'index/market-memory.sqlite'), 'damaged-derived-index')
    await expect(getMarketContext(f.dir, { entityIds: ['asset.gold'] }, now)).rejects.toThrow()
    await manageMemoryIndex(f.dir, 'rebuild')
    expect(await getMarketContext(f.dir, { entityIds: ['asset.gold'], maxChars: 64000 }, now)).toEqual(before)
    const last = (await readdir(f.eventDir)).sort().at(-1)!
    await rm(join(f.eventDir, last))
    await expect(getMarketContext(f.dir, { entityIds: ['asset.gold'] }, now)).rejects.toThrow('inventory mismatch')
  })
  it('refuses live or unknown owners regardless of age, and recovers a verified dead PID', async () => {
    const f = await fixture(), live = await acquireMemoryLock(f.root, 'writer')
    await expect(recoverMemoryLock(f.root, 'writer')).rejects.toThrow('still alive')
    await live.release()
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
    const owner = { owner: randomUUID(), pid: child.pid, machine: hostname(), at: '1970-01-01T00:00:00Z' }
    await writeFile(join(f.root, '.writer.lock'), JSON.stringify(owner))
    expect(await manageMemoryIndex(f.dir, 'recover-lock')).toMatchObject({ recovered: true, previousPid: child.pid })
    await writeFile(join(f.root, '.index.lock'), JSON.stringify({ ...owner, machine: 'other-machine' }))
    await expect(recoverMemoryLock(f.root, 'index')).rejects.toThrow('unknown machine')
    await mkdir(join(f.root, '.lock-control'))
    await writeFile(join(f.root, '.lock-control/owner.json'), JSON.stringify(owner))
    expect(await recoverMemoryLock(f.root, 'control')).toMatchObject({ recovered: true, kind: 'control' })
  })
  it('retrieves bounded context from 50,000 persisted events under one second after indexing', async () => {
    const f = await fixture(50_000)
    const buildStarted = performance.now()
    await manageMemoryIndex(f.dir, 'rebuild')
    const buildMs = performance.now() - buildStarted, durations: number[] = []
    let selectionMs = 0
    const instrumentStart = performance.now()
    await withMemoryIndex(f.root, read, db => {
      const started = performance.now()
      indexedContextEvents(db, memoryContextSchema.parse({ entityIds: ['asset.gold'] }), now.toISOString(), (sql, ms) => console.info('memory-index query', JSON.stringify({ sql, ms })))
      selectionMs = performance.now() - started
    })
    console.info('memory-index profile', JSON.stringify({ selectionMs, verificationAndOpenMs: performance.now() - instrumentStart - selectionMs }))
    for (let i = 0; i < 3; i++) {
      const started = performance.now()
      const context = await getMarketContext(f.dir, { entityIds: ['asset.gold'], maxChars: 64000 }, now)
      durations.push(performance.now() - started)
      expect(context.theses).toHaveLength(1)
      expect(context.observations).toHaveLength(21)
      expect(context.coverage.observationResultsTruncated).toBe(true)
    }
    console.info('memory-index benchmark', JSON.stringify({ events: 50_000, buildMs, contextMs: durations }))
    if (process.env.SUPERAI_MEMORY_BENCHMARK_RECEIPT) await writeFile(process.env.SUPERAI_MEMORY_BENCHMARK_RECEIPT,
      JSON.stringify({ at: new Date().toISOString(), node: process.version, events: 50_000, buildMs, contextMs: durations, allUnderOneSecond: durations.every(ms => ms < 1000) }, null, 2))
    expect(Math.max(...durations)).toBeLessThan(1000)
  }, 180_000)
})
