import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { localRequestGuard } from './local-request-guard.js'
import { mountLocalToolGateway } from './local-tool-gateway.js'

function guarded() {
  const app = new Hono()
  app.use('*', localRequestGuard())
  app.get('/cli/ws/uta/manifest', (c) => c.json({ ok: true }))
  app.post('/cli/ws/uta/invoke', (c) => c.json({ ok: true }))
  return app
}

const JSON_BODY = { method: 'POST', body: JSON.stringify({ tool: 'tradingPush', args: {} }) }

describe('localRequestGuard', () => {
  it('lets the workspace shims through (Node fetch: JSON, no Origin, local Host)', async () => {
    const res = await guarded().request('http://127.0.0.1:47332/cli/ws/uta/invoke', {
      ...JSON_BODY, headers: { host: '127.0.0.1:47332', 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
  })

  it('refuses a cross-site page (foreign Origin), reads and writes alike', async () => {
    const app = guarded()
    const read = await app.request('/cli/ws/uta/manifest', { headers: { origin: 'https://evil.example' } })
    const write = await app.request('/cli/ws/uta/invoke', {
      ...JSON_BODY, headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    })
    expect([read.status, write.status]).toEqual([403, 403])
  })

  it('refuses DNS rebinding (foreign Host, no Origin)', async () => {
    const res = await guarded().request('/cli/ws/uta/manifest', { headers: { host: 'rebind.evil.example:47332' } })
    expect(res.status).toBe(403)
  })

  it('refuses simple-request bodies that skip the CORS preflight', async () => {
    for (const type of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await guarded().request('/cli/ws/uta/invoke', { ...JSON_BODY, headers: { 'content-type': type } })
      expect(res.status, type).toBe(415)
    }
  })

  it('accepts the local UI origins', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:47331', 'app://openalice']) {
      const res = await guarded().request('/cli/ws/uta/manifest', { headers: { origin } })
      expect(res.status, origin).toBe(200)
    }
  })

  it('is mounted with the gateway and sends no CORS grant', async () => {
    const app = new Hono()
    mountLocalToolGateway(app, {
      toolCenter: {} as never, workspaceToolCenter: {} as never, inboxStore: {} as never,
      entityStore: {} as never, getWorkspaceService: () => null,
    })
    const res = await app.request('/cli/any-ws/uta/manifest', { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
