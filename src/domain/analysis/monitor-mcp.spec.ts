import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { MonitorMcpClient, verifyMonitorMcpEvidence } from './monitor-mcp.js'
import { monitorInputSchema } from './monitor-mcp-schema.js'
import { extractMcpShape, wrapToolExecute } from '../../core/mcp-export.js'
import { tool } from 'ai'
import { z } from 'zod'

const text = '{ "schema":"ibivmonitor.context/1", "sourceAt":"2026-10-13T12:00:00Z" }'
const evidence = (): CallToolResult => ({ content: [{ type: 'text', text }], structuredContent: JSON.parse(text),
  _meta: { 'ibivmonitor/sha256': createHash('sha256').update(text).digest('hex') } })

describe('IbIvMonitor MCP evidence boundary', () => {
  it('preserves canonical bytes and metadata through the shared MCP exporter', async () => {
    const original = evidence()
    expect(verifyMonitorMcpEvidence(original)).toBe(original)
    const exposed = await wrapToolExecute(tool({ inputSchema: z.object({}), execute: async () => original }))({})
    expect(exposed).toEqual(original)
    expect(exposed.content[0]).toEqual({ type: 'text', text })
  })
  it('retains hashed remote errors rather than turning them into success', async () => {
    const original = { ...evidence(), isError: true }
    expect((await wrapToolExecute(tool({ inputSchema: z.object({}), execute: async () => original }))({}))).toEqual(original)
  })
  it('rejects missing hashes, altered text and disagreeing structured content', () => {
    expect(() => verifyMonitorMcpEvidence({ ...evidence(), _meta: {} })).toThrow('hash')
    expect(() => verifyMonitorMcpEvidence({ ...evidence(), content: [{ type: 'text', text: text + ' ' }] })).toThrow('hash')
    expect(() => verifyMonitorMcpEvidence({ ...evidence(), structuredContent: { sourceAt: 'now' } })).toThrow('differs')
  })
  it('rejects agent-selected relative executable paths', () => {
    expect(() => new MonitorMcpClient({ executable: 'monitor.exe', directory: process.cwd() })).toThrow('operator-owned')
  })
})

describe('monitor JSON-schema projection', () => {
  const schema = monitorInputSchema({ type: 'object', additionalProperties: false, properties: {
    from: { type: 'string', format: 'date-time', maxLength: 40 },
    years: { type: 'integer', minimum: 1, maximum: 20, default: 2 },
    ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25, uniqueItems: true },
  }, required: ['ids'] })
  it('accepts explicit timezone offsets and refuses unknown arguments and missing required arrays', () => {
    expect(schema.parse({ ids: ['ES'], from: '2026-10-13T14:00:00+02:00' }).from).toContain('+02:00')
    expect(() => schema.parse({ ids: ['ES'], from: '2026-10-13T14:00:00' })).toThrow()
    expect(() => schema.parse({ ids: ['ES'], account: 'x' })).toThrow()
    expect(() => schema.parse({})).toThrow()
  })
  it('accepts numeric CLI flags while preserving imported limits and defaults', () => {
    const projected = z.strictObject(extractMcpShape(tool({ inputSchema: schema, execute: async args => args })))
    expect(projected.parse({ ids: ['ES'], years: '5' }).years).toBe(5)
    expect(projected.parse({ ids: ['ES'] }).years).toBe(2)
    expect(() => projected.parse({ ids: ['ES'], years: '21' })).toThrow()
  })
})
