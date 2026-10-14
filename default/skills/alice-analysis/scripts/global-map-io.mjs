import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

// Workspace, gateway and network helpers shared by the global-map scripts.

/** The current directory must be an Alice Workspace; returns its real path. */
export async function workspaceRoot() {
  const root = await realpath(process.cwd())
  await realpath(join(root, '.alice')) // Refuse accidental execution from the source repository.
  return root
}

export const isInside = (root, target) => { const r = relative(root, target); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }

/**
 * Create (or accept) a directory below the Workspace one component at a time,
 * refusing symlinks and non-directories before anything is written.
 */
export async function safeDir(root, rel, { exclusiveLast = false } = {}) {
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some(p => p === '..' || p === '.' || p.includes('\\'))) throw new Error(`Unsafe directory: ${rel}`)
  let current = root
  for (const [i, part] of parts.entries()) {
    current = join(current, part)
    const last = i === parts.length - 1
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe path component: ${relative(root, current)}`)
      if (last && exclusiveLast) throw Object.assign(new Error(`Directory already exists: ${rel}`), { code: 'EEXIST' })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
  if (!isInside(root, await realpath(current))) throw new Error(`Directory escaped the Workspace: ${rel}`)
  return current
}

/**
 * Load a collected map run and verify the universe copy and every payload hash
 * before anything is parsed. Payloads live in the temporary, content-addressed cache.
 */
export async function loadRun(root, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(runId)) throw new Error('Invalid run id')
  const runDir = await realpath(join(root, 'research/market-assistant/runs', runId))
  if (!isInside(root, runDir)) throw new Error('Run directory escaped the Workspace')
  const manifest = JSON.parse(await readFile(join(runDir, 'global-map.manifest.json'), 'utf8'))
  if (manifest.schema !== 'superai.global-map.manifest/1' || manifest.runId !== runId) throw new Error('Unexpected manifest')
  const universeBytes = await readFile(join(runDir, manifest.universe.file))
  if (createHash('sha256').update(universeBytes).digest('hex') !== manifest.universe.sha256) throw new Error('Universe copy integrity mismatch')
  const payloadText = new Map()
  for (const p of manifest.payloads) {
    if (p.status !== 'ok') continue
    if (!/^research\/market-assistant\/global-map\/cache\/payloads\/[a-f0-9]{64}\.txt(\.gz)?$/.test(p.file)) throw new Error(`Unexpected payload path: ${p.file}`)
    const path = join(root, p.file)
    if (!isInside(root, await realpath(path).catch(() => { throw new Error(`Payload no longer cached: ${p.file}`) }))) throw new Error('Payload escaped the Workspace')
    const stored = await readFile(path)
    const bytes = p.file.endsWith('.gz') ? gunzipSync(stored, { maxOutputLength: 40_000_000 }) : stored
    if (createHash('sha256').update(bytes).digest('hex') !== p.sha256) throw new Error(`Evidence integrity mismatch: ${p.file}`)
    payloadText.set(p.key, { text: bytes.toString('utf8'), fetchedAt: p.fetchedAt })
  }
  return { runDir, manifest, universe: JSON.parse(universeBytes.toString('utf8')), payloadText }
}

/** Read a response body with an explicit byte ceiling. */
export async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`)
  const chunks = []
  let total = 0
  for await (const chunk of res.body ?? []) {
    total += chunk.length
    if (total > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Loopback gateway of this Workspace, with the same provenance headers as the CLI shim. */
export function gateway() {
  const workspaceId = process.env.AQ_WS_ID
  if (!workspaceId || !/^[a-zA-Z0-9_-]+$/.test(workspaceId)) throw new Error('Run inside an injected Alice Workspace shell')
  const endpoint = new URL(process.env.OPENALICE_TOOL_URL ?? '')
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Expected the injected loopback CLI endpoint')
  const headers = {
    'content-type': 'application/json',
    ...(process.env.OPENALICE_PROJECT_ID ? { 'x-openalice-project': process.env.OPENALICE_PROJECT_ID } : {}),
    ...(process.env.AQ_RUN_ID ? { 'x-openalice-run': process.env.AQ_RUN_ID } : {}),
    ...(process.env.AQ_SESSION_ID ? { 'x-openalice-session': process.env.AQ_SESSION_ID } : {}),
  }
  const base = exportKey => `${endpoint.href.replace(/\/+$/, '')}/${encodeURIComponent(workspaceId)}/${exportKey}`
  const MAX = 30_000_000
  async function json(url, init) {
    const res = await fetch(url, { headers, ...init, signal: AbortSignal.timeout(120_000) })
    const text = await readLimited(res, MAX)
    let body
    try { body = JSON.parse(text) } catch { throw new Error(`Gateway returned non-JSON (HTTP ${res.status})`) }
    return { res, body }
  }
  return {
    workspaceId,
    async toolName(exportKey, group, verb) {
      const { body } = await json(`${base(exportKey)}/manifest`, { method: 'GET' })
      const tool = body?.groups?.[group]?.[verb]?.tool
      if (!tool) throw new Error(`Gateway does not expose ${exportKey} ${group} ${verb}`)
      return tool
    },
    /** Returns the full response body; callers decide how to read the canonical text. */
    async invoke(exportKey, tool, args) {
      const { res, body } = await json(`${base(exportKey)}/invoke`, { method: 'POST', body: JSON.stringify({ tool, args }) })
      const text = body.content?.[0]?.text
      if (!res.ok || body.isError || typeof text !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : text?.slice(0, 500) ?? `HTTP ${res.status}`)
      }
      return body
    },
  }
}
