import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemoryEntry, readMemoryCatalog } from './market-memory.js'
import type { MemoryOrigin } from './market-memory-schema.js'

const dirs: string[] = []
const origin: MemoryOrigin = { kind: 'session', workspaceId: 'fixture-desk', resumeId: 'resume-chat' }
const assetId = 'asset.cmd.gold.fixture', seriesId = 'series.cmd.gold.fixture'
const author = { type: 'superai', agent: 'codex' }
const time = '2026-10-14T10:00:00Z'
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-v2-')); dirs.push(dir)
  await mkdir(join(dir, '.alice')); await mkdir(join(dir, 'research/market-assistant/global-map'), { recursive: true })
  let tick = 0
  const append = (entry: unknown, host = origin, scheduledReviewIssueId?: string) => appendMemoryEntry(dir, entry, host,
    new Date(Date.parse(time) + ++tick * 1000), { scheduledReviewIssueId })
  await append({ kind: 'catalog', entityId: assetId, role: 'asset', assetClass: 'commodity', label: 'Fixture gold' })
  await append({ kind: 'catalog', entityId: seriesId, assetId, role: 'observed-series', assetClass: 'commodity', label: 'Fixture series',
    source: 'fixture', sourceSeriesId: 'gold', currency: 'USD', unit: 'USD/oz', method: { id: 'fixture', version: '1', description: 'Synthetic' },
    yieldType: null, benchmarkEquivalence: 'not-established' })
  const raw = '{"fixture":true}\n'
  await writeFile(join(dir, 'research/metrics.json'), raw)
  const evidence = await append({ kind: 'evidence', originalPath: 'research/metrics.json', sha256: createHash('sha256').update(raw).digest('hex'), format: 'json', description: 'Fixture evidence', originalRunId: 'run-fixture' })
  const observationInput = { kind: 'observation', entityId: seriesId, observationKey: 'close', value: 2, unit: 'USD/oz',
    observedPeriod: { start: time, end: time }, publishedAt: null, publicationBasis: 'unknown', acquiredAt: time,
    quality: 'usable', finality: 'final', expiresAt: null, evidenceIds: [evidence.eventId], supersedesId: null, note: 'Synthetic' }
  const observation = await append(observationInput)
  const measures = { schema: 'superai.measures/1', methodVersion: 'fixture-1', measures: [{ assetId, measureKey: 'close', timeframe: '1D', unit: 'USD/oz', seriesId, definition: 'Closed fixture bar', completedBarsOnly: true }] }
  await writeFile(join(dir, 'research/market-assistant/global-map/measures.json'), JSON.stringify(measures))
  const condition = { conditionId: 'invalid-close', role: 'invalidation', assetId, measureKey: 'close', timeframe: '1D', op: '<', threshold: 1, consecutive: 1 }
  const thesis = { kind: 'thesis', author, thesisId: 'gold-long', entityIds: [assetId], horizon: 'long-term', version: 1,
    previousEventId: null, status: 'candidate', summary: 'Synthetic thesis', invalidation: 'Below fixture threshold',
    supportingObservationIds: [observation.eventId], contraryObservationIds: [], openQuestions: [], conditions: [condition] }
  const candidate = await append(thesis)
  const signal = { kind: 'signal', author, signalId: 'signal-fixture', assetIds: [assetId], horizon: 'intraday', signalType: 'fixture',
    summary: 'Confirmed synthetic signal', confirmedAt: time, expiresAt: '2026-10-15T10:00:00Z', relatedThesisIds: [candidate.eventId], sourceRunId: 'run-fixture', evidenceIds: [evidence.eventId] }
  const lesson = { kind: 'lesson', author, lessonId: 'lesson-fixture', version: 1, previousEventId: null, statement: 'Fixture statement', scope: { assetIds: [assetId] },
    supportingEventIds: [evidence.eventId, observation.eventId, candidate.eventId], counterEventIds: [], status: 'proposed' }
  const approve = (targetEventId: string, decision = 'approve') => append({ kind: 'approval', targetEventId, decision, note: 'Fixture user decision' }, { kind: 'user-surface', workspaceId: origin.workspaceId })
  return { dir, append, thesis, candidate, signal, lesson, approve, evidence, condition, measures, observationInput }
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('market memory v2 write contracts', () => {
  it('rejects chat activation and accepts a matching host scheduled review', async () => {
    const f = await fixture()
    const active = { ...f.thesis, status: 'active', version: 2, previousEventId: f.candidate.eventId, activationBasis: { type: 'scheduled-review', issueId: 'saturday-review' } }
    await expect(f.append(active)).rejects.toThrow('chat cannot activate')
    const host: MemoryOrigin = { kind: 'issue', workspaceId: origin.workspaceId, resumeId: 'resume-review', issueId: 'saturday-review' }
    await expect(f.append(active, host)).rejects.toThrow('host scheduled review')
    await expect(f.append(active, host, 'another-issue')).rejects.toThrow('host scheduled review')
    expect((await f.append(active, host, 'saturday-review')).accepted).toBe(true)
  })
  it('activates a user thesis only after the exact user approval, even in a scheduled review', async () => {
    const f = await fixture()
    const user = { ...f.thesis, thesisId: 'user-gold', author: { type: 'user' } }
    const candidate = await f.append(user)
    const active = { ...user, status: 'active', version: 2, previousEventId: candidate.eventId }
    await expect(f.append({ ...active, author, activationBasis: { type: 'scheduled-review', issueId: 'review' } }, { kind: 'issue', workspaceId: origin.workspaceId, issueId: 'review' }, 'review')).rejects.toThrow('author type is immutable')
    await expect(f.append({ ...active, activationBasis: { type: 'scheduled-review', issueId: 'review' } }, { kind: 'issue', workspaceId: origin.workspaceId, issueId: 'review' }, 'review')).rejects.toThrow('user approval')
    const approval = await f.approve(candidate.eventId)
    const approved = { ...active, activationBasis: { type: 'user-approval', approvalEventId: approval.eventId } }
    await expect(f.append(approved)).rejects.toThrow('chat cannot activate')
    const host: MemoryOrigin = { kind: 'issue', workspaceId: origin.workspaceId, issueId: 'review' }
    await expect(f.append({ ...approved, summary: 'Changed after consent' }, host, 'review')).rejects.toThrow('approved candidate content')
    expect((await f.append(approved, host, 'review')).accepted).toBe(true)
    await expect(f.approve(candidate.eventId)).rejects.toThrow('superseded')
  })
  it('rejects revoked approvals and missing activation or dated invalidation/review conditions', async () => {
    const f = await fixture()
    const approval = await f.approve(f.candidate.eventId)
    await f.approve(f.candidate.eventId, 'reject')
    const host: MemoryOrigin = { kind: 'issue', workspaceId: origin.workspaceId, issueId: 'review' }
    await expect(f.append({ ...f.thesis, status: 'active', version: 2, previousEventId: f.candidate.eventId, activationBasis: { type: 'user-approval', approvalEventId: approval.eventId } }, host, 'review')).rejects.toThrow('current user approval')
    await expect(f.append({ ...f.thesis, status: 'active', version: 2, previousEventId: f.candidate.eventId }, host, 'review')).rejects.toThrow('activationBasis')
    await expect(f.append({ ...f.thesis, conditions: [], status: 'active', version: 2, previousEventId: f.candidate.eventId }, host, 'review')).rejects.toThrow('invalidation or a dated review')
  })
  it('validates the latest measure registry, comparison thresholds and completed bars', async () => {
    const f = await fixture()
    await expect(f.append({ ...f.thesis, thesisId: 'unknown', conditions: [{ ...f.condition, measureKey: 'invented' }] })).rejects.toThrow('Unknown measureKey')
    await expect(f.append({ ...f.thesis, thesisId: 'comparison', conditions: [{ ...f.condition, threshold: { assetId, measureKey: 'invented' } }] })).rejects.toThrow('Unknown measureKey')
    await writeFile(join(f.dir, 'research/market-assistant/global-map/measures.json'), JSON.stringify({ ...f.measures, measures: [{ ...f.measures.measures[0], completedBarsOnly: false }] }))
    await expect(f.append({ ...f.thesis, thesisId: 'partial' })).rejects.toThrow('completed bars only')
  })
  it('requires economic asset links for new series and preserves source-free assets', async () => {
    const f = await fixture()
    const entries = (await readMemoryCatalog(f.dir)).entries
    expect(entries.find(e => 'entityId' in e && e.entityId === assetId)).not.toHaveProperty('source')
    expect(entries.find(e => 'entityId' in e && e.entityId === seriesId)).toMatchObject({ assetId })
    await expect(f.append({ kind: 'catalog', entityId: 'bad-asset', role: 'asset', assetClass: 'commodity', label: 'bad', source: 'fixture' })).rejects.toThrow('economic asset')
    expect((await f.append({ kind: 'catalog', entityId: 'derived.rates.us.2s10s', role: 'asset', assetClass: 'rates', label: 'Synthetic economic spread' })).accepted).toBe(true)
  })
  it('consumes C2 registry metadata/monthly measures and validates derived units independently of price units', async () => {
    const f = await fixture()
    const rsi = { ...f.measures.measures[0], measureKey: 'rsi14', unit: 'score' }
    const monthly = { ...f.measures.measures[0], measureKey: 'monthly-level', timeframe: '1M' }
    const unresolvedDerived = { ...f.measures.measures[0], assetId: 'derived.rates.us.2s10s', seriesId: 'series.us.10y - series.us.2y' }
    await writeFile(join(f.dir, 'research/market-assistant/global-map/measures.json'), JSON.stringify({ ...f.measures, runId: 'run-c2', asOf: '2026-10-13', measures: [...f.measures.measures, rsi, monthly, unresolvedDerived] }))
    const observation = await f.append({ ...f.observationInput, observationKey: 'rsi14', unit: 'score', value: 42 })
    expect((await f.append({ ...f.thesis, thesisId: 'gold-rsi', supportingObservationIds: [observation.eventId], conditions: [{ ...f.condition, measureKey: 'rsi14', threshold: 30 }] })).accepted).toBe(true)
    await expect(f.append({ ...f.observationInput, observationKey: 'rsi14', unit: 'bp' })).rejects.toThrow('unit differs')
    await expect(f.append({ ...f.thesis, thesisId: 'monthly-as-daily', conditions: [{ ...f.condition, measureKey: 'monthly-level' }] })).rejects.toThrow('Unknown measureKey')
    await expect(f.append({ ...f.thesis, thesisId: 'incompatible-units', conditions: [{ ...f.condition, threshold: { assetId, measureKey: 'rsi14' } }] })).rejects.toThrow('same unit')
  })
  it('requires author, rejects caller origin and blocks agent approvals', async () => {
    const f = await fixture()
    const { author: _author, ...unattributed } = f.thesis
    await expect(f.append({ ...unattributed, thesisId: 'anonymous' })).rejects.toThrow()
    await expect(f.append({ ...f.thesis, thesisId: 'forged', origin: { kind: 'issue', issueId: 'review' } })).rejects.toThrow()
    await expect(f.append({ kind: 'approval', targetEventId: f.candidate.eventId, decision: 'approve', note: 'Agent forged consent' })).rejects.toThrow('user surface')
  })
  it('requires signal expiry within seven days and rejects duplicate signals and missing references', async () => {
    const f = await fixture()
    const { expiresAt: _expiry, ...missingExpiry } = f.signal
    await expect(f.append(missingExpiry)).rejects.toThrow()
    await expect(f.append({ ...f.signal, expiresAt: '2026-10-22T10:00:00Z' })).rejects.toThrow('seven days')
    await expect(f.append({ ...f.signal, evidenceIds: ['0'.repeat(64)] })).rejects.toThrow('Missing evidence')
    expect((await f.append(f.signal)).accepted).toBe(true)
    await expect(f.append(f.signal)).rejects.toThrow('already recorded')
  })
  it('writes one check per run with verified thesis-condition references and clocks', async () => {
    const f = await fixture()
    const check = { kind: 'check', runId: 'evening-fixture', evaluatedAt: time, metricsEvidenceId: f.evidence.eventId,
      results: [{ thesisEventId: f.candidate.eventId, conditionId: f.condition.conditionId, result: 'met', value: 0.5, observedAt: time }] }
    await expect(f.append({ ...check, results: [{ ...check.results[0], conditionId: 'unknown' }] })).rejects.toThrow('Unknown conditionId')
    await expect(f.append({ ...check, results: [{ ...check.results[0], result: 'not-evaluable', value: null, observedAt: null }] })).rejects.toThrow('requires a reason')
    expect((await f.append(check)).accepted).toBe(true)
    await expect(f.append(check)).rejects.toThrow('already recorded')
  })
  it('refuses corrupted metrics evidence before publishing a check', async () => {
    const f = await fixture()
    const evidenceDir = join(f.dir, 'research/market-memory/v1/evidence')
    await writeFile(join(evidenceDir, (await readdir(evidenceDir))[0]), '{"tampered":true}\n')
    await expect(f.append({ kind: 'check', runId: 'corrupt-check', evaluatedAt: time, metricsEvidenceId: f.evidence.eventId,
      results: [{ thesisEventId: f.candidate.eventId, conditionId: f.condition.conditionId, result: 'met', value: 0.5, observedAt: time }] })).rejects.toThrow('Stored evidence integrity mismatch')
    expect((await readMemoryCatalog(f.dir)).recordCount).toBe(5)
  })
  it('preserves 500 nightly results in one event beyond the old 32/48 KB budgets', async () => {
    const f = await fixture()
    const results = []
    for (let i = 0; i < 25; i++) {
      const conditions = Array.from({ length: 20 }, (_, index) => ({ ...f.condition, conditionId: `fixture-${i}-${index}` }))
      const thesis = await f.append({ ...f.thesis, thesisId: `nightly-${i}`, conditions })
      for (const condition of conditions) results.push({ thesisEventId: thesis.eventId, conditionId: condition.conditionId, result: 'not-met', value: 2, observedAt: time })
    }
    const entry = { kind: 'check', runId: 'full-nightly-fixture', evaluatedAt: time, metricsEvidenceId: f.evidence.eventId, results }
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeGreaterThan(48_000)
    const saved = await f.append(entry)
    const eventsDir = join(f.dir, 'research/market-memory/v1/events')
    const file = (await readdir(eventsDir)).find(name => name.includes(saved.eventId))!
    expect(JSON.parse(await readFile(join(eventsDir, file), 'utf8')).entry.results).toEqual(results)
    await expect(f.append(entry)).rejects.toThrow('already recorded')
  })
  it('validates judgment dimensions, asset references and review uniqueness', async () => {
    const f = await fixture()
    const judgment = { kind: 'judgment', author, reviewRunId: 'saturday-fixture', groupId: 'commodities', assetId, horizon: 'long-term',
      dimensions: { valuation: 'not-available', fundamentals: 'not-available', technical: 'favorable', risk: 'neutral' }, coverage: 'technical-only',
      relativePreference: 'preferred', confidence: 'low', rationale: 'Fixture technical-only judgment', observationIds: [], metricsEvidenceId: f.evidence.eventId }
    await expect(f.append({ ...judgment, dimensions: { ...judgment.dimensions, technical: 'bullish' } })).rejects.toThrow()
    expect((await f.append(judgment)).accepted).toBe(true)
    await expect(f.append(judgment)).rejects.toThrow('already recorded')
  })
  it('requires three distinct lesson examples and user approval for approval and retirement', async () => {
    const f = await fixture()
    await expect(f.append({ ...f.lesson, supportingEventIds: [f.candidate.eventId, f.candidate.eventId, f.candidate.eventId] })).rejects.toThrow('Duplicate')
    await expect(f.append({ ...f.lesson, status: 'approved' })).rejects.toThrow('user approval')
    const proposed = await f.append(f.lesson)
    const approved = { ...f.lesson, status: 'approved', version: 2, previousEventId: proposed.eventId }
    await expect(f.append(approved)).rejects.toThrow('user approval')
    await f.approve(proposed.eventId)
    await expect(f.append({ ...approved, statement: 'Changed rule' })).rejects.toThrow('user-approved content')
    const accepted = await f.append(approved)
    const retired = { ...f.lesson, status: 'retired', version: 3, previousEventId: accepted.eventId }
    await expect(f.append(retired)).rejects.toThrow('user approval')
    await f.approve(accepted.eventId)
    expect((await f.append(retired)).accepted).toBe(true)
  })
  it('reads v1 catalog bytes unchanged and appends v2 on the original chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-legacy-')); dirs.push(dir)
    await mkdir(join(dir, '.alice')); await mkdir(join(dir, 'research/market-memory/v1/events'), { recursive: true })
    const legacy = { schemaVersion: 1, sequence: 1, recordedAt: time, previousHash: null, origin: { workspaceId: origin.workspaceId, resumeId: null },
      entry: { kind: 'catalog', entityId: 'legacy.gold', role: 'observed-series', assetClass: 'commodity', label: 'Legacy gold', source: 'fixture', sourceSeriesId: 'legacy',
        currency: 'USD', unit: 'USD/oz', method: { id: 'fixture', version: '1', description: 'Legacy' }, yieldType: null, benchmarkEquivalence: 'not-established', availability: 'evidence-only' } }
    const raw = JSON.stringify(legacy) + '\n', eventId = createHash('sha256').update(raw).digest('hex')
    const file = join(dir, `research/market-memory/v1/events/00000001-${eventId}.json`)
    await writeFile(file, raw)
    await appendMemoryEntry(dir, { kind: 'catalog', entityId: assetId, role: 'asset', assetClass: 'commodity', label: 'Gold asset' }, origin, new Date(Date.parse(time) + 1000))
    expect(await readFile(file, 'utf8')).toBe(raw)
    const names = (await readdir(join(dir, 'research/market-memory/v1/events'))).sort()
    expect(JSON.parse(await readFile(join(dir, 'research/market-memory/v1/events', names[1]), 'utf8'))).toMatchObject({ schemaVersion: 2, previousHash: eventId })
    expect((await readMemoryCatalog(dir)).entries).toHaveLength(2)
  })
})
