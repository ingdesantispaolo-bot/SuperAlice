import { tool } from 'ai'
import { z } from 'zod'
import type { WorkspaceToolFactory } from '../core/workspace-tool-center.js'
import { appendMemoryEntry, getMarketContext, memoryContextSchema, readMemoryCatalog } from '../domain/analysis/market-memory.js'

const ownerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/).optional()
function workspace(ctx: Parameters<WorkspaceToolFactory['build']>[0], ownerWorkspaceId = ctx.workspaceId) {
  const resolved = ctx.resolveWorkspace?.(ownerWorkspaceId)
  if (!resolved || resolved.id !== ownerWorkspaceId) throw new Error('Memory Workspace unavailable in this Project')
  return resolved.dir
}
export const marketMemoryFactories: WorkspaceToolFactory[] = [
  {
    name: 'market_memory_catalog',
    build: ctx => tool({
      description: 'Read this Workspace market-memory catalog. Series identity includes source, method, unit and yield type; fitted BTP curves are not asserted equivalent to a benchmark. Local files only; no broker, model or monitor is called.',
      inputSchema: z.object({ ownerWorkspaceId: ownerId }).strict(),
      execute: async ({ ownerWorkspaceId }) => readMemoryCatalog(workspace(ctx, ownerWorkspaceId)),
    }),
  },
  {
    name: 'market_memory_record',
    build: ctx => tool({
      description: 'Append a catalog/evidence/observation/thesis/reconciliation event to this Workspace memory. --entry-json-file reads the structured entry from a file. Existing snapshots remain immutable. The host stamps recordedAt; importing old evidence never backdates knowledge. See alice-analysis references/market-memory.md for the reviewed schema. Research only, no trading or configuration authority.',
      inputSchema: z.object({ entryJson: z.string().min(2).max(32000) }).strict(),
      execute: async ({ entryJson }) => appendMemoryEntry(workspace(ctx), JSON.parse(entryJson), { workspaceId: ctx.workspaceId, resumeId: ctx.origin?.resumeId ?? null }),
    }),
  },
  {
    name: 'get_market_context',
    build: ctx => tool({
      description: 'Retrieve this Workspace local market context: catalog, observations, horizon-specific thesis revisions, supporting/contrary evidence and immutable reconciliations. knownAsOf means knowledge recorded by this memory at that timestamp, not source vintages retroactively reconstructed. Works with the monitor/TWS offline; never re-evaluates a thesis or silently treats stale data as current. Unknown coverage, truncation and output budgets are explicit.',
      inputSchema: memoryContextSchema.extend({ ownerWorkspaceId: ownerId }),
      execute: async ({ ownerWorkspaceId, ...query }) => ({ ownerWorkspaceId: ownerWorkspaceId ?? ctx.workspaceId, ...await getMarketContext(workspace(ctx, ownerWorkspaceId), query) }),
    }),
  },
]
