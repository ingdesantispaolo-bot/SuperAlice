import type { Hono } from 'hono'
import { resolveAliceProjectIdentity } from '@traderalice/guardian-runtime'
import { appResourcesHome, userDataHome } from '../core/paths.js'
import { appendMemoryEntry } from '../domain/analysis/market-memory.js'
import { memoryApprovalSchema } from '../domain/analysis/market-memory-schema.js'

/** Operator-only CLI surface. Deliberately never registered as an AI/MCP tool.
 * Header rejection is a workflow guard, not isolation from same-user processes. */
export function registerMarketMemoryApprovalRoutes(app: Hono,
  resolveWorkspace: (id: string) => { id: string; dir: string } | undefined) {
  app.post('/cli/:wsId/memory/approval', async c => {
    if (c.req.header('x-openalice-run') !== undefined || c.req.header('x-openalice-session') !== undefined) {
      return c.json({ error: 'Memory approval must come from the user terminal, outside an agent Session' }, 403)
    }
    const project = c.req.header('x-openalice-project')
    if (project && project !== resolveAliceProjectIdentity({ home: userDataHome, appRoot: appResourcesHome }).id) {
      return c.json({ error: 'Project identity mismatch' }, 403)
    }
    const ws = resolveWorkspace(c.req.param('wsId'))
    if (!ws?.dir) return c.json({ error: 'Unknown memory Workspace in this Project' }, 404)
    const raw = await c.req.text()
    if (Buffer.byteLength(raw) > 4096) return c.json({ error: 'Approval exceeds input limit' }, 413)
    let input
    try { input = memoryApprovalSchema.parse(JSON.parse(raw)) }
    catch { return c.json({ error: 'Expected approval targetEventId, decision (approve/reject), and note' }, 400) }
    try {
      const result = await appendMemoryEntry(ws.dir, input, { kind: 'user-surface', workspaceId: ws.id })
      return c.json({ content: [{ type: 'text', text: JSON.stringify(result) }] })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Memory approval failed' }, 400)
    }
  })
}
