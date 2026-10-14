import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, rename, unlink, mkdir, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'

export const monitorPlanSchema = z.object({
  refreshSeconds: z.number().int().min(300).max(3600).default(300),
  gexWindowSeconds: z.number().int().min(0).max(120).refine(n => n === 0 || n >= 45).default(75),
  backfillDaily: z.boolean().default(true),
  realtimeIds: z.array(z.string().min(1).max(40)).max(8).default([]),
  dailyIds: z.array(z.string().min(1).max(40)).max(200).default([]),
}).strict().refine(p => new Set(p.realtimeIds).size === p.realtimeIds.length && new Set(p.dailyIds).size === p.dailyIds.length, 'Duplicate instrument')
export type MonitorPlan = z.infer<typeof monitorPlanSchema>
const policySchema = z.object({ mode: z.enum(['research', 'off']), plan: monitorPlanSchema }).strict()
const statusSchema = z.object({
  schemaVersion: z.literal(1), instanceId: z.string().min(1).max(80), pid: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }), owner: z.enum(['user', 'superai', 'none']), mode: z.enum(['manual', 'research', 'off']),
  connected: z.boolean(), status: z.string().max(300), led: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  gexCollecting: z.boolean(), macroRunning: z.boolean(), activeLines: z.number().int().nonnegative(), peakLines: z.number().int().nonnegative(),
  instruments: z.array(z.object({ id: z.string().max(40), symbol: z.string(), secType: z.string(), exchange: z.string(), realtimeAllowed: z.boolean() })).max(200),
}).passthrough()

/** Fixed operator archive only, bounded file reads, no symlink escape. */
export async function readMonitorFile(directory: string, parts: string[], max = 2 * 1024 * 1024): Promise<Buffer> {
  const root = await realpath(directory)
  const path = await realpath(join(root, ...parts))
  const contained = relative(root, path)
  if (contained.startsWith('..') || isAbsolute(contained)) throw new Error('Archive path outside root')
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > max) throw new Error('Archive file outside limit')
    const bytes = await file.readFile()
    if (bytes.length > max) throw new Error('Archive file outside limit')
    return bytes
  } finally { await file.close() }
}
export async function readMonitorServiceStatus(directory: string | null, now = Date.now()) {
  if (!directory) return { available: false as const, reason: 'Monitor archive not configured' }
  try {
    const status = statusSchema.parse(JSON.parse((await readMonitorFile(directory, ['service-status.json'], 65536)).toString('utf8')))
    const age = now - Date.parse(status.updatedAt)
    if (age > 90_000 || age < -5000) return { available: false as const, reason: 'Monitor heartbeat expired' }
    return { available: true as const, ...status }
  } catch { return { available: false as const, reason: 'Monitor status unavailable or incompatible' } }
}
async function atomic(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `${name}.${randomUUID()}.tmp`)
  try { await writeFile(temp, JSON.stringify(value)); await rename(temp, join(directory, name)) }
  finally { await unlink(temp).catch(() => {}) }
}
type Options = { directory: string; executable: string; now?: () => number; launch?: (exe: string, directory: string) => void; periodic?: boolean }
const launchMonitor = (executable: string, directory: string) => {
  const child = spawn(executable, ['--background'], { shell: false, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, SUPERAI_MONITOR_CONTEXT_DIR: directory } })
  child.on('error', () => {}) // Status heartbeat, never raw stderr/secrets, is the readiness contract.
  child.unref()
}

