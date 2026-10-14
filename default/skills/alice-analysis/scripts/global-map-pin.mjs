import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeDir, workspaceRoot } from './global-map-io.mjs'

// Pin a map run whose metrics support a report, judgment or thesis, so payload
// pruning keeps its raw inputs until IbIvMonitor owns long-term persistence.
const usage = 'Use: node global-map-pin.mjs --run-id <id> --reason "<why>"'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--run-id', '--reason'].includes(args[i]) || args[i + 1] === undefined) throw new Error(usage)
  options[args[i]] = args[i + 1]
}
const runId = options['--run-id'], reason = options['--reason']
if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(runId) || !reason || reason.length > 300) throw new Error(usage)

const root = await workspaceRoot()
const manifest = JSON.parse(await readFile(join(root, 'research/market-assistant/runs', runId, 'global-map.manifest.json'), 'utf8'))
if (manifest.schema !== 'superai.global-map.manifest/1' || manifest.runId !== runId) throw new Error('Not a global-map run')

const dir = await safeDir(root, 'research/market-assistant/global-map')
const path = join(dir, 'pinned-runs.json')
let pins = { schema: 'superai.global-map.pins/1', runs: [] }
try { pins = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!pins.runs.some(r => r.runId === runId)) pins.runs.push({ runId, reason, pinnedAt: new Date().toISOString() })
const temp = join(dir, `.pinned-runs.${process.pid}.tmp`)
await writeFile(temp, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' })
await rename(temp, path)
process.stdout.write(JSON.stringify({ pinned: runId, total: pins.runs.length }) + '\n')
