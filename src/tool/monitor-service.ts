import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { userDataHome } from '../core/paths.js'
import { MonitorService, monitorPlanSchema, readMonitorServiceStatus, readMonitorHistory } from '../domain/analysis/monitor-service.js'
import { monitorContextDirectory } from './monitor-context.js'

/** Executable selection is operator-owned, never part of an agent tool argument. */
export async function readMonitorServiceConfiguration(): Promise<{ directory: string; executable: string } | null> {
  try {
    const directory = await monitorContextDirectory()
    if (!directory) return null
    let executable = process.env.SUPERAI_MONITOR_SERVICE_EXE
    let enabled = process.env.SUPERAI_MONITOR_SERVICE_ENABLED === '1'
    if (!executable) {
      const text = await readFile(join(userDataHome, 'data/config/monitor-service.json'), 'utf8')
      if (text.length > 4096) return null
      const config = z.object({ enabled: z.boolean(), executable: z.string().min(1).max(2048) }).strict().parse(JSON.parse(text))
      executable = config.executable; enabled = config.enabled
    }
    return enabled ? { directory, executable } : null
  } catch { return null }
}
export async function startConfiguredMonitorService(): Promise<MonitorService | null> {
  const config = await readMonitorServiceConfiguration()
  try { return config ? await MonitorService.start(config) : null } catch { return null }
}
export function createMonitorServiceTools(service: MonitorService | null, getDirectory = monitorContextDirectory) {
  return {
    monitorServiceStatus: tool({ description: 'Read IbIvMonitor acquisition owner, heartbeat, actual subscriptions, and eligible instrument catalogue. Manual power overrides SuperAi collection policy. No account or order access.',
      inputSchema: z.object({}), execute: async () => service ? service.status() : { controllerActive: false, monitor: await readMonitorServiceStatus(await getDirectory()) } }),
    monitorServiceSet: tool({ description: 'Configure the operator-enabled IbIvMonitor data collector only. research uses bounded GEX collection windows and macro sweeps, releasing polling streams between cycles; selected realtimeIds stay subscribed (maximum eight). dailyIds select incremental SQLite backfill; empty means existing macro universe. Manual power has priority. off stops managed collection only. No execution, accounts, model calls, arbitrary process or path parameters.',
      inputSchema: z.object({ mode: z.enum(['research', 'off']), plan: monitorPlanSchema.default(monitorPlanSchema.parse({})) }).strict(),
      execute: async input => service ? service.setPolicy(input) : { accepted: false, reason: 'Acquisition management not enabled by operator, or another Alice controller owns it' } }),
    monitorHistory: tool({ description: 'Read the monitor final daily history exported from its existing SQLite cache with verified SHA-256. Omit instrumentId to list exports. Original bar time, fetch time, currency and source-native adjustment are preserved. No broker call or database write; inspect coverage before quantitative use.',
      inputSchema: z.object({ instrumentId: z.string().min(1).max(40).optional(), limit: z.number().int().min(1).max(800).default(300) }).strict(),
      execute: async input => readMonitorHistory(await getDirectory(), input.instrumentId, input.limit) }),
  }
}
