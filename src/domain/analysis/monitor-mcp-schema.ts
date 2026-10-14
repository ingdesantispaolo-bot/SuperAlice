import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** Preserve remote constraints, allowing ISO offsets required by its date-time contract. */
export function monitorInputSchema(input: Tool['inputSchema']): z.ZodObject {
  const schema = z.fromJSONSchema(input as Parameters<typeof z.fromJSONSchema>[0])
  if (!(schema instanceof z.ZodObject)) throw new Error('Monitor MCP arguments must use object schemas')
  const dates: Record<string, z.ZodType> = {}
  for (const [name, value] of Object.entries(input.properties ?? {})) {
    const property = value as Record<string, unknown>
    if (property.type !== 'string' || property.format !== 'date-time') continue
    let instant = z.iso.datetime({ offset: true })
    if (typeof property.maxLength === 'number') instant = instant.max(property.maxLength)
    const described = instant.describe(String(property.description ?? 'ISO timestamp with timezone'))
    dates[name] = input.required?.includes(name) ? described : described.optional()
  }
  return schema.extend(dates)
}
