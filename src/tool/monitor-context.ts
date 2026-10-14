import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { userDataHome } from '../core/paths.js'
import { readMonitorContext } from '../domain/analysis/monitor-context.js'

/** Operator-owned configuration; callers cannot select arbitrary filesystem paths. */
export async function monitorContextDirectory(): Promise<string | null> {
  if (process.env.SUPERAI_MONITOR_CONTEXT_DIR) return process.env.SUPERAI_MONITOR_CONTEXT_DIR
  try {
    const raw = await readFile(join(userDataHome, 'data/config/monitor-context.json'), 'utf8')
    if (raw.length > 4096) return null
    const config = z.object({ enabled: z.boolean(), directory: z.string().min(1).max(2048) }).strict().parse(JSON.parse(raw))
    return config.enabled ? config.directory : null
  } catch { return null }
}

export function createMonitorContextTools(getDirectory = monitorContextDirectory) {
  return {
    monitorContext: tool({
      description: 'Read IbIvMonitor macro, volatility and GEX observations from a verified local immutable snapshot. Research and briefing only: never trading or allocation authority. Inspect every metric quality, unit, referenceFrame and sourceAt. Missing/stale/degraded values are not current usable facts. --asOf selects an archived publication at or before a timezone-qualified timestamp; --snapshotId pins an evidence hash. Archive access is read-only; no broker or model is contacted.',
      inputSchema: z.object({
        asOf: z.string().datetime({ offset: true }).optional().describe('Historical ISO timestamp with timezone, e.g. 2026-10-12T14:00:00Z'),
        snapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Immutable snapshot SHA-256; alternative to asOf'),
      }).refine(v => !(v.asOf && v.snapshotId), 'Choose asOf or snapshotId'),
      execute: async options => readMonitorContext(await getDirectory(), options),
    }),
  }
}
