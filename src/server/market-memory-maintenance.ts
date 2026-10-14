import type { Hono } from 'hono'
import { z } from 'zod'
import { resolveAliceProjectIdentity } from '@traderalice/guardian-runtime'
import { appResourcesHome, userDataHome } from '../core/paths.js'
import { manageMemoryIndex } from '../domain/analysis/market-memory.js'

const input = z.object({ operation: z.enum(['audit', 'rebuild', 'recover-lock']), lock: z.enum(['writer', 'index', 'control']).optional() }).strict()
/** Explicit operator maintenance; never an agent/MCP tool or model capability. */
export function registerMarketMemoryMaintenanceRoutes(app: Hono, resolveWorkspace: (id: string) => { id: string; dir: string } | undefined) {
  app.post('/cli/:wsId/memory/index', async c => {
    if (c.req.header('x-openalice-run') !== undefined || c.req.header('x-openalice-session') !== undefined) return c.json({ error: 'Memory maintenance requires the user terminal' }, 403)
    const project = c.req.header('x-openalice-project')
    if (project && project !== resolveAliceProjectIdentity({ home: userDataHome, appRoot: appResourcesHome }).id) return c.json({ error: 'Project identity mismatch' }, 403)
    const ws = resolveWorkspace(c.req.param('wsId'))
    if (!ws?.dir) return c.json({ error: 'Unknown memory Workspace in this Project' }, 404)
    const raw = await c.req.text()
    if (Buffer.byteLength(raw) > 1024) return c.json({ error: 'Maintenance exceeds input limit' }, 413)
    let parsed
    try { parsed = input.parse(JSON.parse(raw)) } catch { return c.json({ error: 'Expected operation audit/rebuild/recover-lock and optional lock writer/index/control' }, 400) }
    try {
      const result = await manageMemoryIndex(ws.dir, parsed.operation, parsed.lock)
      return c.json({ content: [{ type: 'text', text: JSON.stringify(result) }] })
    } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Memory maintenance failed' }, 400) }
  })
}
