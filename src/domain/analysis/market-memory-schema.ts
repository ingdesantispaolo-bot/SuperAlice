import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const stamp = z.string().datetime({ offset: true })
const text = z.string().min(1).max(2000)
const horizon = z.enum(['intraday', 'swing', 'long-term', 'structural'])
const method = z.object({ id, version: z.string().min(1).max(80), description: z.string().max(1000) }).strict()
const refs = z.array(hash).min(1).max(12)
const optionalRefs = z.array(hash).max(12)
const catalogV1 = z.object({
  kind: z.literal('catalog'), entityId: id, label: text,
  assetClass: z.enum(['equity', 'rates', 'credit', 'currency', 'commodity', 'crypto', 'volatility', 'macro', 'research']),
  role: z.enum(['observed-series', 'estimated-curve', 'benchmark', 'proxy', 'research-artifact']),
  source: z.string().min(1).max(300), sourceSeriesId: z.string().min(1).max(300),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), unit: z.string().min(1).max(100), method,
  yieldType: z.enum(['yield-to-maturity', 'zero-coupon', 'par', 'unknown']).nullable(),
  benchmarkEquivalence: z.literal('not-established'),
  availability: z.enum(['pending', 'evidence-only', 'source-verified']).default('evidence-only'),
}).strict()
const evidence = z.object({
  kind: z.literal('evidence'), originalPath: z.string().min(1).max(500), sha256: hash,
  format: z.enum(['mcp', 'json', 'text']), description: text, originalRunId: id.nullable(),
}).strict()
const observation = z.object({
  kind: z.literal('observation'), entityId: id, observationKey: id,
  value: z.number().finite().nullable(), unit: z.string().min(1).max(100),
  observedPeriod: z.object({ start: stamp, end: stamp }).strict(),
  periodBasis: z.enum(['source-observation', 'session-date-label', 'economic-period', 'unknown']).default('unknown'),
  publishedAt: stamp.nullable(), acquiredAt: stamp,
  acquisitionBasis: z.enum(['source-fetch', 'artifact-import', 'producer-record']).default('artifact-import'),
  sourceFetchedAt: stamp.nullable().default(null), publicationBasis: z.enum(['source-declared', 'unknown']),
  quality: z.enum(['usable', 'degraded', 'stale', 'missing']), finality: z.enum(['final', 'partial', 'unknown']),
  expiresAt: stamp.nullable(), evidenceIds: refs, supersedesId: hash.nullable(), note: z.string().max(2000),
}).strict()
const thesisV1 = z.object({
  kind: z.literal('thesis'), thesisId: id, entityIds: z.array(id).min(1).max(8), horizon,
  version: z.number().int().positive(), previousEventId: hash.nullable(),
  status: z.enum(['candidate', 'active', 'invalidated', 'resolved', 'superseded']),
  interpretationAt: stamp.nullable().default(null), summary: text, invalidation: text,
  supportingObservationIds: refs, contraryObservationIds: optionalRefs,
  openQuestions: z.array(z.string().min(1).max(500)).max(8),
}).strict()
const reconciliation = z.object({
  kind: z.literal('reconciliation'), originalEvidenceId: hash, observationId: hash,
  result: z.enum(['same', 'different', 'not-comparable']), explanation: text,
}).strict()
const author = z.object({ type: z.enum(['superai', 'user', 'monitor-analyst']), agent: id.optional() }).strict()
export const memoryOriginSchema = z.object({
  kind: z.enum(['session', 'issue', 'user-surface']), workspaceId: id,
  resumeId: id.optional(), issueId: id.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'issue') !== Boolean(value.issueId) || value.kind === 'user-surface' && value.resumeId) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent host memory origin' })
  }
})
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>
const catalog = catalogV1.extend({
  role: z.enum(['asset', 'observed-series', 'estimated-curve', 'benchmark', 'proxy', 'research-artifact']),
  assetId: id.optional(), source: catalogV1.shape.source.optional(), sourceSeriesId: catalogV1.shape.sourceSeriesId.optional(),
  currency: catalogV1.shape.currency.optional(), unit: catalogV1.shape.unit.optional(), method: method.optional(),
  yieldType: catalogV1.shape.yieldType.optional(), benchmarkEquivalence: catalogV1.shape.benchmarkEquivalence.optional(),
}).superRefine((value, ctx) => {
  if (value.role === 'asset') {
    if (value.source || value.sourceSeriesId || value.assetId || value.method) ctx.addIssue({ code: 'custom', message: 'An economic asset has no source, series, parent asset or method' })
  } else {
    for (const key of ['source', 'sourceSeriesId', 'currency', 'unit', 'method', 'yieldType', 'benchmarkEquivalence'] as const) {
      if (value[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'Required for a series or research artifact' })
    }
    if (value.role !== 'research-artifact' && !value.assetId) ctx.addIssue({ code: 'custom', path: ['assetId'], message: 'New series require an assetId; legacy catalog events remain readable' })
  }
})
const condition = z.object({
  conditionId: id, role: z.enum(['invalidation', 'trigger', 'target', 'review']), assetId: id, measureKey: id,
  timeframe: z.enum(['1D', '1W', '1H']), op: z.enum(['>', '>=', '<', '<=']),
  threshold: z.union([z.number().finite(), z.object({ assetId: id, measureKey: id }).strict()]),
  consecutive: z.number().int().min(1).max(10), activeFrom: stamp.optional(), expiresAt: stamp.optional(),
}).strict()
const activationBasis = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scheduled-review'), issueId: id }).strict(),
  z.object({ type: z.literal('user-approval'), approvalEventId: hash }).strict(),
])
const thesis = thesisV1.extend({ author, conditions: z.array(condition).max(20).default([]), activationBasis: activationBasis.optional() })
export const memoryApprovalSchema = z.object({
  kind: z.literal('approval'), targetEventId: hash, decision: z.enum(['approve', 'reject']), note: text,
}).strict()
const check = z.object({
  kind: z.literal('check'), runId: id, evaluatedAt: stamp, metricsEvidenceId: hash,
  results: z.array(z.object({
    thesisEventId: hash, conditionId: id, result: z.enum(['met', 'not-met', 'not-evaluable']),
    value: z.number().finite().nullable(), observedAt: stamp.nullable(), reason: text.optional(),
  }).strict()).min(1).max(500),
}).strict()
const signal = z.object({
  kind: z.literal('signal'), author, signalId: id, assetIds: z.array(id).min(1).max(50),
  horizon: z.enum(['intraday', 'swing']), signalType: id, summary: text, confirmedAt: stamp, expiresAt: stamp,
  relatedThesisIds: z.array(hash).max(12), sourceRunId: id, observationIds: refs.optional(), evidenceIds: refs.optional(),
}).strict().refine(value => Boolean(value.observationIds?.length || value.evidenceIds?.length), { message: 'Signal requires observations or evidence' })
const dimension = z.enum(['favorable', 'neutral', 'unfavorable', 'not-available'])
const judgment = z.object({
  kind: z.literal('judgment'), author, reviewRunId: id, groupId: id, assetId: id,
  horizon: z.enum(['swing', 'long-term']),
  dimensions: z.object({ valuation: dimension, fundamentals: dimension, technical: dimension, risk: dimension }).strict(),
  coverage: z.enum(['technical-only', 'partial-fundamentals', 'complete']),
  relativePreference: z.enum(['preferred', 'neutral', 'less-preferred', 'not-assessed']), confidence: z.enum(['low', 'medium', 'high']),
  rationale: text, observationIds: optionalRefs, metricsEvidenceId: hash,
}).strict()
const lesson = z.object({
  kind: z.literal('lesson'), author, lessonId: id, version: z.number().int().positive(), previousEventId: hash.nullable().default(null),
  statement: text, scope: z.object({ setupType: id.optional(), regime: id.optional(), assetIds: z.array(id).min(1).max(50).optional() }).strict(),
  supportingEventIds: z.array(hash).min(3).max(30), counterEventIds: z.array(hash).max(30),
  status: z.enum(['proposed', 'approved', 'rejected', 'retired']),
}).strict()
export const memoryEntrySchema = z.discriminatedUnion('kind', [catalog, evidence, observation, thesis, reconciliation, memoryApprovalSchema, check, signal, judgment, lesson])
export type MemoryEntry = z.infer<typeof memoryEntrySchema>
const eventFields = { sequence: z.number().int().positive(), recordedAt: stamp, previousHash: hash.nullable() }
const eventV1 = z.object({
  ...eventFields, schemaVersion: z.literal(1), origin: z.object({ workspaceId: id, resumeId: id.nullable() }).strict(),
  entry: z.union([catalogV1, evidence.extend({ storedPath: z.string().min(1).max(500) }), observation, thesisV1, reconciliation]),
}).strict()
const eventV2 = z.object({
  ...eventFields, schemaVersion: z.literal(2), origin: memoryOriginSchema,
  entry: z.union([catalog, evidence.extend({ storedPath: z.string().min(1).max(500) }), observation, thesis, reconciliation, memoryApprovalSchema, check, signal, judgment, lesson]),
}).strict()
export const memoryEventSchema = z.discriminatedUnion('schemaVersion', [eventV1, eventV2])
export type MemoryEvent = z.infer<typeof memoryEventSchema> & { eventId: string }
export const memoryMeasuresSchema = z.object({
  schema: z.literal('superai.measures/1'), methodVersion: z.string().min(1).max(80),
  measures: z.array(z.object({
    assetId: id, measureKey: id, timeframe: z.enum(['1D', '1W', '1H']), unit: z.string().min(1).max(100), seriesId: id,
    definition: text, completedBarsOnly: z.boolean(),
  }).strict()).min(1).max(5000),
}).strict().refine(value => new Set(value.measures.map(m => `${m.assetId}|${m.measureKey}|${m.timeframe}`)).size === value.measures.length,
  { message: 'Duplicate measure definition for asset/key/timeframe' })
