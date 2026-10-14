import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogEntries } from './global-map-lib.mjs'

// Registers the global-map assets and series in this Workspace's market memory.
// Catalog identities are immutable: existing ids are skipped, never rewritten.
const usage = 'Use: node global-map-register.mjs [--dry-run]'
const args = process.argv.slice(2)
if (args.some(a => a !== '--dry-run')) throw new Error(usage)
const dryRun = args.includes('--dry-run')

const workspaceId = process.env.AQ_WS_ID
if (!workspaceId || !/^[a-zA-Z0-9_-]+$/.test(workspaceId)) throw new Error('Run inside an injected Alice Workspace shell')
const endpoint = new URL(process.env.OPENALICE_TOOL_URL ?? '')
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Expected the injected loopback CLI endpoint')
const root = await realpath(process.cwd())
await realpath(join(root, '.alice'))

const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'global-map-universe.json')
const universePath = await realpath(join(root, 'research/market-assistant/global-map/universe.json')).catch(() => bundled)
const universe = JSON.parse(await readFile(universePath, 'utf8'))

const headers = { 'content-type': 'application/json', ...(process.env.OPENALICE_PROJECT_ID ? { 'x-openalice-project': process.env.OPENALICE_PROJECT_ID } : {}) }
const base = `${endpoint.href.replace(/\/+$/, '')}/${encodeURIComponent(workspaceId)}/data`
const manifest = await (await fetch(`${base}/manifest`, { headers, signal: AbortSignal.timeout(30_000) })).json()
const tool = verb => {
  const name = manifest?.groups?.memory?.[verb]?.tool
  if (!name) throw new Error(`Gateway does not expose memory ${verb}`)
  return name
}
async function invoke(name, toolArgs) {
  const res = await fetch(`${base}/invoke`, { method: 'POST', headers, body: JSON.stringify({ tool: name, args: toolArgs }), signal: AbortSignal.timeout(60_000) })
  const body = await res.json()
  const text = body.content?.[0]?.text
  if (!res.ok || body.isError || typeof text !== 'string') throw new Error(text?.slice(0, 500) ?? body.error ?? `HTTP ${res.status}`)
  return JSON.parse(text)
}

const existing = new Set((await invoke(tool('catalog'), {})).entries.map(e => e.entityId))
const entries = catalogEntries(universe)
const missing = entries.filter(e => !existing.has(e.entityId))
if (dryRun) {
  process.stdout.write(JSON.stringify({ universeRevision: universe.revision, total: entries.length, alreadyRegistered: entries.length - missing.length, toRegister: missing }, null, 2) + '\n')
} else {
  const recorded = []
  for (const entry of missing) {
    // Assets precede their series in catalogEntries, so a failure never leaves an orphan series.
    const result = await invoke(tool('record'), { entryJson: JSON.stringify(entry) })
    recorded.push({ entityId: entry.entityId, eventId: result.eventId, sequence: result.sequence })
  }
  process.stdout.write(JSON.stringify({ universeRevision: universe.revision, total: entries.length, skipped: entries.length - missing.length, recorded: recorded.length, first: recorded[0] ?? null, last: recorded.at(-1) ?? null }, null, 2) + '\n')
}
