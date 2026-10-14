import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { assertMonitorMcpCatalog, MONITOR_EVIDENCE_KEY } from './monitor-mcp-catalog.js'
import { monitorInputSchema } from './monitor-mcp-schema.js'
export { MONITOR_MCP_COMMANDS, MONITOR_EVIDENCE_KEY } from './monitor-mcp-catalog.js'

export function verifyMonitorMcpEvidence(result: CallToolResult): CallToolResult {
  const first = result.content[0]
  const hash = result._meta?.[MONITOR_EVIDENCE_KEY]
  if (first?.type !== 'text' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)
    || createHash('sha256').update(first.text, 'utf8').digest('hex') !== hash) {
    throw new Error('IbIvMonitor MCP evidence missing or hash mismatch')
  }
  const payload: unknown = JSON.parse(first.text)
  if (result.structuredContent && !isDeepStrictEqual(payload, result.structuredContent)) {
    throw new Error('IbIvMonitor MCP structured evidence differs from canonical text')
  }
  return result // Never reserialize the canonical text whose bytes were hashed.
}

type Options = { executable: string; directory: string; configDirectory?: string; mcpEnabled?: string }

/** One lightweight relay per Alice runtime. The relay owns monitor-pipe reconnection. */
export class MonitorMcpClient {
  private client?: Client
  private connecting?: Promise<Client>
  private stopped = false
  private definitions = new Map<string, McpTool>()
  private schemas = new Map<string, z.ZodObject>()

  constructor(private readonly options: Options) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.directory)) {
      throw new Error('Monitor MCP executable and archive must be absolute operator-owned paths')
    }
  }

  async discover(): Promise<McpTool[]> {
    await this.connect()
    return [...this.definitions.values()]
  }

  private connect(): Promise<Client> {
    if (this.stopped) return Promise.reject(new Error('Monitor MCP client stopped'))
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async open(): Promise<Client> {
    const client = new Client({ name: 'superai-ibivmonitor', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: this.options.executable,
      args: ['--mcp', '--wait-seconds', '2'],
      stderr: 'ignore',
      maxBufferSize: 10 * 1024 * 1024,
      env: {
        SUPERAI_MONITOR_CONTEXT_DIR: this.options.directory,
        ...(this.options.configDirectory ? { IBIVMONITOR_CONFIG_DIR: this.options.configDirectory } : {}),
        ...(this.options.mcpEnabled ? { IBIVMONITOR_MCP: this.options.mcpEnabled } : {}),
      },
    })
    client.onclose = () => { if (this.client === client) this.client = undefined }
    client.onerror = () => {} // Protocol failures reach the caller; do not log raw paths or secrets.
    try {
      await client.connect(transport, { timeout: 20_000 })
      const { tools, nextCursor } = await client.listTools({}, { timeout: 20_000 })
      assertMonitorMcpCatalog(tools.map(t => t.name), nextCursor)
      const schemas = new Map<string, z.ZodObject>()
      for (const definition of tools) {
        const schema = monitorInputSchema(definition.inputSchema)
        schemas.set(definition.name, schema)
      }
      if (this.stopped) throw new Error('Monitor MCP client stopped')
      this.definitions = new Map(tools.map(t => [t.name, t]))
      this.schemas = schemas
      this.client = client
      return client
    } catch {
      await client.close().catch(() => {})
      throw new Error('Monitor MCP unavailable or incompatible; check executable, same Windows user and monitor configuration')
    }
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const client = await this.connect()
    const schema = this.schemas.get(name)
    if (!schema) throw new Error('Unknown monitor MCP tool')
    const validated = await schema.parseAsync(args)
    // Never replay an in-flight request: data acquisition may already have been queued.
    const result = await client.callTool({ name, arguments: validated }, undefined, {
      timeout: name === 'data_status' || name === 'correlation_matrix' ? 125_000 : 65_000,
      ...(signal ? { signal } : {}),
    })
    return verifyMonitorMcpEvidence(CallToolResultSchema.parse(result))
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await this.connecting?.catch(() => {})
    const client = this.client
    this.client = undefined
    await client?.close()
  }
}
