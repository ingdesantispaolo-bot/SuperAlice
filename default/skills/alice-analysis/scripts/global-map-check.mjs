import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gateway, loadRun, workspaceRoot } from './global-map-io.mjs'
import { deriveSeries, evaluateCondition, mapAt, prepareRun } from './global-map-lib.mjs'

// Nightly outcome check: evaluates every active thesis condition on a computed
// map run and records one `check` event. Deterministic over the run's verified
// payloads; measures for earlier sessions are recomputed as known at that date.
const usage = 'Use: node global-map-check.mjs --run-id <id> [--dry-run]'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') { options.dryRun = true; continue }
  if (args[i] !== '--run-id' || args[i + 1] === undefined) throw new Error(usage)
  options.runId = args[++i]
}
if (!options.runId) throw new Error(usage)

const gw = gateway()
const root = await workspaceRoot()
const run = await loadRun(root, options.runId)
const metricsPath = join(run.runDir, 'global-map.metrics.json')
const metricsBytes = await readFile(metricsPath)
const metrics = JSON.parse(metricsBytes.toString('utf8'))
if (metrics.runId !== options.runId) throw new Error('Run has no computed metrics: run global-map-calc.mjs first')
const asOf = metrics.asOf
const prep = prepareRun(run)
const { universe } = run

// ---- active theses with conditions, read through the memory context
const contextTool = await gw.toolName('data', 'memory', 'context')
const recordTool = await gw.toolName('data', 'memory', 'record')
const read = async (tool, toolArgs) => JSON.parse((await gw.invoke('data', tool, toolArgs)).content[0].text)
const assetIds = [...universe.assets, ...universe.derived, ...universe.macro].map(a => a.assetId)
const theses = new Map()
async function collect(ids) {
  try {
    const ctx = await read(contextTool, { entityIds: ids, limit: 100, maxChars: 64000 })
    for (const t of ctx.theses ?? []) if (t.status === 'active' && t.conditions?.length) theses.set(t.eventId, t)
  } catch (error) {
    // Output budgets fail explicitly: split the request instead of losing theses.
    if (ids.length === 1) throw error
    const half = Math.ceil(ids.length / 2)
    await collect(ids.slice(0, half)); await collect(ids.slice(half))
  }
}
for (let i = 0; i < assetIds.length; i += 10) await collect(assetIds.slice(i, i + 10))

// ---- measures as known at each session
const specOf = new Map([
  ...universe.assets.map(a => [a.assetId, a.series.seriesId]),
  ...universe.macro.map(m => [m.assetId, m.seriesId]),
])
const derivedOf = new Map(universe.derived.map(d => [d.assetId, d]))
const monthlySeries = new Set([...universe.assets.filter(a => a.frequency === 'monthly').map(a => a.series.seriesId),
  ...[...universe.aux, ...universe.macro].filter(s => s.frequency === 'monthly').map(s => s.seriesId)])
function points(assetId) {
  const d = derivedOf.get(assetId)
  if (d) {
    const a = prep.parsed.get(d.a), b = prep.parsed.get(d.b)
    return a && b ? deriveSeries(d.op, a, b, monthlySeries.has(d.a) || monthlySeries.has(d.b)) : []
  }
  return prep.parsed.get(specOf.get(assetId)) ?? []
}
const sessions = (assetId, n) => points(assetId).filter(p => p.date <= asOf).slice(-n).map(p => p.date)
const maps = new Map()
function value(assetId, key, date) {
  if (!maps.has(date)) {
    const m = mapAt(prep, date)
    maps.set(date, new Map([...m.assets, ...m.derived, ...m.macro].map(e => [e.assetId, e])))
  }
  const e = maps.get(date).get(assetId)
  return e && e.status !== 'missing' && e.status !== 'gap' ? (e.measures[key] ?? null) : null
}

const results = []
for (const t of theses.values()) {
  for (const c of t.conditions) results.push({ thesisEventId: t.eventId, ...evaluateCondition(c, { asOf, sessions, value }) })
}
const summary = { runId: options.runId, asOf, activeTheses: theses.size, results: results.length,
  met: results.filter(r => r.result === 'met').length, notEvaluable: results.filter(r => r.result === 'not-evaluable').length }

if (!results.length) {
  process.stdout.write(JSON.stringify({ ...summary, note: 'No active thesis with conditions: nothing recorded' }, null, 2) + '\n')
} else if (options.dryRun) {
  process.stdout.write(JSON.stringify({ ...summary, detail: results }, null, 2) + '\n')
} else {
  if (results.length > 500) throw new Error('More than 500 condition results: agree a larger check budget with the memory owner')
  // Pin the run so its raw inputs survive pruning, then register its metrics once as evidence.
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'global-map-pin.mjs'), '--run-id', options.runId, '--reason', 'nightly thesis check'], { cwd: root })
  const evidencePath = join(run.runDir, 'global-map.evidence.json')
  let evidence
  try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!evidence?.metricsEvidenceId) {
    const rel = `research/market-assistant/runs/${options.runId}/global-map.metrics.json`
    const recorded = await read(recordTool, { entryJson: JSON.stringify({
      kind: 'evidence', originalPath: rel, sha256: createHash('sha256').update(metricsBytes).digest('hex'),
      format: 'json', description: `Global map metrics as of ${asOf}`, originalRunId: options.runId,
    }) })
    evidence = { metricsEvidenceId: recorded.eventId }
    const temp = `${evidencePath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
    await rename(temp, evidencePath)
  }
  const check = await read(recordTool, { entryJson: JSON.stringify({
    kind: 'check', runId: `check-${options.runId}`, evaluatedAt: new Date().toISOString(),
    metricsEvidenceId: evidence.metricsEvidenceId, results,
  }) })
  // Notify only invalidations that are newly met for this thesis version.
  const fresh = results.filter(r => r.result === 'met').filter(r => {
    const t = theses.get(r.thesisEventId)
    const c = t.conditions.find(x => x.conditionId === r.conditionId)
    const before = t.latestCheck?.results?.find(x => x.conditionId === r.conditionId)?.result
    return c.role === 'invalidation' && before !== 'met'
  })
  let delivery = 'none'
  if (fresh.length) {
    const lines = fresh.map(r => {
      const t = theses.get(r.thesisEventId)
      return `- **${t.thesisId}** (${t.horizon}): condizione \`${r.conditionId}\` soddisfatta, valore ${r.value} al ${r.observedAt.slice(0, 10)}. ${t.invalidation}`
    })
    const body = `### Mappa dei mercati: tesi da rivedere\n\nControllo del ${asOf} (raccolta ${options.runId}).\n\n${lines.join('\n')}\n\nLa tesi resta attiva fino alla revisione programmata o a una tua decisione.`
    // A failed delivery stays visible: it is never reported as a sent notification.
    try { await gw.invoke('data', await gw.toolName('data', 'inbox', 'push'), { body }); delivery = 'sent' }
    catch (error) { delivery = `failed: ${String(error.message).slice(0, 200)}`; process.exitCode = 3 }
  }
  process.stdout.write(JSON.stringify({ ...summary, checkEventId: check.eventId, metricsEvidenceId: evidence.metricsEvidenceId, invalidationsNewlyMet: fresh.length, delivery }, null, 2) + '\n')
}
