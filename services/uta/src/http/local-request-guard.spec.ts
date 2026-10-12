import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { localRequestGuard } from './local-request-guard.js'

// Reproduces the 2026-10-12 audit finding: a page posted `text/plain` JSON to
// 127.0.0.1:47333 and the UTA executed it (no preflight, no session).
function uta() {
  const app = new Hono()
  app.use('*', localRequestGuard())
  app.post('/api/trading/uta/acc/wallet/push', async (c) => c.json({ pushed: await c.req.json() }))
  app.get('/api/trading/uta/acc/account', (c) => c.json({ ok: true }))
  return app
}

describe('UTA localRequestGuard', () => {
  it('serves Alice and Guardian (local Host, JSON, no Origin)', async () => {
    const res = await uta().request('http://127.0.0.1:47333/api/trading/uta/acc/wallet/push', {
      method: 'POST', headers: { host: '127.0.0.1:47333', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedPendingHash: 'abcd1234' }),
    })
    expect(res.status).toBe(200)
  })

  it('refuses the simple-request push a web page can send', async () => {
    const res = await uta().request('/api/trading/uta/acc/wallet/push', {
      method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ expectedPendingHash: 'abcd1234' }),
    })
    expect(res.status).toBe(415)
  })

  it('refuses a foreign Origin and a rebinding Host', async () => {
    const app = uta()
    const crossSite = await app.request('/api/trading/uta/acc/account', { headers: { origin: 'https://evil.example' } })
    const rebind = await app.request('/api/trading/uta/acc/account', { headers: { host: 'evil.example:47333' } })
    expect([crossSite.status, rebind.status]).toEqual([403, 403])
  })
})
