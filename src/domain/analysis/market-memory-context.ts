import { z } from 'zod'
import type { MemoryEvent } from './market-memory-schema.js'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
const stamp = z.string().datetime({ offset: true })
const ms = (value: string) => Date.parse(value)
export const memoryContextSchema = z.object({
  entityIds: z.array(id).min(1).max(25), horizon: z.enum(['intraday', 'swing', 'long-term', 'structural']).optional(),
  observedFrom: stamp.optional(), observedTo: stamp.optional(), knownAsOf: stamp.optional(),
  includeExpired: z.boolean().default(false), setupType: id.optional(), regime: id.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  maxChars: z.number().int().min(4000).max(64000).default(24000),
}).strict()
export type MemoryContextQuery = z.input<typeof memoryContextSchema>
export type ParsedMemoryContextQuery = z.output<typeof memoryContextSchema>

function references(event: MemoryEvent): string[] {
  const e = event.entry
  switch (e.kind) {
    case 'observation': return e.evidenceIds
    case 'thesis': return [...e.supportingObservationIds, ...e.contraryObservationIds]
    case 'check': return [e.metricsEvidenceId, ...new Set(e.results.map(r => r.thesisEventId))]
    case 'signal': return [...e.relatedThesisIds, ...e.observationIds ?? [], ...e.evidenceIds ?? []]
    case 'judgment': return [e.metricsEvidenceId, ...e.observationIds]
    case 'lesson': return [...e.supportingEventIds, ...e.counterEventIds]
    case 'reconciliation': return [e.originalEvidenceId, e.observationId]
    case 'approval': return [e.targetEventId]
    default: return []
  }
}
const packet = (e: MemoryEvent) => ({ eventId: e.eventId, ...e.entry, recordedAt: e.recordedAt, origin: e.origin })

/** Interpret recorded condition outcomes only; no prices, measures or conditions are evaluated here. */
export function recordedThesisState(thesis: MemoryEvent, check?: MemoryEvent) {
  const conditions = thesis.entry.kind === 'thesis' && 'conditions' in thesis.entry ? thesis.entry.conditions : []
  const results = check?.entry.kind === 'check' ? check.entry.results.filter(r => r.thesisEventId === thesis.eventId) : []
  const last = check?.entry.kind === 'check' ? { eventId: check.eventId, runId: check.entry.runId,
    evaluatedAt: check.entry.evaluatedAt, recordedAt: check.recordedAt, origin: check.origin,
    metricsEvidenceId: check.entry.metricsEvidenceId, results } : null
  const met = (role: string) => conditions.some(c => c.role === role && results.some(r => r.conditionId === c.conditionId && r.result === 'met'))
  const unavailable = !conditions.length || !check || conditions.some(c => !results.some(r => r.conditionId === c.conditionId && r.result !== 'not-evaluable'))
  const derivedState = met('invalidation') ? 'smentita-da-rivedere' : unavailable ? 'non-valutabile'
    : met('target') ? 'obiettivo-raggiunto' : met('trigger') ? 'attivata' : 'integra'
  return { derivedState, latestCheck: last,
    derivedStateBasis: 'recorded-check-only', derivedStateChangesThesisStatus: false,
    ...(unavailable && !met('invalidation') ? { derivedStateReason: !conditions.length ? 'No recorded conditions (including legacy theses)' : !check ? 'No check for this exact thesis version' : 'Latest check is incomplete or not evaluable' } : {}) }
}

