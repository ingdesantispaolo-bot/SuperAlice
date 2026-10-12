/**
 * Loopback request guard for unauthenticated local surfaces (the workspace
 * CLI gateway). Binding to 127.0.0.1 keeps the network out, not the browser:
 * any page the user opens can send requests to loopback. Such requests are
 * recognisable — a cross-site request carries a foreign `Origin`, a
 * DNS-rebinding page carries a foreign `Host`, and a "simple" request
 * (`text/plain`, form encodings) skips the CORS preflight. The legitimate
 * callers (workspace shims over Node fetch, Alice's own UI) send none of
 * these, so all three are refused.
 */

import type { MiddlewareHandler } from 'hono'
import { isLocalHostHeader, isTrustedLocalOrigin } from '../webui/middleware/auth.js'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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
