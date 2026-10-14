import type { z } from 'zod'
import type { MemoryEntry, MemoryEvent, MemoryOrigin, memoryMeasuresSchema } from './market-memory-schema.js'

type Measures = z.infer<typeof memoryMeasuresSchema>
const ms = (value: string) => Date.parse(value)
export function memoryReference(events: MemoryEvent[], eventId: string, kind?: MemoryEntry['kind']) {
  const event = events.find(e => e.eventId === eventId)
  if (!event || kind && event.entry.kind !== kind) throw new Error(`Missing ${kind ?? 'event'} reference`)
  return event
}
export function memoryCatalogEntry(events: MemoryEvent[], entityId: string) {
  const event = events.find(e => e.entry.kind === 'catalog' && e.entry.entityId === entityId)
  if (!event || event.entry.kind !== 'catalog') throw new Error(`Unknown catalog entity: ${entityId}`)
  return event.entry
}
export function economicAssetId(events: MemoryEvent[], entityId: string) {
  const entry = memoryCatalogEntry(events, entityId)
  return 'assetId' in entry && entry.assetId ? entry.assetId : entry.entityId
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
function approvedContent(entry: MemoryEvent['entry'] | MemoryEntry) {
  const { status: _status, version: _version, previousEventId: _previous, activationBasis: _basis, ...content } = entry as Record<string, unknown>
  return canonical(content)
}
function latestApproval(events: MemoryEvent[], targetEventId: string) {
  const event = events.filter(e => e.entry.kind === 'approval' && e.entry.targetEventId === targetEventId).at(-1)
  if (!event || event.entry.kind !== 'approval' || event.entry.decision !== 'approve'
    || !('kind' in event.origin) || event.origin.kind !== 'user-surface') throw new Error('A current user approval is required')
  return event
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`)
}

/** Additional v2 write validation. Legacy event bytes are read without rewriting them. */
export function validateMemoryV2(events: MemoryEvent[], entry: MemoryEntry, origin: MemoryOrigin,
  recordedAt: string, measures?: Measures, scheduledReviewIssueId?: string) {
  const asset = (assetId: string) => {
    const item = memoryCatalogEntry(events, assetId)
    if (item.role !== 'asset') throw new Error(`Expected an economic asset: ${assetId}`)
    return item
  }
  const observationsFor = (refs: string[], assetIds: string[]) => {
    unique(refs, 'observation reference')
    for (const ref of refs) {
      const observed = memoryReference(events, ref, 'observation').entry
      if (observed.kind !== 'observation' || !assetIds.includes(economicAssetId(events, observed.entityId))) {
        throw new Error('Interpretation observation belongs to a different asset')
      }
    }
  }
  if (entry.kind === 'catalog' && entry.assetId) {
    if (asset(entry.assetId).assetClass !== entry.assetClass) throw new Error('Series and economic asset classes differ')
  }
  if (entry.kind === 'observation' && memoryCatalogEntry(events, entry.entityId).role === 'asset') {
    throw new Error('Numeric observations require a series identity')
  }
  if (entry.kind === 'thesis') {
    const previous = events.filter(e => e.entry.kind === 'thesis' && e.entry.thesisId === entry.thesisId).at(-1)?.entry
    if (previous?.kind === 'thesis' && 'author' in previous && previous.author.type !== entry.author.type) throw new Error('Thesis author type is immutable across revisions')
    unique(entry.entityIds, 'thesis entity')
    unique(entry.conditions.map(c => c.conditionId), 'conditionId')
    const ownAssets = entry.entityIds.map(entity => economicAssetId(events, entity))
    for (const condition of entry.conditions) {
      asset(condition.assetId)
      if (!ownAssets.includes(condition.assetId)) throw new Error('Condition belongs to a different thesis asset')
      if (condition.activeFrom && condition.expiresAt && ms(condition.activeFrom) > ms(condition.expiresAt)) throw new Error('Invalid condition time range')
      for (const ref of [condition, ...(typeof condition.threshold === 'number' ? [] : [condition.threshold])]) {
        asset(ref.assetId)
        const found = measures?.measures.find(m => m.assetId === ref.assetId && m.measureKey === ref.measureKey && m.timeframe === condition.timeframe)
        if (!found) throw new Error(`Unknown measureKey for ${ref.assetId}/${condition.timeframe}: ${ref.measureKey}`)
        if (!found.completedBarsOnly) throw new Error('Thesis conditions require completed bars only')
        const series = memoryCatalogEntry(events, found.seriesId)
        if (economicAssetId(events, found.seriesId) !== ref.assetId || series.role === 'asset' || series.unit !== found.unit) throw new Error('Measure series identity or unit differs from catalog')
      }
    }
    if (entry.status !== 'active' && entry.activationBasis) throw new Error('activationBasis is only valid for active theses')
    if (entry.status === 'active') {
      if (origin.kind === 'session') throw new Error('A chat cannot activate a thesis, including after user approval')
      if (origin.kind === 'issue' && scheduledReviewIssueId !== origin.issueId) throw new Error('Activation requires the host scheduled review origin')
      if (!entry.conditions.some(c => c.role === 'invalidation' || c.role === 'review' && c.expiresAt)) throw new Error('Active thesis requires invalidation or a dated review condition')
      const basis = entry.activationBasis
      if (!basis) throw new Error('Active thesis requires activationBasis')
      if (basis.type === 'scheduled-review') {
        if (entry.author.type === 'user') throw new Error('User thesis activation requires user approval')
        if (origin.kind !== 'issue' || origin.issueId !== basis.issueId || scheduledReviewIssueId !== basis.issueId) throw new Error('Activation requires the host scheduled review origin; a chat cannot activate')
      } else {
        if (!entry.previousEventId) throw new Error('Approval activation requires a previous candidate event')
        const previous = memoryReference(events, entry.previousEventId, 'thesis')
        const approval = latestApproval(events, previous.eventId)
        if (approval.eventId !== basis.approvalEventId) throw new Error('activationBasis does not name the current approval')
        if (previous.entry.kind !== 'thesis' || previous.entry.status !== 'candidate'
          || approvedContent(previous.entry) !== approvedContent(entry)) throw new Error('Activation differs from the approved candidate content')
      }
    }
  }
  if (entry.kind === 'approval') {
    if (origin.kind !== 'user-surface') throw new Error('Approval is available only on the user surface, never through agent tools')
    const target = memoryReference(events, entry.targetEventId)
    const item = target.entry
    if (item.kind !== 'thesis' && item.kind !== 'lesson') throw new Error('Approval target must be a thesis or lesson')
    const latest = events.filter(e => item.kind === 'thesis'
      ? e.entry.kind === 'thesis' && e.entry.thesisId === item.thesisId
      : e.entry.kind === 'lesson' && e.entry.lessonId === item.lessonId).at(-1)
    if (latest?.eventId !== target.eventId) throw new Error('Cannot approve a superseded interpretation')
    if (item.kind === 'thesis' && item.status !== 'candidate'
      || item.kind === 'lesson' && !['proposed', 'approved'].includes(item.status)) throw new Error('Interpretation is not eligible for approval')
  }
  if (entry.kind === 'check') {
    memoryReference(events, entry.metricsEvidenceId, 'evidence')
    if (ms(entry.evaluatedAt) > ms(recordedAt)) throw new Error('Check evaluation is after recording')
    if (events.some(e => e.entry.kind === 'check' && e.entry.runId === entry.runId)) throw new Error('Check runId is already recorded')
    unique(entry.results.map(r => `${r.thesisEventId}:${r.conditionId}`), 'condition result')
    for (const result of entry.results) {
      const thesis = memoryReference(events, result.thesisEventId, 'thesis').entry
      if (thesis.kind !== 'thesis' || !('conditions' in thesis) || !thesis.conditions.some(c => c.conditionId === result.conditionId)) throw new Error('Unknown conditionId in thesis check')
      if (result.result === 'not-evaluable') {
        if (!result.reason) throw new Error('Not-evaluable check requires a reason')
      } else if (result.value === null || result.observedAt === null) throw new Error('Evaluated checks require value and observedAt')
      if (result.observedAt && ms(result.observedAt) > ms(entry.evaluatedAt)) throw new Error('Check observation is after evaluation')
    }
  }
  if (entry.kind === 'signal') {
    unique(entry.assetIds, 'signal asset'); entry.assetIds.forEach(asset)
    if (events.some(e => e.entry.kind === 'signal' && e.entry.signalId === entry.signalId)) throw new Error('Signal identity is already recorded')
    if (ms(entry.confirmedAt) > ms(recordedAt) || ms(entry.expiresAt) <= ms(entry.confirmedAt)
      || ms(entry.expiresAt) - ms(entry.confirmedAt) > 7 * 86400_000) throw new Error('Signal expiry must follow confirmation by at most seven days')
    observationsFor(entry.observationIds ?? [], entry.assetIds)
    for (const ref of entry.evidenceIds ?? []) memoryReference(events, ref, 'evidence')
    unique(entry.relatedThesisIds, 'related thesis')
    for (const ref of entry.relatedThesisIds) {
      const thesis = memoryReference(events, ref, 'thesis').entry
      if (thesis.kind !== 'thesis' || !thesis.entityIds.some(entity => entry.assetIds.includes(economicAssetId(events, entity)))) throw new Error('Signal related thesis belongs to a different asset')
    }
  }
  if (entry.kind === 'judgment') {
    asset(entry.assetId)
    memoryReference(events, entry.metricsEvidenceId, 'evidence')
    observationsFor(entry.observationIds, [entry.assetId])
    if (events.some(e => e.entry.kind === 'judgment' && e.entry.reviewRunId === entry.reviewRunId
      && e.entry.assetId === entry.assetId && e.entry.horizon === entry.horizon)) throw new Error('Judgment is already recorded for this review, asset and horizon')
  }
  if (entry.kind === 'lesson') {
    unique(entry.supportingEventIds, 'supporting lesson event'); unique(entry.counterEventIds, 'counter lesson event')
    if (entry.counterEventIds.some(ref => entry.supportingEventIds.includes(ref))) throw new Error('Lesson support and counter examples overlap')
    for (const ref of [...entry.supportingEventIds, ...entry.counterEventIds]) memoryReference(events, ref)
    entry.scope.assetIds?.forEach(asset)
    const previous = events.filter(e => e.entry.kind === 'lesson' && e.entry.lessonId === entry.lessonId).at(-1)
    if (entry.previousEventId !== (previous?.eventId ?? null)
      || entry.version !== (previous?.entry.kind === 'lesson' ? previous.entry.version + 1 : 1)) throw new Error('Lesson revision must name the exact previous event')
    if (entry.status === 'approved' || entry.status === 'retired') {
      if (!previous || previous.entry.kind !== 'lesson') throw new Error('Lesson status requires user approval of a previous version')
      latestApproval(events, previous.eventId)
      if (previous.entry.status !== (entry.status === 'approved' ? 'proposed' : 'approved')
        || approvedContent(previous.entry) !== approvedContent(entry)) throw new Error('Lesson differs from the user-approved content or transition')
    }
  }
}
