import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemoryEntry, getMarketContext, readMemoryCatalog, type MemoryEntry } from './market-memory.js'

const dirs: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const baseTime = Date.parse('2026-10-14T10:00:00Z')
const origin = { workspaceId: 'fixture-desk', resumeId: 'resume-fixture' }
const entityId = 'gold.spot.test'
const catalog = (entity = entityId, changes = {}) => ({
  kind: 'catalog', entityId: entity, label: 'Synthetic fixture, not a market observation', assetClass: 'commodity',
  role: 'observed-series', source: 'fixture', sourceSeriesId: entity, currency: 'USD', unit: 'USD/oz',
  method: { id: 'fixture-close', version: '1', description: 'Test only' }, yieldType: null, benchmarkEquivalence: 'not-established', ...changes,
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'alice-market-memory-')); dirs.push(dir)
  await mkdir(join(dir, '.alice')); await mkdir(join(dir, 'research'))
  let tick = 0
  const append = (entry: unknown) => appendMemoryEntry(dir, entry, origin, new Date(baseTime + ++tick * 1000))
  const query = (input = {}) => getMarketContext(dir, { entityIds: [entityId], ...input }, new Date(baseTime + 100_000))
  await append(catalog())
  const original = JSON.stringify({ source: 'synthetic', observedAt: '2023-10-12', value: 2000 }) + '\n'
  await writeFile(join(dir, 'research/original.json'), original)
  const evidence = await append({ kind: 'evidence', originalPath: 'research/original.json', sha256: sha(original), format: 'json', description: 'Synthetic original report input', originalRunId: 'run-fixture' })
  const observationInput = {
    kind: 'observation', entityId, observationKey: 'close', value: 2000, unit: 'USD/oz',
    observedPeriod: { start: '2023-10-12T00:00:00Z', end: '2023-10-12T20:00:00Z' },
    publishedAt: null, publicationBasis: 'unknown', acquiredAt: '2026-10-13T12:00:00Z',
    quality: 'usable', finality: 'final', expiresAt: '2026-10-14T10:01:00Z',
    evidenceIds: [evidence.eventId], supersedesId: null, note: 'Historical import, not knowledge in 2023',
  }
  const observed = await append(observationInput)
  const thesis = (name: string, horizon = 'long-term', summary = 'Positive long-term fixture thesis') => ({
    kind: 'thesis', thesisId: name, entityIds: [entityId], horizon, version: 1, previousEventId: null,
    status: 'active', summary, invalidation: 'A documented contrary observation', supportingObservationIds: [observed.eventId], contraryObservationIds: [], openQuestions: ['Need independent verification'],
  })
  return { dir, append, query, evidence, observed, thesis, observationInput, original }
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('market memory temporal and offline contract', () => {
  it('does not classify unknown expiry as perpetually fresh evidence', async () => {
    const f = await fixture()
    await f.append({ ...f.observationInput, observationKey: 'unknown-expiry', expiresAt: null })
    const context = await f.query()
    expect(context.observations.find(o => o.observationKey === 'unknown-expiry')).toMatchObject({ freshnessUnknown: true, usableForReevaluation: false })
    expect(context.reevaluation.requiresNewEvidence).toBe(true)
  })
  it('keeps opposite short/long interpretations, references and origin together', async () => {
    const f = await fixture()
    await f.append(f.thesis('gold-long'))
    await f.append(f.thesis('gold-short', 'intraday', 'Negative intraday fixture thesis'))
    const context = await f.query()
    expect(context.theses).toHaveLength(2)
    expect(context.theses.map(t => 'horizon' in t ? t.horizon : null)).toEqual(['long-term', 'intraday'])
    expect(context.theses[0].origin).toEqual(origin)
    expect(context.evidence[0].sha256).toBe(sha(f.original))
    expect(context.reevaluation).toMatchObject({ performed: false, monitorContacted: false, sourceAccess: 'cached-only' })
  })

  it('does not backdate imported knowledge to the data period or original run', async () => {
    const f = await fixture()
    const context = await f.query({ knownAsOf: '2024-01-01T00:00:00Z' })
    expect(context.status).toBe('insufficient-history')
    expect(context.observations).toEqual([])
    expect(context.coverage).toMatchObject({ importsBackdateKnowledge: false, historicalSourceCoverage: 'not-attested' })
    expect(context.coverage.firstRecordedAt).toBe('2026-10-14T10:00:01.000Z')
  })

  it('excludes later revisions at a known cutoff and replays deterministically', async () => {
    const f = await fixture()
    const v1 = await f.append(f.thesis('gold-long'))
    await f.append({ ...f.thesis('gold-long'), version: 2, previousEventId: v1.eventId, status: 'invalidated', summary: 'The later interpretation is different' })
    const before = await f.query({ knownAsOf: v1.recordedAt })
    const replay = await f.query({ knownAsOf: v1.recordedAt })
    expect(before).toEqual(replay)
    expect(before.theses).toHaveLength(1)
    expect(before.theses[0]).toMatchObject({ version: 1, status: 'active' })
    expect((await f.query()).theses[0]).toMatchObject({ version: 2, status: 'invalidated' })
  })

  it('retains a thesis offline and marks expired evidence as insufficient for fresh evaluation', async () => {
    const f = await fixture()
    await f.append(f.thesis('gold-long'))
    await rm(join(f.dir, 'research/original.json')) // Source disappears, verified copy survives.
    const context = await f.query()
    expect(context.theses[0]).toMatchObject({ status: 'active' })
    expect(context.observations[0]).toMatchObject({ staleAtQuery: true, usableForReevaluation: false })
    expect(context.reevaluation.requiresNewEvidence).toBe(true)
    expect(context.evidence).toHaveLength(1)
  })

  it('preserves original bytes during correction/reconciliation and labels pinned older evidence', async () => {
    const f = await fixture()
    await f.append(f.thesis('gold-long'))
    const next = await f.append({ ...f.observationInput, value: 2001, supersedesId: f.observed.eventId, note: 'Correction from the source, retained separately' })
    await f.append({ kind: 'reconciliation', originalEvidenceId: f.evidence.eventId, observationId: next.eventId, result: 'different', explanation: 'Synthetic comparison of archived and later measurements' })
    expect(await readFile(join(f.dir, 'research/original.json'), 'utf8')).toBe(f.original)
    const context = await f.query()
    expect(context.observations).toHaveLength(2)
    expect(context.observations.find(o => o.eventId === f.observed.eventId)).toMatchObject({ value: 2000, supersededAtQuery: true, usableForReevaluation: false })
    expect(context.reconciliations[0]).toMatchObject({ result: 'different' })
    expect(await readFile(join(f.dir, context.evidence[0].path), 'utf8')).toBe(f.original)
  })

  it('keeps BTP fitted and benchmark yields distinct and refuses identity replacement', async () => {
    const f = await fixture()
    await f.append(catalog('italy.fitted.10y', { role: 'estimated-curve', assetClass: 'rates', source: 'user-bond-export', unit: 'percent', currency: 'EUR', yieldType: 'unknown', method: { id: 'fit-test', version: '1', description: 'Estimated tenor, not observed benchmark' } }))
    await f.append(catalog('italy.benchmark.10y', { role: 'benchmark', assetClass: 'rates', source: 'benchmark-source', unit: 'percent', currency: 'EUR', yieldType: 'yield-to-maturity' }))
    const context = await f.query({ entityIds: ['italy.fitted.10y', 'italy.benchmark.10y'] })
    expect(context.catalog).toHaveLength(2)
    expect(context.catalog.every(c => 'benchmarkEquivalence' in c && c.benchmarkEquivalence === 'not-established')).toBe(true)
    await expect(f.append(catalog('italy.fitted.10y', { role: 'benchmark' }))).rejects.toThrow('identity is immutable')
  })

  it('retains supporting/contrary references beyond the ordinary observation limit', async () => {
    const f = await fixture()
    const next = await f.append({ ...f.observationInput, value: 2001, supersedesId: f.observed.eventId })
    await f.append({ ...f.thesis('gold-long'), contraryObservationIds: [next.eventId] })
    const context = await f.query({ limit: 1 })
    expect(context.observations.map(o => o.eventId).sort()).toEqual([f.observed.eventId, next.eventId].sort())
    expect(context.theses[0]).toMatchObject({ contraryObservationIds: [next.eventId] })
    await expect(f.query({ maxChars: 4000 })).rejects.toThrow('Context output limit')
  })

  it('rejects corruption as an integrity error rather than missing coverage', async () => {
    const f = await fixture()
    const files = (await readdir(join(f.dir, 'research/market-memory/v1/events'))).sort()
    await writeFile(join(f.dir, 'research/market-memory/v1/events', files.at(-1)!), '{}\n')
    await expect(f.query()).rejects.toThrow('integrity mismatch')
  })

  it('rejects invalid references, backdated clocks, unit swaps and concurrent revisions', async () => {
    const f = await fixture()
    await expect(f.append({ ...f.observationInput, evidenceIds: ['0'.repeat(64)], supersedesId: f.observed.eventId })).rejects.toThrow('Missing evidence')
    await expect(f.append({ ...f.observationInput, unit: 'percent' })).rejects.toThrow('unit differs')
    await expect(f.append({ ...f.observationInput, acquiredAt: '2030-01-01T00:00:00Z' })).rejects.toThrow('clocks')
    const v1 = await f.append(f.thesis('gold-long'))
    await expect(f.append({ ...f.thesis('gold-long'), version: 2, previousEventId: null })).rejects.toThrow('revision')
    await writeFile(join(f.dir, 'research/market-memory/v1/.writer.lock'), JSON.stringify({ owner: 'other-writer' }))
    await expect(f.append({ ...f.thesis('gold-long'), version: 2, previousEventId: v1.eventId })).rejects.toThrow()
    expect((await f.query()).theses[0]).toMatchObject({ version: 1 })
  })

  it('refuses paths outside research and forged MCP evidence', async () => {
    const f = await fixture()
    await expect(f.append({ kind: 'evidence', originalPath: '../secret.json', sha256: sha(f.original), format: 'json', description: 'bad', originalRunId: null })).rejects.toThrow('research artifact')
    const forged = JSON.stringify({ content: [{ type: 'text', text: '{"value":1}' }], _meta: { 'ibivmonitor/sha256': '0'.repeat(64) } })
    await writeFile(join(f.dir, 'research/forged.json'), forged)
    await expect(f.append({ kind: 'evidence', originalPath: 'research/forged.json', sha256: sha(forged), format: 'mcp', description: 'forged', originalRunId: null })).rejects.toThrow('Canonical MCP')
    expect((await readMemoryCatalog(f.dir)).recordCount).toBe(3)
  })

  it('uses no monitor connection while reading a valid canonical MCP copy', async () => {
    const f = await fixture()
    const canonical = '{"value":2,"unit":"USD/oz"}'
    const raw = JSON.stringify({ content: [{ type: 'text', text: canonical }], structuredContent: { unit: 'USD/oz', value: 2 }, _meta: { 'ibivmonitor/sha256': sha(canonical) } }, null, 2)
    await writeFile(join(f.dir, 'research/mcp.json'), raw)
    const evidence = await f.append({ kind: 'evidence', originalPath: 'research/mcp.json', sha256: sha(raw), format: 'mcp', description: 'MCP exact bytes', originalRunId: null })
    await f.append({ ...f.observationInput, evidenceIds: [evidence.eventId], observationKey: 'separate-metric' })
    const context = await f.query()
    const stored = context.evidence.find(e => e.eventId === evidence.eventId)!
    expect(await readFile(join(f.dir, stored.path), 'utf8')).toBe(raw)
    expect(context.reevaluation.monitorContacted).toBe(false)
  })

  it('keeps import/producer clocks distinct and blocks measurements on unresolved identities', async () => {
    const f = await fixture()
    await f.append(catalog('pending.BTP', { availability: 'pending' }))
    await expect(f.append({ ...f.observationInput, entityId: 'pending.BTP' })).rejects.toThrow('Pending catalog')
    await f.append({ ...f.observationInput, observationKey: 'date-labelled', periodBasis: 'session-date-label', acquisitionBasis: 'artifact-import', sourceFetchedAt: '2023-10-13T12:00:00Z' })
    const context = await f.query()
    expect(context.observations.find(o => o.observationKey === 'date-labelled')).toMatchObject({
      acquiredAt: '2026-10-13T12:00:00Z', sourceFetchedAt: '2023-10-13T12:00:00Z',
      periodBasis: 'session-date-label', acquisitionBasis: 'artifact-import',
    })
  })
})
