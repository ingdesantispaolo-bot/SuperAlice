import { createHash } from 'node:crypto'
import { readFile, realpath, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'

const iso = z.string().datetime({ offset: true })
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().min(1).max(120)
const instrument = z.object({
  symbol: identifier, secType: identifier, exchange: identifier, currency: identifier,
  tradingClass: z.string().max(80), multiplier: z.string().max(40),
  expiries: z.array(z.string().regex(/^\d{8}$/)).max(500), referenceFrame: identifier,
}).strict()
const algorithm = z.object({
  id: identifier, version: identifier,
  parameters: z.record(z.string().max(80), z.union([z.number().finite(), z.boolean()])).refine(v => Object.keys(v).length <= 50),
}).strict()
const metric = z.object({
  id: identifier, value: z.number().finite().nullable(), unit: identifier, source: z.literal('IBKR'),
  instrument, sourceAt: iso.nullable(), horizon: z.enum(['intraday', 'daily']),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), sessionComplete: z.boolean(),
  dataType: z.enum(['live', 'delayed', 'frozen', 'unknown', 'historical']),
  quality: z.enum(['usable', 'degraded', 'stale', 'missing']), reason: z.string().max(300),
  coverage: z.number().min(0).max(1).nullable(), algorithm,
}).strict()
export const monitorSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  producer: z.object({ name: z.literal('IbIvMonitor'), version: identifier, instanceId: identifier, startedAt: iso }).strict(),
  generatedAt: iso, connected: z.boolean(),
  modules: z.array(z.object({ id: identifier, active: z.boolean(), metrics: z.array(metric).max(100) }).strict()).max(40),
}).strict()
export const monitorManifestSchema = z.object({
  schemaVersion: z.literal(1), sha256: hash, file: z.string().regex(/^snapshots\/[a-f0-9]{64}\.json$/), generatedAt: iso,
}).strict().refine(v => v.file === `snapshots/${v.sha256}.json`, 'Manifest hash and file differ')
export type MonitorSnapshot = z.infer<typeof monitorSnapshotSchema>

export interface MonitorContextOptions { asOf?: string; snapshotId?: string }
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 4096
const STALE_AFTER_MS = 5 * 60_000
const CLOCK_TOLERANCE_MS = 30_000

/** Paths come only from operator configuration or a validated hash manifest. */
async function containedFile(root: string, parts: string[], maxBytes: number): Promise<Buffer> {
  const target = await realpath(join(root, ...parts))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Archive path escapes configured directory')
  const info = await stat(target)
  if (!info.isFile() || info.size > maxBytes) throw new Error('Archive file is not a bounded regular file')
  const bytes = await readFile(target)
  if (bytes.length > maxBytes) throw new Error('Archive file exceeds size limit')
  return bytes
}

function projectedQuality(item: z.infer<typeof metric>, active: boolean, connected: boolean, at: number, generated: number) {
  let quality = item.quality
  let reason = item.reason
  const sourceAt = item.sourceAt === null ? NaN : Date.parse(item.sourceAt)
  if (!active || item.value === null || !Number.isFinite(sourceAt)) {
    quality = 'missing'; reason = !active ? 'monitor-not-running' : 'value-or-source-time-unavailable'
  } else if (sourceAt > generated + CLOCK_TOLERANCE_MS || sourceAt > at + CLOCK_TOLERANCE_MS) {
    quality = 'missing'; reason = 'source-time-in-future'
  } else if (at - generated > STALE_AFTER_MS) {
    quality = 'stale'; reason = 'producer-heartbeat-stale'
  } else if (item.horizon === 'intraday' && (!connected || at - sourceAt > STALE_AFTER_MS)) {
    quality = 'stale'; reason = connected ? 'source-older-than-five-minutes' : 'tws-disconnected'
  } else if (item.horizon === 'daily' && (!item.sessionComplete || item.sessionDate === null)) {
    quality = 'missing'; reason = 'daily-session-not-confirmed-complete'
  } else if (quality === 'usable' && item.dataType !== 'live' && item.dataType !== 'historical') {
    quality = 'degraded'; reason = `feed-${item.dataType}`
  }
  return { ...item, quality, reason, usableForResearch: quality === 'usable' }
}

