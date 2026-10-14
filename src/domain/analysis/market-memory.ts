import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { memoryEntrySchema, memoryEventSchema as eventSchema, memoryMeasuresSchema, memoryOriginSchema, type MemoryEntry, type MemoryEvent, type MemoryOrigin } from './market-memory-schema.js'
import { economicAssetId, memoryCatalogEntry, validateMemoryV2 } from './market-memory-validation.js'
import { memoryContextSchema, selectMarketContext, type MemoryContextQuery } from './market-memory-context.js'
import { withMemoryIndex, indexedEvents, indexedContextEvents } from './market-memory-index.js'
import { acquireMemoryLock, recoverMemoryLock } from './market-memory-lock.js'
export { memoryEntrySchema } from './market-memory-schema.js'
export type { MemoryEntry, MemoryEvent, MemoryOrigin } from './market-memory-schema.js'
export { memoryContextSchema } from './market-memory-context.js'
export type { MemoryContextQuery } from './market-memory-context.js'
const namespace = 'research/market-memory/v1'
const archiveAttributes = 'events/** -text\nevidence/** -text\n'
const MAX_EVENTS = 100_000, MAX_EVENT_BYTES = 256_000, MAX_EVIDENCE_BYTES = 4_000_000
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const ms = (value: string) => Date.parse(value)
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const within = (root: string, target: string) => { const r = relative(root, target); return r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(r) }

