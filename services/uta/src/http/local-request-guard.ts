/**
 * Loopback request guard for the UTA HTTP service. The UTA has no session
 * layer: its callers are Alice (BFF proxy, SDK client) and Guardian, all
 * local processes that send no Origin. Binding to 127.0.0.1 does not keep a
 * browser out — any page the user opens can post to loopback, and a
 * `text/plain` body skips the CORS preflight while still being parsed as
 * JSON here. So: refuse a foreign Host (DNS rebinding), a non-local Origin
 * (cross-site) and non-JSON mutation bodies (simple requests).
 *
 * Kept as a local copy of Alice's src/server/local-request-guard.ts: the UTA
 * package does not import Alice code.
 */

import type { MiddlewareHandler } from 'hono'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return true
  const name = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name.endsWith('.localhost') || name === '[::1]'
}

export function isTrustedLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol === 'app:' && url.hostname === 'openalice') return true
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

export function localRequestGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!isLocalHostHeader(c.req.header('host'))) {
      return c.json({ error: 'Forbidden: non-local Host', code: 'LOCAL_HOST_REQUIRED' }, 403)
    }
    const origin = c.req.header('origin')
    if (origin !== undefined && !isTrustedLocalOrigin(origin)) {
      return c.json({ error: 'Forbidden: cross-origin request', code: 'CROSS_ORIGIN' }, 403)
    }
    const contentType = c.req.header('content-type')
    if (MUTATING.has(c.req.method) && contentType && !/^application\/json\b/i.test(contentType)) {
      return c.json({ error: 'Unsupported content type: application/json required', code: 'JSON_REQUIRED' }, 415)
    }
    return next()
  }
}