/** Read-only, broker-free. Archived decisions use a publication <= asOf, never a future recomputation. */
export async function readMonitorContext(directory: string | null, options: MonitorContextOptions = {}, now = new Date()) {
  const unavailable = (status: 'missing' | 'invalid', reason: string) => ({ status, reason, advisoryOnly: true as const })
  if (!directory) return unavailable('missing', 'monitor-bridge-not-configured')
  if (options.asOf && options.snapshotId) return unavailable('invalid', 'select-asOf-or-snapshotId')
  if (options.asOf && !iso.safeParse(options.asOf).success) return unavailable('invalid', 'asOf-must-be-an-ISO-timestamp-with-timezone')
  if (options.snapshotId && !hash.safeParse(options.snapshotId).success) return unavailable('invalid', 'invalid-snapshot-id')
  const at = options.asOf ? Date.parse(options.asOf) : now.getTime()
  if (at > now.getTime() + CLOCK_TOLERANCE_MS) return unavailable('invalid', 'asOf-in-future')
  try {
    const root = await realpath(resolve(directory))
    let manifestBytes: Buffer
    if (options.asOf || options.snapshotId) {
      const cutoff = new Date(at).toISOString().replace(/[-:.]/g, '').replace('Z', '9999Z')
      const entries = (await readdir(join(root, 'manifests')))
        .filter(n => /^\d{8}T\d{13}Z-[a-f0-9]{64}\.json$/.test(n)
          && n.slice(0, 23) <= cutoff && (!options.snapshotId || n.endsWith(`-${options.snapshotId}.json`)))
        .sort().reverse()
      let found: Buffer | undefined
      for (const entry of entries) {
        if (options.snapshotId && !entry.endsWith(`-${options.snapshotId}.json`)) continue
        const candidate = await containedFile(root, ['manifests', entry], MAX_MANIFEST_BYTES)
        const manifest = monitorManifestSchema.parse(JSON.parse(candidate.toString('utf8')))
        if (Date.parse(manifest.generatedAt) <= at) { found = candidate; break }
      }
      if (!found) return unavailable('missing', 'no-snapshot-published-at-or-before-selection')
      manifestBytes = found
    } else {
      manifestBytes = await containedFile(root, ['latest.json'], MAX_MANIFEST_BYTES)
    }
    const manifest = monitorManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
    const bytes = await containedFile(root, manifest.file.split('/'), MAX_SNAPSHOT_BYTES)
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) return unavailable('invalid', 'snapshot-hash-mismatch')
    const snapshot = monitorSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')))
    const generated = Date.parse(snapshot.generatedAt)
    if (snapshot.generatedAt !== manifest.generatedAt || generated > at + CLOCK_TOLERANCE_MS) return unavailable('invalid', 'snapshot-publication-time-invalid')
    const assessedAt = options.snapshotId ? generated : at
    const modules = snapshot.modules.map(module => ({
      ...module, reason: module.active ? null : 'monitor-not-running',
      metrics: module.metrics.map(m => projectedQuality(m, module.active, snapshot.connected, assessedAt, generated)),
    }))
    const metrics = modules.flatMap(m => m.metrics)
    const status = metrics.some(m => m.quality === 'usable') ? 'available'
      : metrics.some(m => m.quality === 'degraded') ? 'degraded'
        : metrics.some(m => m.quality === 'stale') ? 'stale' : 'missing'
    return {
      status, advisoryOnly: true as const, asOf: new Date(assessedAt).toISOString(), historical: Boolean(options.asOf || options.snapshotId),
      warning: 'Research context only. GEX is a model estimate; source observations are not execution quotes. No authority to allocate or trade.',
      snapshotId: manifest.sha256, generatedAt: snapshot.generatedAt, connected: snapshot.connected,
      partial: modules.some(m => !m.active) || metrics.some(m => m.quality !== 'usable'),
      producer: snapshot.producer, modules,
      evidence: { sha256: manifest.sha256, file: join(root, ...manifest.file.split('/')), manifest, snapshot },
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return unavailable(code === 'ENOENT' ? 'missing' : 'invalid', code === 'ENOENT' ? 'monitor-archive-unavailable' : 'monitor-archive-invalid-or-unreadable')
  }
}