/** Workspace identity is supplied by the host, never a caller-selected root. */
async function memoryRoot(workspace: string, create = false): Promise<string | null> {
  const root = await realpath(workspace)
  if (!within(root, await realpath(join(root, '.alice')))) throw new Error('Workspace metadata escaped its root')
  let current = root
  for (const part of namespace.split('/')) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe memory directory')
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return null
      await mkdir(current)
    }
  }
  if (create) {
    const attrs = join(current, '.gitattributes')
    try { await writeFile(attrs, archiveAttributes, { flag: 'wx' }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if ((await checkedRead(current, attrs, 4096)).toString('utf8').replaceAll('\r\n', '\n') !== archiveAttributes) {
      throw new Error('Memory archive attributes differ; preserve exact-byte Git storage before writing')
    }
  }
  return current
}
async function checkedRead(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const target = await realpath(path)
  if (!within(root, target)) throw new Error('Evidence path escaped the Workspace')
  const info = await lstat(target)
  if (!info.isFile() || info.size > maxBytes) throw new Error('File exceeds memory read limit or is not a file')
  const bytes = await readFile(target)
  if (bytes.length > maxBytes) throw new Error('File exceeds memory read limit')
  return bytes
}
async function directory(root: string, name: string, create: boolean): Promise<string | null> {
  const path = join(root, name)
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe memory subdirectory')
  } catch (error) {
    if (!isMissing(error)) throw error
    if (!create) return null
    await mkdir(path)
  }
  return path
}
async function readEvents(root: string): Promise<MemoryEvent[]> {
  await directory(root, 'events', true)
  return withMemoryIndex(root, checkedRead, db => indexedEvents(db))
}
function requireKind(events: MemoryEvent[], eventId: string, kind: MemoryEntry['kind']): MemoryEvent {
  const event = events.find(e => e.eventId === eventId)
  if (!event || event.entry.kind !== kind) throw new Error(`Missing ${kind} reference`)
  return event
}
function validateEntry(events: MemoryEvent[], entry: MemoryEntry, recordedAt: string, measures?: z.infer<typeof memoryMeasuresSchema>) {
  const catalog = (entityId: string) => {
    const event = events.find(e => e.entry.kind === 'catalog' && e.entry.entityId === entityId)
    if (!event || event.entry.kind !== 'catalog') throw new Error(`Unknown catalog entity: ${entityId}`)
    return event.entry
  }
  if (entry.kind === 'catalog' && events.some(e => e.entry.kind === 'catalog' && e.entry.entityId === entry.entityId)) {
    throw new Error('Catalog identity is immutable; reuse it or give a changed source/method a distinct entityId')
  }
  if (entry.kind === 'observation') {
    const registeredMeasure = measures?.measures.find(m => m.seriesId === entry.entityId && m.assetId === economicAssetId(events, entry.entityId)
      && m.measureKey === entry.observationKey && m.unit === entry.unit)
    if (catalog(entry.entityId).unit !== entry.unit && !registeredMeasure) throw new Error('Observation unit differs from catalog and no registered measure defines it')
    if (catalog(entry.entityId).availability === 'pending') throw new Error('Pending catalog identity must be verified before measurements are recorded')
    if (ms(entry.observedPeriod.start) > ms(entry.observedPeriod.end)
      || ms(entry.acquiredAt) > ms(recordedAt)
      || entry.finality === 'final' && ms(entry.observedPeriod.end) > ms(entry.acquiredAt)
      || entry.publishedAt && ms(entry.publishedAt) > ms(entry.acquiredAt)
      || (entry.publishedAt === null) !== (entry.publicationBasis === 'unknown')
      || entry.quality === 'missing' && entry.value !== null
      || entry.quality === 'usable' && entry.value === null) throw new Error('Inconsistent observation clocks or quality')
    for (const ref of entry.evidenceIds) requireKind(events, ref, 'evidence')
    const previous = events.filter(e => e.entry.kind === 'observation' && e.entry.entityId === entry.entityId
      && e.entry.observationKey === entry.observationKey
      && ms(e.entry.observedPeriod.start) === ms(entry.observedPeriod.start)
      && ms(e.entry.observedPeriod.end) === ms(entry.observedPeriod.end)).at(-1)
    if (entry.supersedesId !== (previous?.eventId ?? null)) throw new Error('Observation revision must name the exact previous event')
  }
  if (entry.kind === 'thesis') {
    if (entry.interpretationAt && ms(entry.interpretationAt) > ms(recordedAt)) throw new Error('Thesis interpretation is after recording')
    for (const entityId of entry.entityIds) catalog(entityId)
    const previous = events.filter(e => e.entry.kind === 'thesis' && e.entry.thesisId === entry.thesisId).at(-1)
    if (entry.previousEventId !== (previous?.eventId ?? null)
      || entry.version !== (previous?.entry.kind === 'thesis' ? previous.entry.version + 1 : 1)
      || previous?.entry.kind === 'thesis' && (previous.entry.horizon !== entry.horizon
        || JSON.stringify(previous.entry.entityIds) !== JSON.stringify(entry.entityIds))) throw new Error('Thesis revision or horizon identity mismatch')
    for (const ref of [...entry.supportingObservationIds, ...entry.contraryObservationIds]) {
      const observed = requireKind(events, ref, 'observation').entry
      if (observed.kind !== 'observation' || !entry.entityIds.some(entity => economicAssetId(events, entity) === economicAssetId(events, observed.entityId))) throw new Error('Thesis evidence belongs to a different entity')
    }
  }
  if (entry.kind === 'reconciliation') {
    requireKind(events, entry.originalEvidenceId, 'evidence')
    requireKind(events, entry.observationId, 'observation')
  }
}
async function verifyEvidence(root: string, event: MemoryEvent) {
  if (event.entry.kind !== 'evidence') throw new Error('Not an evidence event')
  const expected = `evidence/${event.entry.sha256}.${event.entry.format === 'text' ? 'txt' : 'json'}`
  if (event.entry.storedPath !== expected) throw new Error('Unsafe evidence reference')
  const bytes = await checkedRead(root, join(root, expected), MAX_EVIDENCE_BYTES)
  if (digest(bytes) !== event.entry.sha256) throw new Error('Stored evidence integrity mismatch')
  if (event.entry.format === 'mcp') {
    const envelope = JSON.parse(bytes.toString('utf8'))
    if (typeof envelope.content?.[0]?.text !== 'string'
      || digest(envelope.content[0].text) !== envelope._meta?.['ibivmonitor/sha256']) throw new Error('Canonical MCP evidence mismatch')
    if (envelope.isError) throw new Error('MCP error cannot be used as measurement evidence')
    if (envelope.structuredContent && JSON.stringify(JSON.parse(envelope.content[0].text)) !== JSON.stringify(envelope.structuredContent)) {
      // Key ordering can differ: compare through a canonical sorted object representation.
      const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v
      if (JSON.stringify(sorted(JSON.parse(envelope.content[0].text))) !== JSON.stringify(sorted(envelope.structuredContent))) throw new Error('Structured MCP evidence mismatch')
    }
  }
  return { eventId: event.eventId, ...event.entry, path: `${namespace}/${expected}`, recordedAt: event.recordedAt }
}

