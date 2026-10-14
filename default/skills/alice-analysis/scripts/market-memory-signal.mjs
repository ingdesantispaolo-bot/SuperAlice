import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Build an episode identity; this helper never decides whether a finding is confirmed. */
export function buildConfirmedSignalDraft(draft) {
  if (!draft || draft.schema !== 'superai.confirmed-signal-draft/1' || draft.status !== 'confirmed'
    || typeof draft.findingKey !== 'string' || !draft.findingKey.length || draft.findingKey.length > 500
    || typeof draft.methodRevision !== 'string' || !draft.methodRevision.length || draft.methodRevision.length > 200
    || Object.keys(draft).some(key => !['schema', 'status', 'findingKey', 'methodRevision', 'entry'].includes(key))) throw new Error('Expected an explicitly confirmed signal draft, findingKey and methodRevision')
  const entry = draft.entry
  if (!entry || entry.kind !== 'signal' || !['intraday', 'swing'].includes(entry.horizon)
    || typeof entry.confirmedAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entry.confirmedAt) || !Number.isFinite(Date.parse(entry.confirmedAt))
    || typeof entry.expiresAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entry.expiresAt) || !Number.isFinite(Date.parse(entry.expiresAt))
    || Date.parse(entry.expiresAt) <= Date.parse(entry.confirmedAt) || Date.parse(entry.expiresAt) - Date.parse(entry.confirmedAt) > 7 * 86400_000) throw new Error('Confirmed signals require an explicit horizon, confirmation and bounded expiry')
  const signalId = 'signal.' + createHash('sha256').update(JSON.stringify([draft.findingKey, entry.horizon, new Date(entry.confirmedAt).toISOString(), draft.methodRevision])).digest('hex').slice(0, 48)
  if (entry.signalId !== undefined && entry.signalId !== signalId) throw new Error('Draft signalId differs from its stable episode identity')
  return { findingKey: draft.findingKey, entry: { ...entry, signalId } }
}

async function main() {
  const args = process.argv.slice(2), usage = 'Use: node market-memory-signal.mjs --draft research/<immutable-draft.json> [--record]'
  const draftAt = args.indexOf('--draft'), record = args.includes('--record')
  if (draftAt !== 0 || !args[1] || args.length !== (record ? 3 : 2) || record && args[2] !== '--record') throw new Error(usage)
  const root = await realpath(process.cwd()), path = await realpath(resolve(root, args[1]))
  const research = await realpath(join(root, 'research'))
  const rel = relative(research, path), metadata = relative(root, await realpath(join(root, '.alice')))
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)
    || metadata === '..' || metadata.startsWith('..\\') || metadata.startsWith('../') || isAbsolute(metadata)
    || relative(root, research).startsWith('..')) throw new Error('Draft must stay inside this Workspace research directory')
  const file = await open(path, 'r')
  let bytes
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 256000) throw new Error('Draft outside file budget'); bytes = await file.readFile() } finally { await file.close() }
  if (bytes.length > 256000) throw new Error('Draft outside file budget')
  const result = buildConfirmedSignalDraft(JSON.parse(bytes.toString('utf8')))
  if (!record) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return }
  const workspaceId = process.env.AQ_WS_ID
  if (!workspaceId || !/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error('Run in an injected Alice Workspace shell')
  const endpoint = new URL(process.env.OPENALICE_TOOL_URL ?? '')
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Expected the injected loopback CLI endpoint')
  const headers = { 'content-type': 'application/json',
    ...(process.env.OPENALICE_PROJECT_ID ? { 'x-openalice-project': process.env.OPENALICE_PROJECT_ID } : {}),
    ...(process.env.AQ_SESSION_ID ? { 'x-openalice-session': process.env.AQ_SESSION_ID } : {}),
    ...(process.env.AQ_RUN_ID ? { 'x-openalice-run': process.env.AQ_RUN_ID } : {}) }
  const base = `${endpoint.href.replace(/\/+$/, '')}/${encodeURIComponent(workspaceId)}/data`
  const manifestResponse = await fetch(`${base}/manifest`, { headers, signal: AbortSignal.timeout(30000) })
  if (!manifestResponse.ok) throw new Error(`Gateway manifest HTTP ${manifestResponse.status}`)
  const manifest = await manifestResponse.json(), recordTool = manifest?.groups?.memory?.record
  if (!recordTool?.tool || !recordTool.schema?.properties?.deduplicateSignal) throw new Error('Gateway has not loaded the confirmed-signal contract; operator restart required')
  const response = await fetch(`${base}/invoke`, { method: 'POST', headers,
    body: JSON.stringify({ tool: recordTool.tool, args: { entryJson: JSON.stringify(result.entry), deduplicateSignal: true } }), signal: AbortSignal.timeout(60000) })
  const body = await response.json(), text = body.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
  if (!response.ok || body.isError || !text) throw new Error(text?.slice(0, 500) ?? body.error ?? `Gateway HTTP ${response.status}`)
  process.stdout.write(JSON.stringify({ signalId: result.entry.signalId, findingKey: result.findingKey, ...JSON.parse(text) }) + '\n')
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
