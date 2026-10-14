// Types for global-map-lib.mjs (the skill ships plain ESM so Workspace shells run it with node).
export interface Point { date: string; value: number; close?: number }
export interface SeriesSpec {
  kind: string; frequency?: 'daily' | 'monthly'; source?: string; currency?: string | null; calendar?: string
}
export interface SeriesResult {
  status: 'ok' | 'stale' | 'missing'; lastDate: string | null; staleDays: number | null; cutoff: string
  excludedAfterCutoff: number; firstDate?: string; observations?: number
  measures: Record<string, number | null>
}
export interface MapEntry extends Partial<SeriesResult> {
  assetId: string; label: string; group?: string; kind: string; currency?: string | null
  frequency?: string; seriesId?: string; status: string; measures: Record<string, number | null>
}
export const METHOD_VERSION: string
export const PERIODS: Array<[string, { days?: number; months?: number }]>
export function dayNumber(iso: string): number
export function daysBetween(a: string, b: string): number
export function shiftDate(iso: string, shift: { days?: number; months?: number }): string
export function parseSeries(source: string, texts: string[], symbol: string): Point[]
export function indexOnOrBefore(points: Point[], iso: string): number
export function valueAt(points: Point[], iso: string, maxGap?: number): Point | null
export function sma(values: number[], n: number, end?: number): number | null
export function rsiWilder(values: number[], n?: number): number | null
export function percentileRank(sample: number[], x: number): number | null
export function eurFactor(currency: string | null | undefined, fx: Record<string, Point[]>, iso: string): number | null
export function computeSeries(spec: SeriesSpec, points: Point[], ctx: { asOf: string; fx?: Record<string, Point[]>; incompleteFrom?: string | null }): SeriesResult
export function deriveSeries(op: 'diff' | 'ratio', a: Point[], b: Point[], monthly?: boolean): Point[]
export function applyRelative(groups: Record<string, { relative: string | null }>, results: MapEntry[]): Record<string, string[]>
export function measureCatalog(entries: MapEntry[]): Array<{ assetId: string; measureKey: string; timeframe: string; seriesId?: string; unit: string; definition: string; completedBarsOnly: boolean }>
export function renderTables(metrics: unknown): string
export function catalogEntries(universe: unknown): Array<Record<string, unknown>>
export function extractValuation(provider: 'ishares' | 'ssga' | string, html: string): { asOf: string | null; values: Record<string, number>; fragments: Record<string, string> }
export function computeValuation(payloads: Array<{ seriesId: string; fund: string; asOf: string | null; values: Record<string, number> }>, asOf: string): {
  status: 'ok' | 'stale' | 'missing'; asOf: string | null; staleDays: number | null; measures: Record<string, number>
  sources: Array<{ measureKey: string; seriesId: string; fund: string; asOf: string | null }>
  excluded: Array<{ seriesId: string; fund: string; asOf: string; reason: string }>
}
export interface Prepared { universe: unknown; parsed: Map<string, Point[]>; valuationPayloads: Map<string, unknown>; fetchedDay(id: string): string | null; fx: Record<string, Point[]>; warnings: string[] }
export function prepareRun(run: { manifest: unknown; universe: unknown; payloadText: Map<string, { text: string; fetchedAt: string }> }): Prepared
export function mapAt(prep: Prepared, asOf: string): { assets: MapEntry[]; macro: MapEntry[]; derived: MapEntry[]; groups: Record<string, unknown> }
export interface Condition {
  conditionId: string; role: 'invalidation' | 'trigger' | 'target' | 'review'; assetId: string; measureKey: string
  timeframe: '1D' | '1W' | '1H'; op: '>' | '>=' | '<' | '<='; threshold: number | { assetId: string; measureKey: string }
  consecutive: number; activeFrom?: string; expiresAt?: string
}
export function evaluateCondition(c: Condition, ctx: {
  asOf: string; sessions(assetId: string, n: number): string[]; value(assetId: string, key: string, date: string): number | null
}): { conditionId: string; result: 'met' | 'not-met' | 'not-evaluable'; value: number | null; observedAt: string | null; reason?: string }