/** Data acquisition supervisor. No TWS socket, account or order methods exist here. */
export class MonitorService {
  private readonly id = randomUUID()
  private readonly now: () => number
  private readonly launch: NonNullable<Options['launch']>
  private mode: 'research' | 'off' = 'research'
  private plan = monitorPlanSchema.parse({})
  private timer?: ReturnType<typeof setInterval>
  private busy?: Promise<void>
  private stopped = false
  private nextLaunch = 0
  private policyQueue: Promise<unknown> = Promise.resolve()
  private constructor(private readonly options: Options) { this.now = options.now ?? Date.now; this.launch = options.launch ?? launchMonitor }
  static async start(options: Options): Promise<MonitorService | null> {
    if (!isAbsolute(options.directory) || !isAbsolute(options.executable) || !(await stat(options.executable)).isFile()) return null
    await mkdir(options.directory, { recursive: true })
    const lock = join(options.directory, '.controller.lock')
    const service = new MonitorService(options)
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const handle = await open(lock, 'wx'); try { await handle.writeFile(JSON.stringify({ pid: process.pid, id: service.id })) } finally { await handle.close() }; break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const owner = z.object({ pid: z.number().int().positive(), id: z.string() }).parse(JSON.parse((await readMonitorFile(options.directory, ['.controller.lock'], 512)).toString()))
          try { process.kill(owner.pid, 0); return null } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return null }
          if (attempt === 1) return null
          await unlink(lock)
        } catch { return null }
      }
    }
    try {
      try { const policy = policySchema.parse(JSON.parse((await readMonitorFile(options.directory, ['service-policy.json'], 16384)).toString())); service.mode = policy.mode; service.plan = policy.plan }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') service.mode = 'off' }
      await service.tick()
      if (options.periodic !== false) { service.timer = setInterval(() => { void service.tick().catch(() => {}) }, 30_000); service.timer.unref() }
      return service
    } catch (error) { await service.dispose(); throw error }
  }
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.busy) return this.busy
    this.busy = this.publish().finally(() => { this.busy = undefined })
    return this.busy
  }
  private async publish() {
    const now = this.now()
    await atomic(this.options.directory, 'control.json', { schemaVersion: 1, controllerId: this.id,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 90_000).toISOString(), mode: this.mode, plan: this.plan })
    const status = await readMonitorServiceStatus(this.options.directory, now)
    if (this.mode === 'research' && !status.available && now >= this.nextLaunch) {
      this.nextLaunch = now + 120_000
      this.launch(this.options.executable, this.options.directory)
    }
  }
  async setPolicy(input: z.input<typeof policySchema>) {
    const operation = this.policyQueue.then(async () => {
      if (this.stopped) throw new Error('Monitor controller stopped')
      const policy = policySchema.parse(input)
      const status = await readMonitorServiceStatus(this.options.directory, this.now())
      if (policy.plan.realtimeIds.length || policy.plan.dailyIds.length) {
        if (!status.available) throw new Error('Wait for monitor catalogue before selecting instruments')
        const allowed = new Map(status.instruments.map(i => [i.id, i]))
        if (policy.plan.dailyIds.some(id => !allowed.has(id)) || policy.plan.realtimeIds.some(id => !allowed.get(id)?.realtimeAllowed))
          throw new Error('Instrument outside monitor catalogue or realtime eligibility')
      }
      await atomic(this.options.directory, 'service-policy.json', policy)
      this.mode = policy.mode; this.plan = policy.plan
      if (this.busy) await this.busy
      await this.tick()
      return { accepted: true, requested: policy, effective: status, manualPriority: status.available && status.owner === 'user',
        note: 'Data collection only. Manual power has priority; review service-status for applied state.' }
    })
    this.policyQueue = operation.catch(() => {})
    return operation
  }
  async status() { return { controllerActive: !this.stopped, requested: { mode: this.mode, plan: this.plan }, monitor: await readMonitorServiceStatus(this.options.directory, this.now()) } }
  async dispose() {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.policyQueue
    if (this.busy) await this.busy.catch(() => {})
    try {
      await atomic(this.options.directory, 'control.json', { schemaVersion: 1, controllerId: this.id, issuedAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + 90_000).toISOString(), mode: 'off', plan: this.plan })
    } finally {
      const lock = join(this.options.directory, '.controller.lock')
      try { const owner = JSON.parse((await readMonitorFile(this.options.directory, ['.controller.lock'], 512)).toString()); if (owner.id === this.id) await unlink(lock) } catch {}
    }
  }
}

const indexSchema = z.object({ schemaVersion: z.literal(1), generatedAt: z.string().datetime({ offset: true }),
  instruments: z.array(z.object({ id: z.string(), snapshotId: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().nonnegative(), lastSourceAt: z.string().datetime({ offset: true }) })).max(200) })
const historySchema = z.object({ schemaVersion: z.literal(1), source: z.literal('IBKR'), horizon: z.literal('daily'),
  instrument: z.object({ id: z.string(), symbol: z.string(), currency: z.string() }).passthrough(), contract: z.record(z.string(), z.unknown()),
  adjustment: z.literal('source-native'), unit: z.string(), bars: z.array(z.object({
    timestamp: z.string().datetime({ offset: true }), price: z.number().finite(), open: z.number().finite().nullable(), high: z.number().finite().nullable(),
    low: z.number().finite().nullable(), volume: z.number().nullable(), fetchedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict()).max(800) }).strict()
export async function readMonitorHistory(directory: string | null, instrumentId?: string, limit = 300) {
  if (!directory) return { available: false, reason: 'Monitor archive not configured' }
  try {
    const index = indexSchema.parse(JSON.parse((await readMonitorFile(directory, ['history', 'index.json'], 65536)).toString()))
    if (!instrumentId) return { available: true, ...index, advisoryOnly: true }
    const entry = index.instruments.find(i => i.id === instrumentId)
    if (!entry) return { available: false, reason: 'Instrument has no exported daily history' }
    const bytes = await readMonitorFile(directory, ['history', entry.snapshotId + '.json'])
    if (createHash('sha256').update(bytes).digest('hex') !== entry.snapshotId) throw new Error('Hash mismatch')
    const history = historySchema.parse(JSON.parse(bytes.toString()))
    if (history.instrument.id !== instrumentId || history.unit !== history.instrument.currency) throw new Error('Instrument mismatch')
    return { available: true, advisoryOnly: true, snapshotId: entry.snapshotId, generatedAt: index.generatedAt,
      ...history, bars: history.bars.slice(-Math.max(1, Math.min(800, limit))),
      lineageComplete: history.bars.every(b => b.fetchedAt !== null),
      note: 'Cached completed daily bars. Original timestamp and fetchedAt preserved; source-native adjustment. Archive age does not imply current coverage.' }
  } catch { return { available: false, reason: 'Daily archive unavailable, incompatible or hash mismatch' } }
}
