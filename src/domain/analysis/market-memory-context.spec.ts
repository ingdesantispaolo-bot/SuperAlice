import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemoryEntry, getMarketContext } from './market-memory.js'
import type { MemoryOrigin } from './market-memory-schema.js'

const dirs: string[] = [], base = Date.parse('2026-10-14T10:00:00Z')
const author = { type: 'superai', agent: 'codex' }, assetId = 'asset.gold', seriesId = 'series.gold'
const origin: MemoryOrigin = { kind: 'session', workspaceId: 'fixture' }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-context-')); dirs.push(dir)
  await mkdir(join(dir, '.alice')); await mkdir(join(dir, 'research/market-assistant/global-map'), { recursive: true })
  let tick = 0
  const append = (entry: unknown, host = origin) => appendMemoryEntry(dir, entry, host, new Date(base + ++tick * 1000))
  const query = (input = {}, now = new Date(base + 100_000)) => getMarketContext(dir, { entityIds: [assetId], maxChars: 64000, ...input }, now)
  await append({ kind: 'catalog', role: 'asset', entityId: assetId, label: 'Synthetic gold', assetClass: 'commodity' })
  await append({ kind: 'catalog', role: 'observed-series', entityId: seriesId, assetId, label: 'Synthetic series', assetClass: 'commodity',
    source: 'fixture', sourceSeriesId: 'gold', currency: 'USD', unit: 'USD', method: { id: 'fixture', version: '1', description: 'Synthetic' }, yieldType: null, benchmarkEquivalence: 'not-established' })
  const raw = '{"fixture":true}\n'
  await writeFile(join(dir, 'research/input.json'), raw)
  const evidence = await append({ kind: 'evidence', originalPath: 'research/input.json', sha256: createHash('sha256').update(raw).digest('hex'), format: 'json', description: 'Synthetic metrics', originalRunId: null })
  const obs = { kind: 'observation', entityId: seriesId, observationKey: 'close', value: 2, unit: 'USD',
    observedPeriod: { start: new Date(base - 86400_000).toISOString(), end: new Date(base - 86400_000).toISOString() },
    acquiredAt: new Date(base).toISOString(), publishedAt: null, publicationBasis: 'unknown', quality: 'usable', finality: 'final',
    expiresAt: new Date(base + 86400_000).toISOString(), evidenceIds: [evidence.eventId], supersedesId: null, note: 'Synthetic' }
  const observation = await append(obs)
  await writeFile(join(dir, 'research/market-assistant/global-map/measures.json'), JSON.stringify({ schema: 'superai.measures/1', methodVersion: 'fixture', measures: [{ assetId, seriesId, measureKey: 'close', timeframe: '1D', unit: 'USD', definition: 'Synthetic completed close', completedBarsOnly: true }] }))
  const conditions = ['invalidation', 'trigger', 'target'].map(role => ({ conditionId: role, role, assetId, measureKey: 'close', timeframe: '1D', op: '>', threshold: 1, consecutive: 1 }))
  const thesis = { kind: 'thesis', thesisId: 'gold-long', version: 1, previousEventId: null, entityIds: [assetId], horizon: 'long-term', author,
    status: 'candidate', summary: 'Synthetic candidate', invalidation: 'Synthetic', conditions, supportingObservationIds: [observation.eventId], contraryObservationIds: [], openQuestions: [] }
  const candidate = await append(thesis)
  const check = (runId: string, results: string[], target = candidate.eventId, evaluatedAt = new Date(base + 5000).toISOString()) => append({ kind: 'check', runId, evaluatedAt, metricsEvidenceId: evidence.eventId,
    results: results.map((result, i) => ({ thesisEventId: target, conditionId: conditions[i].conditionId, result,
      value: result === 'not-evaluable' ? null : 2, observedAt: result === 'not-evaluable' ? null : new Date(base).toISOString(), ...(result === 'not-evaluable' ? { reason: 'Synthetic gap' } : {}) })) })
  const signal = (signalId: string, expiresAt = new Date(base + 3600_000).toISOString()) => append({ kind: 'signal', signalId, author, assetIds: [assetId], horizon: 'intraday', signalType: 'fixture', summary: 'Confirmed fixture',
    confirmedAt: new Date(base).toISOString(), expiresAt, sourceRunId: signalId, relatedThesisIds: [candidate.eventId], evidenceIds: [evidence.eventId] })
  const judgment = (reviewRunId: string, horizon = 'long-term', asset = assetId) => append({ kind: 'judgment', author, reviewRunId, groupId: 'metals', assetId: asset, horizon,
    dimensions: { valuation: 'not-available', fundamentals: 'not-available', technical: 'neutral', risk: 'unfavorable' }, coverage: 'technical-only', relativePreference: 'neutral', confidence: 'low', rationale: 'Synthetic', observationIds: [], metricsEvidenceId: evidence.eventId })
  return { dir, append, query, evidence, observation, obs, thesis, candidate, check, signal, judgment }
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('market context v2 recorded knowledge', () => {
  it('derives all states without changing activation; invalidation wins and missing results stay explicit', async () => {
    const f = await fixture()
    expect((await f.query()).theses[0]).toMatchObject({ derivedState: 'non-valutabile', latestCheck: null })
    for (const [run, results, state] of [
      ['intact', ['not-met', 'not-met', 'not-met'], 'integra'],
      ['trigger', ['not-met', 'met', 'not-met'], 'attivata'],
      ['target', ['not-met', 'met', 'met'], 'obiettivo-raggiunto'],
      ['gap', ['not-evaluable', 'met', 'not-met'], 'non-valutabile'],
      ['invalid', ['met', 'not-evaluable', 'met'], 'smentita-da-rivedere'],
      ['partial', ['not-met'], 'non-valutabile'],
    ] as const) {
      await f.check(run, [...results])
      expect((await f.query()).theses[0]).toMatchObject({ status: 'candidate', derivedState: state, derivedStateChangesThesisStatus: false, latestCheck: { runId: run } })
    }
  })
  it('uses evaluation clocks and exact thesis versions; knownAsOf excludes later checks and revisions', async () => {
    const f = await fixture()
    const first = await f.check('first', ['not-met', 'met', 'not-met'])
    const second = await f.check('second', ['met', 'not-met', 'not-met'], undefined, new Date(base + 6000).toISOString())
    await f.check('late-import', ['not-met', 'not-met', 'met'], undefined, new Date(base + 4000).toISOString())
    expect((await f.query()).theses[0]).toMatchObject({ derivedState: 'smentita-da-rivedere', latestCheck: { eventId: second.eventId } })
    expect((await f.query({ knownAsOf: first.recordedAt })).theses[0]).toMatchObject({ derivedState: 'attivata' })
    await f.append({ ...f.thesis, version: 2, previousEventId: f.candidate.eventId, summary: 'New interpretation' })
    expect((await f.query()).theses[0]).toMatchObject({ version: 2, derivedState: 'non-valutabile', latestCheck: null })
  })
  it('resolves series to assets and returns signals by expiry at the knowledge date, with explicit limits', async () => {
    const f = await fixture()
    const old = await f.signal('expired', new Date(base + 30_000).toISOString())
    await f.signal('current')
    const context = await f.query({ entityIds: [seriesId] })
    expect(context.schema).toBe('superai.market-context/2')
    expect(context.theses).toHaveLength(1)
    expect(context.signals).toHaveLength(1)
    expect(context.signals[0]).toMatchObject({ signalId: 'current', expiredAtQuery: false, author })
    expect((await f.query({ includeExpired: true })).signals.find(s => s.eventId === old.eventId)).toMatchObject({ expiredAtQuery: true })
    expect((await f.query({ knownAsOf: old.recordedAt })).signals[0]).toMatchObject({ signalId: 'expired', expiredAtQuery: false })
    await expect(f.query({ includeExpired: true, limit: 1 })).rejects.toThrow('Signal result limit')
  })
  it('returns matching approved lessons and preserves transitive contrary evidence outside the window', async () => {
    const f = await fixture()
    const contrary = await f.append({ ...f.obs, value: 1, supersedesId: f.observation.eventId })
    const lesson = { kind: 'lesson', author: { type: 'user' }, lessonId: 'fixture-rule', version: 1, previousEventId: null, statement: 'Synthetic user rule',
      scope: { assetIds: [assetId], setupType: 'breakout', regime: 'risk-off' }, status: 'proposed',
      supportingEventIds: [f.evidence.eventId, f.observation.eventId, f.candidate.eventId], counterEventIds: [contrary.eventId] }
    const proposed = await f.append(lesson)
    await f.append({ kind: 'approval', targetEventId: proposed.eventId, decision: 'approve', note: 'Fixture consent' }, { kind: 'user-surface', workspaceId: 'fixture' })
    const approved = await f.append({ ...lesson, status: 'approved', version: 2, previousEventId: proposed.eventId })
    expect((await f.query()).lessons).toHaveLength(0)
    expect((await f.query({ setupType: 'breakout', regime: 'risk-on' })).lessons).toHaveLength(0)
    const context = await f.query({ setupType: 'breakout', regime: 'risk-off', observedFrom: new Date(base).toISOString(), limit: 1 })
    expect(context.lessons[0]).toMatchObject({ eventId: approved.eventId, author: { type: 'user' } })
    expect(context.observations.map(o => o.eventId)).toContain(contrary.eventId)
    expect(context.observations.every(o => o.outsideRequestedPeriod)).toBe(true)
    await f.append({ kind: 'approval', targetEventId: approved.eventId, decision: 'approve', note: 'Fixture retirement' }, { kind: 'user-surface', workspaceId: 'fixture' })
    await f.append({ ...lesson, status: 'retired', version: 3, previousEventId: approved.eventId })
    expect((await f.query({ setupType: 'breakout', regime: 'risk-off' })).lessons).toHaveLength(0)
    expect((await f.query({ setupType: 'breakout', regime: 'risk-off', knownAsOf: approved.recordedAt })).lessons).toHaveLength(1)
  })
  it('preserves asset/horizon judgments and the latest coherent group batch without invented aggregation', async () => {
    const f = await fixture()
    await f.append({ kind: 'catalog', role: 'asset', entityId: 'asset.silver', label: 'Synthetic silver', assetClass: 'commodity' })
    await f.judgment('old-review')
    await f.judgment('swing-review', 'swing')
    await f.judgment('latest-review')
    await f.judgment('latest-review', 'long-term', 'asset.silver')
    const context = await f.query({ horizon: 'long-term' })
    expect(context.judgments).toHaveLength(1)
    expect(context.judgments[0]).toMatchObject({ reviewRunId: 'latest-review', author })
    expect(context.judgmentGroups[0]).toMatchObject({ groupId: 'metals', reviewRunId: 'latest-review', basis: 'recorded-member-judgments' })
    expect(context.judgmentGroups[0].judgments).toHaveLength(2)
    await expect(f.query({ horizon: 'long-term', limit: 1 })).rejects.toThrow('Group judgment result limit')
  })
  it('verifies evidence cited only by a check, and fails explicitly on corruption', async () => {
    const f = await fixture(), raw = '{"checkOnly":true}'
    await writeFile(join(f.dir, 'research/check.json'), raw)
    const evidence = await f.append({ kind: 'evidence', originalPath: 'research/check.json', sha256: createHash('sha256').update(raw).digest('hex'), format: 'json', description: 'Check-only evidence', originalRunId: null })
    await f.append({ kind: 'check', runId: 'separate', evaluatedAt: new Date(base).toISOString(), metricsEvidenceId: evidence.eventId,
      results: [{ thesisEventId: f.candidate.eventId, conditionId: 'invalidation', result: 'not-evaluable', value: null, observedAt: null, reason: 'Fixture' }] })
    const context = await f.query()
    expect(context.evidence.map(e => e.eventId)).toContain(evidence.eventId)
    await writeFile(join(f.dir, context.evidence.find(e => e.eventId === evidence.eventId)!.path), '{}')
    await expect(f.query()).rejects.toThrow('integrity mismatch')
  })
})
