import { describe, it, expect } from 'vitest'
import { createMonitorServiceTools } from './monitor-service.js'
import { resolveCommand } from '../server/cli-commands.js'
describe('monitor management commands', () => {
  it('remains available without a controller or TWS and grants no management by default', async () => {
    const tools = createMonitorServiceTools(null, async () => null)
    const options = { toolCallId: 'test', messages: [] }
    expect(await tools.monitorServiceStatus.execute!({}, options)).toMatchObject({ controllerActive: false })
    expect(await tools.monitorServiceSet.execute!({ mode: 'research', plan: { refreshSeconds: 300, gexWindowSeconds: 75, backfillDaily: true, realtimeIds: [], dailyIds: [] } }, options)).toMatchObject({ accepted: false })
    expect(await tools.monitorHistory.execute!({ limit: 300 }, options)).toMatchObject({ available: false })
    expect(resolveCommand('data', 'analysis', 'monitor-service-set')).toBe('monitorServiceSet')
    expect(resolveCommand('data', 'analysis', 'monitor-service-status')).toBe('monitorServiceStatus')
    expect(resolveCommand('data', 'analysis', 'monitor-history')).toBe('monitorHistory')
  })
})
