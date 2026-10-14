import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadRun, safeDir, workspaceRoot } from './global-map-io.mjs'
import { METHOD_VERSION, mapAt, measureCatalog, prepareRun, renderTables } from './global-map-lib.mjs'

// Offline, deterministic calculation over a collected run: no network, no model, no clock.
const usage = 'Use: node global-map-calc.mjs --run-id <id> --as-of YYYY-MM-DD [--publish-measures]'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--publish-measures') { options.publish = true; continue }
  if (!['--run-id', '--as-of'].includes(args[i]) || args[i + 1] === undefined) throw new Error(usage)
  options[args[i]] = args[++i]
}
const runId = options['--run-id'], asOf = options['--as-of']
if (!runId || !/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) throw new Error(usage)

const root = await workspaceRoot()
const run = await loadRun(root, runId) // verifies the universe copy and every payload hash
const prep = prepareRun(run)
const { assets, macro, derived, groups } = mapAt(prep, asOf)
const { manifest, universe, runDir } = run

const metrics = {
  schema: 'superai.global-map.metrics/1', methodVersion: METHOD_VERSION, runId, asOf,
  universeRevision: universe.revision, baseCurrency: universe.baseCurrency,
  inputs: manifest.payloads.map(p => ({ key: p.key, status: p.status, fetchedAt: p.fetchedAt, file: p.file ?? null, sha256: p.sha256 ?? null })),
  coverage: {
    assets: assets.length,
    ok: assets.filter(a => a.status === 'ok').length,
    stale: assets.filter(a => a.status === 'stale').map(a => a.assetId),
    missing: assets.filter(a => a.status === 'missing').map(a => a.assetId),
    gaps: assets.filter(a => a.status === 'gap').map(a => a.assetId),
  },
  groups, assets, derived, macro, warnings: prep.warnings,
}
const catalog = { schema: 'superai.measures/1', methodVersion: METHOD_VERSION, runId, asOf, measures: measureCatalog([...assets, ...derived, ...macro]) }

const write = (name, data) => writeFile(join(runDir, name), data, { flag: 'wx' })
await write('global-map.metrics.json', JSON.stringify(metrics, null, 2) + '\n')
await write('global-map.measures.json', JSON.stringify(catalog, null, 2) + '\n')
await write('global-map.tables.md', renderTables(metrics))

if (options.publish) {
  // Publish the measure catalog used to validate thesis conditions (atomic replace).
  const dir = await safeDir(root, 'research/market-assistant/global-map')
  const temp = join(dir, `.measures.${process.pid}.tmp`)
  await writeFile(temp, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' })
  await rename(temp, join(dir, 'measures.json'))
}
process.stdout.write(JSON.stringify({ runId, asOf, methodVersion: METHOD_VERSION, coverage: metrics.coverage, warnings: prep.warnings, measures: catalog.measures.length }, null, 2) + '\n')
