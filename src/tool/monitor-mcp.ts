import { tool, type Tool } from 'ai'
import { MonitorMcpClient } from '../domain/analysis/monitor-mcp.js'
import { monitorInputSchema } from '../domain/analysis/monitor-mcp-schema.js'
import { readMonitorServiceConfiguration } from './monitor-service.js'

export async function createMonitorMcpTools(client: MonitorMcpClient): Promise<Record<string, Tool>> {
  const definitions = await client.discover()
  return Object.fromEntries(definitions.map(definition => [
    `ibiv_${definition.name}`,
    tool({
      description: `${definition.description ?? definition.name}\nIbIvMonitor data-only MCP. Preserve content[0].text and _meta["ibivmonitor/sha256"] as evidence; generatedAt is not source freshness.`,
      inputSchema: monitorInputSchema(definition.inputSchema),
      execute: async (args, options) => client.call(definition.name, args as Record<string, unknown>, options.abortSignal),
    }),
  ]))
}

export async function startConfiguredMonitorMcp(): Promise<{ client: MonitorMcpClient; tools: Record<string, Tool> } | null> {
  const config = await readMonitorServiceConfiguration()
  if (!config) return null
  const client = new MonitorMcpClient({ ...config,
    configDirectory: process.env.IBIVMONITOR_CONFIG_DIR, mcpEnabled: process.env.IBIVMONITOR_MCP })
  try { return { client, tools: await createMonitorMcpTools(client) } }
  catch {
    await client.dispose()
    console.warn('monitor-mcp: unavailable or incompatible; file context remains available')
    return null
  }
}
