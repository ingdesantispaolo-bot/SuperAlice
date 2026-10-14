import { tool } from 'ai'
import { z } from 'zod'
import type { WorkspaceToolFactory } from '../core/workspace-tool-center.js'
import { appendMemoryEntry, getMarketContext, memoryContextSchema, readMemoryCatalog } from '../domain/analysis/market-memory.js'
import type { MemoryOrigin } from '../domain/analysis/market-memory-schema.js'

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
      description: 'Append a schema-v2 catalog/evidence/observation/thesis/reconciliation/check/signal/judgment/lesson event to this Workspace memory. Approvals belong exclusively to the user terminal. Chat writes candidate theses; activation needs a host scheduled review and a valid basis. --entry-json-file reads structured JSON. Existing snapshots remain immutable. The host stamps origin/recordedAt; imports never backdate knowledge. See alice-analysis references/market-memory.md. Research only, no trading authority.',
      inputSchema: z.object({ entryJson: z.string().min(2).max(256000) }).strict(),
      execute: async ({ entryJson }) => {
        const entry = JSON.parse(entryJson)
        if (entry?.kind === 'approval') throw new Error('Approvals are available only in the user terminal, never through agent tools')
        const trigger = ctx.callerRun?.trigger
        const issue = ctx.origin?.kind === 'headless' && ctx.callerRun?.status === 'running'
          && ctx.origin.runId === ctx.callerRun.taskId && trigger?.kind === 'issue'
          && trigger.workspaceId === ctx.workspaceId && trigger.issueId === ctx.origin.issueId ? trigger : undefined
        const origin: MemoryOrigin = { kind: issue ? 'issue' : 'session', workspaceId: ctx.workspaceId,
          ...(ctx.origin?.resumeId ? { resumeId: ctx.origin.resumeId } : {}), ...(issue ? { issueId: issue.issueId } : {}) }
        const detail = issue ? await ctx.board?.detail(ctx.workspaceId, issue.issueId) : undefined
        const scheduledReviewIssueId = detail?.issue.id === issue?.issueId && detail?.issue.when
          && !['done', 'canceled'].includes(detail.issue.status) ? issue?.issueId : undefined
        return appendMemoryEntry(workspace(ctx), entry, origin, undefined, { scheduledReviewIssueId })
      },
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
