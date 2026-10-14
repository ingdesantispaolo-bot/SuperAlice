import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { memoryEventSchema, type MemoryEvent } from './market-memory-schema.js'
import { acquireMemoryLock } from './market-memory-lock.js'
import type { ParsedMemoryContextQuery } from './market-memory-context.js'

type Read = (root: string, path: string, max: number) => Promise<Buffer>
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex')
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const queues = new Map<string, Promise<unknown>>()
const MAX_EVENTS = 100_000, MAX_BYTES = 512_000_000, MAX_EVENT_BYTES = 256_000
export function eventReferences(event: MemoryEvent): string[] {
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
function columns(event: MemoryEvent) {
  const e = event.entry
  const subjects = e.kind === 'catalog' || e.kind === 'observation' ? [e.entityId] : e.kind === 'thesis' ? e.entityIds
    : e.kind === 'signal' ? e.assetIds : e.kind === 'judgment' ? [e.assetId] : e.kind === 'lesson' ? e.scope.assetIds ?? [] : []
  const identity = e.kind === 'thesis' ? e.thesisId : e.kind === 'lesson' ? e.lessonId : e.kind === 'judgment' ? `${e.assetId}|${e.horizon}`
    : e.kind === 'observation' ? `${e.entityId}|${e.observationKey}|${Date.parse(e.observedPeriod.start)}|${Date.parse(e.observedPeriod.end)}` : null
  return { subjects, identity, horizon: 'horizon' in e ? e.horizon : null,
    group: e.kind === 'judgment' ? `${e.groupId}|${e.horizon}` : null, run: e.kind === 'judgment' ? e.reviewRunId : null,
    observedEnd: e.kind === 'observation' ? Date.parse(e.observedPeriod.end) : null,
    supersedes: e.kind === 'observation' ? e.supersedesId : null,
    expires: e.kind === 'signal' ? Date.parse(e.expiresAt) : null }
}
function parse(raw: Buffer, name: string, previous?: MemoryEvent) {
  const match = /^(\d{8})-([a-f0-9]{64})\.json$/.exec(name)
  if (!match || hash(raw) !== match[2]) throw new Error('Memory event integrity mismatch')
  const value = memoryEventSchema.parse(JSON.parse(raw.toString('utf8')))
  if (value.sequence !== Number(match[1]) || value.sequence !== (previous?.sequence ?? 0) + 1
    || value.previousHash !== (previous?.eventId ?? null) || previous && Date.parse(value.recordedAt) <= Date.parse(previous.recordedAt)) throw new Error('Broken memory event chain')
  return { ...value, eventId: match[2] }
}
async function indexDirectory(root: string) {
  const dir = join(root, 'index')
  try { await mkdir(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe memory index directory')
  const path = join(dir, 'market-memory.sqlite')
  try { const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe memory index file') } catch (e) { if (!missing(e)) throw e }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { if ((await lstat(path + suffix)).isSymbolicLink()) throw new Error('Unsafe memory index sidecar') } catch (e) { if (!missing(e)) throw e }
  }
  await writeFile(join(root, '.gitignore'), 'index/\n.writer.lock\n.index.lock\n.lock-control\n', { flag: 'wx' }).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e })
  return path
}

/** The index is derived local state. Persisted checkpoints trust previously verified immutable bytes. */
export async function withMemoryIndex<T>(root: string, read: Read, operation: (db: DatabaseSync, verification: { sequence: number; hash: string | null; newlyVerified: number; firstRecordedAt: string | null }) => T,
  mode: 'incremental' | 'audit' | 'rebuild' = 'incremental'): Promise<T> {
  const prior = queues.get(root) ?? Promise.resolve()
  const work = prior.catch(() => {}).then(async () => {
    const path = await indexDirectory(root), lock = await acquireMemoryLock(root, 'index')
    let db: DatabaseSync | undefined
    try {
      const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined
      if (!sqlite) throw new Error('Memory indexing requires a Node host with node:sqlite support')
      if (mode === 'rebuild') for (const suffix of ['', '-wal', '-shm', '-journal']) {
        // These exact derived paths were checked above; no archive/event bytes
        // are removed, and the index lock excludes all other index operations.
        await unlink(path + suffix).catch(e => { if (!missing(e)) throw e })
      }
      db = new sqlite.DatabaseSync(path)
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (version !== 2 && (version !== 0 || tables.length)) throw new Error('Memory index format is unknown; explicit rebuild required')
      db.exec(`PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;
        PRAGMA user_version=2;
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, filename TEXT NOT NULL, raw TEXT NOT NULL,
          kind TEXT NOT NULL, recorded INTEGER NOT NULL, identity TEXT, horizon TEXT, group_key TEXT, run TEXT, observed_end INTEGER, supersedes TEXT, expires INTEGER);
        CREATE INDEX IF NOT EXISTS event_kind ON events(kind, recorded, seq);
        CREATE INDEX IF NOT EXISTS event_inventory ON events(seq, hash, filename);
        CREATE INDEX IF NOT EXISTS event_identity ON events(kind, identity, recorded, seq);
        CREATE INDEX IF NOT EXISTS event_observation ON events(kind, identity, recorded, seq, hash, observed_end);
        CREATE INDEX IF NOT EXISTS event_group ON events(group_key, seq);
        CREATE INDEX IF NOT EXISTS event_supersedes ON events(supersedes);
        CREATE TABLE IF NOT EXISTS subjects (hash TEXT NOT NULL REFERENCES events(hash) ON DELETE CASCADE, subject TEXT NOT NULL, PRIMARY KEY(hash,subject));
        CREATE INDEX IF NOT EXISTS subject_lookup ON subjects(subject,hash);
        CREATE TABLE IF NOT EXISTS refs (hash TEXT NOT NULL REFERENCES events(hash) ON DELETE CASCADE, target TEXT NOT NULL, PRIMARY KEY(hash,target));
        CREATE TABLE IF NOT EXISTS checks (hash TEXT NOT NULL REFERENCES events(hash) ON DELETE CASCADE, thesis TEXT NOT NULL, evaluated INTEGER NOT NULL, PRIMARY KEY(hash,thesis));
        CREATE INDEX IF NOT EXISTS check_lookup ON checks(thesis,evaluated);
        CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE, entity TEXT NOT NULL, identity TEXT NOT NULL, recorded INTEGER NOT NULL, observed_end INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS observation_period ON observations(entity,observed_end DESC,seq DESC,recorded,identity);
        CREATE INDEX IF NOT EXISTS observation_revision ON observations(identity,recorded,seq);
        CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL, hash TEXT, total_bytes INTEGER NOT NULL);`)
      const names = (await readdir(join(root, 'events')).catch(e => { if (missing(e)) return []; throw e })).filter(n => !n.startsWith('.')).sort()
      if (names.length > MAX_EVENTS) throw new Error('Memory indexed event limit reached')
      // A name inventory detects removals/replacements/gaps without re-reading old bodies.
      for (let i = 0; i < names.length; i++) if (!/^\d{8}-[a-f0-9]{64}\.json$/.test(names[i]) || Number(names[i].slice(0, 8)) !== i + 1) throw new Error('Broken memory event chain or invalid filename')
      const checkpoint = db.prepare('SELECT * FROM checkpoint WHERE id=1').get()
      const indexed = db.prepare('SELECT seq, hash, filename FROM events INDEXED BY event_inventory ORDER BY seq').all()
      if (mode !== 'rebuild' && (indexed.length !== Number(checkpoint?.seq ?? 0) || indexed.some((row, i) => row.filename !== names[i]))) throw new Error('Memory index/archive inventory mismatch; audit or rebuild required')
      if (mode === 'rebuild') db.exec('BEGIN IMMEDIATE; DELETE FROM events; DELETE FROM checkpoint; COMMIT;')
      let sequence = mode === 'rebuild' ? 0 : Number(checkpoint?.seq ?? 0), totalBytes = mode === 'rebuild' ? 0 : Number(checkpoint?.total_bytes ?? 0)
      let previous: MemoryEvent | undefined, newlyVerified = 0
      if (sequence) {
        const row = db.prepare('SELECT raw, filename, hash FROM events WHERE seq=?').get(sequence)!
        const bytes = await read(root, join(root, 'events', String(row.filename)), MAX_EVENT_BYTES)
        if (hash(bytes) !== checkpoint?.hash || hash(String(row.raw)) !== row.hash) throw new Error('Memory checkpoint integrity mismatch')
        previous = { ...memoryEventSchema.parse(JSON.parse(bytes.toString('utf8'))), eventId: String(row.hash) }
      }
      if (mode === 'audit') {
        if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Memory index structural integrity mismatch')
        let priorEvent: MemoryEvent | undefined
        for (let i = 0; i < sequence; i++) {
          const bytes = await read(root, join(root, 'events', names[i]), MAX_EVENT_BYTES)
          const event = parse(bytes, names[i], priorEvent)
          const row = db.prepare('SELECT * FROM events WHERE seq=?').get(i + 1)!
          if (row.hash !== event.eventId || row.raw !== bytes.toString('utf8')) throw new Error('Memory index content mismatch; rebuild required')
          const fields = columns(event)
          const expected = { kind: event.entry.kind, recorded: Date.parse(event.recordedAt), identity: fields.identity, horizon: fields.horizon,
            group_key: fields.group, run: fields.run, observed_end: fields.observedEnd, supersedes: fields.supersedes, expires: fields.expires }
          if (Object.entries(expected).some(([key, value]) => row[key] !== value)) throw new Error('Memory index projection mismatch; rebuild required')
          const subjects = db.prepare('SELECT subject FROM subjects WHERE hash=? ORDER BY subject').all(event.eventId).map(r => r.subject)
          const refs = db.prepare('SELECT target FROM refs WHERE hash=? ORDER BY target').all(event.eventId).map(r => r.target)
          if (JSON.stringify(subjects) !== JSON.stringify([...new Set(fields.subjects)].sort())
            || JSON.stringify(refs) !== JSON.stringify([...new Set(eventReferences(event))].sort())) throw new Error('Memory index references mismatch; rebuild required')
          const checks = db.prepare('SELECT thesis,evaluated FROM checks WHERE hash=? ORDER BY thesis').all(event.eventId)
          const expectedChecks = event.entry.kind === 'check' ? [...new Set(event.entry.results.map(r => r.thesisEventId))].sort().map(thesis => ({ thesis, evaluated: event.entry.kind === 'check' ? Date.parse(event.entry.evaluatedAt) : 0 })) : []
          if (JSON.stringify(checks) !== JSON.stringify(expectedChecks)) throw new Error('Memory index checks mismatch; rebuild required')
          const observation = db.prepare('SELECT entity,identity,recorded,observed_end FROM observations WHERE seq=?').get(event.sequence)
          const expectedObservation = event.entry.kind === 'observation' ? { entity: event.entry.entityId, identity: fields.identity, recorded: Date.parse(event.recordedAt), observed_end: fields.observedEnd } : undefined
          if (JSON.stringify(observation) !== JSON.stringify(expectedObservation)) throw new Error('Memory index observation mismatch; rebuild required')
          priorEvent = event
        }
      }
      const insert = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'), subject = db.prepare('INSERT INTO subjects VALUES (?,?)'), ref = db.prepare('INSERT INTO refs VALUES (?,?)'), check = db.prepare('INSERT INTO checks VALUES (?,?,?)')
      const observation = db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)')
      db.exec('BEGIN IMMEDIATE')
      try {
        for (let offset = sequence; offset < names.length; offset += 32) {
          const raws = await Promise.all(names.slice(offset, offset + 32).map(name => read(root, join(root, 'events', name), MAX_EVENT_BYTES)))
          for (let i = 0; i < raws.length; i++) {
            const raw = raws[i], event = parse(raw, names[offset + i], previous), fields = columns(event)
            totalBytes += raw.length
            if (totalBytes > MAX_BYTES) throw new Error('Memory indexed byte limit reached')
            insert.run(event.sequence, event.eventId, names[offset + i], raw.toString('utf8'), event.entry.kind, Date.parse(event.recordedAt), fields.identity, fields.horizon, fields.group, fields.run, fields.observedEnd, fields.supersedes, fields.expires)
            for (const s of new Set(fields.subjects)) subject.run(event.eventId, s)
            for (const r of new Set(eventReferences(event))) ref.run(event.eventId, r)
            if (event.entry.kind === 'observation') observation.run(event.sequence, event.entry.entityId, fields.identity, Date.parse(event.recordedAt), fields.observedEnd)
            if (event.entry.kind === 'check') for (const t of new Set(event.entry.results.map(r => r.thesisEventId))) check.run(event.eventId, t, Date.parse(event.entry.evaluatedAt))
            previous = event; sequence = event.sequence; newlyVerified++
          }
        }
        db.prepare('INSERT OR REPLACE INTO checkpoint VALUES (1,?,?,?)').run(sequence, previous?.eventId ?? null, totalBytes)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
      const first = db.prepare('SELECT raw FROM events ORDER BY seq LIMIT 1').get()
      return operation(db, { sequence, hash: previous?.eventId ?? null, newlyVerified, firstRecordedAt: first ? JSON.parse(String(first.raw)).recordedAt : null })
    } finally { db?.close(); await lock.release() }
  })
  queues.set(root, work)
  try { return await work } finally { if (queues.get(root) === work) queues.delete(root) }
}

export function indexedEvents(db: DatabaseSync, sql = 'SELECT raw,hash FROM events ORDER BY seq', values: SQLInputValue[] = []) {
  return db.prepare(sql).all(...values).map(row => {
    const raw = String(row.raw), eventId = String(row.hash)
    if (hash(raw) !== eventId) throw new Error('Memory index row integrity mismatch')
    return { ...memoryEventSchema.parse(JSON.parse(raw)), eventId }
  })
}

/** Select only query-relevant rows and their immutable reference closure. */
export function indexedContextEvents(db: DatabaseSync, query: ParsedMemoryContextQuery, at: string, profile?: (sql: string, ms: number) => void) {
  const time = Date.parse(at), selected = new Map<string, MemoryEvent>()
  const add = (rows: MemoryEvent[]) => { for (const e of rows) selected.set(e.eventId, e); return rows }
  const rows = (sql: string, args: SQLInputValue[] = []) => {
    const started = performance.now(), result = indexedEvents(db, sql, args)
    profile?.(sql.replaceAll(/\s+/g, ' ').slice(0, 110), performance.now() - started)
    return result
  }
  const catalogs = add(rows("SELECT raw,hash FROM events WHERE kind='catalog' AND recorded<=? ORDER BY seq", [time]))
  const entities = new Set(query.entityIds), assets = new Set<string>()
  for (const e of catalogs) if (e.entry.kind === 'catalog' && entities.has(e.entry.entityId)) {
    if (e.entry.role === 'asset') assets.add(e.entry.entityId)
    else if ('assetId' in e.entry && e.entry.assetId) assets.add(e.entry.assetId)
  }
  for (const a of assets) entities.add(a)
  for (const e of catalogs) if (e.entry.kind === 'catalog' && 'assetId' in e.entry && e.entry.assetId && assets.has(e.entry.assetId)) entities.add(e.entry.entityId)
  const marks = [...entities].map(() => '?').join(','), args: SQLInputValue[] = [time, ...entities]
  const horizon = query.horizon ? ' AND horizon=?' : '', horizonArgs: SQLInputValue[] = query.horizon ? [query.horizon] : []
  const latest = (kind: string, extra = '', extraArgs: SQLInputValue[] = [], order = 'ORDER BY seq') => rows(`SELECT raw,hash FROM (
    SELECT e.*,row_number() OVER(PARTITION BY identity ORDER BY seq DESC) AS rank FROM events e
    WHERE kind=? AND recorded<=? AND EXISTS(SELECT 1 FROM subjects s WHERE s.hash=e.hash AND subject IN (${marks})))
    WHERE rank=1${kind === 'observation' ? '' : horizon}${extra} ${order}`, [kind, ...args, ...kind === 'observation' ? [] : horizonArgs, ...extraArgs])
  const theses = add(latest('thesis'))
  add(rows(`SELECT raw,hash FROM events e WHERE kind='signal' AND recorded<=? AND EXISTS(SELECT 1 FROM subjects s WHERE s.hash=e.hash AND subject IN (${marks}))${horizon}${query.includeExpired ? '' : ' AND expires>?'} ORDER BY seq`, [...args, ...horizonArgs, ...query.includeExpired ? [] : [time]]))
  add(rows("SELECT raw,hash FROM (SELECT *,row_number() OVER(PARTITION BY identity ORDER BY seq DESC) AS rank FROM events WHERE kind='lesson' AND recorded<=?) WHERE rank=1 ORDER BY seq", [time]))
  const judgments = add(latest('judgment'))
  const groups = new Set(judgments.flatMap(e => e.entry.kind === 'judgment' ? [`${e.entry.groupId}|${e.entry.horizon}`] : []))
  for (const group of groups) add(rows(`SELECT raw,hash FROM events WHERE group_key=? AND recorded<=? AND run=(SELECT run FROM events WHERE group_key=? AND recorded<=? ORDER BY seq DESC LIMIT 1) ORDER BY seq`, [group, time, group, time]))
  for (const thesis of theses) add(rows(`SELECT e.raw,e.hash FROM events e JOIN checks c ON e.hash=c.hash WHERE c.thesis=? AND e.recorded<=? ORDER BY c.evaluated DESC,e.seq DESC LIMIT 1`, [thesis.eventId, time]))
  const observationRows: MemoryEvent[] = []
  for (const entity of entities) observationRows.push(...rows(`SELECT e.raw,e.hash FROM (
    SELECT o.seq FROM observations o WHERE entity=? AND recorded<=?
      ${query.observedFrom ? ' AND observed_end>=?' : ''}${query.observedTo ? ' AND observed_end<=?' : ''}
      AND NOT EXISTS(SELECT 1 FROM observations newer WHERE newer.identity=o.identity AND newer.recorded<=? AND newer.seq>o.seq)
      ORDER BY observed_end DESC,seq DESC LIMIT ?
    ) latest CROSS JOIN events e ON e.seq=latest.seq`, [entity, time,
    ...query.observedFrom ? [Date.parse(query.observedFrom)] : [], ...query.observedTo ? [Date.parse(query.observedTo)] : [], time, query.limit + 1]))
  add(observationRows.sort((a, b) => a.entry.kind === 'observation' && b.entry.kind === 'observation' ? Date.parse(b.entry.observedPeriod.end) - Date.parse(a.entry.observedPeriod.end) || b.sequence - a.sequence : 0).slice(0, query.limit + 1))
  const refRows = db.prepare(`WITH RECURSIVE closure(hash) AS (SELECT value FROM json_each(?) UNION SELECT r.target FROM refs r JOIN closure c ON r.hash=c.hash)
    SELECT e.raw,e.hash FROM closure c CROSS JOIN events e ON e.hash=c.hash WHERE recorded<=? ORDER BY seq`)
  const closeRefs = () => add(refRows.all(JSON.stringify([...selected.keys()]), time).map(row => {
    const raw = String(row.raw), eventId = String(row.hash)
    if (hash(raw) !== eventId) throw new Error('Memory index row integrity mismatch')
    return { ...memoryEventSchema.parse(JSON.parse(raw)), eventId }
  }))
  closeRefs()
  const refs = JSON.stringify([...selected.keys()])
  add(rows("SELECT raw,hash FROM events WHERE supersedes IN (SELECT value FROM json_each(?)) AND recorded<=? ORDER BY seq", [refs, time]))
  add(rows("SELECT raw,hash FROM events WHERE kind='reconciliation' AND recorded<=? AND (json_extract(raw,'$.entry.observationId') IN (SELECT value FROM json_each(?)) OR json_extract(raw,'$.entry.originalEvidenceId') IN (SELECT value FROM json_each(?))) ORDER BY seq", [time, refs, refs]))
  closeRefs()
  // Keep a global eligible clock, independent of scoped row pruning.
  add(rows('SELECT raw,hash FROM events WHERE recorded<=? ORDER BY seq DESC LIMIT 1', [time]))
  return [...selected.values()].sort((a, b) => a.sequence - b.sequence)
}