/** Pure selection. Evidence bytes are verified by the archive owner after selection. */
export function selectMarketContext(all: MemoryEvent[], query: ParsedMemoryContextQuery, at: string, firstRecordedAt: string | null = all[0]?.recordedAt ?? null) {
  const events = all.filter(e => ms(e.recordedAt) <= ms(at))
  const byId = new Map(events.map(e => [e.eventId, e]))
  const catalogById = new Map(events.flatMap(e => e.entry.kind === 'catalog' ? [[e.entry.entityId, e] as const] : []))
  const requested = new Set(query.entityIds)
  const assets = new Set<string>()
  for (const entity of requested) {
    const entry = catalogById.get(entity)?.entry
    if (entry?.kind === 'catalog') {
      if (entry.role === 'asset') assets.add(entry.entityId)
      else if ('assetId' in entry && entry.assetId) assets.add(entry.assetId)
    }
  }
  const entities = new Set([...requested, ...assets])
  for (const event of catalogById.values()) if (event.entry.kind === 'catalog' && 'assetId' in event.entry && event.entry.assetId && assets.has(event.entry.assetId)) entities.add(event.entry.entityId)
  const unknownEntityIds = query.entityIds.filter(entity => !catalogById.has(entity))
  const inHorizon = (e: MemoryEvent) => !query.horizon || 'horizon' in e.entry && e.entry.horizon === query.horizon
  const bounded = (items: MemoryEvent[], label: string) => {
    if (items.length > query.limit) throw new Error(`${label} result limit reached; narrow the query instead of hiding interpretations`)
    return items
  }
  const thesisById = new Map<string, MemoryEvent>(), lessonById = new Map<string, MemoryEvent>()
  const judgmentByAsset = new Map<string, MemoryEvent>(), checkByThesis = new Map<string, MemoryEvent>()
  const groupRuns = new Map<string, MemoryEvent>()
  for (const event of events) {
    const e = event.entry
    if (e.kind === 'thesis' && e.entityIds.some(entity => entities.has(entity)) && inHorizon(event)) thesisById.set(e.thesisId, event)
    if (e.kind === 'lesson') lessonById.set(e.lessonId, event)
    if (e.kind === 'judgment' && inHorizon(event)) {
      if (assets.has(e.assetId)) judgmentByAsset.set(`${e.assetId}|${e.horizon}`, event)
      groupRuns.set(`${e.groupId}|${e.horizon}`, event)
    }
    if (e.kind === 'check') for (const ref of new Set(e.results.map(r => r.thesisEventId))) {
      const prior = checkByThesis.get(ref)
      if (!prior || prior.entry.kind === 'check' && ms(e.evaluatedAt) >= ms(prior.entry.evaluatedAt)) checkByThesis.set(ref, event)
    }
  }
  const theses = bounded([...thesisById.values()], 'Thesis')
  const signals = bounded(events.filter(e => e.entry.kind === 'signal' && e.entry.assetIds.some(a => assets.has(a)) && inHorizon(e)
    && (query.includeExpired || ms(e.entry.expiresAt) > ms(at)))
    .sort((a, b) => a.entry.kind === 'signal' && b.entry.kind === 'signal' ? ms(b.entry.confirmedAt) - ms(a.entry.confirmedAt) || b.sequence - a.sequence : 0), 'Signal')
  const lessons = bounded([...lessonById.values()].filter(e => e.entry.kind === 'lesson' && e.entry.status === 'approved'
    && (!e.entry.scope.assetIds || e.entry.scope.assetIds.some(a => assets.has(a)))
    && (!e.entry.scope.setupType || e.entry.scope.setupType === query.setupType)
    && (!e.entry.scope.regime || e.entry.scope.regime === query.regime)), 'Lesson')
  const judgments = bounded([...judgmentByAsset.values()], 'Judgment')
  const groups = new Set(judgments.flatMap(e => e.entry.kind === 'judgment' ? [`${e.entry.groupId}|${e.entry.horizon}`] : []))
  const groupJudgments = bounded(events.filter(e => {
    if (e.entry.kind !== 'judgment') return false
    const key = `${e.entry.groupId}|${e.entry.horizon}`, latest = groupRuns.get(key)?.entry
    return groups.has(key) && latest?.kind === 'judgment' && latest.reviewRunId === e.entry.reviewRunId
  }), 'Group judgment')
  const checks = [...new Map(theses.flatMap(e => {
    const check = checkByThesis.get(e.eventId)
    return check ? [[check.eventId, check] as const] : []
  })).values()]
  const pinned = new Map<string, MemoryEvent>()
  const visit = (ref: string) => {
    if (pinned.has(ref)) return
    const event = byId.get(ref)
    if (!event) throw new Error(`Missing eligible memory reference ${ref}`)
    pinned.set(ref, event)
    for (const child of references(event)) visit(child)
  }
  for (const e of [...theses, ...signals, ...lessons, ...judgments, ...groupJudgments]) for (const ref of references(e)) visit(ref)
  // A scoped latestCheck contains only this query's thesis results. Full checks
  // explicitly cited by lessons remain pinned with every supporting reference.
  for (const e of checks) if (e.entry.kind === 'check') visit(e.entry.metricsEvidenceId)
  const inPeriod = (e: MemoryEvent) => e.entry.kind === 'observation'
    && (!query.observedFrom || ms(e.entry.observedPeriod.end) >= ms(query.observedFrom))
    && (!query.observedTo || ms(e.entry.observedPeriod.end) <= ms(query.observedTo))
  const latest = new Map<string, MemoryEvent>()
  for (const event of events) if (event.entry.kind === 'observation' && entities.has(event.entry.entityId) && inPeriod(event)) {
    const e = event.entry
    latest.set(`${e.entityId}|${e.observationKey}|${ms(e.observedPeriod.start)}|${ms(e.observedPeriod.end)}`, event)
  }
  const candidates = [...latest.values()].sort((a, b) => a.entry.kind === 'observation' && b.entry.kind === 'observation' ? ms(b.entry.observedPeriod.end) - ms(a.entry.observedPeriod.end) || b.sequence - a.sequence : 0)
  const selected = new Map(candidates.slice(0, query.limit).map(e => [e.eventId, e]))
  for (const [ref, event] of pinned) if (event.entry.kind === 'observation') selected.set(ref, event)
  for (const e of selected.values()) for (const ref of references(e)) visit(ref)
  const reconciliations = events.filter(e => e.entry.kind === 'reconciliation' && (selected.has(e.entry.observationId) || pinned.has(e.entry.originalEvidenceId)))
  for (const e of reconciliations) for (const ref of references(e)) visit(ref)
  for (const [ref, event] of pinned) if (event.entry.kind === 'observation') selected.set(ref, event)
  const superseded = new Set(events.flatMap(e => e.entry.kind === 'observation' && e.entry.supersedesId ? [e.entry.supersedesId] : []))
  const observations = [...selected.values()].map(event => {
    if (event.entry.kind !== 'observation') throw new Error('Not an observation')
    const e = event.entry, withinPeriod = inPeriod(event), stale = e.expiresAt !== null && ms(e.expiresAt) <= ms(at), unknown = e.expiresAt === null
    return { eventId: event.eventId, ...e, recordedAt: event.recordedAt, origin: event.origin,
      verification: 'source-attributed-not-independently-verified', outsideRequestedPeriod: !withinPeriod,
      usableForReevaluation: withinPeriod && !unknown && !stale && !superseded.has(event.eventId) && e.quality === 'usable' && e.finality === 'final',
      staleAtQuery: stale, freshnessUnknown: unknown, supersededAtQuery: superseded.has(event.eventId) }
  })
  const main = new Set([...theses, ...signals, ...lessons, ...judgments, ...groupJudgments, ...selected.values(), ...reconciliations].map(e => e.eventId))
  const evidenceEvents = [...pinned.values()].filter(e => e.entry.kind === 'evidence')
  return { evidenceEvents, output: {
    schema: 'superai.market-context/2', status: query.knownAsOf && firstRecordedAt && ms(at) < ms(firstRecordedAt) ? 'insufficient-history' : events.length ? 'available' : 'empty',
    mode: query.knownAsOf ? 'knowledge-as-recorded' : 'current-memory', evaluatedAt: at,
    coverage: { firstRecordedAt, lastEligibleRecordedAt: events.at(-1)?.recordedAt ?? null, historicalSourceCoverage: 'not-attested', importsBackdateKnowledge: false,
      unknownEntityIds, resolvedAssetIds: [...assets], observationResultsTruncated: candidates.length > query.limit,
      selectedOutsideWindowForThesis: observations.some(e => e.outsideRequestedPeriod), mandatoryReferencesPreserved: true },
    catalog: [...catalogById.values()].filter(e => e.entry.kind === 'catalog' && entities.has(e.entry.entityId)).map(packet), observations,
    theses: theses.map(e => ({ ...packet(e), ...recordedThesisState(e, checkByThesis.get(e.eventId)) })),
    signals: signals.map(e => ({ ...packet(e), expiredAtQuery: e.entry.kind === 'signal' && ms(e.entry.expiresAt) <= ms(at) })),
    lessons: lessons.map(packet), judgments: judgments.map(packet),
    judgmentGroups: [...groups].map(key => {
      const latest = groupRuns.get(key)!
      if (latest.entry.kind !== 'judgment') throw new Error('Not a judgment')
      return { groupId: latest.entry.groupId, horizon: latest.entry.horizon, reviewRunId: latest.entry.reviewRunId,
        lastRecordedAt: latest.recordedAt, basis: 'recorded-member-judgments',
        judgments: groupJudgments.filter(e => e.entry.kind === 'judgment' && `${e.entry.groupId}|${e.entry.horizon}` === key).map(packet) }
    }),
    referencedEvents: [...pinned.values()].filter(e => e.entry.kind !== 'evidence' && !main.has(e.eventId)).map(packet),
    reconciliations: reconciliations.map(packet),
    reevaluation: { performed: false, sourceAccess: 'cached-only', monitorContacted: false,
      requiresNewEvidence: observations.length === 0 || observations.some(e => !e.usableForReevaluation),
      reason: 'Context retrieval preserves interpretations and recorded checks; it does not run a fresh evaluation or attest source availability.' },
  } }
}
