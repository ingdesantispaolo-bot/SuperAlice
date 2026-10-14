import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateway, workspaceRoot } from './global-map-io.mjs'
import { catalogEntries } from './global-map-lib.mjs'

// Registers the global-map assets and series in this Workspace's market memory.
// Catalog identities are immutable: existing ids are skipped, never rewritten.
const usage = 'Use: node global-map-register.mjs [--dry-run]'
const args = process.argv.slice(2)
if (args.some(a => a !== '--dry-run')) throw new Error(usage)
const dryRun = args.includes('--dry-run')

const gw = gateway() // forwards AQ_RUN_ID / AQ_SESSION_ID like the CLI shim, so memory records the true origin
const root = await workspaceRoot()
const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'global-map-universe.json')
const universePath = await realpath(join(root, 'research/market-assistant/global-map/universe.json')).catch(() => bundled)
const universe = JSON.parse(await readFile(universePath, 'utf8'))

const catalogTool = await gw.toolName('data', 'memory', 'catalog')
const recordTool = await gw.toolName('data', 'memory', 'record')
const read = async (tool, toolArgs) => JSON.parse((await gw.invoke('data', tool, toolArgs)).content[0].text)

const existing = new Set((await read(catalogTool, {})).entries.map(e => e.entityId))
const entries = catalogEntries(universe)
const missing = entries.filter(e => !existing.has(e.entityId))
if (dryRun) {
  process.stdout.write(JSON.stringify({ universeRevision: universe.revision, total: entries.length, alreadyRegistered: entries.length - missing.length, toRegister: missing }, null, 2) + '\n')
} else {
  const recorded = []
  for (const entry of missing) {
    // Assets precede their series in catalogEntries, so a failure never leaves an orphan series.
    const result = await read(recordTool, { entryJson: JSON.stringify(entry) })
    recorded.push({ entityId: entry.entityId, eventId: result.eventId, sequence: result.sequence })
  }
  process.stdout.write(JSON.stringify({ universeRevision: universe.revision, total: entries.length, skipped: entries.length - missing.length, recorded: recorded.length, first: recorded[0] ?? null, last: recorded.at(-1) ?? null }, null, 2) + '\n')
}
