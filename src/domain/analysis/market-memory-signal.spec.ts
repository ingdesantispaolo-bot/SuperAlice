import { describe, expect, it } from 'vitest'
import { buildConfirmedSignalDraft } from '../../../default/skills/alice-analysis/scripts/market-memory-signal.mjs'

const draft = { schema: 'superai.confirmed-signal-draft/1', status: 'confirmed', findingKey: 'fixture:gold', methodRevision: 'fixture-1',
  entry: { kind: 'signal', horizon: 'intraday', confirmedAt: '2026-10-14T12:00:00+02:00', expiresAt: '2026-10-14T18:00:00+02:00' } }
describe('confirmed signal episode identity', () => {
  it('keeps the same episode across controls and equivalent timestamps, separating horizons and re-confirmations', () => {
    const first = buildConfirmedSignalDraft(draft).entry.signalId
    expect(buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, confirmedAt: '2026-10-14T10:00:00Z' } }).entry.signalId).toBe(first)
    expect(buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, horizon: 'swing' } }).entry.signalId).not.toBe(first)
    expect(buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, confirmedAt: '2026-10-14T13:00:00+02:00' } }).entry.signalId).not.toBe(first)
  })
  it('refuses candidates, missing/extended expiry and a caller-supplied different identity', () => {
    expect(() => buildConfirmedSignalDraft({ ...draft, status: 'candidate' })).toThrow('explicitly confirmed')
    expect(() => buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, expiresAt: undefined } })).toThrow('bounded expiry')
    expect(() => buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, confirmedAt: '2026-10-14' } })).toThrow('bounded expiry')
    expect(() => buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, expiresAt: '2026-10-22T10:00:00Z' } })).toThrow('bounded expiry')
    expect(() => buildConfirmedSignalDraft({ ...draft, entry: { ...draft.entry, signalId: 'changed' } })).toThrow('stable episode')
  })
})