/** Append-only writes under one exclusive lock, no backdating API. */
export async function appendMemoryEntry(workspace: string, entryInput: unknown, hostOrigin: MemoryOrigin, now = new Date(), authority: { scheduledReviewIssueId?: string; deduplicateSignal?: boolean } = {}) {
  const origin = memoryOriginSchema.parse(hostOrigin)
  const entry = memoryEntrySchema.parse(entryInput)
  const root = (await memoryRoot(workspace, true))!
  const lock = await acquireMemoryLock(root, 'writer'), owner = lock.owner
  try {
    const events = await readEvents(root)
    if (authority.deduplicateSignal) {
      if (entry.kind !== 'signal') throw new Error('deduplicateSignal applies only to confirmed signal entries')
      const prior = events.find(e => e.entry.kind === 'signal' && e.entry.signalId === entry.signalId)
      if (prior) {
        if (JSON.stringify(prior.entry) !== JSON.stringify(entry)) throw new Error('Signal identity exists with different content; preserve its original confirmation or use a new episode identity')
        const refs = new Set(entry.evidenceIds ?? [])
        for (const ref of entry.observationIds ?? []) {
          const observation = requireKind(events, ref, 'observation').entry
          if (observation.kind === 'observation') for (const evidence of observation.evidenceIds) refs.add(evidence)
        }
        for (const ref of refs) await verifyEvidence(root, requireKind(events, ref, 'evidence'))
        return { accepted: true, alreadyRecorded: true, eventId: prior.eventId, sequence: prior.sequence, recordedAt: prior.recordedAt }
      }
    }
    if (events.length >= MAX_EVENTS) throw new Error('Memory event limit reached')
    const recordedAt = new Date(Math.max(now.getTime(), events.length ? ms(events.at(-1)!.recordedAt) + 1 : 0)).toISOString()
    let measures: z.infer<typeof memoryMeasuresSchema> | undefined
    const needsMeasures = entry.kind === 'thesis' && entry.conditions.length
      || entry.kind === 'observation' && memoryCatalogEntry(events, entry.entityId).unit !== entry.unit
    if (needsMeasures) {
      const workspaceRoot = await realpath(workspace)
      try {
        measures = memoryMeasuresSchema.parse(JSON.parse((await checkedRead(workspaceRoot, join(workspaceRoot, 'research/market-assistant/global-map/measures.json'), MAX_EVIDENCE_BYTES)).toString('utf8')))
      } catch (error) {
        if (isMissing(error)) {
          if (entry.kind === 'thesis') throw new Error('Measures registry unavailable: research/market-assistant/global-map/measures.json')
        } else throw error
      }
    }
    validateEntry(events, entry, recordedAt, measures)
    validateMemoryV2(events, entry, origin, recordedAt, measures, authority.scheduledReviewIssueId)
    let persisted: unknown = entry
    if (entry.kind === 'evidence') {
      const normalized = entry.originalPath.replaceAll('\\', '/')
      if (!normalized.startsWith('research/') || isAbsolute(normalized) || normalized.includes('\0') || normalized.split('/').includes('..')) throw new Error('Evidence must be a research artifact in this Workspace')
      const workspaceRoot = await realpath(workspace)
      const bytes = await checkedRead(workspaceRoot, resolve(workspaceRoot, normalized), MAX_EVIDENCE_BYTES)
      if (digest(bytes) !== entry.sha256) throw new Error('Original evidence hash mismatch')
      if (entry.format !== 'text') JSON.parse(bytes.toString('utf8'))
      const storedPath = `evidence/${entry.sha256}.${entry.format === 'text' ? 'txt' : 'json'}`
      const evidenceEntry = { ...entry, storedPath }
      persisted = evidenceEntry
      const provisional = { schemaVersion: 2 as const, sequence: events.length + 1, recordedAt, previousHash: events.at(-1)?.eventId ?? null, origin, entry: evidenceEntry, eventId: '' }
      await directory(root, 'evidence', true)
      try { await writeFile(join(root, storedPath), bytes, { flag: 'wx' }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await verifyEvidence(root, provisional)
    }
    const evidenceRefs = entry.kind === 'observation' ? entry.evidenceIds
      : entry.kind === 'signal' ? entry.evidenceIds ?? []
        : entry.kind === 'check' || entry.kind === 'judgment' ? [entry.metricsEvidenceId] : []
    const observationRefs = entry.kind === 'thesis' ? [...entry.supportingObservationIds, ...entry.contraryObservationIds]
      : entry.kind === 'signal' || entry.kind === 'judgment' ? entry.observationIds ?? [] : []
    const allEvidenceRefs = new Set(evidenceRefs)
    for (const ref of observationRefs) {
      const observation = requireKind(events, ref, 'observation').entry
      if (observation.kind === 'observation') for (const evidenceId of observation.evidenceIds) allEvidenceRefs.add(evidenceId)
    }
    for (const ref of allEvidenceRefs) await verifyEvidence(root, requireKind(events, ref, 'evidence'))
    const event = eventSchema.parse({ schemaVersion: 2, sequence: events.length + 1, recordedAt, previousHash: events.at(-1)?.eventId ?? null, origin, entry: persisted })
    const bytes = JSON.stringify(event) + '\n', eventId = digest(bytes)
    if (Buffer.byteLength(bytes) > MAX_EVENT_BYTES) throw new Error('Event exceeds memory write limit')
    const eventsDir = (await directory(root, 'events', true))!
    const temp = join(eventsDir, `.${owner}.tmp`)
    try {
      await writeFile(temp, bytes, { flag: 'wx' })
      await rename(temp, join(eventsDir, `${String(event.sequence).padStart(8, '0')}-${eventId}.json`))
    } finally { await unlink(temp).catch(error => { if (!isMissing(error)) throw error }) }
    return { accepted: true, eventId, sequence: event.sequence, recordedAt }
  } finally {
    await lock.release()
  }
}

export async function readMemoryCatalog(workspace: string) {
  const root = await memoryRoot(workspace)
  if (!root) return { status: 'empty', entries: [], recordCount: 0 }
  return withMemoryIndex(root, checkedRead, (db, verification) => ({ status: verification.sequence ? 'available' : 'empty',
    entries: indexedEvents(db, "SELECT raw,hash FROM events WHERE kind='catalog' ORDER BY seq").map(e => ({ eventId: e.eventId, ...e.entry, recordedAt: e.recordedAt })), recordCount: verification.sequence }))
}

/** Read-only retrieval: neither the monitor nor any model participates. */
export async function getMarketContext(workspace: string, input: MemoryContextQuery, now = new Date()) {
  const query = memoryContextSchema.parse(input)
  const at = query.knownAsOf ?? now.toISOString()
  if (ms(at) > now.getTime() || query.observedFrom && query.observedTo && ms(query.observedFrom) > ms(query.observedTo)) throw new Error('Invalid context time range')
  const root = await memoryRoot(workspace)
  const { evidenceEvents, output } = root
    ? await withMemoryIndex(root, checkedRead, (db, verification) => selectMarketContext(indexedContextEvents(db, query, at), query, at, verification.firstRecordedAt))
    : selectMarketContext([], query, at)
  const evidence = []
  for (const event of evidenceEvents) evidence.push(await verifyEvidence(root!, event))
  const packet = { ...output, evidence }
  if (JSON.stringify(packet).length > query.maxChars) throw new Error('Context output limit reached; narrow entities/horizon or raise the reviewed budget')
  return packet
}

/** Local operator maintenance, exposed separately from agent tools. */
export async function manageMemoryIndex(workspace: string, operation: 'audit' | 'rebuild' | 'recover-lock', kind: 'writer' | 'index' | 'control' = 'writer') {
  const root = await memoryRoot(workspace)
  if (!root) return { available: false, reason: 'Memory archive absent' }
  if (operation === 'recover-lock') return recoverMemoryLock(root, kind)
  return withMemoryIndex(root, checkedRead, (_db, verification) => ({ available: true, operation, ...verification,
    verificationScope: 'all-event-bytes', evidenceVerification: 'Selected context evidence is checked separately' }), operation)
}
