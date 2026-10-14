import { describe, expect, it } from 'vitest'
import { createMonitorContextTools } from './monitor-context.js'
import { resolveCommand, toolRegistryScope, CLI_EXPORTS } from '../server/cli-commands.js'

describe('monitor context capability', () => {
  it('is discoverable by the existing global workspace CLI', () => {
    expect(resolveCommand('data', 'analysis', 'monitor-context')).toBe('monitorContext')
    expect(toolRegistryScope(CLI_EXPORTS.data, 'monitorContext')).toBe('global')
  })
  it('works without a broker, model, or configured archive', async () => {
    const tools = createMonitorContextTools(async () => null)
    expect(await tools.monitorContext.execute!({}, { toolCallId: 'test', messages: [] })).toMatchObject({ status: 'missing', advisoryOnly: true })
  })
})
